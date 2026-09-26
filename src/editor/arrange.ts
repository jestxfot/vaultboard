// Выравнивание и распределение, как в Miro: на входе — рамки «единиц» (объект или целая группа),
// на выходе — на сколько сдвинуть каждую. Сами объекты здесь не трогаются, поэтому это легко проверить тестом.
import type { Rect } from '../render/geometry.ts';

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type Shift = { dx: number; dy: number };

/** Выровнять по краю или центру общей рамки всех единиц. */
export function alignShifts(units: readonly Rect[], kind: AlignKind): Shift[] {
  if (units.length < 2) return units.map(() => ({ dx: 0, dy: 0 }));
  const x0 = Math.min(...units.map((r) => r.x)), x1 = Math.max(...units.map((r) => r.x + r.w));
  const y0 = Math.min(...units.map((r) => r.y)), y1 = Math.max(...units.map((r) => r.y + r.h));
  return units.map((r) => {
    switch (kind) {
      case 'left': return { dx: x0 - r.x, dy: 0 };
      case 'right': return { dx: x1 - (r.x + r.w), dy: 0 };
      case 'hcenter': return { dx: (x0 + x1) / 2 - (r.x + r.w / 2), dy: 0 };
      case 'top': return { dx: 0, dy: y0 - r.y };
      case 'bottom': return { dx: 0, dy: y1 - (r.y + r.h) };
      case 'vcenter': return { dx: 0, dy: (y0 + y1) / 2 - (r.y + r.h / 2) };
    }
  });
}

/**
 * Распределить равномерно: крайние единицы стоят на месте, между соседями — одинаковые промежутки.
 * Порядок — по положению центров, так что после распределения никто не перепрыгивает соседа.
 * Если единицы шире общего места, промежутки выйдут отрицательными — это честное «внахлёст поровну».
 */
export function distributeShifts(units: readonly Rect[], axis: 'x' | 'y'): Shift[] {
  const out = units.map(() => ({ dx: 0, dy: 0 }));
  if (units.length < 3) return out;
  const pos = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.w : r.h);
  const order = units.map((r, i) => ({ r, i })).sort((a, b) => pos(a.r) + size(a.r) / 2 - (pos(b.r) + size(b.r) / 2));
  const first = order[0].r, last = order[order.length - 1].r;
  const span = pos(last) + size(last) - pos(first);
  const total = order.reduce((s, o) => s + size(o.r), 0);
  const gap = (span - total) / (order.length - 1);
  let at = pos(first);
  for (const { r, i } of order) {
    const d = at - pos(r);
    out[i] = axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    at += size(r) + gap;
  }
  return out;
}

/**
 * Разложить в ряд с одинаковым шагом, сохранив порядок: удобно, когда годы на таймлайне стоят кое-как.
 * Промежуток — средний из нынешних (но не меньше `minGap`), выравнивание — по верхнему краю (или левому для столбца).
 */
export function tidyShifts(units: readonly Rect[], axis: 'x' | 'y', minGap = 20): Shift[] {
  const out = units.map(() => ({ dx: 0, dy: 0 }));
  if (units.length < 2) return out;
  const pos = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.w : r.h);
  const cross = (r: Rect) => (axis === 'x' ? r.y : r.x);
  const order = units.map((r, i) => ({ r, i })).sort((a, b) => pos(a.r) - pos(b.r));
  let gaps = 0;
  for (let k = 1; k < order.length; k++) gaps += pos(order[k].r) - (pos(order[k - 1].r) + size(order[k - 1].r));
  const gap = Math.max(minGap, gaps / (order.length - 1));
  const line = Math.min(...units.map(cross));
  let at = pos(order[0].r);
  for (const { r, i } of order) {
    const d = at - pos(r), c = line - cross(r);
    out[i] = axis === 'x' ? { dx: d, dy: c } : { dx: c, dy: d };
    at += size(r) + gap;
  }
  return out;
}
