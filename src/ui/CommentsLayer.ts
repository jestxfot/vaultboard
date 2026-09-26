// Булавки обсуждений поверх доски. Всегда одного размера на экране, как в Miro, ездят вместе с доской
// и с объектом, на который их поставили. Щелчок — открыть обсуждение, перетаскивание — передвинуть.
//
// Булавок обычно десятки, поэтому это обычные элементы страницы: при сдвиге камеры каждой меняется
// только transform — это дёшево. Булавки за экраном не показываются вовсе.
import type { BoardView } from '../render/BoardView.ts';
import type { Comments } from '../editor/Comments.ts';
import type { CommentThread } from '../model/types.ts';
import { isDone, pinAnchor, pinColor, pinPath, pinShape } from '../model/comments.ts';

/** Размер булавки на экране, точек. */
const PIN = 30;
/** Сдвиг мыши, после которого щелчок становится перетаскиванием. */
const DRAG_PX = 4;

interface Pin {
  el: HTMLDivElement;
  /** Что сейчас нарисовано — чтобы не перерисовывать булавку без нужды. */
  key: string;
}

export class CommentsLayer {
  private readonly root: HTMLDivElement;
  private readonly pins = new Map<string, Pin>();
  private readonly view: BoardView;
  private readonly comments: Comments;
  /** Прятать завершённые обсуждения. */
  hideDone = true;
  /** Спрятать все булавки (например, для чистого экспорта или показа). */
  hideAll = false;
  /** Открытое сейчас обсуждение — его булавка подсвечена и не прячется, даже если завершена. */
  openId: string | null = null;
  onOpen: ((id: string) => void) | null = null;
  onContextMenu: ((id: string, e: MouseEvent) => void) | null = null;

  constructor(host: HTMLElement, view: BoardView, comments: Comments) {
    this.view = view;
    this.comments = comments;
    this.root = document.createElement('div');
    this.root.className = 'comments-layer';
    host.appendChild(this.root);
    this.update();
  }

  /** Экранная точка крепления булавки (для окна обсуждения). */
  screenPoint(id: string): { x: number; y: number } | null {
    const t = this.comments.get(id);
    if (!t) return null;
    const p = this.comments.point(t);
    return this.view.worldToScreen(p.x, p.y);
  }

  visible(t: CommentThread): boolean {
    if (t.id === this.openId) return true;
    if (this.hideAll || this.comments.isHidden(t)) return false;
    return !(this.hideDone && isDone(t));
  }

  update(): void {
    const { w: sw, h: sh } = this.view.screen;
    const seen = new Set<string>();
    for (const t of this.comments.threads) {
      if (!this.visible(t)) continue;
      const p = this.comments.point(t);
      const s = this.view.worldToScreen(p.x, p.y);
      if (s.x < -PIN * 2 || s.y < -PIN * 2 || s.x > sw + PIN * 2 || s.y > sh + PIN * 2) continue;
      seen.add(t.id);
      let pin = this.pins.get(t.id);
      if (!pin) {
        pin = { el: this.createPin(t.id), key: '' };
        this.pins.set(t.id, pin);
        this.root.appendChild(pin.el);
      }
      const shape = pinShape(t);
      const key = `${shape}|${pinColor(t)}|${t.messages.length}|${t.messages[0]?.author}|${isDone(t)}`;
      if (pin.key !== key) {
        pin.key = key;
        this.paint(pin.el, t);
      }
      const { ax, ay } = pinAnchor(shape);
      pin.el.style.transform = `translate(${s.x - ax * PIN}px, ${s.y - ay * PIN}px)`;
      pin.el.classList.toggle('open', t.id === this.openId);
    }
    for (const [id, pin] of this.pins) {
      if (seen.has(id)) continue;
      pin.el.remove();
      this.pins.delete(id);
    }
  }

  destroy(): void {
    this.root.remove();
  }

  // ---------- внутреннее ----------

  private paint(el: HTMLDivElement, t: CommentThread): void {
    const color = pinColor(t);
    const first = t.messages[0];
    const initial = (first?.author ?? '?').trim().charAt(0).toUpperCase() || '?';
    const count = t.messages.length;
    const shape = pinShape(t);
    // Надпись в «облачке» и «флажке» сдвинута от носика к центру тела булавки.
    const tx = shape === 'bubble' ? 13 : shape === 'flag' ? 11 : 12;
    const ty = shape === 'bubble' ? 11.5 : shape === 'flag' ? 8.5 : shape === 'triangle' ? 15 : 12.5;
    el.innerHTML =
      `<svg width="${PIN}" height="${PIN}" viewBox="0 0 24 24">` +
      `<path d="${pinPath(shape)}" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<text x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="9" font-weight="700" font-family="Inter, system-ui, sans-serif"></text>` +
      `</svg>` +
      (count > 1 ? `<span class="pin-count"></span>` : '');
    // Текст — через textContent: имя автора и число сообщений не должны становиться разметкой.
    el.querySelector('text')!.textContent = initial;
    const badge = el.querySelector('.pin-count');
    if (badge) badge.textContent = String(count);
    el.classList.toggle('done', isDone(t));
    el.title = first ? `${first.author}: ${first.text.slice(0, 140)}` : '';
  }

  private createPin(id: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'comment-pin';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      let dragging = false;
      el.setPointerCapture(e.pointerId);
      const hostRect = this.root.getBoundingClientRect();
      const onMove = (ev: PointerEvent) => {
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_PX) return;
        if (!dragging) {
          dragging = true;
          this.comments.beginMove();
          el.classList.add('dragging');
        }
        // Булавка встаёт носиком туда, где курсор, и цепляется к объекту под ним.
        this.comments.move(id, this.view.screenToWorld(ev.clientX - hostRect.left, ev.clientY - hostRect.top));
      };
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.classList.remove('dragging');
        if (dragging) this.comments.endMove();
        else this.onOpen?.(id);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onContextMenu?.(id, e);
    });
    // Колесо над булавкой — зум доски, как везде.
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.root.parentElement?.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    return el;
  }
}
