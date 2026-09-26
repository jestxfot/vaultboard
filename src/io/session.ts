// Открытая доска на диске: автосохранение и журнал истории.
//
// Сохранение — через полсекунды после последней правки, в фоне, атомарно. Если файл доски
// изменили снаружи, молча не затираем: сообщаем и ждём решения.
// Журнал истории лежит в папке доски и дописывается порциями; его сверка с доской идёт по номеру версии `meta.rev`.
import type { BoardStore } from '../model/store.ts';
import { encodeOps, type LogLine, parseLog, rebuildHistory } from '../model/historyCodec.ts';
import { serializeBoard } from '../format/board.ts';
import { vault } from './vault.ts';

export type SaveState =
  | { kind: 'saved' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; message: string };

const SAVE_DELAY_MS = 500;
const LOG_DELAY_MS = 300;

export class BoardSession {
  readonly store: BoardStore;
  path: string;
  onState: ((s: SaveState) => void) | null = null;
  private mtime: number | 'new';
  private saveTimer = 0;
  private saving = false;
  private again = false;
  private dirty = false;
  private logLines: string[] = [];
  private logTimer = 0;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(store: BoardStore, path: string, mtime: number | 'new') {
    this.store = store;
    this.path = path;
    this.mtime = mtime;
    if (typeof store.doc.meta.id !== 'string') store.doc.meta.id = crypto.randomUUID();
  }

  get boardId(): string {
    return this.store.doc.meta.id as string;
  }

  get hasUnsaved(): boolean {
    return this.dirty || this.saving || this.logLines.length > 0;
  }

  /** Поднять историю с диска и начать следить за правками. Возвращает, сколько шагов отмены восстановлено. */
  async start(): Promise<number> {
    const text = await vault.readHistory(this.path).catch(() => '');
    const rebuilt = text ? rebuildHistory(this.store.items, parseLog(text), this.store.rev, this.store.threads) : null;
    if (rebuilt) this.store.restoreHistory(rebuilt.undo, rebuilt.redo);
    else this.queueLog({ v: 1, start: this.store.rev });

    this.unsubscribe.push(
      this.store.onHistory((e) => {
        const r = this.store.rev;
        if (e.kind === 'do') this.queueLog({ d: e.label, o: encodeOps(e.ops), r });
        else if (e.kind === 'undo') this.queueLog({ u: 1, r });
        else this.queueLog({ re: 1, r });
      }),
      this.store.onChange(() => this.scheduleSave()),
    );
    return rebuilt?.undo.length ?? 0;
  }

  scheduleSave(): void {
    this.dirty = true;
    this.onState?.({ kind: 'pending' });
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  async save(): Promise<void> {
    if (this.saving) {
      this.again = true;
      return;
    }
    clearTimeout(this.saveTimer);
    this.saving = true;
    this.dirty = false;
    this.onState?.({ kind: 'saving' });
    this.store.doc.meta.rev = this.store.rev;
    const text = serializeBoard(this.store.doc);
    try {
      const res = await vault.writeBoard(this.path, text, this.mtime);
      if (res.ok) {
        this.mtime = res.mtime;
        this.onState?.({ kind: 'saved' });
      } else {
        this.dirty = true;
        this.onState?.(res.conflict ? { kind: 'conflict', message: res.error } : { kind: 'error', message: res.error });
      }
    } catch (err) {
      this.dirty = true;
      this.onState?.({ kind: 'error', message: (err as Error).message });
    } finally {
      this.saving = false;
      await this.flushLog();
      if (this.again) {
        this.again = false;
        void this.save();
      }
    }
  }

  /** Перезаписать доску поверх чужих правок (по решению пользователя). */
  async overwrite(): Promise<void> {
    this.store.doc.meta.rev = this.store.rev;
    const res = await vault.writeBoard(this.path, serializeBoard(this.store.doc), 'force');
    if (res.ok) {
      this.mtime = res.mtime;
      this.dirty = false;
      this.onState?.({ kind: 'saved' });
    }
  }

  private queueLog(line: LogLine): void {
    this.logLines.push(JSON.stringify(line));
    clearTimeout(this.logTimer);
    this.logTimer = window.setTimeout(() => void this.flushLog(), LOG_DELAY_MS);
  }

  private async flushLog(): Promise<void> {
    if (!this.logLines.length) return;
    const chunk = `${this.logLines.join('\n')}\n`;
    this.logLines = [];
    try {
      await vault.appendHistory(this.path, chunk);
    } catch {
      // История не записалась — не страшно для доски: при следующем открытии журнал не сойдётся
      // по версии и начнётся заново. Саму доску это не трогает.
    }
  }

  close(): void {
    clearTimeout(this.saveTimer);
    clearTimeout(this.logTimer);
    for (const off of this.unsubscribe) off();
  }
}
