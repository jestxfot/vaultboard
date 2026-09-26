// Отрисовка доски через WebGL (PixiJS).
//
// Почему быстро:
// - рисуем только когда что-то изменилось (нет постоянного цикла);
// - вся доска — одна группа отрисовки: сдвиг и зум камеры применяет видеокарта одной матрицей;
// - пространственный индекс отдаёт только объекты в пределах экрана, остальные скрыты;
// - два уровня детализации: издалека объект — цветной прямоугольник-спрайт (почти бесплатно),
//   вблизи — полноценная фигура с текстом;
// - полноценные фигуры и тексты строятся очередью с лимитом на кадр, чтобы не было рывков.
//   Пока объект строится, на его месте виден цветной прямоугольник — дыр не бывает;
// - правки применяются точечно: меняется только тронутый объект и прицепленные к нему линии.
import { Application, Container, Graphics, HTMLText, Rectangle, RenderTexture, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import RBush from 'rbush';
import type { Background, BoardDoc, BoxItem, DocItem, ImageItem, Item, LineItem } from '../model/types.ts';
import { resolveLook } from '../model/look.ts';
import { hexToNum, isDark } from '../format/colors.ts';
import type { DocCache } from '../io/files.ts';
import type { Markdown } from '../format/markdown.ts';
import { BoardPaths } from '../model/paths.ts';
import { isLine } from '../model/types.ts';
import type { Op } from '../model/store.ts';
import type { PerfMonitor } from '../perf/monitor.ts';
import { dashPattern, dashPolyline, drawBox, drawLine, farColor, FONT, labelSpec, type LabelSpec, makeLabel } from './draw.ts';
import { ImageCache, type Level } from './images.ts';
import { endpointCenter, geomBounds, type LineGeom, lineGeometry, lineMidpoint, type Rect, resolveAnchor, samplePath } from './geometry.ts';

export interface Camera {
  /** Где на экране (в CSS-пикселях) находится точка доски (0,0). */
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

/** Оформление markdown на карточке документа. Классы с префиксом, чтобы не задеть страницу. */
const CARD_CSS = [
  '.vbmd{overflow:hidden;font-size:14px;line-height:1.45;color:#1f1f1f;word-wrap:break-word}',
  '.vbmd>*:first-child{margin-top:0}',
  '.vbmd h1{font-size:21px;margin:0 0 6px;font-weight:700}',
  '.vbmd h2{font-size:18px;margin:10px 0 4px;font-weight:700}',
  '.vbmd h3,.vbmd h4{font-size:15px;margin:8px 0 3px;font-weight:700}',
  '.vbmd p{margin:0 0 6px}',
  '.vbmd ul,.vbmd ol{margin:0 0 6px;padding-left:20px}',
  '.vbmd blockquote{margin:0 0 6px;padding-left:10px;border-left:3px solid #d4d4d4;color:#555}',
  '.vbmd code{background:#f1f1ef;border-radius:3px;padding:0 3px;font-family:Consolas,monospace;font-size:12px}',
  '.vbmd pre{background:#f1f1ef;padding:6px;border-radius:4px;white-space:pre-wrap}',
  '.vbmd mark{background:#fff3a3}',
  '.vbmd a,.vbmd .wikilink{color:#4262ff;text-decoration:none}',
  '.vbmd .unresolved{color:#8a94d6}',
  '.vbmd table{border-collapse:collapse}.vbmd td,.vbmd th{border:1px solid #ddd;padding:2px 5px}',
  '.vbmd .embed{color:#6b6b6b}',
].join('');

/** Сколько миллисекунд кадра можно тратить на отложенную работу. */
const FRAME_BUDGET_MS = 5;
/**
 * Сколько полноценных фигур строить за кадр. Лимит по штукам, а не только по времени:
 * фигура дорога не при построении, а при первой отрисовке (разбиение на треугольники), которую бюджет не видит.
 */
const NEAR_BUILDS_PER_FRAME = 40;
const LABELS_PER_FRAME = 12;
/** Объект рисуется полноценно, когда его меньшая сторона на экране не меньше стольких пикселей. */
const NEAR_PX = 28;
/**
 * Линия издалека не исчезает: на экране она не тоньше стольких пикселей, как в Miro.
 * Толщина подстраивается ступенями масштаба (×2) и только когда камера остановилась.
 */
const LINE_MIN_PX = 1.5;
/**
 * Ниже этого масштаба все линии рисуются одним общим графическим объектом упрощённой формы:
 * стрелки и пунктир отсюда всё равно не различить, а полторы тысячи отдельных объектов стоили бы
 * процессору ~10 мс на каждый кадр. Один общий объект строится, когда камера остановилась.
 */
const FAR_LINES_ZOOM = 0.25;
const LINE_LABEL_FONT = 14;
/** Экранный размер шрифта, ниже которого текст не рисуем. */
const MIN_TEXT_PX = 5.5;
/** Сколько текстов держать в памяти видеокарты, не считая видимых. */
const MAX_LABELS = 2500;
const SETTLE_MS = 150;
/**
 * Текст издалека не пропадает: пока объект виден вблизи, с него снимается маленькая картинка
 * (≈96 px по длинной стороне) со всем текстом и оформлением. Издалека показывается она —
 * для видеокарты это такой же дешёвый прямоугольник, только с текстурой.
 */
const SNAPSHOT_PX = 96;
const MAX_SNAPSHOTS = 3000;

interface Entry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  view: ItemView;
}

class ItemView {
  readonly container = new Container();
  item: Item;
  spec: LabelSpec | null;
  entry: Entry | null = null;
  /** Дальний вид: цветной прямоугольник. */
  far: Sprite | null = null;
  /** Ближний вид: полноценная фигура. */
  gfx: Graphics | null = null;
  label: Text | null = null;
  labelRes = 0;
  title: Text | null = null;
  /** Само фото (для объектов-картинок), когда загружен хоть один уровень. */
  photo: Sprite | null = null;
  /** Ступень масштаба, под которую построена линия (её видимая толщина). */
  lineStep = 0;
  /** Маленький снимок объекта с текстом — показывается издалека вместо серого прямоугольника. */
  snapshot: Texture | null = null;
  /** Текст документа на карточке (отформатированный markdown). */
  body: HTMLText | null = null;
  bodyRes = 0;

  constructor(item: Item) {
    this.item = item;
    this.container.visible = false;
    if (!isLine(item)) this.container.position.set(item.x, item.y);
    this.spec = null;
  }
}

export interface ViewStats {
  total: number;
  visible: number;
  near: number;
  labels: number;
  queued: number;
}

type Task = () => void;

/** Меняются ли у объекта только координаты — тогда его не надо перестраивать, достаточно сдвинуть. */
function onlyMoved(a: Item, b: Item): boolean {
  if (isLine(a) || isLine(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (k === 'x' || k === 'y') continue;
    if ((a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export class BoardView {
  readonly app = new Application();
  readonly cam: Camera = { x: 0, y: 0, zoom: 1 };
  /** Вызывается после каждого кадра, в котором сдвинулась камера или доска. */
  onCamera: (() => void) | null = null;
  /** Автопилот замера: двигает камеру каждый кадр, пока задан. */
  driver: ((t: number) => void) | null = null;
  /** Вызывается в начале каждого кадра — редактор применяет здесь накопленное движение мыши. */
  beforeFrame: (() => void) | null = null;
  /** Рисует слой поверх доски (выделение, ручки) в экранных координатах. */
  overlayPainter: ((g: Graphics) => void) | null = null;
  /** Какие линии прицеплены к объекту — берётся из хранилища. */
  linesOf: (id: string) => string[] = () => [];

  /** Текстуры фото. */
  images!: ImageCache;
  /** Как пути в доске переводятся в пути от корня базы. Задаётся перед load(). */
  paths = new BoardPaths('');
  private docs: DocCache | null = null;
  private markdown: Markdown | null = null;

  private readonly host: HTMLElement;
  private readonly perf: PerfMonitor;
  /** Открытая доска — отсюда берутся её стили и фон (хранилище меняет их на месте). */
  private doc: BoardDoc | null = null;
  private gridKind = '';
  private darkBackground = false;
  /** Файл (фото или заметка) → объекты доски, которые его показывают. */
  private readonly fileViews = new Map<string, Set<ItemView>>();
  /** Камера сейчас движется — оригиналы фото не грузим, пока не остановится. */
  private moving = false;
  private readonly world = new Container({ isRenderGroup: true });
  private readonly overlay = new Graphics();
  /** Клетка как в Miro: линии рисуются в пикселях экрана, всегда ровно в 1 пиксель. */
  private readonly gridLines = new Graphics();
  private gridMode = 'dots';
  private gridInk = 0xd6d6d2;
  /** Все линии одним объектом — для вида издалека. */
  private farLines: Graphics | null = null;
  private farLinesStep = 0;
  private farLinesDirty = true;
  private grid!: TilingSprite;
  private readonly rects = new Map<string, Rect>();
  private readonly views = new Map<string, ItemView>();
  private readonly index = new RBush<Entry>();
  private visible = new Set<ItemView>();
  // Три очереди отложенной работы: полноценные фигуры, тексты и прочее (смена разрешения текстов).
  private readonly nearQueue = new Map<ItemView, Task>();
  private readonly labelQueue = new Map<ItemView, Task>();
  private readonly miscQueue = new Map<string, Task>();
  private bounds: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Границы доски нужны только для «показать всю доску» — считаем их по требованию, а не после каждой правки. */
  private boundsDirty = true;
  private nearCount = 0;
  private snapshotCount = 0;
  private labelCount = 0;
  private camDirty = true;
  private overlayDirty = true;
  private editingId: string | null = null;
  private raf = 0;
  private settleTimer = 0;
  private resizeObserver: ResizeObserver | null = null;

  private constructor(host: HTMLElement, perf: PerfMonitor) {
    this.host = host;
    this.perf = perf;
  }

  static async create(host: HTMLElement, perf: PerfMonitor): Promise<BoardView> {
    const view = new BoardView(host, perf);
    await view.init();
    return view;
  }

  private async init(): Promise<void> {
    await this.app.init({
      resizeTo: this.host,
      autoStart: false,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      background: '#f7f7f5',
      preference: 'webgl',
    });
    // Ввод обрабатываем сами, система событий Pixi не нужна: она обходила бы тысячи объектов.
    this.app.stage.eventMode = 'none';
    this.host.appendChild(this.app.canvas);

    let maxTexture = 4096;
    try {
      const gl = (this.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
      if (gl) maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    } catch {
      // Не WebGL — оставим безопасное значение.
    }
    this.images = new ImageCache(maxTexture);
    this.images.onLoaded = (file) => {
      for (const v of this.fileViews.get(file) ?? []) if (this.visible.has(v)) this.updateDetail(v);
      this.requestFrame();
    };

    this.grid = new TilingSprite({ texture: dotTexture(), width: 1, height: 1 });
    this.app.stage.addChild(this.grid, this.gridLines, this.world, this.overlay);

    this.resizeObserver = new ResizeObserver(() => {
      this.app.resize();
      this.camDirty = true;
      this.requestFrame();
    });
    this.resizeObserver.observe(this.host);
  }

  get screen(): { w: number; h: number } {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  /** Время работы последнего кадра на процессоре, мс. */
  get lastCpu(): number {
    return this.perf.lastCpu;
  }

  get stats(): ViewStats {
    return {
      total: this.views.size,
      visible: this.visible.size,
      near: this.nearCount,
      labels: this.labelCount,
      queued: this.nearQueue.size + this.labelQueue.size + this.miscQueue.size,
    };
  }

  // ---------- загрузка и правки ----------

  load(doc: BoardDoc, fit = true): void {
    this.doc = doc;
    this.farLines = null;
    this.applyBackground(doc.background);
    for (const child of this.world.removeChildren()) child.destroy({ children: true });
    this.rects.clear();
    this.views.clear();
    this.index.clear();
    this.visible = new Set();
    this.nearQueue.clear();
    this.labelQueue.clear();
    this.miscQueue.clear();
    this.nearCount = 0;
    this.labelCount = 0;
    this.editingId = null;

    for (const item of doc.items) {
      if (!isLine(item)) this.rects.set(item.id, { x: item.x, y: item.y, w: item.w, h: item.h });
    }

    // Контейнеры добавляются в порядке объектов — это и есть порядок слоёв, сортировка не нужна.
    const entries: Entry[] = [];
    this.fileViews.clear();
    for (const item of doc.items) {
      const view = this.newView(item);
      this.world.addChild(view.container);
      const entry = this.makeEntry(view);
      if (entry) entries.push(entry);
    }
    this.index.load(entries);
    this.boundsDirty = true;
    this.farLinesDirty = true;
    if (fit) this.fitAll();
    else this.cameraMoved();
  }

  /** Применить правки хранилища. Порядок операций тот же, что в хранилище. */
  apply(ops: Op[]): void {
    const touched = new Set<string>();
    let stylesChanged = false;
    let darkChanged = false;
    for (const op of ops) {
      if (op.t === 'prop') {
        if (op.key === 'styles') stylesChanged = true;
        if (op.key === 'background') {
          const wasDark = this.darkBackground;
          this.applyBackground(this.doc?.background);
          darkChanged = wasDark !== this.darkBackground;
        }
        continue;
      }
      if (op.t === 'insert') {
        const v = this.newView(op.item);
        this.world.addChildAt(v.container, op.index);
        if (!isLine(op.item)) this.rects.set(op.item.id, { x: op.item.x, y: op.item.y, w: op.item.w, h: op.item.h });
        touched.add(op.item.id);
      } else if (op.t === 'delete') {
        const v = this.views.get(op.item.id);
        if (v) this.destroyView(v);
        this.views.delete(op.item.id);
        this.rects.delete(op.item.id);
        touched.delete(op.item.id);
        for (const lineId of this.linesOf(op.item.id)) touched.add(lineId);
      } else {
        const old = this.views.get(op.after.id);
        if (!old) continue;
        const after = op.after;
        if (!isLine(after)) this.rects.set(after.id, { x: after.x, y: after.y, w: after.w, h: after.h });
        if (onlyMoved(old.item, after) && !isLine(after)) {
          old.item = after;
          old.container.position.set(after.x, after.y);
        } else {
          // Вид объекта поменялся — строим его заново на том же месте в порядке слоёв.
          const at = this.world.getChildIndex(old.container);
          this.destroyView(old);
          const v = this.newView(after);
          this.world.addChildAt(v.container, at);
        }
        touched.add(after.id);
      }
    }

    // Стиль поменялся — перестраиваем все объекты с каким-либо стилем на том же месте в порядке слоёв.
    if (stylesChanged || darkChanged) {
      for (const old of [...this.views.values()]) {
        // Смена стилей — перестроить объекты со стилем; светлый/тёмный фон — текст и линии.
        const affected = (stylesChanged && old.item.style) || (darkChanged && (old.item.kind === 'text' || old.item.kind === 'line'));
        if (!affected) continue;
        const at = this.world.getChildIndex(old.container);
        const item = old.item;
        this.destroyView(old);
        const v = this.newView(item);
        this.world.addChildAt(v.container, at);
        touched.add(item.id);
      }
    }

    // Линии, прицепленные к тронутым объектам, тоже надо перерисовать.
    const lines = new Set<string>();
    for (const id of touched) {
      const v = this.views.get(id);
      if (v && isLine(v.item)) lines.add(id);
      for (const lineId of this.linesOf(id)) lines.add(lineId);
    }
    for (const id of lines) {
      const v = this.views.get(id);
      if (v?.gfx) {
        v.gfx.destroy();
        v.gfx = null;
        this.nearCount--;
      }
      if (v?.label) {
        v.label.destroy();
        v.label = null;
        this.labelCount--;
      }
    }
    if (lines.size) this.farLinesDirty = true;
    // Немного правок — переставляем объекты в индексе по одному. Много (выделили всё и тащат) —
    // быстрее пересобрать индекс целиком одной пачкой.
    if (touched.size + lines.size > 300) {
      this.index.clear();
      const entries: Entry[] = [];
      for (const v of this.views.values()) {
        const e = this.makeEntry(v);
        if (e) entries.push(e);
      }
      this.index.load(entries);
    } else {
      for (const id of touched) {
        const v = this.views.get(id);
        if (v && !isLine(v.item)) this.reindex(v);
      }
      for (const id of lines) {
        const v = this.views.get(id);
        if (v) this.reindex(v);
      }
    }

    // Тронутые видимые объекты достраиваем сразу, без очереди: правка должна быть видна в этом же кадре.
    this.updateVisible();
    for (const id of [...touched, ...lines]) {
      const v = this.views.get(id);
      if (v && this.visible.has(v)) this.buildNow(v);
    }
    this.boundsDirty = true;
    this.overlayDirty = true;
    this.requestFrame();
  }

  /** Источник текстов документов: карточки показывают их содержимое и обновляются, когда заметка меняется. */
  setDocs(docs: DocCache, markdown: Markdown): void {
    this.docs = docs;
    this.markdown = markdown;
    docs.onChange((path) => {
      for (const v of this.fileViews.get(path) ?? []) {
        this.dropBody(v);
        if (this.visible.has(v)) this.updateDetail(v);
      }
      this.requestFrame();
    });
  }

  private dropBody(v: ItemView): void {
    this.dropSnapshot(v);
    if (!v.body) return;
    v.body.destroy();
    v.body = null;
  }

  private dropSnapshot(v: ItemView): void {
    if (!v.snapshot) return;
    if (v.far && v.far.texture === v.snapshot) {
      v.far.texture = Texture.WHITE;
      if (!isLine(v.item)) {
        v.far.tint = farColor(this.look(v.item));
        v.far.setSize(v.item.w, v.item.h);
      }
    }
    v.snapshot.destroy(true);
    v.snapshot = null;
    this.snapshotCount--;
  }

  /** Снять маленькую картинку объекта вместе с текстом — для вида издалека. */
  private makeSnapshot(v: ItemView): void {
    if (v.snapshot || isLine(v.item) || !v.gfx?.visible || !this.visible.has(v)) return;
    if (!v.label?.visible && !v.body?.visible) return;
    const item = v.item;
    const res = Math.min(2, SNAPSHOT_PX / Math.max(item.w, item.h, 1));
    const farWas = v.far?.visible;
    if (v.far) v.far.visible = false;
    v.snapshot = this.app.renderer.generateTexture({ target: v.container, resolution: res, frame: new Rectangle(0, 0, item.w, item.h) });
    if (v.far && farWas) v.far.visible = true;
    this.snapshotCount++;
  }

  /** Объект со стилем доски: так он и рисуется. */
  look<T extends Item>(item: T): T {
    const look = resolveLook(item, this.doc?.styles);
    // На тёмном фоне текст и линии без явно заданного цвета становятся светлыми — иначе их не видно.
    if (this.darkBackground) {
      if (look.kind === 'text' && !look.textColor) return { ...look, textColor: '#ececec' };
      if (look.kind === 'line' && !look.color) return { ...look, color: '#a9a9a6' };
    }
    return look;
  }

  private newView(item: Item): ItemView {
    const v = new ItemView(item);
    v.spec = isLine(item) ? null : labelSpec(this.look(item));
    this.views.set(item.id, v);
    if (item.kind === 'image' || item.kind === 'doc') {
      const file = this.paths.toVault(item.file);
      let set = this.fileViews.get(file);
      if (!set) this.fileViews.set(file, (set = new Set()));
      set.add(v);
    }
    return v;
  }

  private makeEntry(v: ItemView): Entry | null {
    const r = isLine(v.item) ? this.lineBounds(v.item) : this.rects.get(v.item.id);
    if (!r) return null;
    v.entry = { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h, view: v };
    return v.entry;
  }

  private reindex(v: ItemView): void {
    if (v.entry) this.index.remove(v.entry);
    const e = this.makeEntry(v);
    if (e) this.index.insert(e);
  }

  private destroyView(v: ItemView): void {
    if (v.entry) this.index.remove(v.entry);
    this.visible.delete(v);
    this.nearQueue.delete(v);
    this.labelQueue.delete(v);
    if (v.gfx) this.nearCount--;
    if (v.label) this.labelCount--;
    if (v.snapshot) {
      v.snapshot.destroy(true);
      v.snapshot = null;
      this.snapshotCount--;
    }
    if (v.item.kind === 'image' || v.item.kind === 'doc') this.fileViews.get(this.paths.toVault(v.item.file))?.delete(v);
    // Текстуры фото общие и живут в кэше — спрайт уничтожается без них.
    v.container.destroy({ children: true });
  }

  private recomputeBounds(): void {
    this.boundsDirty = false;
    const all = this.index.all();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of all) {
      x0 = Math.min(x0, e.minX); y0 = Math.min(y0, e.minY);
      x1 = Math.max(x1, e.maxX); y1 = Math.max(y1, e.maxY);
    }
    this.bounds = all.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
  }

  // ---------- запросы для редактора ----------

  /** Объекты, чьи границы пересекают прямоугольник доски. */
  search(r: Rect): Item[] {
    return this.index.search({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h }).map((e) => e.view.item);
  }

  rectOf(id: string): Rect | undefined {
    return this.rects.get(id);
  }

  lineGeomOf(item: LineItem): LineGeom | null {
    return this.lineGeom(item);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.cam.x) / this.cam.zoom, y: (sy - this.cam.y) / this.cam.zoom };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx * this.cam.zoom + this.cam.x, y: wy * this.cam.zoom + this.cam.y };
  }

  invalidateOverlay(): void {
    this.overlayDirty = true;
    this.requestFrame();
  }

  /** Текст объекта, который сейчас редактируется, не рисуем — поверх него стоит поле ввода. */
  setEditing(id: string | null): void {
    const prev = this.editingId ? this.views.get(this.editingId) : undefined;
    this.editingId = id;
    if (prev) this.updateDetail(prev);
    const cur = id ? this.views.get(id) : undefined;
    if (cur?.label) cur.label.visible = false;
    this.requestFrame();
  }

  private lineGeom(item: LineItem): LineGeom | null {
    const rectOf = (id: string) => this.rects.get(id);
    const ca = endpointCenter(item.from, rectOf);
    const cb = endpointCenter(item.to, rectOf);
    if (!ca || !cb) return null;
    const a = resolveAnchor(item.from, cb, rectOf);
    const b = resolveAnchor(item.to, ca, rectOf);
    return a && b ? lineGeometry(a, b, this.look(item).path ?? 'curve') : null;
  }

  private lineBounds(item: LineItem): Rect | null {
    const g = this.lineGeom(item);
    return g ? geomBounds(g, 20) : null;
  }

  /**
   * Бесконечная клетка как в Miro: три уровня, каждый в 4 раза мельче предыдущего.
   * Прозрачность уровня зависит от того, сколько пикселей между его линиями на экране:
   * при 8 px уровень невидим, к 48 px — проявился полностью. При зуме мелкие клетки плавно
   * проявляются и сами становятся крупными — переходов не видно.
   */
  private drawGridLines(): void {
    const g = this.gridLines;
    g.clear();
    const { w, h } = this.screen;
    const { x, y, zoom } = this.cam;
    const base = 20;
    const k = Math.ceil(Math.log(8 / (base * zoom)) / Math.log(4));
    for (let level = 0; level < 3; level++) {
      const world = base * Math.pow(4, k + level);
      const px = world * zoom;
      const alpha = Math.min(1, Math.max(0, (px - 8) / 40)) * 0.55;
      if (alpha <= 0.01) continue;
      const x0 = ((x % px) + px) % px, y0 = ((y % px) + px) % px;
      for (let sx = x0; sx < w; sx += px) g.rect(Math.round(sx), 0, 1, h);
      for (let sy = y0; sy < h; sy += px) g.rect(0, Math.round(sy), w, 1);
      g.fill({ color: this.gridInk, alpha });
    }
  }

  // ---------- фон ----------

  /** Фон доски: цвет и сетка (точки, клетка или ничего), как в Miro. На тёмном фоне сетка светлее. */
  private applyBackground(bg: Background | undefined): void {
    const color = bg?.color ?? '#f7f7f5';
    const grid = bg?.grid ?? 'dots';
    this.app.renderer.background.color = color;
    this.darkBackground = isDark(color);
    this.farLinesDirty = true;
    const ink = this.darkBackground ? '#4a4a48' : '#cfcfcb';
    const key = `${grid}:${ink}`;
    if (key !== this.gridKind && this.grid) {
      this.gridKind = key;
      const old = this.grid.texture;
      this.grid.texture = gridTexture(grid, ink);
      if (old !== Texture.WHITE) old.destroy(true);
    }
    this.gridMode = grid;
    this.gridInk = this.darkBackground ? 0x3d414c : 0xcfcfca;
    // Точки — плиткой; клетка — отдельными линиями в пикселях экрана (см. drawGridLines).
    if (this.grid) this.grid.visible = grid === 'dots';
    this.gridLines.visible = grid === 'lines';
    this.camDirty = true;
    this.requestFrame();
  }

  // ---------- камера ----------

  setCamera(c: Partial<Camera>): void {
    if (c.zoom !== undefined) this.cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom));
    if (c.x !== undefined) this.cam.x = c.x;
    if (c.y !== undefined) this.cam.y = c.y;
    this.cameraMoved();
  }

  panBy(dx: number, dy: number): void {
    this.cam.x += dx;
    this.cam.y += dy;
    this.cameraMoved();
  }

  /** Зум к точке экрана: точка доски под курсором остаётся под курсором. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    const k = zoom / this.cam.zoom;
    this.cam.x = sx - (sx - this.cam.x) * k;
    this.cam.y = sy - (sy - this.cam.y) * k;
    this.cam.zoom = zoom;
    this.cameraMoved();
  }

  fitRect(r: Rect, padding = 60, maxZoom = 1): void {
    const { w, h } = this.screen;
    if (r.w <= 0 || r.h <= 0 || w <= 0 || h <= 0) {
      this.setCamera({ x: w / 2 - r.x, y: h / 2 - r.y, zoom: 1 });
      return;
    }
    const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((w - padding * 2) / r.w, (h - padding * 2) / r.h)));
    this.setCamera({ zoom, x: w / 2 - (r.x + r.w / 2) * zoom, y: h / 2 - (r.y + r.h / 2) * zoom });
  }

  fitAll(padding = 60, maxZoom = 1): void {
    this.fitRect(this.boardBounds, padding, maxZoom);
  }

  get boardBounds(): Rect {
    if (this.boundsDirty) this.recomputeBounds();
    return this.bounds;
  }

  private cameraMoved(): void {
    this.moving = true;
    this.camDirty = true;
    this.requestFrame();
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS);
  }

  // ---------- кадр ----------

  requestFrame(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  /** Отрисовать кадр прямо сейчас, без ожидания браузера. Для замеров процессорного времени. */
  renderNow(): number {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const start = performance.now();
    this.frame(start);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    return performance.now() - start;
  }

  private readonly frame = (t: number): void => {
    this.raf = 0;
    const start = performance.now();
    this.driver?.(t);
    this.beforeFrame?.();
    const moved = this.camDirty;
    if (this.camDirty) {
      this.camDirty = false;
      this.applyCamera();
      this.updateVisible();
    }
    if (moved || this.overlayDirty) {
      this.overlayDirty = false;
      this.overlay.clear();
      this.overlayPainter?.(this.overlay);
    }
    this.runQueues(start + FRAME_BUDGET_MS);
    this.app.render();
    this.perf.frameDone(performance.now() - start);
    this.onCamera?.();
    if (this.nearQueue.size || this.labelQueue.size || this.miscQueue.size || this.driver) this.requestFrame();
  };

  private applyCamera(): void {
    const { x, y, zoom } = this.cam;
    if (this.farLines) this.farLines.visible = zoom < FAR_LINES_ZOOM;
    // Первый раз ушли в даль — общий объект нужен сразу, не дожидаясь остановки камеры.
    if (zoom < FAR_LINES_ZOOM && !this.farLines) this.updateFarLines();
    this.world.position.set(x, y);
    this.world.scale.set(zoom);

    if (this.gridMode === 'lines') this.drawGridLines();

    // Точечная сетка как в Miro: шаг меняется ступенями ×4, чтобы на экране он всегда был 16–64 px.
    const base = 32;
    const level = Math.ceil(Math.log(16 / (base * zoom)) / Math.log(4));
    const step = Math.pow(4, level);
    const { w, h } = this.screen;
    this.grid.width = w;
    this.grid.height = h;
    this.grid.tileScale.set(zoom * step);
    this.grid.tilePosition.set(x, y);
  }

  private viewRect(margin: number): Rect {
    const { w, h } = this.screen;
    const z = this.cam.zoom;
    const mw = (w * margin) / z, mh = (h * margin) / z;
    return { x: -this.cam.x / z - mw, y: -this.cam.y / z - mh, w: w / z + 2 * mw, h: h / z + 2 * mh };
  }

  private updateVisible(area?: Rect): void {
    const r = area ?? this.viewRect(0.25);
    const hits = this.index.search({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h });
    const next = new Set<ItemView>();
    for (const e of hits) {
      const v = e.view;
      next.add(v);
      if (!v.container.visible) v.container.visible = true;
      this.updateDetail(v);
    }
    for (const v of this.visible) if (!next.has(v)) v.container.visible = false;
    this.visible = next;
  }

  /** Выбор уровня детализации объекта при текущем масштабе. */
  private updateDetail(v: ItemView): void {
    const zoom = this.cam.zoom;
    const item = v.item;

    if (isLine(item)) {
      if (zoom < FAR_LINES_ZOOM) {
        // Издалека линию показывает общий объект, а свой прячем.
        if (v.gfx) v.gfx.visible = false;
        if (v.label) v.label.visible = false;
        return;
      }
      if (v.gfx) v.gfx.visible = true;
      if (!v.gfx) this.nearQueue.set(v, () => this.buildNear(v));
      else if (!this.moving && v.lineStep !== lineStep(zoom)) {
        // Масштаб ушёл на другую ступень — перестроить линию с новой видимой толщиной (порциями, в очереди).
        this.nearQueue.set(v, () => this.rebuildLine(v));
      }
      if (v.label) v.label.visible = LINE_LABEL_FONT * zoom >= MIN_TEXT_PX && item.id !== this.editingId;
      return;
    }

    if (item.kind === 'frame') this.updateFrameTitle(v, item);
    if (item.kind === 'image' && this.updatePhoto(v, item)) return;

    // Текст — тонкая полоска, по её высоте порог не считаем: он виден, пока читается шрифт.
    // Рисунок всегда рисуется полностью: заменять его цветным прямоугольником издалека было бы странно.
    const textReadable = (v.spec?.fontSize ?? 16) * zoom >= MIN_TEXT_PX;
    const wantNear = item.kind === 'drawing'
      ? true
      : item.kind === 'text'
        ? (v.spec?.fontSize ?? 18) * zoom >= MIN_TEXT_PX || !v.snapshot
        : Math.min(item.w, item.h) * zoom >= NEAR_PX && (textReadable || !v.snapshot);
    if (wantNear && v.gfx) {
      v.gfx.visible = true;
      if (v.far) v.far.visible = false;
      this.updateLabel(v);
      return;
    }
    if (!v.far) this.buildFar(v, item);
    if (v.snapshot && v.far!.texture !== v.snapshot) {
      v.far!.texture = v.snapshot;
      v.far!.tint = 0xffffff;
      v.far!.setSize(item.w, item.h);
    }
    v.far!.visible = true;
    if (v.gfx) v.gfx.visible = false;
    if (v.label) v.label.visible = false;
    if (v.body) v.body.visible = false;
    if (wantNear) this.nearQueue.set(v, () => this.buildNear(v));
  }

  /** Построить объект в нужной детализации немедленно (после правки). */
  private buildNow(v: ItemView): void {
    this.updateDetail(v);
    const near = this.nearQueue.get(v);
    if (near) {
      this.nearQueue.delete(v);
      near();
    }
    const label = this.labelQueue.get(v);
    if (label) {
      this.labelQueue.delete(v);
      label();
    }
  }

  /**
   * Фото: уровень зависит от того, сколько пикселей экрана оно занимает. Пока нужный уровень грузится,
   * показывается ближайший готовый; пока нет никакого — серая заглушка с именем файла.
   */
  private updatePhoto(v: ItemView, item: ImageItem): boolean {
    const px = Math.max(item.w, item.h) * this.cam.zoom * window.devicePixelRatio;
    const want: Level = px <= 160 ? 0 : px <= 640 ? 1 : 2;
    const file = this.paths.toVault(item.file);
    this.images.request(file, want === 2 ? 1 : want);
    if (want === 2 && !this.moving) this.images.request(file, 2);
    const best = this.images.best(file, want);
    if (!best) {
      if (v.photo) v.photo.visible = false;
      return false;
    }
    if (!v.photo) {
      v.photo = new Sprite(best.tex);
      v.container.addChild(v.photo);
    } else if (v.photo.texture !== best.tex) {
      v.photo.texture = best.tex;
    }
    v.photo.setSize(item.w, item.h);
    v.photo.visible = true;
    if (v.far) v.far.visible = false;
    if (v.gfx) v.gfx.visible = false;
    if (v.label) v.label.visible = false;
    return true;
  }

  private buildFar(v: ItemView, item: BoxItem): void {
    const s = new Sprite(Texture.WHITE);
    s.width = item.w;
    s.height = item.h;
    s.tint = farColor(this.look(item));
    v.far = s;
    v.container.addChildAt(s, 0);
  }

  private buildNear(v: ItemView): void {
    if (v.gfx || !this.visible.has(v)) return;
    const item = v.item;
    const g = new Graphics();
    if (isLine(item)) {
      const geom = this.lineGeom(item);
      if (geom) {
        const look = this.look(item);
        const step = lineStep(this.cam.zoom);
        v.lineStep = step;
        drawLine(g, { ...look, width: Math.max(look.width ?? 2, LINE_MIN_PX / step) }, geom);
        if (item.label) this.buildLineLabel(v, g, item.label, lineMidpoint(geom));
      }
    } else {
      drawBox(g, this.look(item));
    }
    v.gfx = g;
    // Ближний вид — над дальним, но под текстом и заголовком.
    v.container.addChildAt(g, v.far ? 1 : 0);
    this.nearCount++;
    this.updateDetail(v);
  }

  private rebuildLine(v: ItemView): void {
    if (!this.visible.has(v) || !v.gfx) return;
    v.gfx.destroy();
    v.gfx = null;
    this.nearCount--;
    if (v.label) {
      v.label.destroy();
      v.label = null;
      this.labelCount--;
    }
    this.buildNear(v);
  }

  /** Все линии доски одним объектом: упрощённая форма, видимая толщина не меньше LINE_MIN_PX. */
  private updateFarLines(): void {
    const zoom = this.cam.zoom;
    if (zoom >= FAR_LINES_ZOOM) return;
    const step = lineStep(zoom);
    if (this.farLines && !this.farLinesDirty && this.farLinesStep === step) return;
    const g = this.farLines ?? new Graphics();
    g.clear();
    const minWidth = LINE_MIN_PX / step;
    for (const v of this.views.values()) {
      if (!isLine(v.item)) continue;
      const geom = this.lineGeom(v.item);
      if (!geom) continue;
      const look = this.look(v.item);
      const pts = samplePath(geom, 12);
      const width = Math.max(look.width ?? 2, minWidth);
      // Пунктир сохраняется и издалека: шаблон считается от видимой толщины, штрихи не слипаются в полосу.
      const pattern = dashPattern(look.dash, width);
      if (pattern) dashPolyline(g, pts, pattern);
      else {
        g.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      }
      g.stroke({ width, color: look.color ? hexToNum(look.color) : 0x5b5b5b, cap: look.dash === 'dotted' || look.dash === 'dashdot' ? 'round' : 'butt' });
    }
    if (!this.farLines) {
      this.farLines = g;
      this.world.addChild(g);
    } else {
      // Держим общий объект поверх объектов доски.
      this.world.addChild(g);
    }
    this.farLines.visible = zoom < FAR_LINES_ZOOM;
    this.farLinesStep = step;
    this.farLinesDirty = false;
  }

  /** Подпись на линии: белая плашка посередине пути, чтобы линия не перечёркивала текст. */
  private buildLineLabel(v: ItemView, g: Graphics, text: string, mid: { x: number; y: number }): void {
    const label = new Text({
      text,
      style: { fontFamily: FONT, fontSize: LINE_LABEL_FONT, fill: 0x1f1f1f, align: 'center', wordWrap: true, wordWrapWidth: 260 },
      resolution: this.labelResolution(),
    });
    label.anchor.set(0.5);
    label.position.set(mid.x, mid.y);
    const w = label.width + 14, h = label.height + 6;
    g.roundRect(mid.x - w / 2, mid.y - h / 2, w, h, 6).fill(0xffffff).stroke({ width: 1, color: 0xd4d4d4 });
    v.label = label;
    v.labelRes = this.labelResolution();
    v.container.addChild(label);
    this.labelCount++;
  }

  private updateLabel(v: ItemView): void {
    if (!v.spec || isLine(v.item)) return;
    const want = v.spec.fontSize * this.cam.zoom >= MIN_TEXT_PX && v.item.id !== this.editingId;
    if (v.label) v.label.visible = want;
    else if (want) this.labelQueue.set(v, () => this.createLabel(v));
    if (v.item.kind === 'doc') {
      if (v.body) v.body.visible = want;
      else if (want) this.labelQueue.set(v, () => {
        this.createLabel(v);
        this.createDocBody(v);
      });
    }
  }

  /** Текст заметки на карточке: markdown, отрисованный как HTML, обрезанный по размеру карточки. */
  private createDocBody(v: ItemView): void {
    const item = v.item as DocItem;
    if (v.body || !this.docs || !this.markdown || !v.gfx?.visible || !this.visible.has(v)) return;
    const file = this.paths.toVault(item.file);
    const doc = this.docs.get(file);
    if (!doc) {
      this.docs.request(file);
      return;
    }
    const pad = 14, top = 42;
    const w = Math.max(20, item.w - pad * 2), h = Math.max(10, item.h - top - pad);
    const html = this.markdown.render(doc.text, { from: file, card: true });
    const res = this.labelResolution();
    const body = new HTMLText({
      text: `<style>${CARD_CSS}</style><div class="vbmd" style="width:${w}px;height:${h}px">${html}</div>`,
      // Pixi по умолчанию ставит white-space: pre — тогда абзацы не переносятся, а переводы строк
      // между HTML-тегами превращаются в пустоты. Нужен обычный перенос по ширине карточки.
      style: { fontFamily: FONT, fontSize: 14, fill: 0x1f1f1f, whiteSpace: 'normal', wordWrap: true, wordWrapWidth: w },
      resolution: res,
    });
    body.position.set(pad, top);
    v.body = body;
    v.bodyRes = res;
    v.container.addChild(body);
  }

  /** Заголовок рамки всегда одного размера на экране, как в Miro. */
  private updateFrameTitle(v: ItemView, item: BoxItem & { title?: string }): void {
    if (!item.title) return;
    const zoom = this.cam.zoom;
    if (!v.title) {
      v.title = new Text({
        text: item.title,
        style: { fontFamily: FONT, fontSize: 13, fill: 0x6b6b6b, fontWeight: '500' },
        resolution: window.devicePixelRatio,
      });
      v.title.anchor.set(0, 1);
      v.container.addChild(v.title);
    }
    v.title.visible = item.w * zoom > 60 && item.id !== this.editingId;
    v.title.scale.set(1 / zoom);
    v.title.position.set(0, -6 / zoom);
  }

  private labelResolution(): number {
    const bucket = Math.pow(2, Math.ceil(Math.log2(this.cam.zoom)));
    return window.devicePixelRatio * Math.min(4, Math.max(0.5, bucket));
  }

  private createLabel(v: ItemView): void {
    if (v.label || !v.spec || !v.gfx?.visible || !this.visible.has(v) || isLine(v.item)) return;
    if (v.item.id === this.editingId) return;
    const res = this.labelResolution();
    v.label = makeLabel(v.spec, v.item.w, v.item.h, res);
    v.labelRes = res;
    v.container.addChildAt(v.label, v.container.children.indexOf(v.gfx) + 1);
    this.labelCount++;
  }

  /** Камера остановилась: дорисовать тексты в нужном разрешении и освободить память от далёких. */
  private settle(): void {
    this.moving = false;
    this.updateFarLines();
    // Камера остановилась — теперь можно грузить оригиналы фото, которые видны крупно.
    const photosInUse = new Set<string>();
    for (const v of this.visible) {
      // Линии — подогнать видимую толщину под новый масштаб.
      if (isLine(v.item)) {
        this.updateDetail(v);
        continue;
      }
      if (v.item.kind !== 'image') continue;
      photosInUse.add(this.paths.toVault(v.item.file));
      this.updateDetail(v);
    }
    this.images.evict(photosInUse);
    for (const v of this.visible) {
      if (v.snapshot || isLine(v.item) || v.item.kind === 'frame' || v.item.kind === 'image' || v.item.kind === 'drawing') continue;
      if (v.label?.visible || v.body?.visible) this.miscQueue.set(`snap:${v.item.id}`, () => this.makeSnapshot(v));
    }
    if (this.snapshotCount > MAX_SNAPSHOTS) {
      for (const v of this.views.values()) {
        if (this.snapshotCount <= MAX_SNAPSHOTS * 0.8) break;
        if (v.snapshot && !this.visible.has(v)) this.dropSnapshot(v);
      }
    }
    const res = this.labelResolution();
    for (const v of this.visible) {
      if (v.body?.visible && v.bodyRes !== res) {
        this.miscQueue.set(`body:${v.item.id}`, () => {
          if (v.body && this.visible.has(v)) {
            v.body.resolution = res;
            v.bodyRes = res;
          }
        });
      }
      if (v.label?.visible && v.labelRes !== res) {
        this.miscQueue.set(`res:${v.item.id}`, () => {
          if (v.label && this.visible.has(v)) {
            v.label.resolution = res;
            v.labelRes = res;
          }
        });
      }
    }
    if (this.labelCount > MAX_LABELS) {
      for (const v of this.views.values()) {
        if (this.labelCount <= MAX_LABELS * 0.8) break;
        // Подписи линий строятся вместе с линией — их не выгружаем, их мало.
        if (v.label && !this.visible.has(v) && !isLine(v.item)) {
          v.label.destroy();
          v.label = null;
          this.labelCount--;
        }
      }
    }
    this.requestFrame();
  }

  private runQueues(deadline: number): void {
    let n = 0;
    for (const [v, task] of this.nearQueue) {
      if (n >= NEAR_BUILDS_PER_FRAME || performance.now() > deadline) break;
      this.nearQueue.delete(v);
      task();
      n++;
    }
    n = 0;
    for (const [v, task] of this.labelQueue) {
      if (n >= LABELS_PER_FRAME || performance.now() > deadline) break;
      this.labelQueue.delete(v);
      task();
      n++;
    }
    for (const [key, task] of this.miscQueue) {
      if (performance.now() > deadline) break;
      this.miscQueue.delete(key);
      task();
    }
  }

  // ---------- экспорт ----------

  /** Цвет фона доски — экспорт кладёт картинку на него. */
  get backgroundColor(): string {
    return this.doc?.background?.color ?? '#f7f7f5';
  }

  /**
   * Нарисовать кусок доски в полной детализации на отдельный холст (для экспорта).
   * Все объекты куска строятся сразу, фото грузятся оригиналами, экран потом возвращается как был.
   */
  async renderTile(rect: Rect, scale: number, w: number, h: number): Promise<HTMLCanvasElement> {
    const saved = { ...this.cam };
    this.cam.zoom = scale;
    this.cam.x = -rect.x * scale;
    this.cam.y = -rect.y * scale;
    this.moving = false;
    const pad = 20 / scale;
    this.updateVisible({ x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 });
    if (scale < FAR_LINES_ZOOM) this.updateFarLines();
    if (this.farLines) this.farLines.visible = scale < FAR_LINES_ZOOM;

    // Всё построить сразу: фигуры, тексты, линии — без очередей и лимитов на кадр.
    for (let guard = 0; guard < 1000 && (this.nearQueue.size || this.labelQueue.size || this.miscQueue.size); guard++) {
      for (const [v, task] of this.nearQueue) { this.nearQueue.delete(v); task(); }
      for (const [v, task] of this.labelQueue) { this.labelQueue.delete(v); task(); }
      for (const [k, task] of this.miscQueue) { this.miscQueue.delete(k); task(); }
      for (const v of this.visible) this.updateDetail(v);
    }
    const res = this.labelResolution();
    let bodies = false;
    for (const v of this.visible) {
      if (v.label && v.labelRes !== res && !isLine(v.item)) {
        v.label.resolution = res;
        v.labelRes = res;
      }
      if (v.body) {
        v.body.resolution = res;
        bodies = true;
      }
    }

    // Фото — дождаться оригиналов (или нужного уровня), тексты документов — готовой картинки.
    const deadline = performance.now() + 30000;
    for (;;) {
      let waiting = false;
      for (const v of this.visible) {
        if (v.item.kind !== 'image') continue;
        const file = this.paths.toVault(v.item.file);
        const px = Math.max(v.item.w, v.item.h) * scale;
        const level = px <= 160 ? 0 : px <= 640 ? 1 : 2;
        this.images.request(file, level);
        const st = this.images.status(file, level);
        if (st === 'loading' || st === 'none') waiting = true;
        this.updateDetail(v);
      }
      if (!waiting || performance.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    if (bodies) await new Promise((r) => setTimeout(r, 400));

    this.world.position.set(this.cam.x, this.cam.y);
    this.world.scale.set(scale);
    for (const v of this.visible) if (v.item.kind === 'frame') this.updateDetail(v);
    const rt = RenderTexture.create({ width: w, height: h, resolution: 1 });
    this.app.renderer.render({ container: this.world, target: rt, clear: true, clearColor: this.backgroundColor });
    const canvas = this.app.renderer.extract.canvas(rt) as HTMLCanvasElement;
    rt.destroy(true);

    Object.assign(this.cam, saved);
    this.cameraMoved();
    return canvas;
  }

  destroy(): void {
    this.images.destroy();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settleTimer);
    this.resizeObserver?.disconnect();
    this.app.destroy(true, { children: true });
  }
}

/** Одна клетка сетки: точка в центре или линии по краю (из соседних клеток складывается клетчатая сетка). */
function gridTexture(kind: string, ink: string): Texture {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  if (kind === 'lines') {
    ctx.globalAlpha = 0.7;
    ctx.fillRect(0, 0, size, 1);
    ctx.fillRect(0, 0, 1, size);
  } else {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  return Texture.from(c);
}

/** Ступень масштаба для толщины линий: 1 вблизи, дальше 1/2, 1/4, 1/8… */
function lineStep(zoom: number): number {
  return zoom >= 1 ? 1 : Math.pow(2, Math.floor(Math.log2(zoom)));
}

function dotTexture(): Texture {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#cfcfcb';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 1.3, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(c);
}
