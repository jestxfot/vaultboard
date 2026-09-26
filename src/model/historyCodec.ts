// Журнал истории на диске: компактная запись правок и восстановление полной истории отмены.
//
// Журнал только дописывается — строки «сделано / отменено / повторено». При замене объекта
// пишутся лишь изменившиеся поля (было/стало), целиком объект пишется только при создании и удалении.
// Полные «до» и «после» восстанавливаются при загрузке: идём от текущего состояния доски назад по журналу.
import type { Item } from './types.ts';
import type { Op, Tx } from './store.ts';

/** Изменившиеся поля объекта. `null` — поля нет. */
type Patch = Record<string, unknown>;

export type CompactOp =
  | { i: number; n: Item }                       // вставка
  | { x: number; n: Item }                       // удаление
  | { p: number; id: string; b: Patch; a: Patch }; // замена

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

export function encodeOps(ops: Op[]): CompactOp[] {
  return ops.map((op) => {
    if (op.t === 'insert') return { i: op.index, n: op.item };
    if (op.t === 'delete') return { x: op.index, n: op.item };
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
export function rebuildHistory(items: readonly Item[], log: LogLine[], currentRev: number): { undo: Tx[]; redo: Tx[] } | null {
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
    const undoFull: Tx[] = [];
    for (let t = undo.length - 1; t >= 0; t--) {
      const full: Op[] = [];
      const o = undo[t].o;
      for (let k = o.length - 1; k >= 0; k--) {
        const c = o[k];
        if ('i' in c) {
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
    const redoFull: Tx[] = [];
    for (let t = redo.length - 1; t >= 0; t--) {
      const full: Op[] = [];
      for (const c of redo[t].o) {
        if ('i' in c) {
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
