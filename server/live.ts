// Совместная правка доски вживую. Сервер держит доску, открытую участниками, у себя в памяти:
// каждый участник присылает свои правки (операции хранилища), сервер применяет их к своей копии
// («кто последний тронул объект, того и версия»), раздаёт остальным и сам сохраняет файл доски.
// Пока доска общая, файл пишет только сервер — у участников нет своих сохранений, которые могли бы спорить.
//
// Связь с вкладками: правки и курсор — обычными POST, новости от сервера — одним потоком событий (SSE).
import type { ServerResponse } from 'node:http';
import { BoardStore, type Op } from '../src/model/store.ts';
import { parseBoard, serializeBoard } from '../src/format/board.ts';

export type Role = 'owner' | 'edit' | 'comment' | 'view';

export interface Peer {
  id: string;
  name: string;
  role: Role;
  color: string;
  cursor: { x: number; y: number } | null;
}

interface Client extends Peer {
  /** Кто это: «owner» (автор на своём компьютере) или «invite:<id>». Чужой номер вкладки без своего ключа не подойдёт. */
  key: string;
  res: ServerResponse | null;
  /** Когда поток событий оборвался — даём пару секунд переподключиться, не показывая «ушёл». */
  goneAt: number;
}

const COLORS = ['#e93147', '#08b94e', '#ec7500', '#7852ee', '#00bfbc', '#b04fc8', '#e0ac00', '#4262ff'];
const SAVE_DELAY_MS = 600;
const GRACE_MS = 8000;

/** Что может прислать участник с этой ролью: зритель — ничего, комментатор — только обсуждения. */
export function allowedOps(role: Role, ops: Op[]): Op[] {
  if (role === 'owner' || role === 'edit') return ops;
  if (role === 'comment') return ops.filter((o) => o.t === 'thread');
  return [];
}

class LiveBoard {
  readonly path: string;
  store: BoardStore;
  seq = 0;
  readonly clients = new Map<string, Client>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  dirty = false;

  constructor(path: string, text: string) {
    this.path = path;
    this.store = new BoardStore(parseBoard(text));
  }

  get peers(): Peer[] {
    return [...this.clients.values()].filter((c) => !c.goneAt).map(({ id, name, role, color, cursor }) => ({ id, name, role, color, cursor }));
  }

  send(event: string, data: unknown, except?: string): void {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients.values()) if (c.res && c.id !== except) c.res.write(line);
  }

  scheduleSave(write: () => Promise<void>): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void write();
    }, SAVE_DELAY_MS);
  }

  cancelSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
}

export interface LiveHubIo {
  read(board: string): Promise<string>;
  /** Записать доску атомарно и пометить запись своей (чтобы слежение за файлами не приняло её за чужую). */
  write(board: string, text: string): Promise<void>;
  log?(text: string): void;
}

export class LiveHub {
  private readonly boards = new Map<string, LiveBoard>();
  private readonly io: LiveHubIo;
  private idCounter = 0;

  constructor(io: LiveHubIo) {
    this.io = io;
    // Поддержка связи: раз в 20 с пустая строка — иначе прокси и туннели закрывают «молчащий» поток.
    setInterval(() => {
      for (const b of this.boards.values()) for (const c of b.clients.values()) c.res?.write(': ping\n\n');
      this.sweep();
    }, 20_000).unref();
  }

  /** Доска сейчас открыта вживую (ею владеет сервер). */
  isLive(board: string): boolean {
    return this.boards.has(board);
  }

  /** Чей это номер вкладки (для проверки, что вкладку ведёт тот же участник). */
  keyOf(board: string, client: string): string | undefined {
    return this.boards.get(board)?.clients.get(client)?.key;
  }

  /** Есть ли сейчас кто-нибудь на досках вживую (тогда сервер не перезапускается сам ради обновления). */
  get busy(): boolean {
    for (const b of this.boards.values()) if (b.clients.size) return true;
    return false;
  }

  /** Кто сейчас на доске. */
  peersOf(board: string): Peer[] {
    return this.boards.get(board)?.peers ?? [];
  }

  private async open(board: string): Promise<LiveBoard> {
    let b = this.boards.get(board);
    if (!b) {
      b = new LiveBoard(board, await this.io.read(board));
      // Пока читали, доску мог открыть другой участник.
      const again = this.boards.get(board);
      if (again) return again;
      this.boards.set(board, b);
    }
    return b;
  }

  /** Войти на доску: свежая версия доски с сервера (не с диска — на сервере могут быть ещё не записанные правки). */
  async join(board: string, who: { name: string; role: Role; key: string }): Promise<{ client: string; color: string; seq: number; doc: string; peers: Peer[] }> {
    const b = await this.open(board);
    const id = `c${Date.now().toString(36)}${(++this.idCounter).toString(36)}`;
    const used = new Set([...b.clients.values()].map((c) => c.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[b.clients.size % COLORS.length];
    b.clients.set(id, { id, key: who.key, name: who.name.slice(0, 40) || 'Гость', role: who.role, color, cursor: null, res: null, goneAt: Date.now() });
    return { client: id, color, seq: b.seq, doc: serializeBoard(b.store.doc), peers: b.peers };
  }

  /** Поток событий для вкладки: правки других, кто пришёл и ушёл, курсоры. */
  events(board: string, client: string, res: ServerResponse): boolean {
    const b = this.boards.get(board);
    const c = b?.clients.get(client);
    if (!b || !c) return false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: b.seq })}\n\n`);
    c.res?.end();
    c.res = res;
    c.goneAt = 0;
    b.send('peers', b.peers);
    res.on('close', () => {
      if (c.res !== res) return;
      c.res = null;
      c.goneAt = Date.now();
      // Не показываем «ушёл» сразу: вкладка могла просто переподключиться.
      setTimeout(() => {
        if (c.goneAt && Date.now() - c.goneAt >= GRACE_MS - 50) {
          b.clients.delete(client);
          b.send('peers', b.peers);
        }
      }, GRACE_MS).unref?.();
    });
    return true;
  }

  /** Правки участника: применить, разослать остальным, сохранить. Возвращает номер версии доски. */
  push(board: string, client: string, ops: Op[]): { seq: number; applied: number } | null {
    const b = this.boards.get(board);
    const c = b?.clients.get(client);
    if (!b || !c) return null;
    const allowed = allowedOps(c.role, ops);
    if (!allowed.length) return { seq: b.seq, applied: 0 };
    let done: Op[] = [];
    const off = b.store.onChange((eff) => (done = eff));
    b.store.applyRemote(allowed);
    off();
    if (!done.length) return { seq: b.seq, applied: 0 };
    b.seq++;
    // Всем, и отправителю тоже: у всех правки идут в одном порядке — так все сходятся к одной версии
    // (отправитель по своему эху понимает, что его правка дошла; см. src/io/live.ts).
    b.send('ops', { seq: b.seq, client, ops: done });
    b.scheduleSave(() => this.save(b));
    return { seq: b.seq, applied: done.length };
  }

  /** Курсор участника (в координатах доски) — раздаётся остальным, на диск не пишется. */
  presence(board: string, client: string, cursor: { x: number; y: number } | null): void {
    const b = this.boards.get(board);
    const c = b?.clients.get(client);
    if (!b || !c) return;
    c.cursor = cursor ? { x: Math.round(cursor.x), y: Math.round(cursor.y) } : null;
    b.send('cursor', { id: client, cursor: c.cursor }, client);
  }

  leave(board: string, client: string): void {
    const b = this.boards.get(board);
    if (!b?.clients.delete(client)) return;
    b.send('peers', b.peers);
  }

  /** Доску поменяли снаружи (git, Obsidian): перечитать и сказать всем вкладкам взять новую версию. */
  async reloadFromDisk(board: string): Promise<void> {
    const b = this.boards.get(board);
    if (!b) return;
    try {
      b.cancelSave();
      b.store = new BoardStore(parseBoard(await this.io.read(board)));
      b.dirty = false;
      b.seq++;
      b.send('reset', { seq: b.seq });
    } catch (err) {
      this.io.log?.(`[вживую] не перечитать ${board}: ${(err as Error).message}`);
    }
  }

  /** Записать все несохранённые доски сейчас (перед перезапуском сервера). */
  async flush(): Promise<void> {
    for (const b of this.boards.values()) {
      if (!b.dirty) continue;
      b.cancelSave();
      await this.save(b);
    }
  }

  /** Отключить участников с этим приглашением (его отозвали). */
  kick(match: (peer: Peer & { board: string; key: string }) => boolean): void {
    for (const b of this.boards.values()) {
      let changed = false;
      for (const c of [...b.clients.values()]) {
        if (!match({ ...c, board: b.path })) continue;
        c.res?.write(`event: kicked\ndata: {}\n\n`);
        c.res?.end();
        b.clients.delete(c.id);
        changed = true;
      }
      if (changed) b.send('peers', b.peers);
    }
  }

  private async save(b: LiveBoard): Promise<void> {
    b.dirty = false;
    try {
      await this.io.write(b.path, serializeBoard(b.store.doc));
      b.send('saved', { seq: b.seq });
    } catch (err) {
      b.dirty = true;
      this.io.log?.(`[вживую] не записать ${b.path}: ${(err as Error).message}`);
      b.send('error', { message: (err as Error).message });
    }
  }

  /** Доски, где никого не осталось и всё записано, — отпустить (дальше их снова пишет обычное сохранение). */
  private sweep(): void {
    for (const [path, b] of this.boards) {
      // Вкладка вошла, но так и не подключила поток событий (или оборвалась и не вернулась).
      let gone = false;
      for (const c of [...b.clients.values()]) {
        if (!c.res && c.goneAt && Date.now() - c.goneAt > GRACE_MS) {
          b.clients.delete(c.id);
          gone = true;
        }
      }
      if (gone) b.send('peers', b.peers);
      if (!b.clients.size && !b.dirty) this.boards.delete(path);
    }
  }
}
