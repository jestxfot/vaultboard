// Живые видео на доске. Карточка видео на холсте — просто кадр; когда она на экране и достаточно крупная,
// поверх неё встаёт настоящий плеер YouTube / Vimeo и ездит вместе с доской.
//
// Чтобы плееры не мешали работать с доской, они «прозрачны» для мыши: колесо, перетаскивание и щелчок
// уходят доске. Щелчок по видео запускает его и делает плеер активным — тогда кнопки плеера нажимаются.
// Щелчок мимо снимает активность, но видео не останавливает: оно играет дальше, пока его не поставят на паузу.
//
// Плееры тяжёлые (каждый — отдельная страница), поэтому живых немного: только крупные на экране
// и те, что уже запускали. Остальные видео показываются кадром на холсте и ничего не стоят.
import type { BoardView } from '../render/BoardView.ts';
import type { BoardStore } from '../model/store.ts';
import { embedUrl, playerCommand } from '../format/embed.ts';

/** Сколько плееров держать на экране одновременно (не считая запущенных). */
const MAX_IDLE = 6;
/** Сколько запущенных видео помнить: они живут, даже когда уехали с экрана, чтобы звук не обрывался. */
const MAX_STARTED = 8;
/** Меньше этой ширины на экране плеер не ставим — кадра на холсте достаточно. */
const MIN_SCREEN_W = 200;
/** Через сколько после конца зума перестроить плеер под новый размер (во время зума он просто растягивается). */
const REBASE_MS = 250;

interface Live {
  id: string;
  box: HTMLDivElement;
  frame: HTMLIFrameElement;
  loaded: boolean;
  started: number;
  /** Масштаб доски, под который выставлен размер плеера. Между перестройками плеер растягивается трансформацией. */
  base: number;
  /** Размер карточки на доске, под который выставлен плеер. */
  rw: number;
  rh: number;
  pendingPlay: boolean;
}

export class EmbedLayer {
  private readonly root: HTMLDivElement;
  private readonly live = new Map<string, Live>();
  /** Карточки видео на доске: пересчитываются при правках, а не каждый кадр. */
  private videos: string[] = [];
  private active: string | null = null;
  private rebaseTimer = 0;
  private readonly view: BoardView;
  private readonly store: BoardStore;
  private readonly selection: () => string[];

  constructor(host: HTMLElement, view: BoardView, store: BoardStore, selection: () => string[]) {
    this.view = view;
    this.store = store;
    this.selection = selection;
    this.root = document.createElement('div');
    this.root.className = 'embed-layer';
    host.appendChild(this.root);
    this.itemsChanged();
  }

  /** Доска поменялась: обновить список карточек видео. */
  itemsChanged(): void {
    this.videos = this.store.items.filter((i) => i.kind === 'link' && embedUrl(i.url)).map((i) => i.id);
    this.update();
  }

  isStarted(id: string): boolean {
    return !!this.live.get(id)?.started;
  }

  /** Запустить видео (щелчок, двойной щелчок, Enter, меню) и сделать его плеер активным. */
  play(id: string): void {
    this.active = id;
    let l = this.live.get(id);
    if (!l) l = this.create(id, true);
    if (!l) return;
    l.started = performance.now();
    if (l.loaded) playerCommand(l.frame, true);
    else l.pendingPlay = true;
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
    const sel = this.selection();
    // Щелчок мимо видео (выделили другое или ничего) — плеер снова прозрачен для мыши, но играет дальше.
    if (this.active && !(sel.length === 1 && sel[0] === this.active)) this.active = null;

    const { w: sw, h: sh } = this.view.screen;
    const zoom = this.view.cam.zoom;
    const want = new Set<string>();
    const idle: { id: string; d: number }[] = [];
    for (const id of this.videos) {
      const item = this.store.get(id);
      const r = this.view.rectOf(id);
      if (!item || !r || this.view.isHidden(item)) continue;
      const l = this.live.get(id);
      if (l?.started) {
        want.add(id);
        continue;
      }
      const a = this.view.worldToScreen(r.x, r.y);
      const w = r.w * zoom, h = r.h * zoom;
      if (w < MIN_SCREEN_W || a.x > sw || a.y > sh || a.x + w < 0 || a.y + h < 0) continue;
      idle.push({ id, d: Math.hypot(a.x + w / 2 - sw / 2, a.y + h / 2 - sh / 2) });
    }
    idle.sort((x, y) => x.d - y.d);
    for (const { id } of idle.slice(0, MAX_IDLE)) want.add(id);

    // Запущенных слишком много — самые давние уходят.
    const started = [...this.live.values()].filter((l) => l.started && want.has(l.id)).sort((x, y) => y.started - x.started);
    for (const l of started.slice(MAX_STARTED)) want.delete(l.id);

    for (const id of [...this.live.keys()]) if (!want.has(id)) this.remove(id);
    for (const id of want) if (!this.live.has(id)) this.create(id, false);

    let rebase = false;
    for (const l of this.live.values()) {
      const r = this.view.rectOf(l.id);
      if (!r) continue;
      const a = this.view.worldToScreen(r.x, r.y);
      if (!l.base || l.rw !== r.w || l.rh !== r.h) this.resize(l, l.base || zoom);
      if (Math.abs(l.base - zoom) > 1e-6) rebase = true;
      const s = zoom / l.base;
      l.box.style.transform = `translate(${a.x}px, ${a.y}px) scale(${s})`;
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
    for (const id of [...this.live.keys()]) this.remove(id);
    this.root.remove();
  }

  // ---------- внутреннее ----------

  private create(id: string, autoplay: boolean): Live | undefined {
    const item = this.store.get(id);
    if (item?.kind !== 'link') return;
    const src = embedUrl(item.url, autoplay);
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
    const l: Live = { id, box, frame, loaded: false, started: autoplay ? performance.now() : 0, base: 0, rw: 0, rh: 0, pendingPlay: false };
    frame.addEventListener('load', () => {
      l.loaded = true;
      // Плеер грузился, когда по нему щёлкнули, — запустить, как только он готов слушать.
      if (l.pendingPlay) window.setTimeout(() => playerCommand(frame, true), 300);
      l.pendingPlay = false;
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
