// Генератор тестовых досок для замеров скорости. Детерминированный: одно зерно — одна и та же доска.
import type { BoardDoc, BoxItem, Item, ShapeKind } from '../model/types.ts';
import { FORMAT } from '../format/board.ts';
import { STICKY_PALETTE } from '../format/colors.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'фабрика укус запрет костюм пиццерия аниматроник ночь смена охранник камера вентиляция ' +
  'марионетка подарок торт плюш кошмар лимб пожар логбук чертёж подвал исчезновение ' +
  'теория факт улика цитата канон книга таймлайн версия опровержение источник проверка'
).split(' ');

const SHAPES: ShapeKind[] = ['rect', 'round', 'ellipse', 'diamond', 'triangle'];

/** `count` — число объектов-карточек; связи добавляются сверху примерно на треть от них. */
export function generateBoard(count: number, seed = 1): BoardDoc {
  const rnd = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
  const words = (min: number, max: number) =>
    Array.from({ length: min + Math.floor(rnd() * (max - min)) }, () => pick(WORDS)).join(' ');

  const perFrame = 48;
  const cols = 8;
  const cellW = 280;
  const cellH = 260;
  const frameW = cols * cellW + 80;
  const frameH = Math.ceil(perFrame / cols) * cellH + 80;
  const frameCount = Math.ceil(count / perFrame);
  const framesPerRow = Math.ceil(Math.sqrt(frameCount));

  const frames: Item[] = [];
  const boxes: BoxItem[] = [];
  for (let f = 0; f < frameCount; f++) {
    const fx = (f % framesPerRow) * (frameW + 400);
    const fy = Math.floor(f / framesPerRow) * (frameH + 400);
    frames.push({ id: `f${f}`, kind: 'frame', x: fx, y: fy, w: frameW, h: frameH, title: `Раздел ${f + 1}: ${words(1, 3)}` });
    for (let j = 0; j < perFrame && boxes.length < count; j++) {
      const x = fx + 40 + (j % cols) * cellW + rnd() * 30;
      const y = fy + 40 + Math.floor(j / cols) * cellH + rnd() * 30;
      const id = `n${boxes.length}`;
      const r = rnd();
      if (r < 0.4) boxes.push({ id, kind: 'sticky', x, y, w: 200, h: 200, color: pick(STICKY_PALETTE.slice(0, 14)), text: words(3, 14) });
      else if (r < 0.65) boxes.push({ id, kind: 'card', x, y, w: 240, h: 180, text: `# ${words(1, 3)}\n${words(8, 30)}` });
      else if (r < 0.8) boxes.push({ id, kind: 'shape', shape: pick(SHAPES), x, y, w: 200, h: 140, text: words(1, 4) });
      else if (r < 0.92) boxes.push({ id, kind: 'doc', x, y, w: 240, h: 200, file: `Замер/${words(2, 4)}.md` });
      else boxes.push({ id, kind: 'text', x, y, w: 220, h: 80, text: words(2, 8) });
    }
  }

  const lines: Item[] = [];
  for (let i = 0; i < boxes.length; i += 3) {
    const j = Math.min(boxes.length - 1, i + (rnd() < 0.5 ? 1 : cols));
    if (i === j) continue;
    lines.push({
      id: `l${i}`,
      kind: 'line',
      from: { item: boxes[i].id },
      to: { item: boxes[j].id },
      path: pick(['curve', 'straight', 'elbow'] as const),
      end: 'arrow',
    });
  }

  return { format: FORMAT, meta: { generated: { count, seed } }, items: [...frames, ...boxes, ...lines], comments: [] };
}
