// Умное рисование: нарисованное от руки превращается в настоящую фигуру или линию доски.
// Без нейросетей — простая геометрия: замкнут ли штрих, сколько у него углов, насколько он похож на эллипс.
import type { Point } from '../render/geometry.ts';

export type Recognized =
  | { kind: 'shape'; shape: 'rect' | 'ellipse' | 'triangle' | 'diamond'; x: number; y: number; w: number; h: number }
  | { kind: 'line'; a: Point; b: Point }
  | null;

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Упрощение ломаной (алгоритм Рамера — Дугласа — Пекера): остаются только «углы». */
export function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.slice();
  let maxDist = 0, index = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i], a, b);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon) return [a, b];
  const left = simplify(points.slice(0, index + 1), epsilon);
  const right = simplify(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** Углы замкнутого контура: режем его в самой дальней от начала точке и упрощаем обе половины. */
function closedCorners(points: Point[], epsilon: number): Point[] {
  const start = points[0];
  let far = 0, farDist = 0;
  points.forEach((p, i) => {
    const d = Math.hypot(p.x - start.x, p.y - start.y);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  });
  const a = simplify(points.slice(0, far + 1), epsilon);
  const b = simplify([...points.slice(far), start], epsilon);
  const corners = [...a.slice(0, -1), ...b.slice(0, -1)];
  // Соседние почти совпадающие углы (дрожание руки в углу) склеиваем.
  return corners.filter((p, i) => {
    const q = corners[(i + 1) % corners.length];
    return Math.hypot(p.x - q.x, p.y - q.y) > epsilon;
  });
}

/**
 * `minSize` — меньше этого (в точках доски) штрих считается каракулей, а не фигурой.
 */
export function recognize(points: Point[], minSize: number): Recognized {
  if (points.length < 4) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0, h = y1 - y0;
  const diag = Math.hypot(w, h);
  if (diag < minSize) return null;
  const first = points[0], last = points[points.length - 1];
  const closed = Math.hypot(last.x - first.x, last.y - first.y) < diag * 0.22;

  if (!closed) {
    // Прямая: все точки лежат близко к отрезку «начало — конец».
    const len = Math.hypot(last.x - first.x, last.y - first.y);
    const worst = Math.max(...points.map((p) => distToSegment(p, first, last)));
    return worst < Math.max(len * 0.07, 3) ? { kind: 'line', a: first, b: last } : null;
  }

  // Насколько контур похож на эллипс, вписанный в его рамку: 0 — идеально.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.max(w / 2, 1), ry = Math.max(h / 2, 1);
  const ellipseError = points.reduce((sum, p) => sum + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) / points.length;

  const corners = closedCorners(points, diag * 0.08);
  const box = { x: x0, y: y0, w, h };
  if (corners.length === 3) return { kind: 'shape', shape: 'triangle', ...box };
  if (corners.length === 4) {
    // Ромб — углы у середин сторон рамки; прямоугольник — у её углов.
    const nearMid = corners.filter((p) => Math.abs(p.x - cx) < w * 0.2 || Math.abs(p.y - cy) < h * 0.2).length;
    return { kind: 'shape', shape: nearMid >= 3 ? 'diamond' : 'rect', ...box };
  }
  if (ellipseError < 0.14) return { kind: 'shape', shape: 'ellipse', ...box };
  return null;
}
