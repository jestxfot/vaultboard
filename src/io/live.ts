// Общая доска вживую, сторона вкладки. Свои правки уходят на сервер пачками (раз в 40 мс, перетаскивание одного
// объекта склеивается в одну замену), чужие приходят потоком событий и применяются без записи в историю отмены.
//
// Как все сходятся к одной версии. Сервер применяет правки в порядке прихода и раздаёт их ВСЕМ в этом же порядке,
// отправителю тоже. Пока своя правка объекта «в пути» (эхо не вернулось), чужую правку того же объекта вкладка
// пропускает: раз эхо ещё впереди, сервер применил чужую раньше нашей, и наша её перезапишет. Эхо вернулось —
// чужие правки снова применяются. Так у каждого в итоге то же, что на сервере.
import type { BoardStore, Op } from '../model/store.ts';
import { parseBoard } from '../format/board.ts';
import type { SaveState } from './session.ts';

export type LiveRole = 'owner' | 'edit' | 'comment' | 'view';

export interface LivePeer {
  id: string;
  name: string;
  role: LiveRole;
  color: string;
  cursor: { x: number; y: number } | null;
}

interface Joined {
  client: string;
  color: string;
  seq: number;
  doc: string;
  peers: LivePeer[];
  role: LiveRole;
}

const SEND_MS = 40;
const CURSOR_MS = 60;

/** Какой «объект» трогает операция — по нему считаем, что наша правка ещё в пути. */
function keyOf(op: Op): string {
  if (op.t === 'prop') return `prop:${op.key}`;
  if (op.t === 'thread') return `thread:${(op.after ?? op.before)!.id}`;
  return op.t === 'replace' ? op.after.id : op.item.id;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; rejoin?: boolean };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Ошибка сервера ${res.status}`), { rejoin: !!data.rejoin, status: res.status });
  return data;
}

export class LiveSession {
  readonly path: string;
  readonly name: string;
  store: BoardStore | null = null;
  client = '';
  color = '';
  role: LiveRole = 'view';
  peers: LivePeer[] = [];
  onState: ((s: SaveState) => void) | null = null;
  onPeers: ((peers: LivePeer[]) => void) | null = null;
  onCursor: ((id: string, cursor: { x: number; y: number } | null) => void) | null = null;
  /** Приглашение отозвали или поменяли роль — вкладку отключили. */
  onKicked: (() => void) | null = null;

  private queue: Op[] = [];
  /** Последняя замена объекта в очереди — следующую замену того же объекта склеиваем с ней. */
  private lastReplace = new Map<string, number>();
  /** Сколько своих правок объекта ещё не вернулось эхом. */
  private inFlight = new Map<string, number>();
  private sendTimer = 0;
  private sending = false;
  private events: EventSource | null = null;
  private cursorTimer = 0;
  private cursorNext: { x: number; y: number } | null | undefined;
  private closed = false;
  private rejoining = false;
  private off: (() => void) | null = null;

  constructor(path: string, name: string) {
    this.path = path;
    this.name = name;
  }

  private url(what: string): string {
    return `/api/live/${what}?board=${encodeURIComponent(this.path)}&client=${encodeURIComponent(this.client)}`;
  }

  /** Войти на доску и получить её свежую версию с сервера. */
  async join(): Promise<string> {
    const j = await post<Joined>(`/api/live/join?board=${encodeURIComponent(this.path)}`, { name: this.name });
    this.client = j.client;
    this.color = j.color;
    this.role = j.role;
    this.peers = j.peers;
    this.inFlight.clear();
    return j.doc;
  }

  /** Начать обмен правками для уже открытой доски. */
  start(store: BoardStore): void {
    this.store = store;
    this.off = store.onChange((ops, remote) => {
      if (!remote && !this.closed) this.enqueue(ops);
    });
    this.listen();
    this.onPeers?.(this.peers);
  }

  get hasUnsaved(): boolean {
    return this.queue.length > 0 || this.sending;
  }

  private listen(): void {
    this.events?.close();
    const es = new EventSource(this.url('events'));
    this.events = es;
    es.addEventListener('ops', (e) => this.onOps(JSON.parse((e as MessageEvent).data) as { client: string; ops: Op[] }));
    es.addEventListener('peers', (e) => {
      this.peers = JSON.parse((e as MessageEvent).data) as LivePeer[];
      this.onPeers?.(this.peers);
    });
    es.addEventListener('cursor', (e) => {
      const { id, cursor } = JSON.parse((e as MessageEvent).data) as { id: string; cursor: { x: number; y: number } | null };
      const p = this.peers.find((x) => x.id === id);
      if (p) p.cursor = cursor;
      this.onCursor?.(id, cursor);
    });
    es.addEventListener('saved', () => {
      if (!this.hasUnsaved) this.onState?.({ kind: 'saved' });
    });
    es.addEventListener('error', (e) => {
      // Сервер сказал об ошибке записи (это событие с данными) или оборвалась связь (без данных).
      const data = (e as MessageEvent).data;
      if (typeof data === 'string') {
        this.onState?.({ kind: 'error', message: (JSON.parse(data) as { message: string }).message });
        return;
      }
      // Оборвалось. Браузер переподключится сам, но если сервер перезапускался — нашей вкладки он уже не знает.
      if (es.readyState === EventSource.CLOSED) void this.rejoin();
    });
    es.addEventListener('reset', () => void this.rejoin());
    es.addEventListener('kicked', () => {
      this.close();
      this.onKicked?.();
    });
  }

  private onOps(msg: { client: string; ops: Op[] }): void {
    if (!this.store) return;
    if (msg.client === this.client) {
      // Эхо своей правки: она уже на доске, просто отметим, что дошла.
      for (const op of msg.ops) {
        const k = keyOf(op);
        const n = (this.inFlight.get(k) ?? 0) - 1;
        if (n > 0) this.inFlight.set(k, n);
        else this.inFlight.delete(k);
      }
      return;
    }
    const apply = msg.ops.filter((op) => !this.inFlight.has(keyOf(op)));
    if (apply.length) this.store.applyRemote(apply);
  }

  private enqueue(ops: Op[]): void {
    for (const op of ops) {
      const k = keyOf(op);
      const at = op.t === 'replace' ? this.lastReplace.get(k) : undefined;
      const prev = at !== undefined ? this.queue[at] : undefined;
      if (prev?.t === 'replace') {
        // Перетаскивание: кадры одного объекта — одна замена с последним положением.
        prev.after = (op as Extract<Op, { t: 'replace' }>).after;
        continue;
      }
      this.queue.push(op.t === 'replace' ? { ...op } : op);
      if (op.t === 'replace') this.lastReplace.set(k, this.queue.length - 1);
      else this.lastReplace.delete(k);
    }
    this.onState?.({ kind: 'pending' });
    if (!this.sendTimer) this.sendTimer = window.setTimeout(() => void this.flush(), SEND_MS);
  }

  private async flush(): Promise<void> {
    this.sendTimer = 0;
    if (this.sending || !this.queue.length || this.closed) return;
    const ops = this.queue;
    this.queue = [];
    this.lastReplace.clear();
    for (const op of ops) this.inFlight.set(keyOf(op), (this.inFlight.get(keyOf(op)) ?? 0) + 1);
    this.sending = true;
    try {
      const r = await post<{ applied: number }>(this.url('ops'), { ops });
      if (r.applied === 0) {
        // Сервер ничего не применил (например, роль не позволяет) — эха не будет.
        for (const op of ops) this.inFlight.delete(keyOf(op));
      }
    } catch (err) {
      for (const op of ops) this.inFlight.delete(keyOf(op));
      if ((err as { rejoin?: boolean }).rejoin) void this.rejoin();
      else this.onState?.({ kind: 'error', message: (err as Error).message });
    } finally {
      this.sending = false;
      if (this.queue.length) void this.flush();
    }
  }

  /** Дослать всё, что ещё не ушло (перед закрытием доски или страницы). */
  async save(): Promise<void> {
    clearTimeout(this.sendTimer);
    this.sendTimer = 0;
    while ((this.queue.length || this.sending) && !this.closed) {
      if (this.sending) await new Promise((r) => setTimeout(r, 30));
      else await this.flush();
    }
  }

  /** Сервер перезапустился или доску поменяли снаружи: войти заново и взять его версию доски. */
  private async rejoin(): Promise<void> {
    if (this.rejoining || this.closed || !this.store) return;
    this.rejoining = true;
    this.events?.close();
    this.onState?.({ kind: 'pending' });
    for (let attempt = 0; !this.closed; attempt++) {
      try {
        const text = await this.join();
        this.queue = [];
        this.lastReplace.clear();
        this.store.resetTo(parseBoard(text));
        this.listen();
        this.onPeers?.(this.peers);
        this.onState?.({ kind: 'saved' });
        break;
      } catch (err) {
        if ((err as { status?: number }).status === 401 || (err as { status?: number }).status === 403) {
          this.close();
          this.onKicked?.();
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * (attempt + 1))));
      }
    }
    this.rejoining = false;
  }

  /** Где мой курсор на доске (null — ушёл с доски). Отправляется не чаще раза в 60 мс. */
  cursor(at: { x: number; y: number } | null): void {
    this.cursorNext = at;
    if (this.cursorTimer || this.closed) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = 0;
      const c = this.cursorNext;
      this.cursorNext = undefined;
      if (c !== undefined) void post(this.url('presence'), { cursor: c }).catch(() => undefined);
    }, CURSOR_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.sendTimer);
    clearTimeout(this.cursorTimer);
    this.events?.close();
    this.off?.();
    navigator.sendBeacon?.(this.url('leave'), new Blob(['{}'], { type: 'application/json' }));
  }
}
