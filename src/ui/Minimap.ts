// Миникарта: вся доска в миниатюре в правом нижнем углу, рамкой — то, что сейчас на экране.
// Щелчок или протягивание по карте — перенести туда взгляд (масштаб не меняется).
//
// Дёшево по процессору: объекты рисуются в запасной холст только когда доска меняется (и не чаще
// раза в 200 мс), а при движении камеры поверх готовой картинки перерисовывается одна рамка.
import type { BoardView } from '../render/BoardView.ts';
import type { BoardStore } from '../model/store.ts';
import type { Item } from '../model/types.ts';
import { isLine } from '../model/types.ts';
import { samplePath } from '../render/geometry.ts';

const W = 220;
const H = 150;
/** Поля вокруг содержимого карты, доля её размера. */
const PAD = 0.06;

/** Цвет объекта на карте: своя заливка или цвет по виду. */
function colorOf(item: Item, look: Item): string {
  const own = 'color' in look ? (look as { color?: string }).color : undefined;
  switch (item.kind) {
    case 'frame': return own ?? '#e6e6e2';
    case 'sticky': return own ?? '#ffe98a';
    case 'image': return '#b9bec8';
    case 'text':
    case 'drawing': return '#8f8f8b';
    case 'shape': return own ?? '#dcdcd6';
    default: return own ?? '#ffffff';
  }
}

export class Minimap {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Готовая картинка объектов — копируется на карту, поверх рисуется рамка экрана. */
  private readonly items: HTMLCanvasElement;
  private readonly view: BoardView;
  private readonly store: BoardStore;
  /** Какую часть доски показывает карта и в каком масштабе. */
  private world = { x: 0, y: 0, scale: 1 };
  private itemsDirty = true;
  private itemsTimer = 0;
  private frame = 0;
  private dragging = false;
  visible = true;

  constructor(host: HTMLElement, view: BoardView, store: BoardStore) {
    this.view = view;
    this.store = store;
    const dpr = window.devicePixelRatio || 1;
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.root.appendChild(this.canvas);
    host.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.items = document.createElement('canvas');
    this.items.width = W * dpr;
    this.items.height = H * dpr;

    // Перенести взгляд туда, куда щёлкнули или тянут.
    const moveTo = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const wx = this.world.x + (e.clientX - r.left) / this.world.scale;
      const wy = this.world.y + (e.clientY - r.top) / this.world.scale;
      const { w, h } = this.view.screen;
      const z = this.view.cam.zoom;
      this.view.setCamera({ x: w / 2 - wx * z, y: h / 2 - wy * z });
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.dragging = true;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Захват не вышел — тянуть можно, пока курсор над картой.
      }
      moveTo(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) moveTo(e);
    });
    const stop = () => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
    // Колесо над картой — не зум доски и не прокрутка страницы.
    this.root.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.style.display = on ? '' : 'none';
    if (on) {
      this.itemsDirty = true;
      this.schedule();
    }
  }

  /** Доска поменялась — перерисовать объекты (не чаще раза в 200 мс). */
  itemsChanged(): void {
    if (!this.visible) return;
    if (this.itemsTimer) return;
    this.itemsTimer = window.setTimeout(() => {
      this.itemsTimer = 0;
      this.itemsDirty = true;
      this.schedule();
    }, 200);
  }

  /** Камера сдвинулась — перерисовать рамку экрана. */
  cameraChanged(): void {
    if (this.visible) this.schedule();
  }

  destroy(): void {
    clearTimeout(this.itemsTimer);
    cancelAnimationFrame(this.frame);
    this.root.remove();
  }

  // ---------- внутреннее ----------

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Экран в координатах доски. */
  private viewport() {
    const a = this.view.screenToWorld(0, 0);
    const { w, h } = this.view.screen;
    const b = this.view.screenToWorld(w, h);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  /** Какую область показывать: вся доска вместе с экраном, с полями, в пропорциях карты. */
  private fit(): boolean {
    const b = this.view.boardBounds;
    const v = this.viewport();
    const x0 = Math.min(b.w ? b.x : v.x, v.x), y0 = Math.min(b.h ? b.y : v.y, v.y);
    const x1 = Math.max(b.w ? b.x + b.w : v.x + v.w, v.x + v.w), y1 = Math.max(b.h ? b.y + b.h : v.y + v.h, v.y + v.h);
    const ww = Math.max(1, x1 - x0), hh = Math.max(1, y1 - y0);
    const scale = Math.min((W * (1 - PAD * 2)) / ww, (H * (1 - PAD * 2)) / hh);
    const next = { x: x0 + ww / 2 - W / 2 / scale, y: y0 + hh / 2 - H / 2 / scale, scale };
    const changed = Math.abs(next.scale - this.world.scale) > 1e-9 || Math.abs(next.x - this.world.x) > 1e-6 || Math.abs(next.y - this.world.y) > 1e-6;
    this.world = next;
    return changed;
  }

  private drawItems(): void {
    const dpr = window.devicePixelRatio || 1;
    const c = this.items.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const { x, y, scale } = this.world;
    // Линии — тонкими штрихами под объектами: на доске-таймлайне именно линия — главный ориентир.
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(60, 60, 60, .55)';
    for (const item of this.store.items) {
      if (!isLine(item) || this.view.isHidden(item)) continue;
      const geom = this.view.lineGeomOf(item);
      if (!geom) continue;
      const pts = samplePath(geom, 8);
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo((p.x - x) * scale, (p.y - y) * scale) : c.moveTo((p.x - x) * scale, (p.y - y) * scale)));
      c.stroke();
    }
    // Рамки — первыми (они фон для своего содержимого), остальное — в порядке слоёв.
    const all = this.store.items.filter((i) => !isLine(i) && !this.view.isHidden(i));
    for (const pass of [true, false]) {
      for (const item of all) {
        if ((item.kind === 'frame') !== pass) continue;
        const r = this.view.rectOf(item.id);
        if (!r) continue;
        const sx = (r.x - x) * scale, sy = (r.y - y) * scale;
        const sw = Math.max(1.5, r.w * scale), sh = Math.max(1.5, r.h * scale);
        c.fillStyle = colorOf(item, this.view.look(item));
        c.fillRect(sx, sy, sw, sh);
        if (sw > 4 && sh > 4 && (item.kind === 'doc' || item.kind === 'card' || item.kind === 'link' || item.kind === 'frame')) {
          c.strokeStyle = 'rgba(0,0,0,.18)';
          c.lineWidth = 0.75;
          c.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
        }
      }
    }
  }

  private draw(): void {
    // Экран вышел за прежние границы карты или доска поменялась — пересчитать масштаб и картинку объектов.
    if (this.fit() || this.itemsDirty) {
      this.itemsDirty = false;
      this.drawItems();
    }
    const dpr = window.devicePixelRatio || 1;
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.items, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = this.viewport();
    const { x, y, scale } = this.world;
    const vx = (v.x - x) * scale, vy = (v.y - y) * scale, vw = v.w * scale, vh = v.h * scale;
    // Всё вне экрана слегка притушено — так рамку видно даже на пёстрой доске.
    c.fillStyle = 'rgba(40, 44, 60, .10)';
    c.fillRect(0, 0, W, H);
    c.clearRect(vx, vy, vw, vh);
    c.drawImage(this.items, vx * dpr, vy * dpr, vw * dpr, vh * dpr, vx, vy, vw, vh);
    c.strokeStyle = '#4262ff';
    c.lineWidth = 1.5;
    c.strokeRect(vx, vy, vw, vh);
  }
}
