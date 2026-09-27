// Хранилище доски: единственное место, где меняется документ.
//
// Любая правка — это список элементарных операций (вставить / удалить / заменить объект).
// Отмена — те же операции наоборот, поэтому Ctrl+Z мгновенный даже на огромной доске:
// история хранит только то, что поменялось, а не копии доски.
//
// Жесты (перетаскивание, набор текста) меняют доску «вживую» каждый кадр,
// но в историю попадают одной записью — одно перетаскивание отменяется одним Ctrl+Z.
import type { BoardDoc, CommentThread, Item } from './types.ts';
import { isLine } from './types.ts';

/** Свойства всей доски, которые меняются через историю (их правки отменяются как всё остальное). */
export type DocProp = 'styles' | 'background' | 'layers';

export type Op =
  | { t: 'insert'; index: number; item: Item }
  | { t: 'delete'; index: number; item: Item }
  | { t: 'replace'; index: number; before: Item; after: Item }
  | { t: 'prop'; key: DocProp; before: unknown; after: unknown }
  /** Обсуждение: появилось (before = null), исчезло (after = null) или поменялось. */
  | { t: 'thread'; index: number; before: CommentThread | null; after: CommentThread | null };

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
    case 'thread': return { t: 'thread', index: op.index, before: op.after, after: op.before };
  }
}

function opId(op: Op): string {
  if (op.t === 'prop') return `prop:${op.key}`;
  if (op.t === 'thread') return `thread:${(op.after ?? op.before)!.id}`;
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
    if (op.t === 'thread') {
      // Перетаскивание булавки — одна запись: где была в начале, где стала в конце.
      const prev = out.find((o): o is Extract<Op, { t: 'thread' }> => o.t === 'thread' && opId(o) === id);
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
  // Обсуждение, которое жест и создал, и удалил, в историю не попадает.
  return out.filter((o) => o.t !== 'thread' || o.before || o.after);
}

/** `remote` — правки пришли от другого участника доски (их не надо отправлять обратно и сохранять заново). */
export type StoreListener = (ops: Op[], remote?: boolean) => void;

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
  /** Слой, на который ложатся новые объекты. Пустая строка — основной слой. */
  activeLayer = '';

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
    this.run({ t: 'insert', index, item: this.onLayer(item) });
  }

  /**
   * Удаляет объект вместе с прицепленными к нему линиями.
   * Обсуждения на объекте остаются там, где он был: булавка отцепляется и встаёт в точку доски.
   */
  remove(id: string): void {
    const item = this.byId.get(id);
    if (!item) return;
    this.write(() => {
      for (const lineId of this.linesOf(id)) this.remove(lineId);
      if (!isLine(item)) {
        for (const t of this.doc.comments) {
          if (t.item !== id) continue;
          this.updateThread(t.id, (cur) => {
            const next = { ...cur, x: item.x + (cur.fx ?? 0) * item.w, y: item.y + (cur.fy ?? 0) * item.h };
            delete next.item;
            delete next.fx;
            delete next.fy;
            return next;
          });
        }
      }
      this.run({ t: 'delete', index: this.indexOf(id), item });
    });
  }

  // ---------- обсуждения ----------

  get threads(): readonly CommentThread[] {
    return this.doc.comments;
  }

  thread(id: string): CommentThread | undefined {
    return this.doc.comments.find((t) => t.id === id);
  }

  addThread(thread: CommentThread): void {
    this.run({ t: 'thread', index: this.doc.comments.length, before: null, after: thread });
  }

  updateThread(id: string, change: (t: CommentThread) => CommentThread): void {
    const index = this.doc.comments.findIndex((t) => t.id === id);
    if (index < 0) return;
    const before = this.doc.comments[index];
    const after = change(before);
    if (after !== before) this.run({ t: 'thread', index, before, after });
  }

  removeThread(id: string): void {
    const index = this.doc.comments.findIndex((t) => t.id === id);
    if (index >= 0) this.run({ t: 'thread', index, before: this.doc.comments[index], after: null });
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
    this.emit(this.applyAll(g.ops.map(invert).reverse()));
  }

  undo(): void {
    if (this.gesture) this.endGesture();
    const tx = this.undoStack.pop();
    if (!tx) return;
    const done = this.applyAll(tx.ops.map(invert).reverse());
    this.redoStack.push(tx);
    this.notifyHistory({ kind: 'undo' });
    this.emit(done);
  }

  redo(): void {
    const tx = this.redoStack.pop();
    if (!tx) return;
    const done = this.applyAll(tx.ops);
    this.undoStack.push(tx);
    this.notifyHistory({ kind: 'redo' });
    this.emit(done);
  }

  // ---------- внутреннее ----------

  /**
   * Новый объект ложится на активный слой. Если у него уже есть слой этой доски (копия, дубликат) —
   * остаётся на нём; пустая строка — явно основной слой.
   */
  private onLayer(item: Item): Item {
    const known = item.layer !== undefined && (item.layer === '' || !!this.doc.layers?.some((l) => l.id === item.layer));
    const layer = known ? item.layer! : this.activeLayer;
    if (layer === (item.layer ?? '') && item.layer !== '') return item;
    const next = { ...item };
    if (layer) next.layer = layer;
    else delete next.layer;
    return next;
  }

  private write(fn: () => void): void {
    if (this.sink) fn();
    else this.transact('Правка', fn);
  }

  private run(op: Op): void {
    this.write(() => {
      const done = this.applyOp(op);
      if (done) this.sink!.push(done);
    });
  }

  /**
   * Применить операцию. Объект ищется по id, а номер в операции — только подсказка места:
   * при совместной правке чужие вставки и удаления сдвигают номера, и отмена по номеру задела бы не тот объект.
   * Поэтому операция над исчезнувшим объектом просто пропускается, а вставка уже существующего — заменяет его
   * («кто последний тронул объект, того и версия»).
   */
  private applyOp(op: Op): Op | null {
    const items = this.doc.items;
    switch (op.t) {
      case 'insert': {
        const old = this.byId.get(op.item.id);
        if (old) return this.applyOp({ t: 'replace', index: this.indexOf(old.id), before: old, after: op.item });
        const at = Math.min(op.index, items.length);
        items.splice(at, 0, op.item);
        this.byId.set(op.item.id, op.item);
        this.link(op.item);
        this.positionDirty = true;
        return at === op.index ? op : { ...op, index: at };
      }
      case 'delete': {
        const cur = this.byId.get(op.item.id);
        if (!cur) return null;
        const at = items[op.index]?.id === op.item.id ? op.index : this.indexOf(op.item.id);
        items.splice(at, 1);
        this.byId.delete(op.item.id);
        this.unlink(cur);
        this.positionDirty = true;
        return { t: 'delete', index: at, item: cur };
      }
      case 'prop': {
        const before = this.doc[op.key];
        if (op.after === undefined) delete this.doc[op.key];
        else (this.doc as Record<string, unknown>)[op.key] = op.after;
        return { ...op, before };
      }
      case 'thread': {
        const id = (op.after ?? op.before)!.id;
        const at = this.doc.comments[op.index]?.id === id ? op.index : this.doc.comments.findIndex((t) => t.id === id);
        if (!op.after) {
          if (at < 0) return null;
          const before = this.doc.comments[at];
          this.doc.comments.splice(at, 1);
          return { t: 'thread', index: at, before, after: null };
        }
        if (at >= 0) {
          const before = this.doc.comments[at];
          this.doc.comments[at] = op.after;
          return { t: 'thread', index: at, before, after: op.after };
        }
        const to = Math.min(op.index, this.doc.comments.length);
        this.doc.comments.splice(to, 0, op.after);
        return { t: 'thread', index: to, before: null, after: op.after };
      }
      case 'replace': {
        const cur = this.byId.get(op.after.id);
        if (!cur) return null;
        const at = items[op.index]?.id === op.after.id ? op.index : this.indexOf(op.after.id);
        items[at] = op.after;
        this.byId.set(op.after.id, op.after);
        if (isLine(cur)) this.unlink(cur);
        this.link(op.after);
        return { t: 'replace', index: at, before: cur, after: op.after };
      }
    }
  }

  /** Применить список операций; вернуть то, что на самом деле сделано (для вида доски и подписчиков). */
  private applyAll(ops: Op[]): Op[] {
    const done: Op[] = [];
    for (const op of ops) {
      const eff = this.applyOp(op);
      if (eff) done.push(eff);
    }
    return done;
  }

  // ---------- совместная правка ----------

  /**
   * Чужие правки (другой участник доски): применяются сразу, в историю отмены не попадают,
   * подписчики получают их с пометкой `remote` — такие правки не отправляются обратно на сервер.
   * Идущий жест (перетаскивание) не прерывается: чужая правка того же объекта перезапишется нашей, когда отпустим.
   */
  applyRemote(ops: Op[]): void {
    const done = this.applyAll(ops);
    if (!done.length) return;
    for (const fn of this.listeners) fn(done, true);
  }

  /** Заменить документ целиком (сервер прислал свежую версию доски) — история отмены сбрасывается. */
  resetTo(doc: { items: Item[]; comments: CommentThread[] } & Record<string, unknown>): Op[] {
    const ops: Op[] = [];
    const next = new Map(doc.items.map((i) => [i.id, i]));
    for (const item of [...this.doc.items].reverse()) if (!next.has(item.id)) ops.push({ t: 'delete', index: this.indexOf(item.id), item });
    doc.items.forEach((item, index) => {
      const cur = this.byId.get(item.id);
      if (!cur) ops.push({ t: 'insert', index, item });
      else if (JSON.stringify(cur) !== JSON.stringify(item)) ops.push({ t: 'replace', index, before: cur, after: item });
    });
    for (const key of ['styles', 'background', 'layers'] as const) {
      if (JSON.stringify(this.doc[key]) !== JSON.stringify(doc[key])) ops.push({ t: 'prop', key, before: this.doc[key], after: doc[key] });
    }
    const threads = new Map(doc.comments.map((t) => [t.id, t]));
    this.doc.comments.forEach((t, index) => {
      if (!threads.has(t.id)) ops.push({ t: 'thread', index, before: t, after: null });
    });
    doc.comments.forEach((t, index) => {
      const cur = this.doc.comments.find((c) => c.id === t.id) ?? null;
      if (JSON.stringify(cur) !== JSON.stringify(t)) ops.push({ t: 'thread', index, before: cur, after: t });
    });
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.applyRemote(ops);
    return ops;
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
