// Живые видео на доске. Карточка видео на холсте — кадр с кнопкой ▶ и ничего не стоит.
// Щелчок по ней ставит поверх настоящий плеер YouTube / Vimeo, и он ездит вместе с доской.
//
// Плеер — это целая отдельная страница (сотни мегабайт памяти и процессор, даже когда стоит),
// поэтому заранее плееры не создаются: только по щелчку. Играющее видео живёт, даже уехав с экрана,
// чтобы звук не обрывался; поставленное на паузу или досмотренное, уехав с экрана, закрывается само.
//
// Чтобы плеер не мешал работать с доской, он «прозрачен» для мыши: колесо, перетаскивание и щелчок
// уходят доске. Активный (по которому только что щёлкнули) — принимает мышь, и его кнопки нажимаются.
// Щелчок мимо снимает активность, но видео не останавливает.
import type { BoardView } from '../render/BoardView.ts';
import type { BoardStore } from '../model/store.ts';
import { embedUrl, listenPlayer, playerCommand, playerState } from '../format/embed.ts';

/** Сколько плееров держать одновременно; лишние — самые давно запущенные — закрываются. */
const MAX_LIVE = 3;
/** Через сколько после конца зума перестроить плеер под новый размер (во время зума он просто растягивается). */
const REBASE_MS = 250;

interface Live {
  id: string;
  box: HTMLDivElement;
  frame: HTMLIFrameElement;
  loaded: boolean;
  started: number;
  /** Играет ли сейчас — по сообщениям самого плеера. Неизвестно — считаем, что играет. */
  playing: boolean;
  /** Масштаб доски, под который выставлен размер плеера. Между перестройками плеер растягивается трансформацией. */
  base: number;
  /** Размер карточки на доске, под который выставлен плеер. */
  rw: number;
  rh: number;
}

export class EmbedLayer {
  private readonly root: HTMLDivElement;
  private readonly live = new Map<string, Live>();
  private active: string | null = null;
  /** Активный плеер не зависит от выделения (опубликованная доска, где выделять нечего). */
  sticky = false;
  private rebaseTimer = 0;
  private readonly view: BoardView;
  private readonly store: BoardStore;
  private readonly selection: () => string[];
  private readonly onMessage = (e: MessageEvent): void => {
    for (const l of this.live.values()) {
      if (e.source !== l.frame.contentWindow) continue;
      const state = playerState(e.data);
      if (state === null) return;
      l.playing = state;
      if (!state) this.update();
      return;
    }
  };

  constructor(host: HTMLElement, view: BoardView, store: BoardStore, selection: () => string[]) {
    this.view = view;
    this.store = store;
    this.selection = selection;
    this.root = document.createElement('div');
    this.root.className = 'embed-layer';
    host.appendChild(this.root);
    window.addEventListener('message', this.onMessage);
  }

  /** Доска поменялась: у удалённых или скрытых карточек плеер закрывается. */
  itemsChanged(): void {
    if (this.live.size) this.update();
  }

  isStarted(id: string): boolean {
    return this.live.has(id);
  }

  /** Запустить видео (щелчок, двойной щелчок, Enter, меню) и сделать его плеер активным. */
  play(id: string): void {
    this.active = id;
    let l = this.live.get(id);
    if (l) {
      if (l.loaded) playerCommand(l.frame, true);
    } else {
      l = this.create(id);
    }
    if (!l) return;
    l.started = performance.now();
    l.playing = true;
    this.update();
  }

  /** Остановить видео и вернуть карточке обычный вид. */
  stop(id: string): void {
    this.remove(id);
    if (this.active === id) this.active = null;
    this.update();
  }

  /** Поставить плееры на свои места. Зовётся при каждом сдвиге камеры и каждой правке. */
  update(): void {
    if (!this.live.size) return;
    const sel = this.selection();
    // Щелчок мимо видео (выделили другое или ничего) — плеер снова прозрачен для мыши, но играет дальше.
    // На сайте выделения нет: запущенный плеер остаётся активным, пока не запустят другой.
    if (!this.sticky && this.active && !(sel.length === 1 && sel[0] === this.active)) this.active = null;

    const { w: sw, h: sh } = this.view.screen;
    const zoom = this.view.cam.zoom;
    for (const l of [...this.live.values()]) {
      const item = this.store.get(l.id);
      const r = this.view.rectOf(l.id);
      if (!item || !r || this.view.isHidden(item)) {
        this.remove(l.id);
        continue;
      }
      const a = this.view.worldToScreen(r.x, r.y);
      const offscreen = a.x > sw || a.y > sh || a.x + r.w * zoom < 0 || a.y + r.h * zoom < 0;
      // На паузе и уехал с экрана — больше не нужен; вернёшься — щёлкнешь снова.
      if (offscreen && !l.playing && l.id !== this.active) this.remove(l.id);
    }
    const byAge = [...this.live.values()].sort((x, y) => y.started - x.started);
    for (const l of byAge.slice(MAX_LIVE)) this.remove(l.id);

    let rebase = false;
    for (const l of this.live.values()) {
      const r = this.view.rectOf(l.id)!;
      const a = this.view.worldToScreen(r.x, r.y);
      if (!l.base || l.rw !== r.w || l.rh !== r.h) this.resize(l, l.base || zoom);
      if (Math.abs(l.base - zoom) > 1e-6) rebase = true;
      l.box.style.transform = `translate(${a.x}px, ${a.y}px) scale(${zoom / l.base})`;
      l.box.style.pointerEvents = l.id === this.active ? 'auto' : 'none';
      l.box.classList.toggle('active', l.id === this.active);
    }
    if (rebase) {
      clearTimeout(this.rebaseTimer);
      this.rebaseTimer = window.setTimeout(() => {
        for (const l of this.live.values()) this.resize(l, this.view.cam.zoom);
        this.update();
      }, REBASE_MS);
    }
  }

  destroy(): void {
    clearTimeout(this.rebaseTimer);
    window.removeEventListener('message', this.onMessage);
    for (const id of [...this.live.keys()]) this.remove(id);
    this.root.remove();
  }

  // ---------- внутреннее ----------

  private create(id: string): Live | undefined {
    const item = this.store.get(id);
    if (item?.kind !== 'link') return;
    const src = embedUrl(item.url, true);
    if (!src) return;
    const box = document.createElement('div');
    box.className = 'embed-live';
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.title = item.title ?? item.url;
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    box.appendChild(frame);
    this.root.appendChild(box);
    const l: Live = { id, box, frame, loaded: false, started: performance.now(), playing: true, base: 0, rw: 0, rh: 0 };
    frame.addEventListener('load', () => {
      l.loaded = true;
      // Попросить плеер сообщать, играет он или стоит, — чтобы закрыть его, когда он больше не нужен.
      listenPlayer(frame);
    });
    this.live.set(id, l);
    return l;
  }

  private resize(l: Live, zoom: number): void {
    const r = this.view.rectOf(l.id);
    if (!r) return;
    l.base = zoom;
    l.rw = r.w;
    l.rh = r.h;
    l.box.style.width = `${r.w * zoom}px`;
    l.box.style.height = `${r.h * zoom}px`;
  }

  private remove(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    // Пустой адрес перед удалением — чтобы звук оборвался сразу, а не когда сборщик мусора дойдёт до плеера.
    l.frame.src = 'about:blank';
    l.box.remove();
    this.live.delete(id);
  }
}
