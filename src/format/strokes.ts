// Компактная запись точек штриха в файле доски.
//
// Точка — это x, y и нажим. Координаты хранятся целыми числами в десятых долях точки доски,
// нажим — целым от 0 до 100. Первая точка пишется как есть, каждая следующая — разностью
// с предыдущей: у соседних точек штриха разности маленькие, и файл получается в разы короче.

export interface StrokePoint {
  x: number;
  y: number;
  /** Нажим пера, 0…1. */
  p: number;
}

export function encodePoints(points: StrokePoint[]): number[] {
  const out: number[] = [];
  let px = 0, py = 0, pp = 0;
  for (const pt of points) {
    const x = Math.round(pt.x * 10), y = Math.round(pt.y * 10), p = Math.round(pt.p * 100);
    out.push(x - px, y - py, p - pp);
    px = x;
    py = y;
    pp = p;
  }
  return out;
}

export function decodePoints(data: number[]): StrokePoint[] {
  const out: StrokePoint[] = [];
  let x = 0, y = 0, p = 0;
  for (let i = 0; i + 2 < data.length; i += 3) {
    x += data[i];
    y += data[i + 1];
    p += data[i + 2];
    out.push({ x: x / 10, y: y / 10, p: p / 100 });
  }
  return out;
}

/** Сдвинуть все точки штриха (нужно, когда рисунок расширяется влево или вверх). */
export function shiftPoints(data: number[], dx: number, dy: number): number[] {
  if (data.length < 3) return data;
  const out = data.slice();
  // Сдвиг меняет только первую точку: остальные записаны разностями.
  out[0] += Math.round(dx * 10);
  out[1] += Math.round(dy * 10);
  return out;
}
