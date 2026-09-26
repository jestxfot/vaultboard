// Перо: своё рисование штриха, без внешних библиотек.
//
// Раньше штрих был одним залитым контуром. На резком развороте руки такой контур перекручивается,
// и заливка даёт чёрные клинья и шипы. Теперь штрих — цепочка «капсул»: круг в каждой точке
// и касательная полоса между соседними кругами. Каждая капсула заливается отдельно, перекрутиться нечему,
// а разная толщина соседних кругов даёт плавный нажим.
//
// Порядок: убрать дребезг (слишком близкие точки) → сгладить путь срезанием углов (Chaikin) →
// толщина из нажима пера, а у мыши — из скорости (редкие точки = быстрая рука = тоньше) →
// капсулы.
import type { Graphics } from 'pixi.js';

export interface InkPoint {
  x: number;
  y: number;
  /** Нажим 0…1. У мыши нажима нет — везде 0.5. */
  p: number;
}

interface Disc {
  x: number;
  y: number;
  r: number;
}

/** Мышь не знает нажима — все точки с нажимом 0.5. */
function noPressure(points: InkPoint[]): boolean {
  return points.every((q) => Math.abs(q.p - 0.5) < 0.01);
}

/** Срезание углов: каждая пара соседних точек даёт две точки на 1/4 и 3/4 отрезка. Концы остаются на месте. */
function chaikin(pts: InkPoint[]): InkPoint[] {
  if (pts.length < 3) return pts;
  const out: InkPoint[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push(
      { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, p: a.p * 0.75 + b.p * 0.25 },
      { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, p: a.p * 0.25 + b.p * 0.75 },
    );
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Точки ближе `min` друг к другу — дребезг руки и лишняя работа; оставляем по одной. */
function thin(pts: InkPoint[], min: number): InkPoint[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) >= min) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Мышь: нажим из скорости. События мыши приходят через равное время, поэтому расстояние между
 * соседними точками — это и есть скорость. Быстрее — тоньше, как у настоящей ручки; сглажено,
 * чтобы толщина не скакала от точки к точке.
 */
function speedPressure(pts: InkPoint[], size: number): InkPoint[] {
  const out: InkPoint[] = [];
  let p = 0.6;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const d = Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y);
    const target = Math.max(0.25, Math.min(0.85, 0.85 - (d / Math.max(size, 1)) * 0.12));
    p += (target - p) * 0.3;
    out.push({ ...pts[i], p });
  }
  return out;
}

/** Круги штриха: сглаженный путь и радиус в каждой точке. */
export function inkDiscs(points: InkPoint[], size: number): Disc[] {
  if (!points.length) return [];
  let pts = thin(points, Math.max(0.3, size * 0.08));
  if (noPressure(pts)) pts = speedPressure(pts, size);
  pts = chaikin(chaikin(pts));
  // Нажим меняет толщину от 40% до 100%: совсем тонких «ниточек» и клиньев не бывает.
  const discs = pts.map((q) => ({ x: q.x, y: q.y, r: (size / 2) * (0.4 + 0.6 * Math.max(0, Math.min(1, q.p))) }));
  // После сглаживания точек стало вчетверо больше — снова прореживаем, но гуще, чем толщина штриха.
  const out = [discs[0]];
  for (let i = 1; i < discs.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(discs[i].x - last.x, discs[i].y - last.y) >= Math.max(0.35, Math.min(last.r, discs[i].r) * 0.45)) out.push(discs[i]);
  }
  if (discs.length > 1) out.push(discs[discs.length - 1]);
  return out;
}

/**
 * Полоса между двумя кругами по внешним касательным (как ремень на двух шкивах).
 * Если один круг внутри другого — полоса не нужна.
 */
function bridge(a: Disc, b: Disc): number[] | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(a.r - b.r) + 1e-6) return null;
  const base = Math.atan2(dy, dx);
  const off = Math.acos((a.r - b.r) / d);
  const p = (c: Disc, ang: number) => [c.x + Math.cos(ang) * c.r, c.y + Math.sin(ang) * c.r];
  return [...p(a, base + off), ...p(b, base + off), ...p(b, base - off), ...p(a, base - off)];
}

/** Нарисовать штрих пера. Все части заливаются одним вызовом, каждая треугольниками отдельно — перекручиваться нечему. */
export function drawInk(g: Graphics, points: InkPoint[], size: number, color: number): void {
  const discs = inkDiscs(points, size);
  if (!discs.length) return;
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i];
    g.circle(d.x, d.y, d.r);
    if (i > 0) {
      const quad = bridge(discs[i - 1], d);
      if (quad) g.poly(quad);
    }
  }
  g.fill(color);
}

/** Путь маркера — тоже сглаженный: без него дрожание руки видно на широком полупрозрачном штрихе. */
export function smoothPath(points: InkPoint[]): InkPoint[] {
  return chaikin(chaikin(thin(points, 0.8)));
}
