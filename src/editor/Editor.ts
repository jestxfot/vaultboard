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
import type { BoxItem, EndCap, Endpoint, FrameItem, Item, LineItem, PathKind, ShapeKind, Side } from '../model/types.ts';
import { isLine } from '../model/types.ts';
import { makeFrame, makeLine, makeShape, makeSticky, makeText, newId, shapeSize, STICKY_SIZE } from '../model/factory.ts';
import { DEFAULT_STICKY } from '../format/colors.ts';
import type { BoardView } from '../render/BoardView.ts';
import type { PerfMonitor } from '../perf/monitor.ts';
import { type Anchor, geomBounds, lineGeometry, lineMidpoint, type Point, type Rect, resolveAnchor } from '../render/geometry.ts';
import { textBlockHeight } from '../render/draw.ts';
import { distToLine, geomPoints, inRect, rectContains, rectFromPoints, rectsIntersect, round2, unionRect } from './hit.ts';
import { type CloseReason, type EditField, TextEditor } from './TextEditor.ts';

export type Tool = 'select' | 'sticky' | 'text' | 'shape' | 'line' | 'frame';
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
  | { kind: 'pan'; lastX: number; lastY: number; moved: boolean; clearOnClick: boolean; downX: number; downY: number }
  | { kind: 'press'; id: string; downX: number; downY: number; start: Point; toggleOff: boolean; alt: boolean }
  | { kind: 'move'; start: Point; boxes: Map<string, Point>; lines: Map<string, LineItem> }
  | { kind: 'marquee'; start: Point; end: Point; base: Set<string> }
  | { kind: 'resize'; handle: Handle; start: Rect; boxes: Map<string, BoxItem>; aspect: boolean }
  | { kind: 'create'; tool: Tool; start: Point; end: Point }
  | { kind: 'line'; from: Endpoint; end: Point; target: string | null }
  | { kind: 'endpoint'; lineId: string; which: 'from' | 'to'; target: string | null };

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
}

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
    view.overlayPainter = (g) => this.paint(g);
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
      if (op.t === 'replace' && op.after.id === this.text.activeId && !isLine(op.after)) this.text.update(op.after);
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
    this.host.setPointerCapture(e.pointerId);
    e.preventDefault();

    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.startPan(p, false);
      return;
    }
    if (e.button !== 0) return;
    const w = { x: p.wx, y: p.wy };

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

    if (p.shift || p.ctrl) {
      this.gesture = { kind: 'marquee', start: w, end: w, base: p.shift ? new Set(this.selection) : new Set() };
      if (!p.shift) this.select([]);
      return;
    }
    this.startPan(p, true);
  }

  private startPan(p: PointerState, clearOnClick: boolean): void {
    this.gesture = { kind: 'pan', lastX: p.sx, lastY: p.sy, moved: false, clearOnClick, downX: p.sx, downY: p.sy };
    this.host.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent): void {
    this.pointer = this.readPointer(e);
    if (this.gesture) this.perf.noteInput(e.timeStamp);
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
        this.processMove(w, p.shift);
        break;
      }
      case 'move':
        this.processMove(w, p.shift);
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
        this.processResize(w, p.shift);
        break;
      case 'create':
        g.end = w;
        this.view.invalidateOverlay();
        break;
      case 'line':
        g.end = w;
        g.target = this.hitBox(w, 'item' in g.from ? g.from.item : undefined);
        this.view.invalidateOverlay();
        break;
      case 'endpoint': {
        const line = this.store.get(g.lineId) as LineItem | undefined;
        if (!line) break;
        const other = g.which === 'from' ? line.to : line.from;
        g.target = this.hitBox(w, 'item' in other ? other.item : undefined);
        const ep: Endpoint = g.target ? { item: g.target } : { x: round2(w.x), y: round2(w.y) };
        this.store.live(() => this.store.update<LineItem>(g.lineId, { [g.which]: ep }));
        break;
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId);
    this.processPointer();
    const g = this.gesture;
    this.gesture = null;
    this.host.style.cursor = this.tool === 'select' ? (this.spaceDown ? 'grab' : '') : 'crosshair';
    if (!g) return;
    const p = this.pointer ?? this.readPointer(e);
    const w = { x: p.wx, y: p.wy };

    switch (g.kind) {
      case 'pan':
        if (!g.moved && g.clearOnClick && !p.shift) this.select([]);
        break;
      case 'press':
        if (g.toggleOff) {
          this.selection.delete(g.id);
          this.changed();
        } else if (!p.shift && this.selection.size > 1) {
          this.select([g.id]);
        }
        break;
      case 'move':
      case 'resize':
      case 'endpoint':
        this.store.endGesture();
        break;
      case 'marquee':
        break;
      case 'create':
        this.finishCreate(g.tool, g.start, w);
        break;
      case 'line':
        this.finishLine(g.from, w, g.target);
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
    else if (item?.kind === 'doc') this.onOpenDoc?.(item.file, 'read');
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
      } else if (inRect(w, item)) {
        return item.id;
      }
    }
    return null;
  }

  /** Объект, к которому можно прицепить линию (не линия и не рамка — рамку тоже можно, но только за край). */
  private hitBox(w: Point, exclude?: string): string | null {
    const candidates = this.view.search({ x: w.x, y: w.y, w: 0, h: 0 });
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

  private selectionWorldRect(): Rect | null {
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
    this.gesture = { kind: 'move', start, boxes, lines };
  }

  private processMove(w: Point, axisLock: boolean): void {
    const g = this.gesture;
    if (g?.kind !== 'move') return;
    let dx = w.x - g.start.x, dy = w.y - g.start.y;
    if (axisLock) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
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
    const boxes = new Map(this.selectedBoxes().filter((b) => !b.locked).map((b) => [b.id, b]));
    const start = unionRect([...boxes.values()]);
    if (!start) return;
    const aspect = shift || [...boxes.values()].every((b) => b.kind === 'image');
    this.store.beginGesture('Размер');
    this.gesture = { kind: 'resize', handle, start, boxes, aspect };
  }

  private processResize(w: Point, shift: boolean): void {
    const g = this.gesture;
    if (g?.kind !== 'resize') return;
    const s = g.start;
    let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
    if (g.handle.includes('w')) x0 = Math.min(w.x, x1 - 10);
    if (g.handle.includes('e')) x1 = Math.max(w.x, x0 + 10);
    if (g.handle.includes('n')) y0 = Math.min(w.y, y1 - 10);
    if (g.handle.includes('s')) y1 = Math.max(w.y, y0 + 10);
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
        // Свободный текст за угол масштабируется целиком — вместе со шрифтом, как в Miro.
        if (o.kind === 'text' && corner && sx === sy) patch.fontSize = round2(Math.max(6, (o.fontSize ?? 18) * sx));
        if (o.kind === 'text' && !corner) patch.h = round2(textBlockHeight(o.text, patch.w!, o.fontSize ?? 18, 2));
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
    this.text.open(item, field, value);
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
        // Свободный текст растёт вниз по мере набора.
        if (item.kind === 'text') next.h = round2(textBlockHeight(value, item.w, item.fontSize ?? 18, 2));
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
          ? { ...base, kind: 'image', file: s.f.path, pw: s.f.pw, ph: s.f.ph }
          : { ...base, kind: 'file', file: s.f.path };
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
    this.store.transact('Документ', () => this.store.insert({ id, kind: 'doc', file: path, x: round2(at.x - w / 2), y: round2(at.y - h / 2), w, h }));
    this.select([id]);
    return id;
  }

  /** Стикер, текст или карточку заменить на карточку заметки на том же месте и того же размера. */
  replaceWithDoc(id: string, path: string): void {
    const item = this.store.get(id);
    if (!isBox(item)) return;
    const next: BoxItem = { id: this.id(), kind: 'doc', file: path, x: item.x, y: item.y, w: Math.max(item.w, 240), h: Math.max(item.h, 200) };
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
    const at = this.cursorPoint();
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
    item.h = round2(textBlockHeight(text, item.w, item.fontSize ?? 18, 2));
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
      else if (code === 'KeyA') { handled(); this.select(this.store.items.map((i) => i.id)); }
      else if (code === 'KeyD') { handled(); this.duplicate(); }
      else if (code === 'KeyK') { handled(); this.onQuickOpen?.(); }
      else if (code === 'BracketRight') { handled(); this.bringToFront(); }
      else if (code === 'BracketLeft') { handled(); this.sendToBack(); }
      else if (code === 'Equal' || code === 'NumpadAdd') { handled(); this.zoomCenter(1.25); }
      else if (code === 'Minus' || code === 'NumpadSubtract') { handled(); this.zoomCenter(0.8); }
      return;
    }
    if (e.altKey) return;

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
        else if (only?.kind === 'doc') { handled(); this.onOpenDoc?.(only.file, e.shiftKey ? 'edit' : 'read'); }
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
      case 'KeyL': handled(); this.setTool('line', { path: 'straight', end: 'arrow' }); break;
      case 'KeyF': handled(); this.setTool('frame'); break;
      case 'KeyD': handled(); this.onCreateDoc?.(this.cursorPoint()); break;
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

  private paint(g: Graphics): void {
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

    const gs = this.gesture;
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
