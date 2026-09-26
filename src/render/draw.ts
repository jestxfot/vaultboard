// Как выглядит каждый вид объекта. Рисует в Pixi Graphics в координатах объекта (0,0 — его левый верхний угол).
import { CanvasTextMetrics, Graphics, Text, TextStyle } from 'pixi.js';
import getStroke from 'perfect-freehand';
import type { BoxItem, DrawingItem, EndCap, LineItem, ShapeKind, Stroke } from '../model/types.ts';
import { decodePoints, type StrokePoint } from '../format/strokes.ts';
import { DEFAULT_STICKY, hexToNum, isDark, tint } from '../format/colors.ts';
import { type LineGeom, lineTip, samplePath } from './geometry.ts';

export const FONT = '"Segoe UI", "Noto Sans", system-ui, sans-serif';
const INK = 0x1f1f1f;
const BORDER = 0xd4d4d4;
const LINE = 0x5b5b5b;

function shapePath(g: Graphics, shape: ShapeKind, w: number, h: number): Graphics {
  switch (shape) {
    case 'ellipse': return g.ellipse(w / 2, h / 2, w / 2, h / 2);
    case 'round': return g.roundRect(0, 0, w, h, Math.min(w, h) * 0.2);
    case 'diamond': return g.poly([w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]);
    case 'triangle': return g.poly([w / 2, 0, w, h, 0, h]);
    case 'parallelogram': return g.poly([w * 0.2, 0, w, 0, w * 0.8, h, 0, h]);
    case 'hexagon': return g.poly([w * 0.25, 0, w * 0.75, 0, w, h / 2, w * 0.75, h, w * 0.25, h, 0, h / 2]);
    case 'star': {
      const pts: number[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.4 : 1;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push(w / 2 + (Math.cos(a) * r * w) / 2, h / 2 + (Math.sin(a) * r * h) / 2);
      }
      return g.poly(pts);
    }
    case 'cylinder': return g.roundRect(0, 0, w, h, Math.min(w / 2, h * 0.15));
    case 'document': return g.poly([0, 0, w, 0, w, h * 0.85, w * 0.5, h * 0.95, 0, h]);
    default: return g.rect(0, 0, w, h);
  }
}

export function drawBox(g: Graphics, item: BoxItem): void {
  const { w, h } = item;
  switch (item.kind) {
    case 'frame':
      g.rect(0, 0, w, h).fill(item.color ? tint(item.color, 0.92) : 0xffffff).stroke({ width: 1, color: BORDER });
      break;
    case 'sticky':
      // Лёгкая «тень» под стикером, как в Miro, без размытия: размытие дорого на тысячах объектов.
      g.rect(2, 4, w, h).fill({ color: 0x000000, alpha: 0.08 });
      g.rect(0, 0, w, h).fill(hexToNum(item.color ?? DEFAULT_STICKY));
      break;
    case 'text':
      break;
    case 'shape':
      shapePath(g, item.shape, w, h).fill(item.color ? hexToNum(item.color) : 0xffffff).stroke({ width: 2, color: INK });
      break;
    case 'doc':
    case 'file':
      g.roundRect(0, 0, w, h, 8).fill(0xffffff).stroke({ width: 2, color: item.color ? hexToNum(item.color) : BORDER });
      g.roundRect(1, 1, w - 2, 34, 7).fill(0xf1f1ef);
      break;
    case 'image':
      g.rect(0, 0, w, h).fill(0xe9e9e6).stroke({ width: 1, color: BORDER });
      break;
    case 'drawing':
      drawStrokes(g, item);
      break;
    case 'card':
    case 'link':
      g.roundRect(0, 0, w, h, 8)
        .fill(item.color ? tint(item.color, 0.9) : 0xffffff)
        .stroke({ width: 2, color: item.color ? hexToNum(item.color) : BORDER });
      break;
  }
}

/**
 * Цвет объекта издалека. Вдали объект — просто цветной прямоугольник:
 * скругления, рамки и текст всё равно не различить, а рисовать его в разы дешевле.
 */
export function farColor(item: BoxItem): number {
  switch (item.kind) {
    case 'sticky': return hexToNum(item.color ?? DEFAULT_STICKY);
    case 'frame': return item.color ? tint(item.color, 0.92) : 0xffffff;
    case 'shape': return item.color ? hexToNum(item.color) : 0xe4e4e0;
    case 'text': return 0xd6d6d2;
    case 'image': return 0xd9d9d5;
    case 'drawing': return item.strokes[0] ? tint(item.strokes[0].color, 0.6) : 0xd6d6d2;
    default: return item.color ? tint(item.color, 0.55) : 0xe4e4e0;
  }
}

function drawCap(g: Graphics, geom: LineGeom, atEnd: boolean, cap: EndCap, width: number, color: number): void {
  if (cap === 'none') return;
  const { tip, dir } = lineTip(geom, atEnd);
  const size = 8 + width * 2.5;
  const [dx, dy] = dir;
  const bx = tip.x - dx * size, by = tip.y - dy * size;
  const px = -dy * size * 0.5, py = dx * size * 0.5;
  if (cap === 'arrow') g.poly([tip.x, tip.y, bx + px, by + py, bx - px, by - py]).fill(color);
  else if (cap === 'dot') g.circle(tip.x - dx * size * 0.35, tip.y - dy * size * 0.35, size * 0.35).fill(color);
  else g.poly([tip.x, tip.y, tip.x - dx * size * 0.5 + px, tip.y - dy * size * 0.5 + py, bx, by, tip.x - dx * size * 0.5 - px, tip.y - dy * size * 0.5 - py]).fill(color);
}

/** Пунктир или точки: путь режется на отрезки по длине. В WebGL нет готового пунктира, поэтому так. */
function dashPath(g: Graphics, geom: LineGeom, dash: number, gap: number): void {
  const pts = samplePath(geom, 64);
  let draw = true, left = dash;
  let x = pts[0].x, y = pts[0].y;
  g.moveTo(x, y);
  for (let i = 1; i < pts.length; i++) {
    const tx = pts[i].x, ty = pts[i].y;
    let seg = Math.hypot(tx - x, ty - y);
    while (seg > 0) {
      const step = Math.min(seg, left);
      const k = step / seg;
      x += (tx - x) * k;
      y += (ty - y) * k;
      if (draw) g.lineTo(x, y);
      else g.moveTo(x, y);
      seg -= step;
      left -= step;
      if (left <= 1e-6) {
        draw = !draw;
        left = draw ? dash : gap;
      }
    }
  }
}

/** Линия рисуется в координатах доски (у контейнера линии нет своего смещения). */
export function drawLine(g: Graphics, item: LineItem, geom: LineGeom): void {
  const color = item.color ? hexToNum(item.color) : LINE;
  const width = item.width ?? 2;
  const dash = item.dash ?? 'solid';
  if (dash === 'dashed') {
    dashPath(g, geom, width * 4 + 4, width * 2.5 + 3);
  } else if (dash === 'dotted') {
    // Точка — очень короткий отрезок с круглыми концами.
    dashPath(g, geom, 0.01, width * 2.5 + 2);
  } else if (geom.kind === 'bezier') {
    g.moveTo(geom.a.x, geom.a.y).bezierCurveTo(geom.c1.x, geom.c1.y, geom.c2.x, geom.c2.y, geom.b.x, geom.b.y);
  } else {
    g.moveTo(geom.points[0].x, geom.points[0].y);
    for (let i = 1; i < geom.points.length; i++) g.lineTo(geom.points[i].x, geom.points[i].y);
  }
  g.stroke({ width, color, cap: dash === 'dashed' ? 'butt' : 'round', join: 'round' });
  drawCap(g, geom, false, item.start ?? 'none', width, color);
  drawCap(g, geom, true, item.end ?? 'arrow', width, color);
}

/** Что и как писать внутри объекта. */
export interface LabelSpec {
  text: string;
  fontSize: number;
  bold: boolean;
  align: 'left' | 'center';
  vcenter: boolean;
  pad: number;
  /** Сверху отведено место под заголовок (у карточек-документов). */
  top: number;
  color: number;
  /** Подбирать размер шрифта, чтобы текст влез (стикеры и фигуры, как в Miro). */
  fit: boolean;
}

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** Черновое упрощение markdown до плоского текста. Настоящий рендер markdown — на этапе документов. */
function plainMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__|==|~~/g, '')
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

export function labelSpec(item: BoxItem): LabelSpec | null {
  const base = { bold: false, align: 'left' as const, vcenter: false, pad: 14, top: 0, color: INK, fit: false };
  switch (item.kind) {
    case 'sticky': {
      const dark = isDark(item.color ?? DEFAULT_STICKY);
      return item.text ? { ...base, text: plainMarkdown(item.text), fontSize: 32, align: 'center', vcenter: true, pad: 16, color: dark ? 0xffffff : INK, fit: true } : null;
    }
    case 'card':
      return item.text ? { ...base, text: plainMarkdown(item.text), fontSize: 16 } : null;
    case 'text':
      return item.text ? { ...base, text: plainMarkdown(item.text), fontSize: item.fontSize ?? 18, pad: 2 } : null;
    case 'shape':
      return item.text ? { ...base, text: item.text, fontSize: 24, align: 'center', vcenter: true, pad: 12, fit: true } : null;
    case 'doc':
      return { ...base, text: basename(item.file).replace(/\.md$/i, ''), fontSize: 15, bold: true, pad: 12 };
    case 'file':
      return { ...base, text: basename(item.file), fontSize: 15, bold: true, pad: 12 };
    case 'image':
      return { ...base, text: `🖼 ${basename(item.file)}`, fontSize: 15, align: 'center', vcenter: true };
    case 'link':
      return { ...base, text: item.url, fontSize: 15, color: 0x2f5bd3 };
    case 'frame':
    case 'drawing':
      return null;
  }
}

const FIT_SIZES = [48, 40, 32, 28, 24, 20, 18, 16, 14, 12, 10, 8];

export function labelStyle(spec: LabelSpec, w: number, fontSize: number): TextStyle {
  return new TextStyle({
    fontFamily: FONT,
    fontSize,
    fontWeight: spec.bold ? '600' : '400',
    fill: spec.color,
    align: spec.align,
    wordWrap: true,
    breakWords: true,
    wordWrapWidth: Math.max(10, w - spec.pad * 2),
    lineHeight: lineHeightOf(fontSize),
  });
}

export function lineHeightOf(fontSize: number): number {
  return Math.round(fontSize * 1.35);
}

/** Самый крупный шрифт, при котором текст целиком влезает в объект. */
export function fitFontSize(spec: LabelSpec, w: number, h: number): number {
  if (!spec.fit) return spec.fontSize;
  for (const size of FIT_SIZES) {
    if (size > spec.fontSize) continue;
    const m = CanvasTextMetrics.measureText(spec.text || ' ', labelStyle(spec, w, size));
    if (m.lines.length * m.lineHeight <= h - spec.pad * 2 - spec.top) return size;
  }
  return FIT_SIZES[FIT_SIZES.length - 1];
}

/** Высота блока текста при заданной ширине — для текста, который растёт вниз по мере набора. */
export function textBlockHeight(text: string, w: number, fontSize: number, pad: number): number {
  const style = new TextStyle({ fontFamily: FONT, fontSize, wordWrap: true, breakWords: true, wordWrapWidth: Math.max(10, w - pad * 2), lineHeight: lineHeightOf(fontSize) });
  const m = CanvasTextMetrics.measureText(text || ' ', style);
  return Math.max(1, m.lines.length) * m.lineHeight + pad * 2;
}

/** Строит текст, обрезанный по высоте объекта, чтобы не вылезал за край. */
export function makeLabel(spec: LabelSpec, w: number, h: number, resolution: number): Text {
  const style = labelStyle(spec, w, fitFontSize(spec, w, h));
  const metrics = CanvasTextMetrics.measureText(spec.text, style);
  const maxLines = Math.max(1, Math.floor((h - spec.pad * 2 - spec.top) / metrics.lineHeight));
  let text = spec.text;
  if (metrics.lines.length > maxLines) {
    const kept = metrics.lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s*\S{0,3}$/, '')}…`;
    text = kept.join('\n');
  }
  const label = new Text({ text, style, resolution });
  if (spec.align === 'center') {
    label.anchor.set(0.5, 0);
    label.x = w / 2;
  } else {
    label.x = spec.pad;
  }
  label.y = spec.vcenter ? Math.max(spec.pad, (h - label.height) / 2) : spec.pad + spec.top;
  return label;
}

/** Мышь не знает нажима — тогда толщину подсказывает скорость руки, как у perfect-freehand по умолчанию. */
function noPressure(points: StrokePoint[]): boolean {
  return points.every((p) => Math.abs(p.p - 0.5) < 0.01);
}

/** Контур штриха ручкой: мягкая линия, толщина которой зависит от нажима пера или скорости мыши. */
export function penOutline(points: StrokePoint[], size: number, last: boolean): number[] {
  const outline = getStroke(
    points.map((p) => [p.x, p.y, p.p]),
    { size, thinning: 0.55, smoothing: 0.5, streamline: 0.45, simulatePressure: noPressure(points), last },
  );
  return outline.flat();
}

/** Один штрих в координатах `pts` (уже пересчитанных в координаты объекта). */
export function drawStroke(g: Graphics, stroke: Pick<Stroke, 'tool' | 'color' | 'size'>, pts: StrokePoint[], last = true): void {
  if (!pts.length) return;
  const color = hexToNum(stroke.color);
  if (stroke.tool === 'marker') {
    // Маркер-выделитель: широкий плоский полупрозрачный штрих. Один путь — поэтому в местах
    // самопересечения цвет не темнеет, как у настоящего маркера.
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 1) g.lineTo(pts[0].x + 0.01, pts[0].y);
    g.stroke({ width: stroke.size, color, alpha: 0.38, cap: 'round', join: 'round' });
    return;
  }
  const outline = penOutline(pts, stroke.size, last);
  if (outline.length >= 6) g.poly(outline).fill(color);
}

/** Весь рисунок: штрихи записаны в размере `vw×vh`; если рисунок растянули — масштабируются. */
export function drawStrokes(g: Graphics, item: DrawingItem): void {
  const sx = item.w / (item.vw || item.w || 1), sy = item.h / (item.vh || item.h || 1);
  for (const stroke of item.strokes) {
    const pts = decodePoints(stroke.pts).map((p) => ({ x: p.x * sx, y: p.y * sy, p: p.p }));
    drawStroke(g, stroke, pts);
  }
}
