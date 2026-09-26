// Геометрия линий: к какой точке объекта цепляться и как вести путь. Чистая математика, без Pixi.
import type { Endpoint, PathKind, Side } from '../model/types.ts';

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** Точка крепления и направление, в котором линия выходит из объекта (0,0 — конец висит в воздухе). */
export interface Anchor extends Point { nx: number; ny: number }

export type LineGeom =
  | { kind: 'bezier'; a: Anchor; c1: Point; c2: Point; b: Anchor }
  | { kind: 'poly'; points: Point[] };

const NORMALS: Record<Side, [number, number]> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

export function sideAnchor(r: Rect, side: Side): Anchor {
  const [nx, ny] = NORMALS[side];
  return { x: r.x + r.w / 2 + (nx * r.w) / 2, y: r.y + r.h / 2 + (ny * r.h) / 2, nx, ny };
}

/** Сторона объекта, которая смотрит на точку. */
export function facingSide(r: Rect, tx: number, ty: number): Side {
  const dx = (tx - (r.x + r.w / 2)) / (r.w || 1);
  const dy = (ty - (r.y + r.h / 2)) / (r.h || 1);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

export type RectLookup = (id: string) => Rect | undefined;

/** Центр объекта или сама точка — куда «смотрит» другой конец линии. */
export function endpointCenter(ep: Endpoint, rectOf: RectLookup): Point | null {
  if ('item' in ep) {
    const r = rectOf(ep.item);
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
  }
  return { x: ep.x, y: ep.y };
}

export function resolveAnchor(ep: Endpoint, toward: Point, rectOf: RectLookup): Anchor | null {
  if ('item' in ep) {
    const r = rectOf(ep.item);
    if (!r) return null;
    return sideAnchor(r, ep.side ?? facingSide(r, toward.x, toward.y));
  }
  return { x: ep.x, y: ep.y, nx: 0, ny: 0 };
}

function unit(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y) || 1;
  return [x / len, y / len];
}

function elbowPoints(a: Anchor, b: Anchor): Point[] {
  const stub = 24;
  const s = { x: a.x + a.nx * stub, y: a.y + a.ny * stub };
  const e = { x: b.x + b.nx * stub, y: b.y + b.ny * stub };
  const horizontal = a.nx !== 0 || (a.ny === 0 && Math.abs(b.x - a.x) >= Math.abs(b.y - a.y));
  const mid = horizontal
    ? [{ x: (s.x + e.x) / 2, y: s.y }, { x: (s.x + e.x) / 2, y: e.y }]
    : [{ x: s.x, y: (s.y + e.y) / 2 }, { x: e.x, y: (s.y + e.y) / 2 }];
  const pts = [a, s, ...mid, e, b];
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
}

export function lineGeometry(a: Anchor, b: Anchor, path: PathKind): LineGeom {
  if (path === 'straight') return { kind: 'poly', points: [a, b] };
  if (path === 'elbow') return { kind: 'poly', points: elbowPoints(a, b) };
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const d = Math.min(Math.max(dist * 0.4, 40), 250);
  const [anx, any] = a.nx || a.ny ? [a.nx, a.ny] : unit(b.x - a.x, b.y - a.y);
  const [bnx, bny] = b.nx || b.ny ? [b.nx, b.ny] : unit(a.x - b.x, a.y - b.y);
  return { kind: 'bezier', a, c1: { x: a.x + anx * d, y: a.y + any * d }, c2: { x: b.x + bnx * d, y: b.y + bny * d }, b };
}

/** Кончик линии и направление «наружу» — для наконечника. */
export function lineTip(g: LineGeom, atEnd: boolean): { tip: Point; dir: [number, number] } {
  if (g.kind === 'bezier') {
    const tip = atEnd ? g.b : g.a;
    const from = atEnd ? g.c2 : g.c1;
    return { tip, dir: unit(tip.x - from.x, tip.y - from.y) };
  }
  const p = g.points;
  const tip = atEnd ? p[p.length - 1] : p[0];
  const from = atEnd ? p[p.length - 2] : p[1];
  return { tip, dir: unit(tip.x - from.x, tip.y - from.y) };
}

/** Линия как ломаная: кривую Безье приближаем отрезками — для пунктира и попадания мышью этого хватает. */
export function samplePath(g: LineGeom, steps = 24): Point[] {
  if (g.kind === 'poly') return g.points;
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    pts.push({
      x: u * u * u * g.a.x + 3 * u * u * t * g.c1.x + 3 * u * t * t * g.c2.x + t * t * t * g.b.x,
      y: u * u * u * g.a.y + 3 * u * u * t * g.c1.y + 3 * u * t * t * g.c2.y + t * t * t * g.b.y,
    });
  }
  return pts;
}

/** Середина линии по длине пути — сюда ставится подпись. */
export function lineMidpoint(g: LineGeom): Point {
  if (g.kind === 'bezier') {
    const t = 0.5, u = 0.5;
    return {
      x: u * u * u * g.a.x + 3 * u * u * t * g.c1.x + 3 * u * t * t * g.c2.x + t * t * t * g.b.x,
      y: u * u * u * g.a.y + 3 * u * u * t * g.c1.y + 3 * u * t * t * g.c2.y + t * t * t * g.b.y,
    };
  }
  const p = g.points;
  let total = 0;
  for (let i = 1; i < p.length; i++) total += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < p.length; i++) {
    const seg = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    if (seg >= left && seg > 0) {
      const k = left / seg;
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * k, y: p[i - 1].y + (p[i].y - p[i - 1].y) * k };
    }
    left -= seg;
  }
  return p[0];
}

/** Прямоугольник, в который гарантированно помещается линия (для пространственного индекса). */
export function geomBounds(g: LineGeom, pad: number): Rect {
  const pts = g.kind === 'bezier' ? [g.a, g.c1, g.c2, g.b] : g.points;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}
