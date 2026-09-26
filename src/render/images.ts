// Фото на доске: три уровня детализации и бюджет памяти видеокарты.
//
// Оригинал на диске никогда не меняется. Для скорости у каждого фото есть два маленьких превью
// (128 и 512 пикселей по длинной стороне) — они делаются один раз, качественным уменьшением,
// и хранятся в кэше вне базы. Издалека доска показывает превью, вблизи — сам оригинал,
// пиксель в пиксель. Оригинал грузится, только когда камера остановилась: пока крутишь колесо,
// декодировать 20-мегапиксельный снимок незачем.
import { ImageSource, Texture } from 'pixi.js';
import { vault } from '../io/vault.ts';

export type Level = 0 | 1 | 2;
export const PREVIEW_SIZES = [128, 512] as const;

/** Сколько памяти видеокарты можно занять под фото. Сверх — выгружаем давно не видные. */
const BUDGET_BYTES = 768 * 1024 * 1024;
/** Сколько фото декодировать одновременно, чтобы не забить процессор. */
const PARALLEL = 2;

interface Slot {
  tex: Texture | null;
  bitmap: ImageBitmap | null;
  loading: boolean;
  failed: boolean;
  bytes: number;
  used: number;
}

interface Entry {
  file: string;
  slots: [Slot, Slot, Slot];
  /** Размер оригинала в пикселях, когда стал известен. */
  size: { w: number; h: number } | null;
  /** Превью сейчас делаются — второй запрос ждёт этот же промис, а не декодирует оригинал заново. */
  making: Promise<void> | null;
}

const emptySlot = (): Slot => ({ tex: null, bitmap: null, loading: false, failed: false, bytes: 0, used: 0 });

export class ImageCache {
  /** Фото загрузилось на каком-то уровне — доске пора перерисовать его. */
  onLoaded: ((file: string) => void) | null = null;
  /** Стал известен размер оригинала. */
  onSize: ((file: string, w: number, h: number) => void) | null = null;

  private readonly entries = new Map<string, Entry>();
  private readonly queue: (() => Promise<void>)[] = [];
  private active = 0;
  private totalBytes = 0;
  private readonly maxTexture: number;

  constructor(maxTexture: number) {
    this.maxTexture = maxTexture;
  }

  get memoryMb(): number {
    return Math.round(this.totalBytes / 1024 / 1024);
  }

  private entry(file: string): Entry {
    let e = this.entries.get(file);
    if (!e) this.entries.set(file, (e = { file, slots: [emptySlot(), emptySlot(), emptySlot()], size: null, making: null }));
    return e;
  }

  /** Лучшая готовая текстура: нужный уровень, а если его ещё нет — ближайший готовый. */
  best(file: string, want: Level): { tex: Texture; level: Level } | null {
    const e = this.entries.get(file);
    if (!e) return null;
    const order: Level[] = want === 2 ? [2, 1, 0] : want === 1 ? [1, 2, 0] : [0, 1, 2];
    for (const level of order) {
      const slot = e.slots[level];
      if (slot.tex) {
        slot.used = performance.now();
        return { tex: slot.tex, level };
      }
    }
    return null;
  }

  /** Готов ли уровень фото (для экспорта: дождаться оригиналов перед снимком). */
  status(file: string, level: Level): 'ready' | 'loading' | 'failed' | 'none' {
    const slot = this.entries.get(file)?.slots[level];
    if (!slot) return 'none';
    if (slot.tex) return 'ready';
    if (slot.failed) return 'failed';
    return slot.loading ? 'loading' : 'none';
  }

  request(file: string, level: Level): void {
    const e = this.entry(file);
    const slot = e.slots[level];
    if (slot.tex || slot.loading || slot.failed) return;
    slot.loading = true;
    this.enqueue(() => (level === 2 ? this.loadOriginal(e) : this.loadPreview(e, level)));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    this.pump();
  }

  private pump(): void {
    while (this.active < PARALLEL && this.queue.length) {
      const task = this.queue.shift()!;
      this.active++;
      task()
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private setSlot(e: Entry, level: Level, bitmap: ImageBitmap): void {
    const slot = e.slots[level];
    const source = new ImageSource({ resource: bitmap, autoGenerateMipmaps: true, scaleMode: 'linear' });
    slot.tex = new Texture({ source });
    slot.bitmap = bitmap;
    slot.loading = false;
    slot.bytes = bitmap.width * bitmap.height * 4 * (4 / 3); // с мип-уровнями
    slot.used = performance.now();
    this.totalBytes += slot.bytes;
    this.onLoaded?.(e.file);
  }

  private async fetchOriginal(file: string): Promise<ImageBitmap> {
    const res = await fetch(vault.fileUrl(file));
    if (!res.ok) throw new Error(`Нет файла ${file}`);
    // Декодирование идёт вне главного потока; ориентация из EXIF учитывается.
    return createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
  }

  private async loadPreview(e: Entry, level: 0 | 1): Promise<void> {
    try {
      const res = await fetch(vault.previewUrl(e.file, level));
      if (res.ok) {
        this.setSlot(e, level, await createImageBitmap(await res.blob()));
        return;
      }
      if (!e.making) e.making = this.makePreviews(e).finally(() => (e.making = null));
      await e.making;
      if (!e.slots[level].tex) throw new Error('превью не получилось');
    } catch {
      e.slots[level].loading = false;
      e.slots[level].failed = true;
    }
  }

  /** Превью ещё нет: один раз декодируем оригинал, делаем оба размера и кладём их в кэш на диске. */
  private async makePreviews(e: Entry): Promise<void> {
    const full = await this.fetchOriginal(e.file);
    e.size = { w: full.width, h: full.height };
    this.onSize?.(e.file, full.width, full.height);
    for (const level of [0, 1] as const) {
      const slot = e.slots[level];
      if (slot.tex) continue;
      const k = Math.min(1, PREVIEW_SIZES[level] / Math.max(full.width, full.height));
      const w = Math.max(1, Math.round(full.width * k)), h = Math.max(1, Math.round(full.height * k));
      const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      this.setSlot(e, level, small);
      void this.storePreview(e.file, level, small);
    }
    // Если оригинал уже просили — не декодируем его второй раз.
    if (e.slots[2].loading && !e.slots[2].tex && full.width <= this.maxTexture && full.height <= this.maxTexture) this.setSlot(e, 2, full);
    else full.close();
  }

  private async storePreview(file: string, level: 0 | 1, bmp: ImageBitmap): Promise<void> {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    // Превью — только для скорости на доске. Сам оригинал не пережимается никогда.
    await vault.putPreview(file, level, await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 }));
  }

  private async loadOriginal(e: Entry): Promise<void> {
    try {
      let bmp = await this.fetchOriginal(e.file);
      e.size = { w: bmp.width, h: bmp.height };
      this.onSize?.(e.file, bmp.width, bmp.height);
      // Больше, чем видеокарта берёт одной текстурой (огромный скан или панорама): на доске —
      // уменьшенная до предела видеокарты копия, а в просмотрщике — сам файл целиком.
      if (bmp.width > this.maxTexture || bmp.height > this.maxTexture) {
        const k = this.maxTexture / Math.max(bmp.width, bmp.height);
        const fitted = await createImageBitmap(bmp, { resizeWidth: Math.floor(bmp.width * k), resizeHeight: Math.floor(bmp.height * k), resizeQuality: 'high' });
        bmp.close();
        bmp = fitted;
      }
      if (e.slots[2].tex) bmp.close();
      else this.setSlot(e, 2, bmp);
    } catch {
      e.slots[2].loading = false;
      e.slots[2].failed = true;
    }
  }

  /** Освободить память: сначала оригиналы, потом превью, давно не видные — первыми. Видимые не трогаем. */
  evict(inUse: Set<string>): void {
    if (this.totalBytes <= BUDGET_BYTES) return;
    const candidates: { e: Entry; level: Level; used: number }[] = [];
    for (const e of this.entries.values()) {
      if (inUse.has(e.file)) continue;
      e.slots.forEach((slot, level) => {
        if (slot.tex) candidates.push({ e, level: level as Level, used: slot.used - (level === 2 ? 1e9 : 0) });
      });
    }
    candidates.sort((a, b) => a.used - b.used);
    for (const c of candidates) {
      if (this.totalBytes <= BUDGET_BYTES * 0.8) break;
      this.drop(c.e, c.level);
    }
  }

  private drop(e: Entry, level: Level): void {
    const slot = e.slots[level];
    if (!slot.tex) return;
    slot.tex.destroy(true);
    slot.bitmap?.close();
    this.totalBytes -= slot.bytes;
    e.slots[level] = emptySlot();
  }

  destroy(): void {
    for (const e of this.entries.values()) for (const level of [0, 1, 2] as const) this.drop(e, level);
    this.entries.clear();
  }
}
