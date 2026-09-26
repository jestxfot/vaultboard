// Журнал истории на диске: компактная запись правок и восстановление полной истории отмены.
//
// Журнал только дописывается — строки «сделано / отменено / повторено». При замене объекта
// пишутся лишь изменившиеся поля (было/стало), целиком объект пишется только при создании и удалении.
// Полные «до» и «после» восстанавливаются при загрузке: идём от текущего состояния доски назад по журналу.
import type { CommentMessage, CommentThread, Item } from './types.ts';
import type { DocProp, Op, Tx } from './store.ts';

/** Изменившиеся поля объекта. `null` — поля нет. */
type Patch = Record<string, unknown>;

/** Сообщения обсуждения: с какого места, что там было и что стало (обычно — одно новое сообщение в конце). */
type MessagesPatch = [start: number, removed: CommentMessage[], added: CommentMessage[]];

export type CompactOp =
  | { i: number; n: Item }                       // вставка
  | { x: number; n: Item }                       // удаление
  | { p: number; id: string; b: Patch; a: Patch } // замена
  | { k: DocProp; b: unknown; a: unknown }        // свойство доски (стили, фон)
  | { ti: number; t: CommentThread }              // новое обсуждение
  | { tx: number; t: CommentThread }              // удалённое обсуждение
  | { tp: number; id: string; b: Patch; a: Patch; m?: MessagesPatch }; // правка обсуждения

export type LogLine =
  | { v: 1; start: number }                       // начало журнала: версия доски, с которой он ведётся
  | { d: string; o: CompactOp[]; r: number }      // сделано
  | { u: 1; r: number }                           // отменено
  | { re: 1; r: number };                         // повторено

function same(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
}

export function diffItems(before: Item, after: Item): { b: Patch; a: Patch } {
  const b: Patch = {}, a: Patch = {};
  const bo = before as unknown as Record<string, unknown>;
  const ao = after as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(bo), ...Object.keys(ao)])) {
    if (same(bo[k], ao[k])) continue;
    b[k] = k in bo ? bo[k] : null;
    a[k] = k in ao ? ao[k] : null;
  }
  return { b, a };
}

export function applyPatch(item: Item, patch: Patch): Item {
  const copy = { ...item } as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete copy[k];
    else copy[k] = v;
  }
  return copy as unknown as Item;
}

/**
 * Разница двух версий обсуждения: поля булавки — как у объекта, сообщения — кусок между общим началом
 * и общим концом. Новый ответ в длинном обсуждении пишется в журнал одним сообщением, а не всем обсуждением.
 */
export function diffThreads(before: CommentThread, after: CommentThread): { b: Patch; a: Patch; m?: MessagesPatch } {
  const { messages: bm, ...bo } = before;
  const { messages: am, ...ao } = after;
  const { b, a } = diffItems(bo as unknown as Item, ao as unknown as Item);
  let start = 0;
  while (start < bm.length && start < am.length && same(bm[start], am[start])) start++;
  let tail = 0;
  while (tail < bm.length - start && tail < am.length - start && same(bm[bm.length - 1 - tail], am[am.length - 1 - tail])) tail++;
  const removed = bm.slice(start, bm.length - tail);
  const added = am.slice(start, am.length - tail);
  return removed.length || added.length ? { b, a, m: [start, removed, added] } : { b, a };
}

/** Собрать версию обсуждения из соседней: `forward` — из «было» в «стало», иначе обратно. */
function applyThreadPatch(t: CommentThread, fields: Patch, m: MessagesPatch | undefined, forward: boolean): CommentThread {
  const next = applyPatch(t as unknown as Item, fields) as unknown as CommentThread;
  if (!m) return next;
  const [start, removed, added] = m;
  const messages = t.messages.slice();
  if (forward) messages.splice(start, removed.length, ...added);
  else messages.splice(start, added.length, ...removed);
  return { ...next, messages };
}

export function encodeOps(ops: Op[]): CompactOp[] {
  return ops.map((op): CompactOp => {
    if (op.t === 'insert') return { i: op.index, n: op.item };
    if (op.t === 'delete') return { x: op.index, n: op.item };
    if (op.t === 'prop') return { k: op.key, b: op.before ?? null, a: op.after ?? null };
    if (op.t === 'thread') {
      if (!op.before) return { ti: op.index, t: op.after! };
      if (!op.after) return { tx: op.index, t: op.before };
      return { tp: op.index, id: op.after.id, ...diffThreads(op.before, op.after) };
    }
    return { p: op.index, id: op.after.id, ...diffItems(op.before, op.after) };
  });
}

export function parseLog(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as LogLine);
    } catch {
      // Недописанная последняя строка (выключили свет посреди записи) — просто пропускаем.
    }
  }
  return lines;
}

class Mismatch extends Error {}

function check(cond: boolean): void {
  if (!cond) throw new Mismatch();
}

/**
 * Восстанавливает стеки отмены и повтора по журналу.
 * Возвращает null, если журнал не сходится с доской (её меняли снаружи) — тогда историю начинают заново.
 */
export function rebuildHistory(
  items: readonly Item[],
  log: LogLine[],
  currentRev: number,
  comments: readonly CommentThread[] = [],
): { undo: Tx[]; redo: Tx[] } | null {
  let startAt = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if ('start' in log[i]) {
      startAt = i;
      break;
    }
  }
  if (startAt < 0) return null;

  // Цепочка версий должна идти без пропусков и закончиться на текущей версии доски.
  let rev = (log[startAt] as { start: number }).start;
  const undo: { label: string; o: CompactOp[] }[] = [];
  const redo: { label: string; o: CompactOp[] }[] = [];
  for (const line of log.slice(startAt + 1)) {
    if (!('r' in line) || line.r !== rev + 1) return null;
    rev = line.r;
    if ('d' in line) {
      undo.push({ label: line.d, o: line.o });
      redo.length = 0;
    } else if ('u' in line) {
      const tx = undo.pop();
      if (!tx) return null;
      redo.push(tx);
    } else {
      const tx = redo.pop();
      if (!tx) return null;
      undo.push(tx);
    }
  }
  if (rev !== currentRev) return null;

  try {
    // Отмена: идём от текущего состояния назад, от последней правки к первой.
    let scratch = items.slice();
    let threads = comments.slice();
    const undoFull: Tx[] = [];
    for (let t = undo.length - 1; t >= 0; t--) {
      const full: Op[] = [];
      const o = undo[t].o;
      for (let k = o.length - 1; k >= 0; k--) {
        const c = o[k];
        if ('ti' in c) {
          check(threads[c.ti]?.id === c.t.id);
          full.push({ t: 'thread', index: c.ti, before: null, after: threads[c.ti] });
          threads.splice(c.ti, 1);
        } else if ('tx' in c) {
          threads.splice(c.tx, 0, c.t);
          full.push({ t: 'thread', index: c.tx, before: c.t, after: null });
        } else if ('tp' in c) {
          const after = threads[c.tp];
          check(after?.id === c.id);
          const before = applyThreadPatch(after, c.b, c.m, false);
          threads[c.tp] = before;
          full.push({ t: 'thread', index: c.tp, before, after });
        } else if ('k' in c) {
          full.push({ t: 'prop', key: c.k, before: c.b ?? undefined, after: c.a ?? undefined });
        } else if ('i' in c) {
          check(scratch[c.i]?.id === c.n.id);
          full.push({ t: 'insert', index: c.i, item: scratch[c.i] });
          scratch.splice(c.i, 1);
        } else if ('x' in c) {
          scratch.splice(c.x, 0, c.n);
          full.push({ t: 'delete', index: c.x, item: c.n });
        } else {
          const after = scratch[c.p];
          check(after?.id === c.id);
          const before = applyPatch(after, c.b);
          scratch[c.p] = before;
          full.push({ t: 'replace', index: c.p, before, after });
        }
      }
      undoFull.unshift({ label: undo[t].label, ops: full.reverse() });
    }

    // Повтор: идём от текущего состояния вперёд, в том порядке, в каком будем повторять.
    scratch = items.slice();
    threads = comments.slice();
    const redoFull: Tx[] = [];
    for (let t = redo.length - 1; t >= 0; t--) {
      const full: Op[] = [];
      for (const c of redo[t].o) {
        if ('ti' in c) {
          threads.splice(c.ti, 0, c.t);
          full.push({ t: 'thread', index: c.ti, before: null, after: c.t });
        } else if ('tx' in c) {
          check(threads[c.tx]?.id === c.t.id);
          full.push({ t: 'thread', index: c.tx, before: threads[c.tx], after: null });
          threads.splice(c.tx, 1);
        } else if ('tp' in c) {
          const before = threads[c.tp];
          check(before?.id === c.id);
          const after = applyThreadPatch(before, c.a, c.m, true);
          threads[c.tp] = after;
          full.push({ t: 'thread', index: c.tp, before, after });
        } else if ('k' in c) {
          full.push({ t: 'prop', key: c.k, before: c.b ?? undefined, after: c.a ?? undefined });
        } else if ('i' in c) {
          scratch.splice(c.i, 0, c.n);
          full.push({ t: 'insert', index: c.i, item: c.n });
        } else if ('x' in c) {
          check(scratch[c.x]?.id === c.n.id);
          full.push({ t: 'delete', index: c.x, item: scratch[c.x] });
          scratch.splice(c.x, 1);
        } else {
          const before = scratch[c.p];
          check(before?.id === c.id);
          const after = applyPatch(before, c.a);
          scratch[c.p] = after;
          full.push({ t: 'replace', index: c.p, before, after });
        }
      }
      redoFull.unshift({ label: redo[t].label, ops: full });
    }
    return { undo: undoFull, redo: redoFull };
  } catch (err) {
    if (err instanceof Mismatch) return null;
    throw err;
  }
}
