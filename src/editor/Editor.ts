// Редактор доски: инструменты, выделение, перетаскивание, размеры, линии, горячие клавиши, буфер обмена.
//
// Управление:
// - левая кнопка по пустому месту — двигать доску; Shift/Ctrl + перетаскивание — выделить рамкой;
// - левая кнопка по объекту — выделить и тащить; Alt + перетаскивание — тащить копию;
// - колесо — зум к курсору; средняя/правая кнопка или пробел — тоже двигать доску;
// - двойной щелчок по пустому месту — текст, по объекту — править его текст.
// Горячие клавиши работают по физическим клавишам (e.code), поэтому одинаково в русской и английской раскладке.
import type { Graphics } from 'pixi.js';
import type { BoardStore, Op } from '../model/store.ts';
import { BASE_LAYER, BASE_NAME, layerOf, layersOf } from '../model/layers.ts';
import type { BoxItem, DashKind, DrawingItem, EndCap, Endpoint, FrameItem, Item, LayerDef, LineItem, Look, PathKind, ShapeKind, Side, Stroke, StyleDef, TextItem } from '../model/types.ts';
import { lookOf, withoutStyleFields } from '../model/look.ts';
import { ensureFont } from '../render/fonts.ts';
import { isLine } from '../model/types.ts';
import { makeFrame, makeLine, makeShape, makeSticky, makeText, newId, shapeSize, STICKY_SIZE } from '../model/factory.ts';
import { DEFAULT_STICKY } from '../format/colors.ts';
import type { BoardView } from '../render/BoardView.ts';
import type { PerfMonitor } from '../perf/monitor.ts';
import { type Anchor, geomBounds, lineGeometry, lineMidpoint, type Point, type Rect, resolveAnchor } from '../render/geometry.ts';
import { drawMarker, drawStroke, markerColor, textBox } from '../render/draw.ts';
import { decodePoints, encodePoints, shiftPoints, type StrokePoint } from '../format/strokes.ts';
import { recognize } from './recognize.ts';
import { embedUrl } from '../format/embed.ts';
import { LINK_COVER, LINK_W } from '../render/BoardView.ts';
import { type Guide, snapRect, type XEdge, type YEdge } from './snap.ts';
import { distToLine, distToSegment, geomPoints, inRect, rectContains, rectFromPoints, rectsIntersect, round2, unionRect } from './hit.ts';
import { type CloseReason, type EditField, TextEditor } from './TextEditor.ts';

export type Tool = 'select' | 'sticky' | 'text' | 'shape' | 'line' | 'frame' | 'pen' | 'marker' | 'eraser' | 'lasso' | 'comment';

/** Быстрая кисть: цвет и толщина. У ручки их три, как в Miro. */
export interface PenPreset {
  color: string;
  size: number;
}

const DEFAULT_PRESETS: PenPreset[] = [
  { color: '#1a1a1a', size: 3 },
  { color: '#e93147', size: 6 },
  { color: '#08b94e', size: 12 },
];
const PRESETS_KEY = 'vaultboard:pen-presets';
const DRAW_TOOLS = new Set<Tool>(['pen', 'marker', 'eraser', 'lasso']);

function loadPresets(): PenPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? 'null') as PenPreset[] | null;
    if (Array.isArray(raw) && raw.length === 3) return raw;
  } catch {
    // Нет доступа к хранилищу браузера — берём кисти по умолчанию.
  }
  return DEFAULT_PRESETS.map((p) => ({ ...p }));
}

/** Точка внутри многоугольника (лассо). */
function inPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Точки штрихов рисунка в координатах доски. Объекты не меняются, поэтому кэш по самому объекту надёжен. */
const strokeCache = new WeakMap<DrawingItem, StrokePoint[][]>();
function drawingPoints(d: DrawingItem): StrokePoint[][] {
  let cached = strokeCache.get(d);
  if (!cached) {
    const sx = d.w / (d.vw || d.w || 1), sy = d.h / (d.vh || d.h || 1);
    cached = d.strokes.map((s) => decodePoints(s.pts).map((q) => ({ x: d.x + q.x * sx, y: d.y + q.y * sy, p: q.p })));
    strokeCache.set(d, cached);
  }
  return cached;
}

function nearStroke(pts: StrokePoint[], w: Point, r: number): boolean {
  if (pts.length === 1) return Math.hypot(pts[0].x - w.x, pts[0].y - w.y) <= r;
  for (let i = 1; i < pts.length; i++) if (distToSegment(w, pts[i - 1], pts[i]) <= r) return true;
  return false;
}
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const BLUE = 0x4262ff;
const HANDLE = 8;
const DRAG_THRESHOLD = 4;
const CLIP_MARK = 'vaultboard/clip';

interface PointerState {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number; moved: boolean; clearOnClick: boolean; downX: number; downY: number; menu: boolean; clientX: number; clientY: number }
  | { kind: 'press'; id: string; downX: number; downY: number; start: Point; toggleOff: boolean; alt: boolean }
  | { kind: 'move'; start: Point; boxes: Map<string, Point>; lines: Map<string, LineItem>; base: Rect | null }
  | { kind: 'marquee'; start: Point; end: Point; base: Set<string> }
  | { kind: 'resize'; handle: Handle; start: Rect; boxes: Map<string, BoxItem>; aspect: boolean }
  | { kind: 'create'; tool: Tool; start: Point; end: Point }
  | { kind: 'line'; from: Endpoint; end: Point; target: string | null }
  | { kind: 'endpoint'; lineId: string; which: 'from' | 'to'; target: string | null }
  | { kind: 'draw'; tool: 'pen' | 'marker'; color: string; size: number; smart: boolean; points: StrokePoint[]; predicted: StrokePoint[] }
  | { kind: 'erase'; last: Point }
  | { kind: 'lasso'; points: Point[] };

export interface EditorUi {
  tool: Tool;
  shape: ShapeKind;
  linePath: PathKind;
  lineEnd: EndCap;
  stickyColor: string;
  selection: string[];
  kinds: string[];
  /** Рамка выделения на экране — над ней стоит контекстная панель. */
  bbox: Rect | null;
  editing: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  presets: PenPreset[];
  preset: number;
  markerColor: string;
  smart: boolean;
}

/** Больше стольких объектов для привязки не берём — ближайших хватает. */
const SNAP_MAX = 1500;

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

function isBox(item: Item | undefined): item is BoxItem {
  return !!item && !isLine(item);
}

function hasText(item: Item | undefined): item is BoxItem & { text?: string } {
  return !!item && (item.kind === 'sticky' || item.kind === 'text' || item.kind === 'card' || item.kind === 'shape');
}

export class Editor {
  tool: Tool = 'select';
  shape: ShapeKind = 'rect';
  linePath: PathKind = 'straight';
  lineEnd: EndCap = 'arrow';
  stickyColor: string = DEFAULT_STICKY;
  /** Три быстрые кисти ручки и какая выбрана. */
  presets: PenPreset[] = loadPresets();
  preset = 0;
  markerColor = '#ffe55c';
  markerSize = 22;
  /** Умное рисование: нарисованное от руки превращается в фигуру или линию. */
  smart = false;
  readonly selection = new Set<string>();
  /** Изменилось что-то, что показывает интерфейс вокруг доски. */
  onUi: (() => void) | null = null;
  /** Короткое сообщение для пользователя. */
  onNotice: ((text: string) => void) | null = null;
  /** Файлы вставили или бросили на доску — приложение кладёт их в папку доски и зовёт placeFiles. */
  onFiles: ((files: File[], at: Point) => void) | null = null;
  /** Открыть фото в просмотрщике. */
  onOpenImage: ((id: string) => void) | null = null;
  /** Открыть заметку в панели документа. */
  onOpenDoc: ((path: string, mode: 'read' | 'edit') => void) | null = null;
  /** Создать новый документ у точки (D). */
  onCreateDoc: ((at: Point) => void) | null = null;
  /** Ctrl+K — поиск заметки по базе. */
  onQuickOpen: (() => void) | null = null;
  /** Запустить видео прямо на доске, поверх карточки ссылки. */
  onPlayEmbed: ((id: string) => void) | null = null;
  /** Открыть или закрыть панель слоёв (Shift+L). */
  onLayers: (() => void) | null = null;
  /** Инструмент «Комментарий»: щёлкнули по доске — начать обсуждение в этой точке. */
  onComment: ((at: Point) => void) | null = null;
  /** Открыть или закрыть список комментариев (Shift+C). */
  onCommentsPanel: (() => void) | null = null;
  /** Вставили адрес страницы — приложение разворачивает его в карточку и зовёт applyUnfurl. */
  onUnfurl: ((id: string, url: string) => void) | null = null;
  /** Щелчок правой кнопкой: меню по объекту (target) или по доске (target = null). */
  onContextMenu: ((e: { clientX: number; clientY: number; at: Point; target: string | null }) => void) | null = null;

  private readonly store: BoardStore;
  private readonly view: BoardView;
  private readonly host: HTMLElement;
  private readonly perf: PerfMonitor;
  private readonly text: TextEditor;
  private gesture: Gesture | null = null;
  private pointer: PointerState | null = null;
  private pointerDirty = false;
  private hover: string | null = null;
  private spaceDown = false;
  /** Направляющие привязки, которые сейчас видны (во время перетаскивания или изменения размера). */
  private guides: Guide[] = [];
  /** Объекты, к которым сейчас прилипает перетаскиваемое, — подсвечиваются. */
  private snapHits: Rect[] = [];
  /** Последний рисунок: штрихи, нарисованные подряд и рядом, добавляются в него, а не плодят объекты. */
  private lastDrawing: { id: string; time: number } | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(store: BoardStore, view: BoardView, host: HTMLElement, perf: PerfMonitor) {
    this.store = store;
    this.view = view;
    this.host = host;
    this.perf = perf;
    this.text = new TextEditor(host, view, {
      onInput: (value) => this.onTextInput(value),
      onClose: (reason) => this.onTextClose(reason),
    });
    view.overlayPainter = (g, marker) => this.paint(g, marker);
    view.beforeFrame = () => this.processPointer();
    view.linesOf = (id) => store.linesOf(id);
    this.bind();
  }

  // ---------- состояние для интерфейса ----------

  ui(): EditorUi {
    const items = [...this.selection].map((id) => this.store.get(id)).filter((i): i is Item => !!i);
    const busy = this.gesture !== null && this.gesture.kind !== 'pan' && this.gesture.kind !== 'press';
    return {
      tool: this.tool,
      shape: this.shape,
      linePath: this.linePath,
      lineEnd: this.lineEnd,
      stickyColor: this.stickyColor,
      selection: items.map((i) => i.id),
      kinds: [...new Set(items.map((i) => i.kind))],
      bbox: this.selectionScreenRect(),
      editing: this.text.activeId !== null,
      busy,
      canUndo: this.store.canUndo,
      canRedo: this.store.canRedo,
      presets: this.presets,
      preset: this.preset,
      markerColor: this.markerColor,
      smart: this.smart,
    };
  }

  setTool(tool: Tool, opts: { shape?: ShapeKind; path?: PathKind; end?: EndCap; color?: string } = {}): void {
    this.tool = tool;
    if (opts.shape) this.shape = opts.shape;
    if (opts.path) this.linePath = opts.path;
    if (opts.end) this.lineEnd = opts.end;
    if (opts.color) this.stickyColor = opts.color;
    this.host.style.cursor = tool === 'select' ? '' : 'crosshair';
    this.changed();
  }

  /** Хранилище поменялось (правка, отмена) — убрать из выделения исчезнувшее, подвинуть поле ввода. */
  storeChanged(ops: Op[]): void {
    for (const op of ops) {
      if (op.t === 'delete' && !this.store.has(op.item.id)) this.selection.delete(op.item.id);
      if (op.t === 'prop' && op.key === 'layers') this.layersChanged();
      if (op.t === 'replace' && op.after.id === this.text.activeId && !isLine(op.after)) this.text.update(this.view.look(op.after));
    }
    if (this.hover && !this.store.has(this.hover)) this.hover = null;
    this.changed();
  }

  /** Камера сдвинулась. */
  cameraChanged(): void {
    this.text.reposition();
    this.onUi?.();
  }

  private changed(): void {
    this.view.invalidateOverlay();
    this.onUi?.();
  }

  private select(ids: Iterable<string>): void {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.changed();
  }

  // ---------- ввод ----------

  private bind(): void {
    const h = this.host;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    const onWin = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => window.removeEventListener(type, fn as EventListener));
    };
    on(h, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(h, 'pointerdown', (e) => this.onPointerDown(e));
    on(h, 'pointermove', (e) => this.onPointerMove(e));
    on(h, 'pointerup', (e) => this.onPointerUp(e));
    on(h, 'pointercancel', (e) => this.onPointerUp(e));
    on(h, 'pointerleave', () => {
      if (!this.gesture) this.pointer = null;
    });
    on(h, 'dblclick', (e) => this.onDoubleClick(e));
    // Файлы из проводника можно бросить прямо на доску.
    on(h, 'dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    on(h, 'drop', (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      const p = this.readPointer(e);
      this.onFiles?.(files, { x: p.wx, y: p.wy });
    });
    on(h, 'contextmenu', (e) => e.preventDefault());
    onWin('keydown', (e) => this.onKeyDown(e));
    onWin('keyup', (e) => this.onKeyUp(e));
    onWin('copy', (e) => this.onCopy(e, false));
    onWin('cut', (e) => this.onCopy(e, true));
    onWin('paste', (e) => this.onPaste(e));
  }

  destroy(): void {
    if (this.text.activeId) this.text.close('outside');
    this.text.destroy();
    for (const off of this.cleanup) off();
  }

  private readPointer(e: PointerEvent | MouseEvent | WheelEvent): PointerState {
    const r = this.host.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = this.view.screenToWorld(sx, sy);
    return { sx, sy, wx: w.x, wy: w.y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.perf.noteInput(e.timeStamp);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.host.clientHeight : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    const p = this.readPointer(e);
    if (e.ctrlKey) this.view.zoomAt(p.sx, p.sy, Math.exp(-dy * 0.01));
    else if (e.shiftKey) this.view.panBy(-(dx || dy), 0);
    else if (dx !== 0) this.view.panBy(-dx, -dy);
    else this.view.zoomAt(p.sx, p.sy, Math.exp(-dy * 0.0015));
  }

  private onPointerDown(e: PointerEvent): void {
    // Щелчки внутри поля ввода — это работа с текстом, а не с доской.
    if ((e.target as HTMLElement).closest('.text-edit')) return;
    this.perf.noteInput(e.timeStamp);
    if (this.text.activeId) this.text.close('outside');
    const p = this.readPointer(e);
    this.pointer = p;
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      // Указатель уже отпущен (или событие не от настоящего устройства) — работаем без захвата.
    }
    e.preventDefault();

    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.startPan(p, false);
      // Правая кнопка без движения — меню, с движением — двигаем доску.
      if (e.button === 2 && this.gesture?.kind === 'pan') Object.assign(this.gesture, { menu: true, clientX: e.clientX, clientY: e.clientY });
      return;
    }
    if (e.button !== 0 && !(e.pointerType === 'pen' && e.buttons & 32)) return;
    const w = { x: p.wx, y: p.wy };

    // Обратный конец пера (кнопка-ластик) стирает при любом инструменте.
    if (e.pointerType === 'pen' && e.buttons & 32) {
      this.startErase(w);
      return;
    }
    if (this.tool === 'pen' || this.tool === 'marker') {
      this.startDraw(e, this.tool);
      return;
    }
    if (this.tool === 'eraser') {
      this.startErase(w);
      return;
    }
    if (this.tool === 'lasso') {
      this.gesture = { kind: 'lasso', points: [w] };
      return;
    }
    if (this.tool === 'comment') {
      this.setTool('select');
      this.onComment?.(w);
      return;
    }

    if (this.tool === 'text') {
      this.createTextAt(w);
      this.setTool('select');
      return;
    }
    if (this.tool === 'sticky' || this.tool === 'shape' || this.tool === 'frame') {
      this.gesture = { kind: 'create', tool: this.tool, start: w, end: w };
      return;
    }
    if (this.tool === 'line') {
      const target = this.hitBox(w);
      this.gesture = { kind: 'line', from: target ? { item: target } : { x: round2(w.x), y: round2(w.y) }, end: w, target: null };
      return;
    }

    // Инструмент выделения: сначала ручки выделенного, потом объекты, потом пустое место.
    const handle = this.hitHandle(p);
    if (handle) {
      this.startResize(handle, p.shift);
      return;
    }
    const endpoint = this.hitEndpoint(p);
    if (endpoint) {
      this.store.beginGesture('Конец линии');
      this.gesture = { kind: 'endpoint', lineId: endpoint.lineId, which: endpoint.which, target: null };
      return;
    }
    const dot = this.hitConnectDot(p);
    if (dot) {
      this.gesture = { kind: 'line', from: { item: dot.id, side: dot.side }, end: w, target: null };
      return;
    }

    const hit = this.hitTest(w);
    if (hit) {
      const selected = this.selection.has(hit);
      let toggleOff = false;
      if (p.shift) {
        if (selected) toggleOff = true;
        else {
          this.selection.add(hit);
          this.changed();
        }
      } else if (!selected) {
        this.select([hit]);
      }
      this.gesture = { kind: 'press', id: hit, downX: p.sx, downY: p.sy, start: w, toggleOff, alt: p.alt };
      return;
    }

    // По пустому месту перо планшета рисует сразу, без выбора инструмента; мышь — с зажатым Alt.
    if (e.pointerType === 'pen' || p.alt) {
      this.startDraw(e, 'pen');
      return;
    }
    // Щёлкнули по объекту закреплённого слоя — он не выделяется; скажем почему, чтобы это не выглядело поломкой.
    this.explainLockedLayer(w);
    // Левая кнопка по пустому месту — выделение рамкой (Shift — добавить к выделенному).
    // Доску двигают правой кнопкой, средней или пробелом.
    this.gesture = { kind: 'marquee', start: w, end: w, base: p.shift ? new Set(this.selection) : new Set() };
    if (!p.shift) this.select([]);
  }

  /** Слои, про которые уже подсказали в этот раз, — чтобы не повторять подсказку на каждый щелчок. */
  private explainedLayers = new Set<string>();

  private explainLockedLayer(w: Point): void {
    const under = this.view.search({ x: w.x, y: w.y, w: 0, h: 0 }, true).find((i) => !isLine(i) && this.view.isLayerLocked(i) && inRect(w, i));
    if (!under) return;
    const id = layerOf(under);
    if (this.explainedLayers.has(id)) return;
    this.explainedLayers.add(id);
    const name = this.layers().find((l) => l.id === id)?.name ?? BASE_NAME;
    this.onNotice?.(`Слой «${name}» закреплён — его объекты не выделяются. Открепить: Shift+L → замок у слоя`);
  }

  private startPan(p: PointerState, clearOnClick: boolean): void {
    this.gesture = { kind: 'pan', lastX: p.sx, lastY: p.sy, moved: false, clearOnClick, downX: p.sx, downY: p.sy, menu: false, clientX: 0, clientY: 0 };
    this.host.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent): void {
    this.pointer = this.readPointer(e);
    if (this.gesture) this.perf.noteInput(e.timeStamp);
    const g = this.gesture;
    if (g?.kind === 'draw') {
      // Все промежуточные точки от пера и мыши, а не только последняя: линия не рубится на отрезки.
      for (const ce of e.getCoalescedEvents?.() ?? [e]) g.points.push(this.strokePoint(ce));
      // Предсказанные точки рисуются только в черновике штриха — чтобы линия не отставала от руки.
      g.predicted = (e.getPredictedEvents?.() ?? []).map((pe) => this.strokePoint(pe));
      this.view.invalidateOverlay();
    } else if (g?.kind === 'lasso') {
      for (const ce of e.getCoalescedEvents?.() ?? [e]) {
        const q = this.readPointer(ce);
        g.points.push({ x: q.wx, y: q.wy });
      }
      this.view.invalidateOverlay();
    } else if (DRAW_TOOLS.has(this.tool)) {
      this.view.invalidateOverlay();
    }
    this.pointerDirty = true;
    this.view.requestFrame();
  }

  /** Раз в кадр применяем последнее положение мыши — сколько бы событий ни прислала мышь с частотой 1000 Гц. */
  private processPointer(): void {
    if (!this.pointerDirty || !this.pointer) return;
    this.pointerDirty = false;
    const p = this.pointer;
    const w = { x: p.wx, y: p.wy };
    const g = this.gesture;

    if (!g) {
      this.updateHover(p);
      return;
    }
    switch (g.kind) {
      case 'pan': {
        this.view.panBy(p.sx - g.lastX, p.sy - g.lastY);
        g.lastX = p.sx;
        g.lastY = p.sy;
        if (Math.hypot(p.sx - g.downX, p.sy - g.downY) > DRAG_THRESHOLD) g.moved = true;
        // Камера сдвинулась — точка доски под мышью теперь другая.
        this.pointer = { ...p, ...this.view.screenToWorld(p.sx, p.sy) } as PointerState;
        break;
      }
      case 'press': {
        if (Math.hypot(p.sx - g.downX, p.sy - g.downY) < DRAG_THRESHOLD) break;
        if (g.toggleOff) break;
        this.startMove(g.start, g.alt);
        this.processMove(w, p.shift, p.ctrl);
        break;
      }
      case 'move':
        this.processMove(w, p.shift, p.ctrl);
        break;
      case 'marquee': {
        g.end = w;
        const r = rectFromPoints(g.start, g.end);
        const ids = new Set(g.base);
        for (const item of this.view.search(r)) {
          if (isLine(item)) {
            const geom = this.view.lineGeomOf(item);
            if (geom && inRect(geom.kind === 'bezier' ? geom.a : geom.points[0], r) && inRect(geom.kind === 'bezier' ? geom.b : geom.points[geom.points.length - 1], r)) ids.add(item.id);
          } else if (item.kind === 'frame' ? rectContains(r, item) : rectsIntersect(r, item)) {
            ids.add(item.id);
          }
        }
        this.select(ids);
        break;
      }
      case 'resize':
        this.processResize(w, p.shift, p.ctrl);
        break;
      case 'create':
        g.end = w;
        this.view.invalidateOverlay();
        break;
      case 'line':
        if (p.shift) {
          // Shift — ровная линия: угол прилипает к шагу 45° (горизонталь, вертикаль, диагонали).
          g.end = this.snapAngle(this.endpointPoint(g.from), w);
          g.target = null;
        } else {
          g.end = w;
          g.target = this.hitBox(w, 'item' in g.from ? g.from.item : undefined);
        }
        this.view.invalidateOverlay();
        break;
      case 'endpoint': {
        const line = this.store.get(g.lineId) as LineItem | undefined;
        if (!line) break;
        const other = g.which === 'from' ? line.to : line.from;
        const at = p.shift ? this.snapAngle(this.endpointPoint(other), w) : w;
        g.target = p.shift ? null : this.hitBox(w, 'item' in other ? other.item : undefined);
        const ep: Endpoint = g.target ? { item: g.target } : { x: round2(at.x), y: round2(at.y) };
        this.store.live(() => this.store.update<LineItem>(g.lineId, { [g.which]: ep }));
        break;
      }
      case 'erase':
        this.eraseAlong(g.last, w);
        g.last = w;
        break;
      case 'draw':
      case 'lasso':
        break;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId);
    this.processPointer();
    const g = this.gesture;
    this.gesture = null;
    this.guides = [];
    this.snapHits = [];
    this.host.style.cursor = this.tool === 'select' ? (this.spaceDown ? 'grab' : '') : 'crosshair';
    if (!g) return;
    if (g.kind === 'draw') g.predicted = [];
    const p = this.pointer ?? this.readPointer(e);
    const w = { x: p.wx, y: p.wy };

    switch (g.kind) {
      case 'pan':
        if (!g.moved && g.clearOnClick && !p.shift) this.select([]);
        if (!g.moved && g.menu) {
          // Меню по объекту: если щёлкнули не по выделенному — выделяем его, как в Miro.
          const hit = this.hitTest(w);
          if (hit && !this.selection.has(hit)) this.select([hit]);
          if (!hit && this.selection.size) this.select([]);
          this.onContextMenu?.({ clientX: g.clientX, clientY: g.clientY, at: w, target: hit });
        }
        break;
      case 'press': {
        if (g.toggleOff) {
          this.selection.delete(g.id);
          this.changed();
        } else if (!p.shift && this.selection.size > 1) {
          this.select([g.id]);
        }
        // Щелчок по видео запускает его прямо на доске; перетаскивание по-прежнему двигает карточку.
        const item = this.store.get(g.id);
        if (!g.toggleOff && !p.shift && item?.kind === 'link' && embedUrl(item.url)) this.onPlayEmbed?.(g.id);
        break;
      }
      case 'move':
      case 'resize':
      case 'endpoint':
      case 'erase':
        this.store.endGesture();
        break;
      case 'draw':
        this.finishDraw(g);
        break;
      case 'lasso':
        this.finishLasso(g.points);
        break;
      case 'marquee':
        break;
      case 'create':
        this.finishCreate(g.tool, g.start, w);
        break;
      case 'line':
        this.finishLine(g.from, g.end, g.target);
        break;
    }
    this.changed();
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.tool !== 'select' || (e.target as HTMLElement).closest('.text-edit')) return;
    const p = this.readPointer(e);
    const w = { x: p.wx, y: p.wy };
    const hit = this.hitTest(w);
    const item = hit ? this.store.get(hit) : undefined;
    if (item?.kind === 'frame') this.editText(item.id, 'title');
    else if (item?.kind === 'image') this.onOpenImage?.(item.id);
    else if (item?.kind === 'link') {
      if (embedUrl(item.url)) this.onPlayEmbed?.(item.id);
      else window.open(item.url, '_blank', 'noopener');
    }
    else if (item?.kind === 'doc') this.onOpenDoc?.(this.view.paths.toVault(item.file), 'read');
    else if (item && isLine(item)) this.editText(item.id, 'label');
    else if (hasText(item)) this.editText(item.id, 'text');
    else if (!item) this.createTextAt(w);
  }

  // ---------- попадания ----------

  /** Самый верхний объект под точкой доски. Рамки ловятся только за заголовок, чтобы внутри них можно было двигать доску. */
  hitTest(w: Point, exclude?: string): string | null {
    const z = this.view.cam.zoom;
    const tol = 6 / z;
    const candidates = this.view.search({ x: w.x - tol, y: w.y - tol, w: tol * 2, h: tol * 2 + 30 / z });
    candidates.sort((a, b) => this.store.indexOf(b.id) - this.store.indexOf(a.id));
    for (const item of candidates) {
      if (item.id === exclude) continue;
      if (isLine(item)) {
        const geom = this.view.lineGeomOf(item);
        if (geom && distToLine(w, geom) <= tol) return item.id;
      } else if (item.kind === 'frame') {
        const titleW = Math.max(item.w * 0.5, 140 / z);
        if (w.x >= item.x && w.x <= item.x + Math.min(item.w, titleW) && w.y >= item.y - 24 / z && w.y <= item.y) return item.id;
      } else if (item.kind === 'drawing') {
        if (inRect(w, item, tol) && drawingPoints(item).some((pts, i) => nearStroke(pts, w, tol + item.strokes[i].size / 2))) return item.id;
      } else if (inRect(w, item)) {
        return item.id;
      }
    }
    return null;
  }

  /** Объект, к которому можно прицепить линию (не линия и не рамка — рамку тоже можно, но только за край). */
  private hitBox(w: Point, exclude?: string): string | null {
    // Линию можно прицепить и к объекту закреплённого слоя (например, стрелку к фото-подложке).
    const candidates = this.view.search({ x: w.x, y: w.y, w: 0, h: 0 }, true);
    candidates.sort((a, b) => this.store.indexOf(b.id) - this.store.indexOf(a.id));
    for (const item of candidates) {
      if (item.id === exclude || isLine(item) || item.kind === 'frame') continue;
      if (inRect(w, item)) return item.id;
    }
    return null;
  }

  private selectedBoxes(): BoxItem[] {
    return [...this.selection].map((id) => this.store.get(id)).filter(isBox);
  }

  /** Где объект на экране (для плеера поверх карточки). */
  screenRectOf(id: string): Rect | null {
    const r = this.view.rectOf(id);
    return r ? this.toScreenRect(r) : null;
  }

  /** Рамка выделенного на доске (для экспорта выделенного). */
  selectionWorldRect(): Rect | null {
    const rects: Rect[] = this.selectedBoxes();
    for (const id of this.selection) {
      const item = this.store.get(id);
      if (item && isLine(item)) {
        const g = this.view.lineGeomOf(item);
        if (g) rects.push(geomBounds(g, 0));
      }
    }
    return unionRect(rects);
  }

  private toScreenRect(r: Rect): Rect {
    const a = this.view.worldToScreen(r.x, r.y);
    const z = this.view.cam.zoom;
    return { x: a.x, y: a.y, w: r.w * z, h: r.h * z };
  }

  private selectionScreenRect(): Rect | null {
    const r = this.selectionWorldRect();
    return r ? this.toScreenRect(r) : null;
  }

  private handles(): { handle: Handle; x: number; y: number }[] {
    const boxes = this.selectedBoxes();
    if (!boxes.length || this.text.activeId) return [];
    const r = this.toScreenRect(unionRect(boxes)!);
    const x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    const corners: { handle: Handle; x: number; y: number }[] = [
      { handle: 'nw', x: x0, y: y0 }, { handle: 'ne', x: x1, y: y0 },
      { handle: 'se', x: x1, y: y1 }, { handle: 'sw', x: x0, y: y1 },
    ];
    // Любой объект, включая стикеры, тянется за любую ручку в любые пропорции. Shift за угол — сохранить пропорции.
    // Фото — только за углы и без искажения, как в Miro.
    if (r.w < 40 || r.h < 40 || boxes.every((b) => b.kind === 'image')) return corners;
    // Текст: углы увеличивают сам текст, боковые ручки меняют ширину строки.
    if (boxes.every((b) => b.kind === 'text')) return [...corners, { handle: 'e', x: x1, y: ym }, { handle: 'w', x: x0, y: ym }];
    return [...corners, { handle: 'n', x: xm, y: y0 }, { handle: 'e', x: x1, y: ym }, { handle: 's', x: xm, y: y1 }, { handle: 'w', x: x0, y: ym }];
  }

  private hitHandle(p: PointerState): Handle | null {
    for (const h of this.handles()) if (Math.abs(p.sx - h.x) <= HANDLE && Math.abs(p.sy - h.y) <= HANDLE) return h.handle;
    return null;
  }

  /** Точки по бокам выделенного объекта: потянул — и тянется новая стрелка, как в Miro. */
  private connectDots(): { id: string; side: Side; x: number; y: number }[] {
    const boxes = this.selectedBoxes();
    if (boxes.length !== 1 || this.selection.size !== 1 || this.text.activeId) return [];
    const b = boxes[0];
    if (b.kind === 'frame') return [];
    const r = this.toScreenRect(b);
    if (r.w < 24 || r.h < 24) return [];
    const off = 18;
    return [
      { id: b.id, side: 'top', x: r.x + r.w / 2, y: r.y - off },
      { id: b.id, side: 'right', x: r.x + r.w + off, y: r.y + r.h / 2 },
      { id: b.id, side: 'bottom', x: r.x + r.w / 2, y: r.y + r.h + off },
      { id: b.id, side: 'left', x: r.x - off, y: r.y + r.h / 2 },
    ];
  }

  private hitConnectDot(p: PointerState): { id: string; side: Side } | null {
    for (const d of this.connectDots()) if (Math.hypot(p.sx - d.x, p.sy - d.y) <= 8) return d;
    return null;
  }

  private lineEnds(): { lineId: string; which: 'from' | 'to'; x: number; y: number }[] {
    if (this.selection.size !== 1) return [];
    const item = this.store.get([...this.selection][0]);
    if (!item || !isLine(item)) return [];
    const g = this.view.lineGeomOf(item);
    if (!g) return [];
    const pts = geomPoints(g);
    const a = this.view.worldToScreen(pts[0].x, pts[0].y);
    const b = this.view.worldToScreen(pts[pts.length - 1].x, pts[pts.length - 1].y);
    return [{ lineId: item.id, which: 'from', ...a }, { lineId: item.id, which: 'to', ...b }];
  }

  private hitEndpoint(p: PointerState): { lineId: string; which: 'from' | 'to' } | null {
    for (const e of this.lineEnds()) if (Math.hypot(p.sx - e.x, p.sy - e.y) <= 8) return e;
    return null;
  }

  private updateHover(p: PointerState): void {
    let cursor = this.tool === 'select' ? (this.spaceDown ? 'grab' : '') : 'crosshair';
    let hover: string | null = null;
    if (this.tool === 'select' && !this.spaceDown) {
      const handle = this.hitHandle(p);
      if (handle) cursor = HANDLE_CURSOR[handle];
      else if (this.hitEndpoint(p) || this.hitConnectDot(p)) cursor = 'crosshair';
      else hover = this.hitTest({ x: p.wx, y: p.wy });
    }
    this.host.style.cursor = cursor;
    if (hover !== this.hover) {
      this.hover = hover;
      this.view.invalidateOverlay();
    }
  }

  // ---------- перемещение и размер ----------

  private startMove(start: Point, duplicate: boolean): void {
    this.store.beginGesture(duplicate ? 'Копия' : 'Перемещение');
    if (duplicate) {
      let copies: string[] = [];
      this.store.live(() => {
        copies = this.cloneInto([...this.selection].map((id) => this.store.get(id)!).filter(Boolean), 0, 0);
      });
      this.select(copies);
    }
    const boxes = new Map<string, Point>();
    const lines = new Map<string, LineItem>();
    for (const id of this.selection) {
      const item = this.store.get(id);
      if (!item || item.locked) continue;
      if (isLine(item)) lines.set(id, item);
      else boxes.set(id, { x: item.x, y: item.y });
    }
    // Рамка тащит всё, что целиком лежит внутри неё, как в Miro.
    for (const id of [...boxes.keys()]) {
      const frame = this.store.get(id);
      if (frame?.kind !== 'frame') continue;
      const fi = this.store.indexOf(id);
      for (const inner of this.view.search(frame)) {
        if (boxes.has(inner.id) || isLine(inner) || inner.locked) continue;
        if (this.store.indexOf(inner.id) > fi && rectContains(frame, inner)) boxes.set(inner.id, { x: inner.x, y: inner.y });
      }
    }
    // Линии, у которых оба конца едут вместе с объектами или висят в воздухе, тоже едут.
    for (const id of boxes.keys()) {
      for (const lineId of this.store.linesOf(id)) {
        const l = this.store.get(lineId) as LineItem;
        if (!lines.has(lineId)) lines.set(lineId, l);
      }
    }
    const base = unionRect([...boxes.keys()].map((id) => this.view.rectOf(id)).filter((r): r is Rect => !!r));
    this.gesture = { kind: 'move', start, boxes, lines, base };
  }

  /** Соседи для привязки: объекты рядом, кроме перетаскиваемых и линий. */
  /**
   * С чем выравнивать: всё, что видно на экране (как в Miro — год слева видит год справа через весь экран),
   * плюс немного вокруг. Если объектов тысячи — берём ближайшие, чтобы привязка не тормозила.
   */
  private snapTargets(area: Rect, exclude: Set<string>): Rect[] {
    const a = this.view.screenToWorld(0, 0);
    const { w, h } = this.view.screen;
    const b = this.view.screenToWorld(w, h);
    const x0 = Math.min(a.x, area.x), y0 = Math.min(a.y, area.y);
    const x1 = Math.max(b.x, area.x + area.w), y1 = Math.max(b.y, area.y + area.h);
    const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
    const rects = this.view
      .search({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, true)
      .filter((i) => !isLine(i) && !exclude.has(i.id) && i.kind !== 'drawing')
      .map((i) => this.view.rectOf(i.id)!)
      .filter(Boolean);
    if (rects.length <= SNAP_MAX) return rects;
    const dist = (r: Rect) => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    return rects.sort((p, q) => dist(p) - dist(q)).slice(0, SNAP_MAX);
  }

  private processMove(w: Point, axisLock: boolean, noSnap = false): void {
    const g = this.gesture;
    if (g?.kind !== 'move') return;
    let dx = w.x - g.start.x, dy = w.y - g.start.y;
    if (axisLock) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    // Привязка к соседям и сетке; Ctrl — без привязки.
    this.guides = [];
    this.snapHits = [];
    if (g.base && !noSnap) {
      const moved = { x: g.base.x + dx, y: g.base.y + dy, w: g.base.w, h: g.base.h };
      const snap = snapRect(moved, this.snapTargets(moved, new Set(g.boxes.keys())), 6 / this.view.cam.zoom, 8, ['l', 'c', 'r'], ['t', 'm', 'b']);
      if (!(axisLock && dx === 0)) dx += snap.dx;
      if (!(axisLock && dy === 0)) dy += snap.dy;
      this.guides = snap.guides;
      this.snapHits = snap.targets;
    }
    const shift = (ep: Endpoint, orig: Endpoint): Endpoint => ('item' in orig ? ep : { x: round2(orig.x + dx), y: round2(orig.y + dy) });
    this.store.live(() => {
      for (const [id, o] of g.boxes) this.store.update<BoxItem>(id, { x: round2(o.x + dx), y: round2(o.y + dy) });
      for (const [id, orig] of g.lines) {
        const cur = this.store.get(id) as LineItem | undefined;
        if (!cur) continue;
        if ('item' in orig.from && 'item' in orig.to) continue;
        this.store.update<LineItem>(id, { from: shift(cur.from, orig.from), to: shift(cur.to, orig.to) });
      }
    });
  }

  private startResize(handle: Handle, shift: boolean): void {
    const boxes = new Map(this.selectedBoxes().filter((b) => !b.locked).map((b) => [b.id, this.view.look(b)]));
    const start = unionRect([...boxes.values()]);
    if (!start) return;
    // Фото и текст за угол меняются пропорционально: текст при этом увеличивается целиком, вместе со шрифтом.
    const aspect = shift || [...boxes.values()].every((b) => b.kind === 'image' || b.kind === 'text' || b.kind === 'link');
    this.store.beginGesture('Размер');
    this.gesture = { kind: 'resize', handle, start, boxes, aspect };
  }

  private processResize(w: Point, shift: boolean, noSnap = false): void {
    const g = this.gesture;
    if (g?.kind !== 'resize') return;
    const s = g.start;
    let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
    if (g.handle.includes('w')) x0 = Math.min(w.x, x1 - 10);
    if (g.handle.includes('e')) x1 = Math.max(w.x, x0 + 10);
    if (g.handle.includes('n')) y0 = Math.min(w.y, y1 - 10);
    if (g.handle.includes('s')) y1 = Math.max(w.y, y0 + 10);
    // Привязка того края, который тянут, к краям соседей и сетке.
    this.guides = [];
    this.snapHits = [];
    if (!noSnap) {
      const xs: XEdge[] = g.handle.includes('w') ? ['l'] : g.handle.includes('e') ? ['r'] : [];
      const ys: YEdge[] = g.handle.includes('n') ? ['t'] : g.handle.includes('s') ? ['b'] : [];
      const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const snap = snapRect(r, this.snapTargets(r, new Set(g.boxes.keys())), 6 / this.view.cam.zoom, 8, xs, ys);
      if (xs[0] === 'l') x0 += snap.dx;
      if (xs[0] === 'r') x1 += snap.dx;
      if (ys[0] === 't') y0 += snap.dy;
      if (ys[0] === 'b') y1 += snap.dy;
      this.guides = snap.guides;
      this.snapHits = snap.targets;
    }
    let sx = (x1 - x0) / s.w, sy = (y1 - y0) / s.h;
    const corner = g.handle.length === 2;
    if ((g.aspect || shift) && corner) {
      const k = Math.max(sx, sy);
      sx = sy = k;
      if (g.handle.includes('w')) x0 = x1 - s.w * k;
      else x1 = x0 + s.w * k;
      if (g.handle.includes('n')) y0 = y1 - s.h * k;
      else y1 = y0 + s.h * k;
    }
    this.store.live(() => {
      for (const [id, o] of g.boxes) {
        const patch: Partial<BoxItem> & { fontSize?: number } = {
          x: round2(x0 + (o.x - s.x) * sx),
          y: round2(y0 + (o.y - s.y) * sy),
          w: round2(Math.max(10, o.w * sx)),
          h: round2(Math.max(10, o.h * sy)),
        };
        if (o.kind === 'text') {
          // Свободный текст: за угол увеличивается сам текст (шрифт), за бок — ширина строки. Рамка — по тексту.
          const t = this.view.look(o as TextItem);
          const fontSize = corner ? round2(Math.max(6, (t.fontSize ?? 18) * sx)) : (t.fontSize ?? 18);
          const wrap = corner ? (t.wrap ? round2(t.wrap * sx) : undefined) : round2(Math.max(fontSize * 2, patch.w!));
          const box = textBox(t.text, fontSize, wrap, t.font);
          Object.assign(patch, { fontSize, w: box.w, h: box.h });
          if (wrap) (patch as Partial<TextItem>).wrap = wrap;
          // Ручка слева или сверху: правый/нижний край стоит на месте.
          if (g.handle.includes('w')) patch.x = round2(x1 - box.w);
          if (g.handle.includes('n')) patch.y = round2(y1 - box.h);
        }
        this.store.update<BoxItem>(id, patch);
      }
    });
  }

  // ---------- создание ----------

  /** Где создавать объект с клавиатуры: под курсором, а если мышь вне доски — в центре экрана. */
  cursorPoint(): Point {
    if (this.pointer) return { x: this.pointer.wx, y: this.pointer.wy };
    const { w, h } = this.view.screen;
    return this.view.screenToWorld(w / 2, h / 2);
  }

  private id(): string {
    return newId((id) => this.store.has(id));
  }

  /** Создать объект и сразу начать писать в нём. Создание и текст — одна запись в истории. */
  private createAndEdit(label: string, item: BoxItem): void {
    this.store.beginGesture(label);
    this.store.live(() => this.store.insert(item));
    this.select([item.id]);
    this.startTextEdit(item.id, item.kind === 'frame' ? 'title' : 'text');
  }

  createStickyAt(p: Point, color = this.stickyColor): void {
    this.createAndEdit('Стикер', makeSticky(this.id(), round2(p.x), round2(p.y), color));
  }

  createTextAt(p: Point): void {
    this.createAndEdit('Текст', makeText(this.id(), round2(p.x), round2(p.y - 14)));
  }

  createShapeAt(p: Point, shape: ShapeKind): void {
    const { w, h } = shapeSize(shape);
    const item = makeShape(this.id(), shape, round2(p.x - w / 2), round2(p.y - h / 2), w, h);
    this.store.transact('Фигура', () => this.store.insert(item));
    this.select([item.id]);
  }

  private finishCreate(tool: Tool, start: Point, end: Point): void {
    const r = rectFromPoints(start, end);
    const tiny = r.w * this.view.cam.zoom < 8 && r.h * this.view.cam.zoom < 8;
    if (tool === 'sticky') {
      const c = tiny ? start : { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const size = tiny ? STICKY_SIZE : Math.max(40, Math.max(r.w, r.h));
      const item = makeSticky(this.id(), round2(c.x), round2(c.y), this.stickyColor);
      Object.assign(item, { x: round2(c.x - size / 2), y: round2(c.y - size / 2), w: size, h: size });
      this.createAndEdit('Стикер', item);
    } else if (tool === 'shape') {
      if (tiny) this.createShapeAt(start, this.shape);
      else {
        const item = makeShape(this.id(), this.shape, round2(r.x), round2(r.y), round2(r.w), round2(r.h));
        this.store.transact('Фигура', () => this.store.insert(item));
        this.select([item.id]);
      }
    } else if (tool === 'frame') {
      const n = this.store.items.filter((i) => i.kind === 'frame').length + 1;
      const fr = tiny ? { x: start.x - 500, y: start.y - 350, w: 1000, h: 700 } : r;
      const item = makeFrame(this.id(), round2(fr.x), round2(fr.y), round2(fr.w), round2(fr.h), `Рамка ${n}`);
      // Рамка ложится под всё остальное, чтобы не закрывать объекты.
      this.store.transact('Рамка', () => this.store.insert(item, 0));
      this.select([item.id]);
    }
    this.setTool('select');
  }

  private finishLine(from: Endpoint, end: Point, target: string | null): void {
    const to: Endpoint = target ? { item: target } : { x: round2(end.x), y: round2(end.y) };
    const fromPoint = 'item' in from ? null : from;
    // Короткий щелчок без цели — не линия, а промах.
    if (!target && fromPoint && Math.hypot(end.x - fromPoint.x, end.y - fromPoint.y) * this.view.cam.zoom < 6) {
      this.setTool('select');
      return;
    }
    if ('item' in from && !target) {
      const r = this.view.rectOf(from.item);
      if (r && inRect(end, r)) {
        this.setTool('select');
        return;
      }
    }
    const fromDot = this.tool === 'select';
    const item = makeLine(this.id(), from, to, fromDot ? 'curve' : this.linePath, fromDot ? 'arrow' : (this.lineEnd as 'arrow' | 'none'));
    this.store.transact('Линия', () => this.store.insert(item));
    this.select([item.id]);
    this.setTool('select');
  }

  // ---------- текст ----------

  editText(id: string, field: EditField): void {
    this.store.beginGesture(field === 'title' ? 'Заголовок' : field === 'label' ? 'Подпись линии' : 'Текст');
    this.select([id]);
    this.startTextEdit(id, field);
  }

  private startTextEdit(id: string, field: EditField): void {
    const item = this.store.get(id);
    if (field === 'label' && item && isLine(item)) {
      // Подпись правится в поле вокруг середины линии.
      const geom = this.view.lineGeomOf(item);
      if (!geom) return;
      const mid = lineMidpoint(geom);
      this.view.setEditing(id);
      this.text.open({ id, kind: 'label', x: mid.x - 140, y: mid.y - 16, w: 280, h: 32 }, 'label', item.label ?? '');
      this.changed();
      return;
    }
    if (!isBox(item)) return;
    const value = field === 'title' ? ((item as FrameItem).title ?? '') : ((item as { text?: string }).text ?? '');
    this.view.setEditing(id);
    this.text.open(this.view.look(item), field, value);
    this.changed();
  }

  private onTextInput(value: string): void {
    const id = this.text.activeId;
    if (!id) return;
    const field = this.text.activeField;
    if (field === 'label') {
      this.store.live(() => this.store.update<LineItem>(id, (line) => {
        const next: LineItem = { ...line, label: value };
        if (!value) delete next.label;
        return next;
      }));
      return;
    }
    this.store.live(() =>
      this.store.update<BoxItem>(id, (item) => {
        if (field === 'title') return { ...item, title: value } as BoxItem;
        const next = { ...item, text: value } as BoxItem;
        // Рамка свободного текста всегда ровно по тексту.
        if (item.kind === 'text') {
          const look = this.view.look(item);
          Object.assign(next, textBox(value, look.fontSize ?? 18, item.wrap, look.font));
        }
        return next;
      }),
    );
  }

  private onTextClose(reason: CloseReason): void {
    const id = this.text.activeId ?? [...this.selection][0];
    const item = id ? this.store.get(id) : undefined;
    // Пустой свободный текст не нужен — удаляем, и если он только что создан, в истории не останется ничего.
    if (item?.kind === 'text' && !item.text.trim()) {
      this.store.live(() => this.store.remove(item.id));
    }
    this.store.endGesture();
    this.view.setEditing(null);
    this.changed();

    // Tab — следующий стикер справа, Ctrl+Enter — ниже. Быстро набрасывать идеи, как в Miro.
    if (item?.kind === 'sticky' && (reason === 'tab' || reason === 'ctrlEnter')) {
      const gap = 20;
      const c = reason === 'tab'
        ? { x: item.x + item.w * 1.5 + gap, y: item.y + item.h / 2 }
        : { x: item.x + item.w / 2, y: item.y + item.h * 1.5 + gap };
      const next = makeSticky(this.id(), round2(c.x), round2(c.y), item.color);
      Object.assign(next, { w: item.w, h: item.h, x: round2(c.x - item.w / 2), y: round2(c.y - item.h / 2) });
      this.createAndEdit('Стикер', next);
    }
  }

  // ---------- правки выделенного ----------

  deleteSelection(): void {
    if (!this.selection.size) return;
    const ids = [...this.selection];
    this.store.transact('Удаление', () => {
      for (const id of ids) this.store.remove(id);
    });
    this.select([]);
  }

  setColor(color: string | undefined): void {
    this.store.transact('Цвет', () => {
      for (const id of this.selection) this.store.update(id, (item) => {
        if (item.kind === 'drawing') return color ? { ...item, strokes: item.strokes.map((st) => ({ ...st, color })) } : item;
        const next = { ...item } as Item & { color?: string };
        if (color) next.color = color;
        else delete next.color;
        return next;
      });
    });
    if (color && [...this.selection].every((id) => this.store.get(id)?.kind === 'sticky')) this.stickyColor = color;
    this.changed();
  }

  setShape(shape: ShapeKind): void {
    this.store.transact('Фигура', () => {
      for (const id of this.selection) if (this.store.get(id)?.kind === 'shape') this.store.update(id, { shape });
    });
  }

  setLinePath(path: PathKind): void {
    this.store.transact('Вид линии', () => {
      for (const id of this.selection) if (isLine(this.store.get(id)!)) this.store.update<LineItem>(id, { path });
    });
  }

  // ---------- оформление ----------

  /** Оформление первого выделенного объекта (со стилем) — чтобы панель показала текущие значения. */
  selectedLook(): (Look & { width?: number; kind: string; style?: string; hasStyle: boolean }) | null {
    const id = [...this.selection][0];
    const item = id ? this.store.get(id) : undefined;
    if (!item) return null;
    const look = this.view.look(item) as unknown as Look & { width?: number };
    return { ...look, kind: item.kind, style: item.style, hasStyle: !!item.style && !!this.styles()[item.style] };
  }

  /**
   * Поменять оформление выделенного: шрифт, размер, цвета, границу. `undefined` — вернуть «как по умолчанию».
   * Свободный текст после смены шрифта или размера подгоняет рамку под себя.
   */
  setLook(change: Partial<Look>, ids: string[] = [...this.selection]): void {
    // Шрифт ещё не загружен — дождаться (иначе рамка текста посчитается запасным шрифтом).
    // Объекты фиксируем сейчас: пока шрифт грузится, выделение может смениться.
    const wait = ensureFont(change.font);
    if (wait) {
      void wait.then(() => this.setLook(change, ids));
      return;
    }
    this.store.transact('Оформление', () => {
      for (const id of ids) {
        this.store.update(id, (item) => {
          if (isLine(item)) return item;
          const next = { ...item } as unknown as Record<string, unknown>;
          for (const [k, v] of Object.entries(change)) {
            if (v === undefined) delete next[k];
            else next[k] = v;
          }
          const box = next as unknown as BoxItem;
          if (box.kind === 'text') {
            const look = this.view.look(box);
            Object.assign(box, textBox(box.text, look.fontSize ?? 18, box.wrap, look.font));
          }
          return box;
        });
      }
    });
    this.changed();
  }

  /** Жирный или курсив: при наборе — для выделенного куска текста, иначе — для всего объекта. */
  toggleFormat(kind: 'bold' | 'italic'): void {
    if (this.text.activeId) {
      this.text.wrapSelection(kind === 'bold' ? '**' : '*');
      return;
    }
    const look = this.selectedLook();
    this.setLook({ [kind]: look?.[kind] ? undefined : true });
  }

  // ---------- стили доски ----------

  styles(): Record<string, StyleDef> {
    return this.store.doc.styles ?? {};
  }

  /** Сохранить оформление выделенного объекта как стиль с этим именем и сразу применить его. */
  saveStyle(name: string): void {
    const id = [...this.selection][0];
    const item = id ? this.store.get(id) : undefined;
    if (!item || !name.trim()) return;
    const def = lookOf(this.view.look(item));
    this.store.transact('Новый стиль', () => {
      this.store.setProp('styles', { ...this.styles(), [name.trim()]: def });
      for (const sid of this.selection) this.applyStyleTo(sid, name.trim(), def);
    });
    this.changed();
  }

  private applyStyleTo(id: string, name: string, def: StyleDef): void {
    this.store.update(id, (item) => {
      const next = withoutStyleFields({ ...item, style: name }, def);
      if (next.kind === 'text') {
        const look = { ...def, ...next } as TextItem;
        Object.assign(next, textBox(next.text, look.fontSize ?? 18, next.wrap, look.font));
      }
      return next;
    });
  }

  /** Применить стиль к выделенному (null — убрать стиль, оставив вид как есть). */
  applyStyle(name: string | null): void {
    const styles = this.styles();
    this.store.transact(name ? `Стиль «${name}»` : 'Без стиля', () => {
      for (const id of this.selection) {
        if (name && styles[name]) this.applyStyleTo(id, name, styles[name]);
        else {
          const item = this.store.get(id);
          if (!item?.style) continue;
          // Без стиля объект сохраняет свой вид: оформление стиля переписывается в сам объект.
          const baked = { ...this.view.look(item) } as Item & { style?: string };
          delete baked.style;
          this.store.update(id, () => baked);
        }
      }
    });
    this.changed();
  }

  /** Сбросить отличия от стиля: объект снова выглядит ровно как его стиль. */
  resetToStyle(): void {
    const styles = this.styles();
    this.store.transact('Сбросить к стилю', () => {
      for (const id of this.selection) {
        const item = this.store.get(id);
        const def = item?.style ? styles[item.style] : undefined;
        if (item && def) this.applyStyleTo(id, item.style!, def);
      }
    });
  }

  /** «Изменил объект — обновить по нему стиль»: все объекты с этим стилем станут такими же. */
  updateStyleFromSelection(): void {
    const id = [...this.selection][0];
    const item = id ? this.store.get(id) : undefined;
    if (!item?.style) return;
    const def = lookOf(this.view.look(item));
    this.store.transact(`Обновить стиль «${item.style}»`, () => {
      this.store.setProp('styles', { ...this.styles(), [item.style!]: def });
      this.applyStyleTo(item.id, item.style!, def);
    });
    this.changed();
  }

  styleNames(): string[] {
    return Object.keys(this.styles());
  }

  styleUsage(name: string): number {
    return this.store.items.reduce((n, i) => n + (i.style === name ? 1 : 0), 0);
  }

  selectByStyle(name: string): void {
    this.select(this.store.items.filter((i) => i.style === name).map((i) => i.id));
  }

  /** Массовая замена: у всех объектов стиль «from» → «to». */
  replaceStyle(from: string, to: string): void {
    const def = this.styles()[to];
    if (!def) return;
    this.store.transact(`Заменить «${from}» на «${to}»`, () => {
      for (const item of this.store.items) if (item.style === from) this.applyStyleTo(item.id, to, def);
    });
  }

  renameStyle(from: string, to: string): void {
    const styles = this.styles();
    const name = to.trim();
    if (!styles[from] || !name || styles[name]) return;
    const next: Record<string, StyleDef> = {};
    for (const [k, v] of Object.entries(styles)) next[k === from ? name : k] = v;
    this.store.transact('Переименовать стиль', () => {
      this.store.setProp('styles', next);
      for (const item of this.store.items) if (item.style === from) this.store.update(item.id, { style: name });
    });
    this.changed();
  }

  /** Удалить стиль: объекты с ним сохраняют свой вид, просто без стиля. */
  deleteStyle(name: string): void {
    const styles = { ...this.styles() };
    if (!styles[name]) return;
    this.store.transact(`Удалить стиль «${name}»`, () => {
      for (const item of this.store.items) {
        if (item.style !== name) continue;
        const baked = { ...this.view.look(item) } as Item & { style?: string };
        delete baked.style;
        this.store.update(item.id, () => baked);
      }
      delete styles[name];
      this.store.setProp('styles', Object.keys(styles).length ? styles : undefined);
    });
    this.changed();
  }

  /** Добавить стиль из общей библиотеки базы на эту доску. */
  addStyle(name: string, def: StyleDef): void {
    this.store.transact('Стиль из библиотеки', () => this.store.setProp('styles', { ...this.styles(), [name]: def }));
    this.changed();
  }

  setLineWidth(width: number): void {
    this.store.transact('Толщина линии', () => {
      for (const id of this.selection) if (isLine(this.store.get(id)!)) this.store.update<LineItem>(id, { width });
    });
  }

  setLineDash(dash: DashKind): void {
    this.store.transact('Вид линии', () => {
      for (const id of this.selection) if (isLine(this.store.get(id)!)) this.store.update<LineItem>(id, { dash });
    });
  }

  setCap(which: 'start' | 'end', cap: EndCap): void {
    this.store.transact('Наконечник', () => {
      for (const id of this.selection) if (isLine(this.store.get(id)!)) this.store.update<LineItem>(id, { [which]: cap });
    });
  }

  /** Первая выделенная линия — чтобы панель показала её текущие настройки. */
  selectedLine(): LineItem | null {
    for (const id of this.selection) {
      const item = this.store.get(id);
      if (item && isLine(item)) return item;
    }
    return null;
  }

  /** Точка конца линии: центр объекта или сама точка. */
  private endpointPoint(ep: Endpoint): Point {
    if ('item' in ep) {
      const r = this.view.rectOf(ep.item);
      return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 0, y: 0 };
    }
    return { x: ep.x, y: ep.y };
  }

  /** Конец отрезка с углом, округлённым до 45°, той же длины. */
  private snapAngle(from: Point, to: Point): Point {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
    return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
  }

  // ---------- рисование ----------

  setPreset(index: number): void {
    this.preset = index;
    this.setTool('pen');
  }

  /** Поменять цвет или толщину выбранной кисти; кисти запоминаются в браузере. */
  updatePreset(change: Partial<PenPreset>): void {
    if (this.tool === 'marker') {
      if (change.color) this.markerColor = change.color;
      if (change.size) this.markerSize = change.size;
    } else {
      this.presets = this.presets.map((p, i) => (i === this.preset ? { ...p, ...change } : p));
      try {
        localStorage.setItem(PRESETS_KEY, JSON.stringify(this.presets));
      } catch {
        // Не запомнится — не страшно.
      }
    }
    this.changed();
  }

  toggleSmart(): void {
    this.smart = !this.smart;
    this.setTool('pen');
  }

  private strokePoint(e: PointerEvent): StrokePoint {
    const q = this.readPointer(e);
    // У мыши нет нажима: 0.5 — знак для отрисовки подсказывать толщину скоростью руки.
    return { x: q.wx, y: q.wy, p: e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 0.5 };
  }

  private startDraw(e: PointerEvent, tool: 'pen' | 'marker'): void {
    const preset = this.presets[this.preset];
    this.gesture = {
      kind: 'draw',
      tool,
      color: tool === 'marker' ? this.markerColor : preset.color,
      size: tool === 'marker' ? this.markerSize : preset.size,
      smart: this.smart && tool === 'pen',
      points: [this.strokePoint(e)],
      predicted: [],
    };
  }

  private finishDraw(g: Extract<Gesture, { kind: 'draw' }>): void {
    const pts = g.points;
    if (!pts.length) return;
    if (g.smart) {
      const rec = recognize(pts, 30 / this.view.cam.zoom);
      if (rec?.kind === 'shape') {
        const item = makeShape(this.id(), rec.shape, round2(rec.x), round2(rec.y), round2(Math.max(rec.w, 10)), round2(Math.max(rec.h, 10)));
        this.store.transact('Фигура от руки', () => this.store.insert(item));
        this.select([item.id]);
        return;
      }
      if (rec?.kind === 'line') {
        // Прямая от объекта к объекту становится стрелкой между ними.
        const fromId = this.hitBox(rec.a), toId = this.hitBox(rec.b, fromId ?? undefined);
        const from: Endpoint = fromId ? { item: fromId } : { x: round2(rec.a.x), y: round2(rec.a.y) };
        const to: Endpoint = toId ? { item: toId } : { x: round2(rec.b.x), y: round2(rec.b.y) };
        const item = makeLine(this.id(), from, to, 'straight', fromId && toId ? 'arrow' : 'none');
        this.store.transact('Линия от руки', () => this.store.insert(item));
        this.select([item.id]);
        return;
      }
    }
    this.addStroke({ tool: g.tool, color: g.color, size: g.size }, pts);
  }

  /** Штрих ложится в последний рисунок, если тот рядом и нарисован только что; иначе начинается новый рисунок. */
  private addStroke(style: Pick<Stroke, 'tool' | 'color' | 'size'>, pts: StrokePoint[]): void {
    const pad = style.size / 2 + 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) {
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
    const bb = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
    const reach = 120 / this.view.cam.zoom;
    const recent = this.lastDrawing && Date.now() - this.lastDrawing.time < 6000 ? this.store.get(this.lastDrawing.id) : undefined;
    const last = recent?.kind === 'drawing' && recent.w === recent.vw && recent.h === recent.vh ? recent : null;

    if (last && rectsIntersect({ x: last.x - reach, y: last.y - reach, w: last.w + reach * 2, h: last.h + reach * 2 }, bb)) {
      const u = unionRect([last, bb])!;
      const ux = round2(u.x), uy = round2(u.y), uw = round2(u.w + (u.x - ux)), uh = round2(u.h + (u.y - uy));
      const strokes = last.strokes.map((st) => ({ ...st, pts: shiftPoints(st.pts, last.x - ux, last.y - uy) }));
      strokes.push({ ...style, pts: encodePoints(pts.map((q) => ({ x: q.x - ux, y: q.y - uy, p: q.p }))) });
      this.store.transact('Рисунок', () => this.store.update<DrawingItem>(last.id, { x: ux, y: uy, w: uw, h: uh, vw: uw, vh: uh, strokes }));
      this.lastDrawing = { id: last.id, time: Date.now() };
      return;
    }
    const x = round2(bb.x), y = round2(bb.y), w = round2(bb.w), h = round2(bb.h);
    const item: DrawingItem = {
      id: this.id(),
      kind: 'drawing',
      x, y, w, h, vw: w, vh: h,
      strokes: [{ ...style, pts: encodePoints(pts.map((q) => ({ x: q.x - x, y: q.y - y, p: q.p }))) }],
    };
    this.store.transact('Рисунок', () => this.store.insert(item));
    this.lastDrawing = { id: item.id, time: Date.now() };
  }

  private startErase(w: Point): void {
    this.store.beginGesture('Ластик');
    this.gesture = { kind: 'erase', last: w };
    this.eraseAlong(w, w);
  }

  /** Ластик стирает штрихи целиком — те, по которым провёл. Опустевший рисунок исчезает. */
  private eraseAlong(a: Point, b: Point): void {
    const r = 10 / this.view.cam.zoom;
    const area = { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, w: Math.abs(b.x - a.x) + r * 2, h: Math.abs(b.y - a.y) + r * 2 };
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / r));
    const probes = Array.from({ length: steps + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }));
    for (const item of this.view.search(area)) {
      if (item.kind !== 'drawing' || item.locked) continue;
      const all = drawingPoints(item);
      const keep = item.strokes.filter((st, i) => !probes.some((q) => nearStroke(all[i], q, r + st.size / 2)));
      if (keep.length === item.strokes.length) continue;
      this.store.live(() => {
        if (keep.length) this.store.update<DrawingItem>(item.id, { strokes: keep });
        else this.store.remove(item.id);
      });
    }
  }

  /** Лассо: выделить всё, что обвели петлёй. */
  private finishLasso(poly: Point[]): void {
    if (poly.length < 3) return;
    const r = unionRect(poly.map((q) => ({ x: q.x, y: q.y, w: 0, h: 0 })))!;
    const ids: string[] = [];
    for (const item of this.view.search(r)) {
      if (isLine(item)) {
        const geom = this.view.lineGeomOf(item);
        const pts = geom ? geomPoints(geom) : [];
        if (pts.length && inPolygon(pts[0], poly) && inPolygon(pts[pts.length - 1], poly)) ids.push(item.id);
      } else if (inPolygon({ x: item.x + item.w / 2, y: item.y + item.h / 2 }, poly)) {
        ids.push(item.id);
      }
    }
    this.select(ids);
    this.setTool('select');
  }

  toggleCap(which: 'start' | 'end'): void {
    this.store.transact('Наконечник', () => {
      for (const id of this.selection) {
        const item = this.store.get(id);
        if (!item || !isLine(item)) continue;
        const cur = item[which] ?? (which === 'end' ? 'arrow' : 'none');
        this.store.update<LineItem>(id, { [which]: cur === 'none' ? 'arrow' : 'none' });
      }
    });
  }

  bringToFront(): void {
    const ids = [...this.selection].sort((a, b) => this.store.indexOf(a) - this.store.indexOf(b));
    this.store.transact('На передний план', () => {
      for (const id of ids) this.store.moveToIndex(id, this.store.items.length - 1);
    });
  }

  sendToBack(): void {
    const ids = [...this.selection].sort((a, b) => this.store.indexOf(b) - this.store.indexOf(a));
    this.store.transact('На задний план', () => {
      for (const id of ids) this.store.moveToIndex(id, 0);
    });
  }

  undo(): void {
    if (this.text.activeId) this.text.close('outside');
    this.store.undo();
  }

  redo(): void {
    if (this.text.activeId) this.text.close('outside');
    this.store.redo();
  }

  // ---------- копирование ----------

  /**
   * Копии объектов со сдвигом. Линии между копируемыми объектами переподключаются к копиям,
   * а конец линии у объекта, который не копируется, становится свободной точкой.
   */
  private cloneInto(items: Item[], dx: number, dy: number): string[] {
    const map = new Map<string, string>();
    for (const item of items) map.set(item.id, this.id());
    const out: string[] = [];
    const remap = (ep: Endpoint, line: LineItem, which: 'from' | 'to'): Endpoint => {
      if ('item' in ep) {
        const to = map.get(ep.item);
        if (to) return { ...ep, item: to };
        const geom = this.view.lineGeomOf(line);
        const pts = geom ? geomPoints(geom) : [];
        const p = which === 'from' ? pts[0] : pts[pts.length - 1];
        return p ? { x: round2(p.x + dx), y: round2(p.y + dy) } : ep;
      }
      return { x: round2(ep.x + dx), y: round2(ep.y + dy) };
    };
    for (const item of items) {
      const id = map.get(item.id)!;
      const copy: Item = isLine(item)
        ? { ...item, id, from: remap(item.from, item, 'from'), to: remap(item.to, item, 'to') }
        : { ...item, id, x: round2(item.x + dx), y: round2(item.y + dy) };
      this.store.insert(copy, copy.kind === 'frame' ? 0 : undefined);
      out.push(id);
    }
    return out;
  }

  /** Разложить загруженные файлы рядом друг с другом по центру точки. Фото — в натуральных пропорциях. */
  placeFiles(files: { path: string; name: string; pw?: number; ph?: number }[], at: Point): void {
    if (!files.length) return;
    const gap = 40;
    const sized = files.map((f) => {
      if (f.pw && f.ph) {
        // Крупное фото ложится не больше 1000 точек доски по длинной стороне; качество от этого не теряется —
        // вблизи показывается оригинал.
        const k = Math.min(1, 1000 / Math.max(f.pw, f.ph));
        return { f, w: round2(f.pw * k), h: round2(f.ph * k) };
      }
      return { f, w: 260, h: 120 };
    });
    const total = sized.reduce((sum, s) => sum + s.w, 0) + gap * (sized.length - 1);
    const maxH = Math.max(...sized.map((s) => s.h));
    let x = at.x - total / 2;
    const ids: string[] = [];
    this.store.transact('Фото', () => {
      for (const s of sized) {
        const id = this.id();
        const base = { id, x: round2(x), y: round2(at.y - maxH / 2), w: s.w, h: s.h };
        const item: BoxItem = s.f.pw && s.f.ph
          ? { ...base, kind: 'image', file: this.view.paths.toStored(s.f.path), pw: s.f.pw, ph: s.f.ph }
          : { ...base, kind: 'file', file: this.view.paths.toStored(s.f.path) };
        this.store.insert(item);
        ids.push(id);
        x += s.w + gap;
      }
    });
    this.select(ids);
  }

  /** Положить на доску карточку заметки с центром в точке. */
  placeDoc(path: string, at: Point): string {
    const w = 360, h = 440;
    const id = this.id();
    const file = this.view.paths.toStored(path);
    this.store.transact('Документ', () => this.store.insert({ id, kind: 'doc', file, x: round2(at.x - w / 2), y: round2(at.y - h / 2), w, h }));
    this.select([id]);
    return id;
  }

  /** Стикер, текст или карточку заменить на карточку заметки на том же месте и того же размера. */
  replaceWithDoc(id: string, path: string): void {
    const item = this.store.get(id);
    if (!isBox(item)) return;
    const next: BoxItem = { id: this.id(), kind: 'doc', file: this.view.paths.toStored(path), x: item.x, y: item.y, w: Math.max(item.w, 240), h: Math.max(item.h, 200), layer: layerOf(item) };
    const index = this.store.indexOf(id);
    this.store.transact('В документ', () => {
      // Прицепленные линии переносим на новую карточку, а не теряем.
      const lines = this.store.linesOf(id).map((lid) => this.store.get(lid) as LineItem);
      this.store.insert(next, index + 1);
      for (const l of lines) {
        const swap = (ep: Endpoint): Endpoint => ('item' in ep && ep.item === id ? { ...ep, item: next.id } : ep);
        this.store.update<LineItem>(l.id, { from: swap(l.from), to: swap(l.to) });
      }
      this.store.remove(id);
    });
    this.select([next.id]);
  }

  /** Файл выделенной карточки (документ, фото, другой файл) — для «Удалить файл». */
  selectedFile(): { kind: string; file: string } | null {
    if (this.selection.size !== 1) return null;
    const item = this.store.get([...this.selection][0]);
    return item && (item.kind === 'doc' || item.kind === 'image' || item.kind === 'file') ? { kind: item.kind, file: this.view.paths.toVault(item.file) } : null;
  }

  /** Убрать с доски все карточки этого файла (файл ушёл в корзину). */
  removeItemsWithFile(path: string): void {
    const ids = this.store.items.filter((i) => 'file' in i && this.view.paths.toVault(i.file) === path).map((i) => i.id);
    this.store.transact('Удаление файла', () => {
      for (const id of ids) this.store.remove(id);
    });
  }

  /** Документ из [[ссылки]] в стикере: карточка справа от стикера, стрелка от стикера к ней. */
  placeDocFrom(fromId: string, path: string): void {
    const from = this.view.rectOf(fromId);
    if (!from) return;
    const w = 360, h = 440;
    const id = this.id();
    this.store.transact('Документ из ссылки', () => {
      this.store.insert({ id, kind: 'doc', file: this.view.paths.toStored(path), x: round2(from.x + from.w + 120), y: round2(from.y + from.h / 2 - h / 2), w, h });
      this.store.insert(makeLine(this.id(), { item: fromId }, { item: id }, 'curve', 'arrow'));
    });
    this.select([id]);
  }

  /** Выделить объект и показать его на экране. */
  focusItem(id: string): void {
    const r = this.view.rectOf(id);
    if (!r) return;
    this.select([id]);
    this.view.fitRect(r, 120, 1);
  }

  /** Текст выделенного стикера/текста/карточки — для «превратить в документ». */
  selectedText(): { id: string; text: string } | null {
    if (this.selection.size !== 1) return null;
    const item = this.store.get([...this.selection][0]);
    return hasText(item) ? { id: item.id, text: item.text ?? '' } : null;
  }

  selectIds(ids: string[]): void {
    this.select(ids);
  }

  /** Всё, что сейчас можно выделить: без скрытых и закреплённых слоёв. */
  selectAll(): void {
    this.select(this.store.items.filter((i) => this.pickable(i)).map((i) => i.id));
  }

  private pickable(item: Item): boolean {
    return !this.view.isHidden(item) && !this.view.isLayerLocked(item);
  }

  // ---------- слои ----------

  layers(): LayerDef[] {
    return layersOf(this.store.doc);
  }

  get activeLayer(): string {
    return this.store.activeLayer;
  }

  /** Сделать слой активным: новые объекты, фото и вставки ложатся на него. */
  setActiveLayer(id: string): void {
    this.store.activeLayer = id;
    this.changed();
  }

  layerUsage(): Map<string, number> {
    const count = new Map<string, number>();
    for (const item of this.store.items) count.set(layerOf(item), (count.get(layerOf(item)) ?? 0) + 1);
    return count;
  }

  private setLayers(label: string, list: LayerDef[], extra?: () => void): void {
    this.store.transact(label, () => {
      extra?.();
      // Основной слой без настроек в файл не пишем — доска без слоёв остаётся такой же, как была.
      const clean = list.filter((l) => l.id !== BASE_LAYER || l.hidden || l.locked || l.name !== BASE_NAME);
      this.store.setProp('layers', clean.length ? clean : undefined);
    });
  }

  private patchLayer(id: string, change: Partial<LayerDef>, label: string): void {
    this.setLayers(label, this.layers().map((l) => {
      if (l.id !== id) return l;
      const next = { ...l, ...change };
      if (!next.hidden) delete next.hidden;
      if (!next.locked) delete next.locked;
      return next;
    }));
  }

  /** Новый слой; с `fromSelection` на него сразу переезжает выделенное. Слой становится активным. */
  addLayer(name: string, fromSelection = false): string {
    const id = this.id();
    const move = fromSelection ? [...this.selection] : [];
    this.setLayers('Новый слой', [...this.layers(), { id, name }], () => {
      for (const itemId of move) this.store.update(itemId, (item) => ({ ...item, layer: id }));
    });
    this.setActiveLayer(id);
    return id;
  }

  renameLayer(id: string, name: string): void {
    if (name.trim()) this.patchLayer(id, { name: name.trim() }, 'Переименовать слой');
  }

  toggleLayerHidden(id: string): void {
    const l = this.layers().find((x) => x.id === id);
    if (l) this.patchLayer(id, { hidden: !l.hidden }, l.hidden ? 'Показать слой' : 'Скрыть слой');
  }

  toggleLayerLocked(id: string): void {
    const l = this.layers().find((x) => x.id === id);
    if (l) this.patchLayer(id, { locked: !l.locked }, l.locked ? 'Открепить слой' : 'Закрепить слой');
  }

  /** Показать только этот слой; если он уже единственный видимый — показать все. */
  soloLayer(id: string): void {
    const list = this.layers();
    const alone = list.every((l) => (l.id === id) !== !!l.hidden);
    this.setLayers(alone ? 'Показать все слои' : 'Только этот слой', list.map((l) => {
      const next = { ...l };
      if (!alone && l.id !== id) next.hidden = true;
      else delete next.hidden;
      return next;
    }));
  }

  /** Удалить слой; его объекты переходят на основной слой. */
  deleteLayer(id: string): void {
    if (id === BASE_LAYER) return;
    const items = this.store.items.filter((i) => i.layer === id).map((i) => i.id);
    this.setLayers('Удалить слой', this.layers().filter((l) => l.id !== id), () => {
      for (const itemId of items) {
        this.store.update(itemId, (item) => {
          const next = { ...item };
          delete next.layer;
          return next;
        });
      }
    });
  }

  /** Перенести выделенное на слой. */
  moveSelectionToLayer(id: string): void {
    const ids = [...this.selection];
    this.store.transact('На слой', () => {
      for (const itemId of ids) {
        this.store.update(itemId, (item) => {
          if (layerOf(item) === id) return item;
          const next = { ...item };
          if (id) next.layer = id;
          else delete next.layer;
          return next;
        });
      }
    });
    this.changed();
  }

  /** Выделить все объекты слоя (скрытый слой сначала показывается). */
  selectLayer(id: string): void {
    const l = this.layers().find((x) => x.id === id);
    if (l?.hidden) this.toggleLayerHidden(id);
    this.select(this.store.items.filter((i) => layerOf(i) === id).map((i) => i.id));
  }

  /**
   * Слои поменялись: из выделения уходит всё, что стало невидимым или закреплённым;
   * если активный слой скрыт или закреплён, активным становится первый доступный — иначе новые объекты исчезали бы сразу.
   */
  private layersChanged(): void {
    for (const id of [...this.selection]) {
      const item = this.store.get(id);
      if (item && !this.pickable(item)) this.selection.delete(id);
    }
    const list = this.layers();
    const active = list.find((l) => l.id === this.store.activeLayer);
    if (!active || active.hidden || active.locked) {
      this.store.activeLayer = list.find((l) => !l.hidden && !l.locked)?.id ?? BASE_LAYER;
    }
  }

  /** Замок: закреплённый объект не двигается и не меняет размер, пока его не открепят. */
  toggleLock(): void {
    const items = [...this.selection].map((id) => this.store.get(id)).filter((i): i is Item => !!i);
    const lock = !items.every((i) => i.locked);
    this.store.transact(lock ? 'Закрепить' : 'Открепить', () => {
      for (const i of items) {
        this.store.update(i.id, (item) => {
          const next = { ...item };
          if (lock) next.locked = true;
          else delete next.locked;
          return next;
        });
      }
    });
    this.changed();
  }

  /** Копировать / вырезать из меню: браузер вызовет то же событие, что и Ctrl+C / Ctrl+X. */
  clipboardCommand(cmd: 'copy' | 'cut'): void {
    document.execCommand(cmd);
  }

  /** Вставить из меню — из системного буфера (браузер может спросить разрешение). */
  async pasteAt(at: Point): Promise<void> {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      let text = '';
      for (const it of items) {
        const image = it.types.find((t) => t.startsWith('image/'));
        if (image) files.push(new File([await it.getType(image)], `image.${image.split('/')[1]}`, { type: image }));
        else if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
      }
      if (files.length) this.onFiles?.(files, at);
      else if (text) this.pasteText(text, at);
    } catch {
      this.onNotice?.('Браузер не дал прочитать буфер — вставь через Ctrl+V');
    }
  }

  /** Середина экрана в координатах доски. */
  viewCenter(): Point {
    const { w, h } = this.view.screen;
    return this.view.screenToWorld(w / 2, h / 2);
  }

  duplicate(): void {
    const items = [...this.selection].map((id) => this.store.get(id)).filter((i): i is Item => !!i);
    if (!items.length) return;
    const r = this.selectionWorldRect();
    let ids: string[] = [];
    this.store.transact('Дубликат', () => {
      ids = this.cloneInto(items, (r?.w ?? 0) + 40, 0);
    });
    this.select(ids);
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (this.isTyping(e.target) || !this.selection.size) return;
    const ids = new Set(this.selection);
    // Вместе с рамкой копируется её содержимое.
    for (const id of [...ids]) {
      const f = this.store.get(id);
      if (f?.kind !== 'frame') continue;
      for (const inner of this.view.search(f)) if (!isLine(inner) && rectContains(f, inner)) ids.add(inner.id);
    }
    const items = this.store.items.filter((i) => ids.has(i.id));
    e.clipboardData?.setData('text/plain', JSON.stringify({ [CLIP_MARK]: 1, items }));
    e.preventDefault();
    if (cut) this.deleteSelection();
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.isTyping(e.target)) return;
    const data = e.clipboardData;
    if (!data) return;
    const files = [...data.files];
    if (files.length) {
      e.preventDefault();
      this.onFiles?.(files, this.cursorPoint());
      return;
    }
    const text = data.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    this.pasteText(text, this.cursorPoint());
  }

  /** Карточка ссылки у точки: сразу с адресом, через мгновение — с заголовком и обложкой. */
  createLinkAt(url: string, at: Point): void {
    // Видео сразу в пропорциях кадра 16:9; обычная ссылка — узкая карточка, дорастёт, когда придёт обложка.
    const video = !!embedUrl(url);
    const w = video ? 480 : LINK_W, h = video ? 270 : 110;
    const item: BoxItem = { id: this.id(), kind: 'link', url, x: round2(at.x - w / 2), y: round2(at.y - h / 2), w, h };
    this.store.transact('Ссылка', () => this.store.insert(item));
    this.select([item.id]);
    this.onUnfurl?.(item.id, url);
  }

  /** Заполнить карточку ссылки тем, что сервер нашёл на странице. Пути картинок — от корня базы. */
  applyUnfurl(id: string, data: { url: string; title?: string; description?: string; site?: string; image?: string; favicon?: string }): void {
    const item = this.store.get(id);
    if (!item || item.kind !== 'link') return;
    const w = item.w;
    // Высота в масштабе карточки: уменьшенная карточка остаётся уменьшенной и после обновления.
    const k = w / LINK_W;
    const h = embedUrl(data.url) ? Math.round((w * 9) / 16) : Math.round(((data.image ? Math.round(LINK_W * LINK_COVER) + 122 : 124) * k));
    this.store.transact('Карточка ссылки', () =>
      this.store.update(id, (it) => {
        const next = { ...it, url: data.url, w, h } as Record<string, unknown>;
        for (const k of ['title', 'description', 'site'] as const) if (data[k]) next[k] = data[k];
        if (data.image) next.image = this.view.paths.toStored(data.image);
        if (data.favicon) next.favicon = this.view.paths.toStored(data.favicon);
        return next as unknown as Item;
      }),
    );
  }

  /** Адрес выделенной карточки ссылки (для меню: открыть, обновить). */
  selectedLink(): { id: string; url: string } | null {
    if (this.selection.size !== 1) return null;
    const item = this.store.get([...this.selection][0]);
    return item?.kind === 'link' ? { id: item.id, url: item.url } : null;
  }

  /** Вставить текст: наш буфер (объекты доски) — копиями, адрес страницы — карточкой, остальное — текстом. */
  pasteText(text: string, at: Point): void {
    const trimmed = text.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed)) {
      this.createLinkAt(trimmed, at);
      return;
    }
    try {
      const clip = JSON.parse(text) as { items?: Item[] } & Record<string, unknown>;
      if (clip[CLIP_MARK] && Array.isArray(clip.items) && clip.items.length) {
        const boxes = clip.items.filter(isBox);
        const r = unionRect(boxes) ?? { x: at.x, y: at.y, w: 0, h: 0 };
        let ids: string[] = [];
        this.store.transact('Вставка', () => {
          ids = this.cloneInto(clip.items!, at.x - (r.x + r.w / 2), at.y - (r.y + r.h / 2));
        });
        this.select(ids);
        return;
      }
    } catch {
      // Не наш формат — вставим как текст.
    }
    const item = makeText(this.id(), round2(at.x), round2(at.y));
    item.text = text;
    // Длинный вставленный текст переносится по разумной ширине, короткий — одной строкой.
    const one = textBox(text, item.fontSize ?? 18);
    if (one.w > 640) item.wrap = 480;
    Object.assign(item, textBox(text, item.fontSize ?? 18, item.wrap));
    this.store.transact('Вставка текста', () => this.store.insert(item));
    this.select([item.id]);
  }

  // ---------- клавиатура ----------

  private isTyping(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.isTyping(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const code = e.code;
    const handled = (): void => {
      e.preventDefault();
      this.perf.noteInput(e.timeStamp);
    };

    if (code === 'Space') {
      if (!this.spaceDown) {
        this.spaceDown = true;
        if (!this.gesture) this.host.style.cursor = 'grab';
      }
      e.preventDefault();
      return;
    }

    if (ctrl) {
      if (code === 'KeyZ') { handled(); if (e.shiftKey) this.redo(); else this.undo(); }
      else if (code === 'KeyY') { handled(); this.redo(); }
      else if (code === 'KeyA') { handled(); this.selectAll(); }
      else if (code === 'KeyD') { handled(); this.duplicate(); }
      else if (code === 'KeyK') { handled(); this.onQuickOpen?.(); }
      else if (code === 'KeyB' && this.selection.size) { handled(); this.toggleFormat('bold'); }
      else if (code === 'KeyI' && this.selection.size) { handled(); this.toggleFormat('italic'); }
      else if (code === 'BracketRight') { handled(); this.bringToFront(); }
      else if (code === 'BracketLeft') { handled(); this.sendToBack(); }
      else if (code === 'Equal' || code === 'NumpadAdd') { handled(); this.zoomCenter(1.25); }
      else if (code === 'Minus' || code === 'NumpadSubtract') { handled(); this.zoomCenter(0.8); }
      return;
    }
    if (e.altKey) {
      const n = /^Digit([1-9])$/.exec(code);
      const name = n ? Object.keys(this.styles())[Number(n[1]) - 1] : undefined;
      if (name && this.selection.size) {
        handled();
        this.applyStyle(name);
      }
      return;
    }

    if (e.shiftKey && code === 'Digit1') { handled(); this.view.fitAll(); return; }
    if (e.shiftKey && code === 'Digit2') {
      handled();
      const r = this.selectionWorldRect();
      if (r) this.view.fitRect(r, 80, 2);
      return;
    }
    if (e.shiftKey && code === 'Digit0') { handled(); this.zoomCenter(1 / this.view.cam.zoom); return; }

    const nudge = e.shiftKey ? 10 : 1;
    switch (code) {
      case 'Escape':
        handled();
        if (this.gesture && this.store.inGesture) this.store.cancelGesture();
        this.gesture = null;
        this.setTool('select');
        this.select([]);
        break;
      case 'Delete':
      case 'Backspace':
        handled();
        this.deleteSelection();
        break;
      case 'Enter':
      case 'F2': {
        const only = this.selection.size === 1 ? this.store.get([...this.selection][0]) : undefined;
        if (only?.kind === 'frame') { handled(); this.editText(only.id, 'title'); }
        else if (only?.kind === 'image') { handled(); this.onOpenImage?.(only.id); }
        else if (only?.kind === 'link') {
          handled();
          if (embedUrl(only.url)) this.onPlayEmbed?.(only.id);
          else window.open(only.url, '_blank', 'noopener');
        }
        else if (only?.kind === 'doc') { handled(); this.onOpenDoc?.(this.view.paths.toVault(only.file), e.shiftKey ? 'edit' : 'read'); }
        else if (only && isLine(only)) { handled(); this.editText(only.id, 'label'); }
        else if (hasText(only)) { handled(); this.editText(only.id, 'text'); }
        break;
      }
      case 'ArrowLeft': handled(); this.nudge(-nudge, 0); break;
      case 'ArrowRight': handled(); this.nudge(nudge, 0); break;
      case 'ArrowUp': handled(); this.nudge(0, -nudge); break;
      case 'ArrowDown': handled(); this.nudge(0, nudge); break;
      case 'KeyV': handled(); this.setTool('select'); break;
      case 'KeyN': handled(); this.createStickyAt(this.cursorPoint()); break;
      case 'KeyT': handled(); this.createTextAt(this.cursorPoint()); break;
      case 'KeyR': handled(); this.createShapeAt(this.cursorPoint(), 'rect'); break;
      case 'KeyO': handled(); this.createShapeAt(this.cursorPoint(), 'ellipse'); break;
      case 'KeyL':
        handled();
        if (e.shiftKey) this.onLayers?.();
        else this.setTool('line', { path: 'straight', end: 'arrow' });
        break;
      case 'KeyF': handled(); this.setTool('frame'); break;
      case 'KeyP': handled(); this.setTool('pen'); break;
      case 'KeyM': handled(); this.setTool('marker'); break;
      case 'KeyE': handled(); this.setTool('eraser'); break;
      case 'KeyD': handled(); this.onCreateDoc?.(this.cursorPoint()); break;
      case 'KeyC':
        handled();
        if (e.shiftKey) this.onCommentsPanel?.();
        else this.setTool(this.tool === 'comment' ? 'select' : 'comment');
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      this.spaceDown = false;
      if (!this.gesture) this.host.style.cursor = this.tool === 'select' ? '' : 'crosshair';
    }
  }

  private zoomCenter(factor: number): void {
    const { w, h } = this.view.screen;
    this.view.zoomAt(w / 2, h / 2, factor);
  }

  private nudge(dx: number, dy: number): void {
    const step = 1 / Math.max(1, this.view.cam.zoom);
    this.store.transact('Сдвиг', () => {
      for (const b of this.selectedBoxes()) {
        if (!b.locked) this.store.update<BoxItem>(b.id, { x: round2(b.x + dx * step), y: round2(b.y + dy * step) });
      }
    });
  }

  // ---------- слой поверх доски ----------

  private paint(g: Graphics, marker: Graphics): void {
    const outline = (r: Rect, width: number, alpha = 1) => {
      const s = this.toScreenRect(r);
      g.rect(s.x, s.y, s.w, s.h).stroke({ width, color: BLUE, alpha });
    };
    const strokeLine = (item: LineItem, width: number, alpha: number) => {
      const geom = this.view.lineGeomOf(item);
      if (!geom) return;
      const pts = geomPoints(geom).map((p) => this.view.worldToScreen(p.x, p.y));
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.stroke({ width, color: BLUE, alpha });
    };

    // Подсветка под курсором.
    if (this.hover && !this.selection.has(this.hover) && !this.gesture) {
      const item = this.store.get(this.hover);
      if (item && isLine(item)) strokeLine(item, 2, 0.5);
      else if (item) outline(item.kind === 'frame' ? { ...item } : item, 1.5, 0.8);
    }

    // Выделение.
    const boxes = this.selectedBoxes();
    for (const b of boxes) outline(b, boxes.length === 1 ? 2 : 1, boxes.length === 1 ? 1 : 0.6);
    for (const id of this.selection) {
      const item = this.store.get(id);
      if (item && isLine(item)) strokeLine(item, 3, 0.35);
    }
    if (boxes.length > 1 && !this.text.activeId) outline(unionRect(boxes)!, 1.5);
    for (const h of this.handles()) {
      g.rect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE).fill(0xffffff).stroke({ width: 1.5, color: BLUE });
    }
    if (!this.gesture) {
      for (const d of this.connectDots()) g.circle(d.x, d.y, 5).fill(0xffffff).stroke({ width: 1.5, color: BLUE });
    }
    for (const e of this.lineEnds()) g.circle(e.x, e.y, 6).fill(0xffffff).stroke({ width: 2, color: BLUE });

    // Подсветка объектов, к которым прилипли: мягкая розовая «тень» и рамка — видно, с чем выровнялось.
    for (const r of this.snapHits) {
      const s = this.toScreenRect(r);
      g.roundRect(s.x - 3, s.y - 3, s.w + 6, s.h + 6, 4).fill({ color: 0xff3d8b, alpha: 0.08 }).stroke({ width: 1.5, color: 0xff3d8b, alpha: 0.7 });
    }
    for (const gd of this.guides) {
      const a = this.view.worldToScreen(gd.x1, gd.y1), b = this.view.worldToScreen(gd.x2, gd.y2);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0xff3d8b });
    }
    const gs = this.gesture;
    const z = this.view.cam.zoom;
    if (gs?.kind === 'draw') {
      const pts = [...gs.points, ...gs.predicted].map((q) => ({ ...this.view.worldToScreen(q.x, q.y), p: q.p }));
      if (gs.tool === 'marker') drawMarker(marker, pts, gs.size * z, markerColor(gs.color, this.view.backgroundNum));
      else drawStroke(g, { tool: gs.tool, color: gs.color, size: gs.size * z }, pts, false);
    } else if (gs?.kind === 'lasso' && gs.points.length > 1) {
      const pts = gs.points.map((q) => this.view.worldToScreen(q.x, q.y));
      g.poly(pts.flatMap((q) => [q.x, q.y]), true).fill({ color: BLUE, alpha: 0.05 }).stroke({ width: 1.5, color: BLUE, alpha: 0.8 });
    }
    if ((this.tool === 'eraser' || gs?.kind === 'erase') && this.pointer) {
      g.circle(this.pointer.sx, this.pointer.sy, 10).stroke({ width: 1.5, color: 0x5b5b5b });
    }
    if (gs?.kind === 'marquee') {
      const s = this.toScreenRect(rectFromPoints(gs.start, gs.end));
      g.rect(s.x, s.y, s.w, s.h).fill({ color: BLUE, alpha: 0.06 }).stroke({ width: 1, color: BLUE });
    } else if (gs?.kind === 'create') {
      const s = this.toScreenRect(rectFromPoints(gs.start, gs.end));
      if (s.w > 2 || s.h > 2) g.rect(s.x, s.y, s.w, s.h).fill({ color: BLUE, alpha: 0.05 }).stroke({ width: 1, color: BLUE, alpha: 0.8 });
    } else if (gs?.kind === 'line') {
      const rectOf = (id: string) => this.view.rectOf(id);
      const endEp: Endpoint = gs.target ? { item: gs.target } : { x: gs.end.x, y: gs.end.y };
      const toward = gs.target ? { x: rectOf(gs.target)!.x + rectOf(gs.target)!.w / 2, y: rectOf(gs.target)!.y + rectOf(gs.target)!.h / 2 } : gs.end;
      const a = resolveAnchor(gs.from, toward, rectOf);
      const fromCenter = 'item' in gs.from ? (() => { const r = rectOf((gs.from as { item: string }).item)!; return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; })() : gs.from;
      const b: Anchor | null = resolveAnchor(endEp, fromCenter, rectOf);
      if (a && b) {
        const pts = geomPoints(lineGeometry(a, b, this.tool === 'line' ? this.linePath : 'curve')).map((p) => this.view.worldToScreen(p.x, p.y));
        g.moveTo(pts[0].x, pts[0].y);
        for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
        g.stroke({ width: 2, color: BLUE });
      }
      if (gs.target) outline(this.view.rectOf(gs.target)!, 2);
    } else if (gs?.kind === 'endpoint' && gs.target) {
      outline(this.view.rectOf(gs.target)!, 2);
    }
  }
}
