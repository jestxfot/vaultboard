// Как выглядит каждый вид объекта. Рисует в Pixi Graphics в координатах объекта (0,0 — его левый верхний угол).
import { CanvasTextMetrics, Graphics, Text, TextStyle, type TextStyleOptions } from 'pixi.js';
import getStroke from 'perfect-freehand';
import type { Align, BoxItem, DrawingItem, EndCap, LineItem, ShapeKind, Stroke } from '../model/types.ts';
import { decodePoints, type StrokePoint } from '../format/strokes.ts';
import { DEFAULT_STICKY, hexToNum, isDark, tint } from '../format/colors.ts';
import { type LineGeom, lineTip, samplePath } from './geometry.ts';
import { FONT, fontFamily } from './fonts.ts';

export { FONT };

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

/** Граница объекта: своя толщина (любое число) и цвет, иначе — как принято для этого вида. 0 — без границы. */
function border(item: BoxItem, width: number, color: number): { width: number; color: number } | null {
  const w = item.borderWidth ?? width;
  return w > 0 ? { width: w, color: item.borderColor ? hexToNum(item.borderColor) : color } : null;
}

export function drawBox(g: Graphics, item: BoxItem): void {
  const { w, h } = item;
  switch (item.kind) {
    case 'frame': {
      g.rect(0, 0, w, h).fill(item.color ? tint(item.color, 0.92) : 0xffffff);
      const b = border(item, 1, BORDER);
      if (b) g.stroke(b);
      break;
    }
    case 'sticky': {
      // Лёгкая «тень» под стикером, как в Miro, без размытия: размытие дорого на тысячах объектов.
      g.rect(2, 4, w, h).fill({ color: 0x000000, alpha: 0.08 });
      g.rect(0, 0, w, h).fill(hexToNum(item.color ?? DEFAULT_STICKY));
      const b = border(item, 0, INK);
      if (b) g.stroke(b);
      break;
    }
    case 'text': {
      const b = border(item, 0, INK);
      if (b) g.rect(0, 0, w, h).stroke(b);
      break;
    }
    case 'shape': {
      shapePath(g, item.shape, w, h).fill(item.color ? hexToNum(item.color) : 0xffffff);
      const b = border(item, 2, INK);
      if (b) g.stroke({ ...b, join: 'round' });
      break;
    }
    case 'doc':
    case 'file': {
      g.roundRect(0, 0, w, h, 8).fill(0xffffff);
      const b = border(item, 2, item.color ? hexToNum(item.color) : BORDER);
      if (b) g.stroke(b);
      g.roundRect(1, 1, w - 2, 34, 7).fill(0xf1f1ef);
      break;
    }
    case 'image':
      g.rect(0, 0, w, h).fill(0xe9e9e6).stroke({ width: 1, color: BORDER });
      break;
    case 'drawing':
      drawStrokes(g, item);
      break;
    case 'card':
    case 'link': {
      g.roundRect(0, 0, w, h, 8).fill(item.color ? tint(item.color, 0.9) : 0xffffff);
      const b = border(item, 2, item.color ? hexToNum(item.color) : BORDER);
      if (b) g.stroke(b);
      break;
    }
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
    case 'link': return 0xf4f4f2;
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

/**
 * Пунктир любого рисунка: путь режется на отрезки по длине по шаблону «штрих, пробел, штрих, пробел…».
 * В WebGL нет готового пунктира, поэтому так.
 */
function dashPath(g: Graphics, geom: LineGeom, pattern: number[]): void {
  dashPolyline(g, samplePath(geom, 64), pattern);
}

/** Шаблон пунктира для толщины линии — общий для линий вблизи и для общего объекта издалека. */
export function dashPattern(dash: string | undefined, width: number): number[] | null {
  const dot = 0.01, gap = width * 2.5 + 3;
  switch (dash) {
    case 'dashed': return [width * 4 + 4, gap];
    case 'longdash': return [width * 9 + 10, gap + 2];
    case 'dotted': return [dot, width * 2.5 + 2];
    case 'dashdot': return [width * 5 + 6, gap, dot, gap];
    default: return null;
  }
}

/** Ломаная пунктиром по шаблону «штрих, пробел, …». */
export function dashPolyline(g: Graphics, pts: { x: number; y: number }[], pattern: number[]): void {
  let idx = 0, draw = true, left = pattern[0];
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
        idx = (idx + 1) % pattern.length;
        left = pattern[idx];
      }
    }
  }
}

/** Линия рисуется в координатах доски (у контейнера линии нет своего смещения). */
export function drawLine(g: Graphics, item: LineItem, geom: LineGeom): void {
  const color = item.color ? hexToNum(item.color) : LINE;
  const width = item.width ?? 2;
  const dash = item.dash ?? 'solid';
  // Точка — очень короткий отрезок с круглыми концами.
  const pattern = dashPattern(dash, width);
  if (pattern) {
    dashPath(g, geom, pattern);
  } else if (geom.kind === 'bezier') {
    g.moveTo(geom.a.x, geom.a.y).bezierCurveTo(geom.c1.x, geom.c1.y, geom.c2.x, geom.c2.y, geom.b.x, geom.b.y);
  } else {
    g.moveTo(geom.points[0].x, geom.points[0].y);
    for (let i = 1; i < geom.points.length; i++) g.lineTo(geom.points[i].x, geom.points[i].y);
  }
  g.stroke({ width, color, cap: dash === 'dashed' || dash === 'longdash' ? 'butt' : 'round', join: 'round' });
  drawCap(g, geom, false, item.start ?? 'none', width, color);
  drawCap(g, geom, true, item.end ?? 'arrow', width, color);
}

/** Что и как писать внутри объекта. */
export interface LabelSpec {
  /** Текст как написан (markdown). */
  text: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  align: Align;
  vcenter: boolean;
  pad: number;
  /** Сверху отведено место под заголовок (у карточек-документов). */
  top: number;
  color: number;
  /** Подбирать размер шрифта, чтобы текст влез (стикеры и фигуры, как в Miro). */
  fit: boolean;
  /** Показывать markdown-разметку как оформление (жирный, курсив, заголовки, цвет). */
  rich: boolean;
}

/** Семейство шрифта по ключу или имени (оставлено для совместимости: базовые шрифты). */
export const FONTS = { sans: fontFamily('sans'), serif: fontFamily('serif'), mono: fontFamily('mono'), hand: fontFamily('hand') };

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** Есть ли в тексте разметка, которую стоит показать оформлением. */
function hasMarkup(text: string): boolean {
  return /\*|==|^#{1,3}\s|\[\[|<span|^\s*[-*]\s|\[[ xX]\]/m.test(text);
}

/**
 * Markdown → размеченный текст Pixi (`<b>…</b>`, `<i>…</i>`, `<h1>…</h1>`, `<c-e93147>…</c-e93147>`).
 * Так жирный, курсив, заголовки и цвет видны прямо на стикере, а не только в документе.
 */
export function markdownToTagged(md: string): { text: string; colors: string[] } {
  const colors = new Set<string>();
  const inline = (s: string) =>
    s
      .replace(/<span\s+style="\s*color\s*:\s*#([0-9a-f]{6})\s*;?\s*">(.*?)<\/span>/gi, (_m, c: string, t: string) => {
        colors.add(c.toLowerCase());
        return `<c${c.toLowerCase()}>${t}</c${c.toLowerCase()}>`;
      })
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/==(.+?)==/g, '<m>$1</m>')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '<l>$2</l>')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '<l>$1</l>');
  const lines = md.split('\n').map((line) => {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    return inline(
      line
        .replace(/^(\s*)[-*]\s+\[ \]\s+/, '$1☐ ')
        .replace(/^(\s*)[-*]\s+\[[xX]\]\s+/, '$1☑ ')
        .replace(/^(\s*)[-*]\s+/, '$1• '),
    );
  });
  return { text: lines.join('\n').trim(), colors: [...colors] };
}

/** Текст без разметки — для замеров (сколько строк влезает). */
function stripTags(tagged: string): string {
  return tagged.replace(/<\/?[a-z0-9]+>/g, '');
}

export function labelSpec(item: BoxItem): LabelSpec | null {
  const base = {
    bold: item.bold ?? false,
    italic: item.italic ?? false,
    fontFamily: fontFamily(item.font),
    vcenter: false,
    pad: 14,
    top: 0,
    color: item.textColor ? hexToNum(item.textColor) : INK,
    fit: false,
    rich: false,
  };
  const rich = (text: string) => hasMarkup(text);
  switch (item.kind) {
    case 'sticky': {
      if (!item.text) return null;
      const dark = isDark(item.color ?? DEFAULT_STICKY);
      return {
        ...base,
        text: item.text,
        fontSize: item.fontSize ?? 32,
        fit: item.fontSize === undefined,
        align: item.align ?? 'center',
        vcenter: true,
        pad: 16,
        color: item.textColor ? hexToNum(item.textColor) : dark ? 0xffffff : INK,
        rich: rich(item.text),
      };
    }
    case 'card':
      return item.text ? { ...base, text: item.text, fontSize: item.fontSize ?? 16, align: item.align ?? 'left', rich: rich(item.text) } : null;
    case 'text':
      return item.text ? { ...base, text: item.text, fontSize: item.fontSize ?? 18, align: item.align ?? 'left', pad: 2, rich: rich(item.text) } : null;
    case 'shape':
      return item.text
        ? { ...base, text: item.text, fontSize: item.fontSize ?? 24, fit: item.fontSize === undefined, align: item.align ?? 'center', vcenter: true, pad: 12, rich: rich(item.text) }
        : null;
    case 'doc':
      return { ...base, text: basename(item.file).replace(/\.md$/i, ''), fontSize: 15, bold: true, align: 'left', pad: 12 };
    case 'file':
      return { ...base, text: basename(item.file), fontSize: 15, bold: true, align: 'left', pad: 12 };
    case 'image':
      return { ...base, text: `🖼 ${basename(item.file)}`, fontSize: 15, align: 'center', vcenter: true };
    case 'link':
      // Развёрнутую карточку (заголовок, обложка) рисует BoardView; пока её нет — просто адрес.
      return item.title ? null : { ...base, text: item.url, fontSize: 15, align: 'left', color: 0x2f5bd3 };
    case 'frame':
    case 'drawing':
      return null;
  }
}

const FIT_SIZES = [48, 40, 32, 28, 24, 20, 18, 16, 14, 12, 10, 8];

export function labelStyle(spec: LabelSpec, w: number, fontSize: number, colors: string[] = []): TextStyle {
  const tagStyles: Record<string, TextStyleOptions> = {};
  if (spec.rich) {
    tagStyles.b = { fontWeight: '700' };
    tagStyles.i = { fontStyle: 'italic' };
    tagStyles.m = { fill: 0xa36b00, fontWeight: '600' };
    tagStyles.l = { fill: 0x4262ff };
    tagStyles.h1 = { fontSize: Math.round(fontSize * 1.5), fontWeight: '700' };
    tagStyles.h2 = { fontSize: Math.round(fontSize * 1.25), fontWeight: '700' };
    tagStyles.h3 = { fontSize: Math.round(fontSize * 1.1), fontWeight: '700' };
    for (const c of colors) tagStyles[`c${c}`] = { fill: hexToNum(`#${c}`) };
  }
  return new TextStyle({
    fontFamily: spec.fontFamily,
    fontSize,
    fontWeight: spec.bold ? '700' : '400',
    fontStyle: spec.italic ? 'italic' : 'normal',
    fill: spec.color,
    align: spec.align,
    wordWrap: true,
    breakWords: true,
    wordWrapWidth: Math.max(10, w - spec.pad * 2),
    lineHeight: lineHeightOf(fontSize),
    ...(spec.rich ? { tagStyles } : {}),
  });
}

export function lineHeightOf(fontSize: number): number {
  return Math.round(fontSize * 1.35);
}

/** Текст для замера: без разметки, но с тем же числом строк. */
function measurable(spec: LabelSpec): string {
  return spec.rich ? stripTags(markdownToTagged(spec.text).text) : spec.text;
}

/** Самый крупный шрифт, при котором текст целиком влезает в объект. */
export function fitFontSize(spec: LabelSpec, w: number, h: number): number {
  if (!spec.fit) return spec.fontSize;
  const plain = { ...spec, rich: false };
  const text = measurable(spec) || ' ';
  for (const size of FIT_SIZES) {
    if (size > spec.fontSize) continue;
    const m = CanvasTextMetrics.measureText(text, labelStyle(plain, w, size));
    if (m.lines.length * m.lineHeight <= h - spec.pad * 2 - spec.top) return size;
  }
  return FIT_SIZES[FIT_SIZES.length - 1];
}

/**
 * Рамка свободного текста — ровно по тексту. Без `wrap` ширина — по самой длинной строке,
 * с `wrap` — заданная ширина строки, текст переносится.
 */
export function textBox(text: string, fontSize: number, wrap?: number, font?: string): { w: number; h: number } {
  const pad = 2;
  const plain = hasMarkup(text) ? stripTags(markdownToTagged(text).text) : text;
  const style = new TextStyle({
    fontFamily: fontFamily(font),
    fontSize,
    lineHeight: lineHeightOf(fontSize),
    wordWrap: !!wrap,
    breakWords: true,
    wordWrapWidth: wrap ? Math.max(10, wrap - pad * 2) : 100000,
  });
  const m = CanvasTextMetrics.measureText(plain || ' ', style);
  const lines = Math.max(1, m.lines.length);
  // Запас на заголовки и жирное — они шире обычного текста.
  const extra = plain === text ? 2 : Math.ceil(fontSize * 0.6);
  const w = wrap ?? Math.max(fontSize, Math.ceil(m.width) + pad * 2 + extra);
  return { w: Math.round(w * 100) / 100, h: lines * m.lineHeight + pad * 2 + (plain === text ? 0 : Math.round(fontSize * 0.5)) };
}

/** Высота блока текста при заданной ширине — для текста, который растёт вниз по мере набора. */
export function textBlockHeight(text: string, w: number, fontSize: number, pad: number): number {
  const style = new TextStyle({ fontFamily: FONT, fontSize, wordWrap: true, breakWords: true, wordWrapWidth: Math.max(10, w - pad * 2), lineHeight: lineHeightOf(fontSize) });
  const m = CanvasTextMetrics.measureText(text || ' ', style);
  return Math.max(1, m.lines.length) * m.lineHeight + pad * 2;
}

/** Строит надпись. Обычный текст обрезается по высоте объекта с «…»; размеченный — показывается как есть. */
export function makeLabel(spec: LabelSpec, w: number, h: number, resolution: number): Text {
  const fontSize = fitFontSize(spec, w, h);
  let text = spec.text;
  let colors: string[] = [];
  if (spec.rich) {
    const tagged = markdownToTagged(spec.text);
    text = tagged.text;
    colors = tagged.colors;
  }
  const style = labelStyle(spec, w, fontSize, colors);
  if (!spec.rich) {
    const metrics = CanvasTextMetrics.measureText(text, style);
    const maxLines = Math.max(1, Math.floor((h - spec.pad * 2 - spec.top) / metrics.lineHeight));
    if (metrics.lines.length > maxLines) {
      const kept = metrics.lines.slice(0, maxLines);
      kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s*\S{0,3}$/, '')}…`;
      text = kept.join('\n');
    }
  }
  const label = new Text({ text, style, resolution });
  if (spec.align === 'center') {
    label.anchor.set(0.5, 0);
    label.x = w / 2;
  } else if (spec.align === 'right') {
    label.anchor.set(1, 0);
    label.x = w - spec.pad;
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
