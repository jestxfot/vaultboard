// Модель доски. Порядок объектов в `items` — это порядок слоёв: кто дальше в списке, тот выше.

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type ShapeKind =
  | 'rect' | 'round' | 'ellipse' | 'diamond' | 'triangle'
  | 'parallelogram' | 'hexagon' | 'star' | 'cylinder' | 'document';
export type EndCap = 'none' | 'arrow' | 'dot' | 'diamond';
export type PathKind = 'straight' | 'curve' | 'elbow';
export type DashKind = 'solid' | 'dashed' | 'longdash' | 'dotted' | 'dashdot';

interface Common {
  id: string;
  /** Имя стиля из библиотеки стилей. */
  style?: string;
  locked?: boolean;
}

export interface Box extends Common {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Цвет в виде `#rrggbb`. */
  color?: string;
}

export interface FrameItem extends Box { kind: 'frame'; title?: string }
export interface StickyItem extends Box { kind: 'sticky'; text: string }
/** Карточка с рамкой и markdown внутри доски. */
export interface CardItem extends Box { kind: 'card'; text: string }
/** Свободный текст без рамки. Рамка всегда по тексту; `wrap` — ширина строки, если её задали боковыми ручками. */
export interface TextItem extends Box { kind: 'text'; text: string; fontSize?: number; wrap?: number }
export interface ShapeItem extends Box { kind: 'shape'; shape: ShapeKind; text?: string }
/** Ссылка на markdown-файл на диске. Файл — обычная заметка, без нашего формата. */
export interface DocItem extends Box { kind: 'doc'; file: string; subpath?: string }
/** Фото или картинка — оригинальный файл на диске, никогда не пережимается. `pw`/`ph` — его размер в пикселях. */
export interface ImageItem extends Box { kind: 'image'; file: string; pw?: number; ph?: number }
/** Любой другой файл (pdf, видео…). */
export interface FileItem extends Box { kind: 'file'; file: string }
export interface LinkItem extends Box { kind: 'link'; url: string }

/** Штрих рисунка. `pts` — точки в координатах рисунка, сжатые: см. format/strokes.ts. */
export interface Stroke {
  tool: 'pen' | 'marker';
  color: string;
  size: number;
  pts: number[];
}

/**
 * Рисунок от руки: несколько штрихов, нарисованных подряд и рядом, — один объект.
 * `vw`/`vh` — размер, в котором записаны точки; если рисунок растянули, штрихи масштабируются.
 */
export interface DrawingItem extends Box { kind: 'drawing'; vw: number; vh: number; strokes: Stroke[] }

export type BoxItem =
  | FrameItem | StickyItem | CardItem | TextItem | ShapeItem
  | DocItem | ImageItem | FileItem | LinkItem | DrawingItem;

/** Конец линии: прицеплен к объекту или висит в точке доски. */
export type Endpoint = { item: string; side?: Side } | { x: number; y: number };

export interface LineItem extends Common {
  kind: 'line';
  from: Endpoint;
  to: Endpoint;
  path?: PathKind;
  start?: EndCap;
  end?: EndCap;
  color?: string;
  width?: number;
  dash?: DashKind;
  label?: string;
}

export type Item = BoxItem | LineItem;

export interface CommentMessage {
  author: string;
  time: string;
  text: string;
  reactions?: Record<string, number>;
}

export interface CommentThread {
  id: string;
  at: { item: string; dx: number; dy: number } | { x: number; y: number };
  color?: string;
  resolved?: boolean;
  messages: CommentMessage[];
}

export interface BoardDoc {
  format: 'vaultboard/2';
  meta: Record<string, unknown>;
  items: Item[];
  comments: CommentThread[];
  /** Неизвестные поля верхнего уровня сохраняются как есть. */
  [extra: string]: unknown;
}

export function isLine(item: Item): item is LineItem {
  return item.kind === 'line';
}
