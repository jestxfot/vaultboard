// Хранилище доски: единственное место, где меняется документ.
//
// Любая правка — это список элементарных операций (вставить / удалить / заменить объект).
// Отмена — те же операции наоборот, поэтому Ctrl+Z мгновенный даже на огромной доске:
// история хранит только то, что поменялось, а не копии доски.
//
// Жесты (перетаскивание, набор текста) меняют доску «вживую» каждый кадр,
// но в историю попадают одной записью — одно перетаскивание отменяется одним Ctrl+Z.
import type { BoardDoc, Item } from './types.ts';
import { isLine } from './types.ts';

/** Свойства всей доски, которые меняются через историю (их правки отменяются как всё остальное). */
export type DocProp = 'styles' | 'background';

export type Op =
  | { t: 'insert'; index: number; item: Item }
  | { t: 'delete'; index: number; item: Item }
  | { t: 'replace'; index: number; before: Item; after: Item }
  | { t: 'prop'; key: DocProp; before: unknown; after: unknown };

export interface Tx {
  label: string;
  ops: Op[];
}

/** Что записать в журнал истории на диске. */
export type HistoryEvent = { kind: 'do'; label: string; ops: Op[] } | { kind: 'undo' } | { kind: 'redo' };

export function invert(op: Op): Op {
  switch (op.t) {
    case 'insert': return { t: 'delete', index: op.index, item: op.item };
    case 'delete': return { t: 'insert', index: op.index, item: op.item };
    case 'replace': return { t: 'replace', index: op.index, before: op.after, after: op.before };
    case 'prop': return { t: 'prop', key: op.key, before: op.after, after: op.before };
  }
}

function opId(op: Op): string {
  if (op.t === 'prop') return `prop:${op.key}`;
  return op.t === 'replace' ? op.after.id : op.item.id;
}

/** Склеивает операции жеста: много замен одного объекта превращаются в одну. */
function mergeOps(ops: Op[]): Op[] {
  // Объекты, которые жест сначала создал, а в конце удалил (пустой текст закрыли), — их нет в истории вовсе.
  const first = new Map<string, Op['t']>();
  const last = new Map<string, Op['t']>();
  for (const op of ops) {
    const id = opId(op);
    if (!first.has(id)) first.set(id, op.t);
    last.set(id, op.t);
  }
  const transient = new Set<string>();
  for (const [id, t] of first) if (t === 'insert' && last.get(id) === 'delete') transient.add(id);

  const out: Op[] = [];
  const lastReplace = new Map<string, Extract<Op, { t: 'replace' }>>();
  const lastInsert = new Map<string, Extract<Op, { t: 'insert' }>>();
  for (const op of ops) {
    const id = opId(op);
    if (transient.has(id)) continue;
    if (op.t === 'insert') {
      const copy = { ...op };
      lastInsert.set(id, copy);
      lastReplace.delete(id);
      out.push(copy);
      continue;
    }
    if (op.t === 'prop') {
      // Несколько правок одного свойства доски за жест — одна запись: было в начале, стало в конце.
      const prev = out.find((o): o is Extract<Op, { t: 'prop' }> => o.t === 'prop' && o.key === op.key);
      if (prev) prev.after = op.after;
      else out.push({ ...op });
      continue;
    }
    if (op.t === 'replace') {
      // Объект создан в этом же жесте — сразу пишем его итоговый вид во вставку.
      const ins = lastInsert.get(id);
      if (ins) {
        ins.item = op.after;
        continue;
      }
      const prev = lastReplace.get(id);
      if (prev) {
        prev.after = op.after;
        continue;
      }
      const copy = { ...op };
      lastReplace.set(id, copy);
      out.push(copy);
    } else {
      lastReplace.delete(id);
      lastInsert.delete(id);
      out.push(op);
    }
  }
  return out;
}

export type StoreListener = (ops: Op[]) => void;

export class BoardStore {
  readonly doc: BoardDoc;
  private readonly byId = new Map<string, Item>();
  private readonly position = new Map<string, number>();
  private positionDirty = true;
  /** id объекта → id линий, прицепленных к нему. */
  private readonly attached = new Map<string, Set<string>>();
  private readonly undoStack: Tx[] = [];
  private readonly redoStack: Tx[] = [];
  private readonly listeners = new Set<StoreListener>();
  private readonly historyListeners = new Set<(e: HistoryEvent) => void>();
  /** Номер версии доски: растёт с каждой правкой, отменой и повтором. Сверяется с журналом истории. */
  rev: number;
  /** Куда сейчас записываются операции: транзакция или порция жеста. */
  private sink: Op[] | null = null;
  private gesture: Tx | null = null;

  constructor(doc: BoardDoc) {
    this.doc = doc;
    this.rev = typeof doc.meta.rev === 'number' ? doc.meta.rev : 0;
    for (const item of doc.items) {
      this.byId.set(item.id, item);
      this.link(item);
    }
  }

  onChange(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onHistory(fn: (e: HistoryEvent) => void): () => void {
    this.historyListeners.add(fn);
    return () => this.historyListeners.delete(fn);
  }

  /** Восстановить историю, прочитанную с диска. */
  restoreHistory(undo: Tx[], redo: Tx[]): void {
    this.undoStack.splice(0, this.undoStack.length, ...undo);
    this.redoStack.splice(0, this.redoStack.length, ...redo);
  }

  get historySize(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  get items(): readonly Item[] {
    return this.doc.items;
  }

  get(id: string): Item | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Место объекта в порядке слоёв. */
  indexOf(id: string): number {
    if (this.positionDirty) {
      this.position.clear();
      this.doc.items.forEach((item, i) => this.position.set(item.id, i));
      this.positionDirty = false;
    }
    return this.position.get(id) ?? -1;
  }

  /** Линии, прицепленные к объекту. */
  linesOf(id: string): string[] {
    const set = this.attached.get(id);
    return set ? [...set] : [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get inGesture(): boolean {
    return this.gesture !== null;
  }

  // ---------- правки ----------

  insert(item: Item, index = this.doc.items.length): void {
    if (this.byId.has(item.id)) throw new Error(`Объект ${item.id} уже есть на доске`);
    this.run({ t: 'insert', index, item });
  }

  /** Удаляет объект вместе с прицепленными к нему линиями. */
  remove(id: string): void {
    const item = this.byId.get(id);
    if (!item) return;
    this.write(() => {
      for (const lineId of this.linesOf(id)) this.remove(lineId);
      this.run({ t: 'delete', index: this.indexOf(id), item });
    });
  }

  update<T extends Item>(id: string, change: Partial<T> | ((item: T) => T)): void {
    const before = this.byId.get(id) as T | undefined;
    if (!before) return;
    const after = typeof change === 'function' ? change(before) : ({ ...before, ...change } as T);
    if (after === before) return;
    this.run({ t: 'replace', index: this.indexOf(id), before, after });
  }

  /** Поменять свойство всей доски (стили, фон). `undefined` — убрать свойство. */
  setProp(key: DocProp, value: unknown): void {
    const before = this.doc[key];
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    this.run({ t: 'prop', key, before, after: value });
  }

  /** Переставить объект в порядке слоёв (на передний / задний план). */
  moveToIndex(id: string, index: number): void {
    const item = this.byId.get(id);
    if (!item) return;
    const from = this.indexOf(id);
    const to = Math.max(0, Math.min(this.doc.items.length - 1, index));
    if (from === to) return;
    this.write(() => {
      this.run({ t: 'delete', index: from, item });
      this.run({ t: 'insert', index: to, item });
    });
  }

  // ---------- транзакции и жесты ----------

  /** Несколько правок одной записью в истории и одним уведомлением. */
  transact<T>(label: string, fn: () => T): T {
    if (this.sink) return fn();
    const tx: Tx = { label, ops: [] };
    this.sink = tx.ops;
    try {
      return fn();
    } finally {
      this.sink = null;
      if (tx.ops.length) {
        this.pushHistory(tx);
        this.emit(tx.ops);
      }
    }
  }

  beginGesture(label: string): void {
    if (this.gesture) this.endGesture();
    this.gesture = { label, ops: [] };
  }

  /** Порция правок внутри жеста: видна сразу, в историю попадёт при завершении жеста. */
  live(fn: () => void): void {
    if (!this.gesture) {
      this.transact('Правка', fn);
      return;
    }
    const batch: Op[] = [];
    const outer = this.sink;
    this.sink = batch;
    try {
      fn();
    } finally {
      this.sink = outer;
      this.gesture?.ops.push(...batch);
      if (batch.length) this.emit(batch);
    }
  }

  endGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const ops = mergeOps(g.ops);
    if (ops.length) this.pushHistory({ label: g.label, ops });
  }

  /** Отменить жест целиком, как будто его не было. */
  cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g || !g.ops.length) return;
    const inverse = g.ops.map(invert).reverse();
    for (const op of inverse) this.applyOp(op);
    this.emit(inverse);
  }

  undo(): void {
    if (this.gesture) this.endGesture();
    const tx = this.undoStack.pop();
    if (!tx) return;
    const inverse = tx.ops.map(invert).reverse();
    for (const op of inverse) this.applyOp(op);
    this.redoStack.push(tx);
    this.notifyHistory({ kind: 'undo' });
    this.emit(inverse);
  }

  redo(): void {
    const tx = this.redoStack.pop();
    if (!tx) return;
    for (const op of tx.ops) this.applyOp(op);
    this.undoStack.push(tx);
    this.notifyHistory({ kind: 'redo' });
    this.emit(tx.ops);
  }

  // ---------- внутреннее ----------

  private write(fn: () => void): void {
    if (this.sink) fn();
    else this.transact('Правка', fn);
  }

  private run(op: Op): void {
    this.write(() => {
      this.applyOp(op);
      this.sink!.push(op);
    });
  }

  private applyOp(op: Op): void {
    const items = this.doc.items;
    switch (op.t) {
      case 'insert':
        items.splice(op.index, 0, op.item);
        this.byId.set(op.item.id, op.item);
        this.link(op.item);
        this.positionDirty = true;
        break;
      case 'delete':
        items.splice(op.index, 1);
        this.byId.delete(op.item.id);
        this.unlink(op.item);
        this.positionDirty = true;
        break;
      case 'prop':
        if (op.after === undefined) delete this.doc[op.key];
        else (this.doc as Record<string, unknown>)[op.key] = op.after;
        break;
      case 'replace':
        items[op.index] = op.after;
        this.byId.set(op.after.id, op.after);
        if (isLine(op.before)) this.unlink(op.before);
        this.link(op.after);
        break;
    }
  }

  private link(item: Item): void {
    if (!isLine(item)) return;
    for (const ep of [item.from, item.to]) {
      if (!('item' in ep)) continue;
      let set = this.attached.get(ep.item);
      if (!set) this.attached.set(ep.item, (set = new Set()));
      set.add(item.id);
    }
  }

  private unlink(item: Item): void {
    if (!isLine(item)) return;
    for (const ep of [item.from, item.to]) {
      if ('item' in ep) this.attached.get(ep.item)?.delete(item.id);
    }
  }

  private pushHistory(tx: Tx): void {
    this.undoStack.push(tx);
    this.redoStack.length = 0;
    this.notifyHistory({ kind: 'do', label: tx.label, ops: tx.ops });
  }

  private notifyHistory(e: HistoryEvent): void {
    this.rev++;
    for (const fn of this.historyListeners) fn(e);
  }

  private emit(ops: Op[]): void {
    for (const fn of this.listeners) fn(ops);
  }
}
