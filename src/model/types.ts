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
  /** Слой, на котором лежит объект. Нет поля — основной слой. */
  layer?: string;
  /**
   * Группа: у всех объектов группы один и тот же id. Щелчок по любому выделяет всю группу,
   * повторный щелчок — только этот объект внутри неё. Вложенных групп нет: группа из групп — одна новая.
   */
  group?: string;
}

export type FontKind = 'sans' | 'serif' | 'mono' | 'hand';
export type Align = 'left' | 'center' | 'right';

/** Оформление объекта. Его можно задать объекту напрямую или через стиль доски. */
export interface Look {
  /** Заливка (у стикера, фигуры, карточки) в виде `#rrggbb`. */
  color?: string;
  textColor?: string;
  /** Размер шрифта. У стикера и фигуры без него шрифт подбирается под размер, как в Miro. */
  fontSize?: number;
  /** Шрифт: базовый ключ (sans, serif, mono, hand) или имя встроенного / системного шрифта. */
  font?: string;
  align?: Align;
  bold?: boolean;
  italic?: boolean;
  borderColor?: string;
  /** Толщина границы — любое число, 0 — без границы. */
  borderWidth?: number;
}

export interface Box extends Common, Look {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameItem extends Box { kind: 'frame'; title?: string }
export interface StickyItem extends Box { kind: 'sticky'; text: string }
/** Карточка с рамкой и markdown внутри доски. */
export interface CardItem extends Box { kind: 'card'; text: string }
/** Свободный текст без рамки. Рамка всегда по тексту; `wrap` — ширина строки, если её задали боковыми ручками. */
export interface TextItem extends Box { kind: 'text'; text: string; wrap?: number }
export interface ShapeItem extends Box { kind: 'shape'; shape: ShapeKind; text?: string }
/** Ссылка на markdown-файл на диске. Файл — обычная заметка, без нашего формата. */
export interface DocItem extends Box { kind: 'doc'; file: string; subpath?: string }
/** Фото или картинка — оригинальный файл на диске, никогда не пережимается. `pw`/`ph` — его размер в пикселях. */
export interface ImageItem extends Box { kind: 'image'; file: string; pw?: number; ph?: number }
/** Любой другой файл (pdf, видео…). */
export interface FileItem extends Box { kind: 'file'; file: string }
/** Карточка ссылки как в Miro. Картинки (обложка, значок сайта) лежат в папке доски «ссылки/». */
export interface LinkItem extends Box {
  kind: 'link';
  url: string;
  title?: string;
  description?: string;
  site?: string;
  image?: string;
  favicon?: string;
}

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

/** Стиль доски: именованный набор оформления. Для объектов — поля Look, для линий — вид линии. */
export interface StyleDef extends Look {
  width?: number;
  dash?: DashKind;
  start?: EndCap;
  end?: EndCap;
  path?: PathKind;
}

export type GridKind = 'dots' | 'lines' | 'none';

export interface Background {
  color: string;
  grid: GridKind;
}

/**
 * Слой доски: набор объектов, который можно разом скрыть или закрепить (например, все фото).
 * Слои не меняют порядок наложения — кто выше, решает сам объект, как и раньше.
 * Основной слой — это объекты без поля `layer`; в списке он записан с пустым id.
 */
export interface LayerDef {
  id: string;
  name: string;
  hidden?: boolean;
  /** Закреплённый слой виден, но его объекты нельзя выделить — доска под ними двигается, как пустая. */
  locked?: boolean;
}

export type PinShape = 'bubble' | 'circle' | 'square' | 'diamond' | 'triangle' | 'star' | 'flag' | 'heart';

export interface CommentMessage {
  id: string;
  author: string;
  /** Когда написано, ISO-строкой. */
  time: string;
  text: string;
  /** Когда правили, если правили. */
  edited?: string;
  /** На какое сообщение это ответ — обсуждение ветвится деревом. Нет поля — ответ на всё обсуждение. */
  parent?: string;
  /** Реакция → кто её поставил. */
  reactions?: Record<string, string[]>;
}

/**
 * Обсуждение на доске, как в Miro: булавка и сообщения под ней.
 * Булавка стоит в точке доски; если её поставили на объект — ещё и в доле его ширины и высоты,
 * тогда она ездит и тянется вместе с ним, а `x`/`y` — запасное место на случай, если объект удалят.
 */
export interface CommentThread {
  id: string;
  x: number;
  y: number;
  item?: string;
  fx?: number;
  fy?: number;
  /** Цвет булавки `#rrggbb`. Нет — цвет статуса. */
  color?: string;
  /** Форма булавки. Нет — форма статуса. */
  shape?: PinShape;
  /** Статус обсуждения (см. model/comments.ts). Нет поля — «открыто». */
  status?: string;
  messages: CommentMessage[];
}

export interface BoardDoc {
  format: 'vaultboard/2';
  meta: Record<string, unknown>;
  items: Item[];
  comments: CommentThread[];
  /** Стили этой доски — лежат в самой доске и переезжают вместе с её папкой. */
  styles?: Record<string, StyleDef>;
  background?: Background;
  layers?: LayerDef[];
  /** Неизвестные поля верхнего уровня сохраняются как есть. */
  [extra: string]: unknown;
}

export function isLine(item: Item): item is LineItem {
  return item.kind === 'line';
}
