// Курсоры других участников общей доски: цветная стрелка с именем, поверх холста (не рисуется Pixi —
// перемещение чужой мыши не заставляет перерисовывать доску).
import type { BoardView } from '../render/BoardView.ts';
import type { LivePeer } from '../io/live.ts';

export class PresenceLayer {
  private readonly root: HTMLDivElement;
  private readonly view: BoardView;
  private readonly marks = new Map<string, HTMLDivElement>();
  private peers: LivePeer[] = [];
  private self = '';
  private frame = 0;

  constructor(host: HTMLElement, view: BoardView) {
    this.view = view;
    this.root = document.createElement('div');
    this.root.className = 'presence-layer';
    host.appendChild(this.root);
  }

  setPeers(peers: LivePeer[], self: string): void {
    this.peers = peers;
    this.self = self;
    this.schedule();
  }

  /** Чужой курсор сдвинулся. */
  cursor(id: string, cursor: { x: number; y: number } | null): void {
    const p = this.peers.find((x) => x.id === id);
    if (p) p.cursor = cursor;
    this.schedule();
  }

  /** Камера сдвинулась — пересчитать места на экране. */
  update(): void {
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.root.remove();
  }

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const seen = new Set<string>();
    const { w, h } = this.view.screen;
    for (const p of this.peers) {
      if (p.id === this.self || !p.cursor) continue;
      const s = this.view.worldToScreen(p.cursor.x, p.cursor.y);
      if (s.x < -20 || s.y < -20 || s.x > w + 20 || s.y > h + 20) continue;
      seen.add(p.id);
      let el = this.marks.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'presence-cursor';
        el.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 2l5.5 14 2-6 6-2z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>';
        this.root.appendChild(el);
        this.marks.set(p.id, el);
      }
      (el.querySelector('path') as SVGPathElement).setAttribute('fill', p.color);
      const label = el.querySelector('span') as HTMLSpanElement;
      label.textContent = p.name;
      label.style.background = p.color;
      el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
    for (const [id, el] of this.marks) {
      if (seen.has(id)) continue;
      el.remove();
      this.marks.delete(id);
    }
  }
}
