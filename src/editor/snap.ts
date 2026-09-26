// Привязка при перетаскивании и изменении размера: к краям и центрам соседних объектов,
// а если соседей рядом нет — к сетке. Как в Miro: объекты легко ставить ровно рядом и в линию.
import type { Rect } from '../render/geometry.ts';

export type XEdge = 'l' | 'c' | 'r';
export type YEdge = 't' | 'm' | 'b';

export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

const xOf = (r: Rect, e: XEdge) => (e === 'l' ? r.x : e === 'c' ? r.x + r.w / 2 : r.x + r.w);
const yOf = (r: Rect, e: YEdge) => (e === 't' ? r.y : e === 'm' ? r.y + r.h / 2 : r.y + r.h);

/**
 * Насколько сдвинуть прямоугольник `r`, чтобы его края `xs`/`ys` совпали с краями соседей
 * (если ближе `tol`), иначе — с сеткой шага `grid`. Возвращает и направляющие для показа.
 */
export function snapRect(r: Rect, others: Rect[], tol: number, grid: number, xs: XEdge[], ys: YEdge[]): SnapResult {
  let bestX: { d: number; value: number; edge: XEdge } | null = null;
  let bestY: { d: number; value: number; edge: YEdge } | null = null;
  for (const o of others) {
    for (const e of xs) {
      for (const oe of ['l', 'c', 'r'] as XEdge[]) {
        const d = xOf(o, oe) - xOf(r, e);
        if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, value: xOf(o, oe), edge: e };
      }
    }
    for (const e of ys) {
      for (const oe of ['t', 'm', 'b'] as YEdge[]) {
        const d = yOf(o, oe) - yOf(r, e);
        if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, value: yOf(o, oe), edge: e };
      }
    }
  }

  // Соседей рядом нет — к сетке (по первому из двигаемых краёв).
  const gx = xs.length ? xOf(r, xs[0]) : 0, gy = ys.length ? yOf(r, ys[0]) : 0;
  const dx = bestX ? bestX.d : xs.length && grid ? Math.round(gx / grid) * grid - gx : 0;
  const dy = bestY ? bestY.d : ys.length && grid ? Math.round(gy / grid) * grid - gy : 0;

  // Направляющие: вертикальная — через всех соседей на этой линии, горизонтальная — так же.
  const moved = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  const guides: Guide[] = [];
  if (bestX) {
    const x = bestX.value;
    let y1 = moved.y, y2 = moved.y + moved.h;
    for (const o of others) {
      if ((['l', 'c', 'r'] as XEdge[]).some((e) => Math.abs(xOf(o, e) - x) < 0.5)) {
        y1 = Math.min(y1, o.y);
        y2 = Math.max(y2, o.y + o.h);
      }
    }
    guides.push({ x1: x, y1, x2: x, y2 });
  }
  if (bestY) {
    const y = bestY.value;
    let x1 = moved.x, x2 = moved.x + moved.w;
    for (const o of others) {
      if ((['t', 'm', 'b'] as YEdge[]).some((e) => Math.abs(yOf(o, e) - y) < 0.5)) {
        x1 = Math.min(x1, o.x);
        x2 = Math.max(x2, o.x + o.w);
      }
    }
    guides.push({ x1, y1: y, x2, y2: y });
  }
  return { dx, dy, guides };
}
