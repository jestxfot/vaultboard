// Экспорт доски (или выделенного) в PNG, JPG и PDF в полном качестве.
//
// Картинка рисуется отдельно от экрана: камера ставится на нужный кусок, все объекты строятся
// в полной детализации, фото грузятся оригиналами. Большая доска собирается по кускам (плиткам),
// потому что видеокарта не рисует картинку больше своего предела за раз. Сетка и выделение
// в экспорт не попадают — только сама доска на её фоне.
//
// PNG и PDF пишутся потоком, полосами сверху вниз: плитки полосы складываются в строки пикселей и сразу
// сжимаются. Одного огромного холста нет, поэтому нет и его предела (у Chrome — около 32 000 точек по стороне):
// длинный таймлайн выходит в той чёткости, которую выбрали. JPG браузер умеет сжимать только из холста —
// для него предел остаётся.
import type { Rect } from './geometry.ts';

export type ExportFormat = 'png' | 'jpg' | 'pdf';

/** JPG: больше этого браузер не соберёт одну картинку (ограничение холста), поэтому масштаб при необходимости уменьшается. */
const CANVAS_PIXELS = 120_000_000;
const CANVAS_SIDE = 32_000;
/** PNG и PDF потоком: предел — разумный размер файла и время, а не холст. */
const STREAM_PIXELS = 1_500_000_000;
const STREAM_SIDE = 200_000;
const TILE = 4096;
/** Сколько памяти держит одна полоса строк (байт). */
const STRIP_BYTES = 96 * 1024 * 1024;

export interface ExportTarget {
  /** Нарисовать кусок доски `rect` в масштабе `scale` на холст размером `w×h`. */
  renderTile(rect: Rect, scale: number, w: number, h: number): Promise<HTMLCanvasElement | OffscreenCanvas>;
  /** То же сразу пикселями RGBA (без холста — меньше копирований). Нет — возьмём с холста. */
  renderPixels?(rect: Rect, scale: number, w: number, h: number): Promise<Uint8ClampedArray>;
  /** Есть ли в куске что рисовать; пустой кусок — просто фон. */
  hasContent?(rect: Rect): boolean;
  /** Экспорт начался / закончился (камера уходит с экрана один раз, а не на каждую плитку). */
  begin?(): void;
  end?(): void;
  background: string;
}

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  scale: number;
  /** Масштаб пришлось уменьшить, чтобы картинка поместилась в память браузера. */
  reduced: boolean;
}

/** Сколько пикселей получится и не придётся ли уменьшить масштаб. */
export function plan(rect: Rect, scale: number, format: ExportFormat = 'png'): { width: number; height: number; scale: number; reduced: boolean } {
  let s = scale;
  const [maxPixels, maxSide] = format === 'jpg' ? [CANVAS_PIXELS, CANVAS_SIDE] : [STREAM_PIXELS, STREAM_SIDE];
  const fit = Math.min(1, Math.sqrt(maxPixels / (rect.w * rect.h * s * s)), maxSide / (rect.w * s), maxSide / (rect.h * s));
  const reduced = fit < 1;
  s *= fit;
  return { width: Math.max(1, Math.round(rect.w * s)), height: Math.max(1, Math.round(rect.h * s)), scale: s, reduced };
}

export async function exportBoard(
  target: ExportTarget,
  rect: Rect,
  scale: number,
  format: ExportFormat,
  onProgress?: (done: number, total: number) => void,
): Promise<ExportResult> {
  const p = plan(rect, scale, format);
  target.begin?.();
  try {
    if (format !== 'jpg') {
      const blob = await exportStream(target, rect, p, format, onProgress);
      return { blob, width: p.width, height: p.height, scale: p.scale, reduced: p.reduced };
    }
    return await exportJpg(target, rect, p, onProgress);
  } finally {
    target.end?.();
  }
}

async function exportJpg(
  target: ExportTarget,
  rect: Rect,
  p: { width: number; height: number; scale: number; reduced: boolean },
  onProgress?: (done: number, total: number) => void,
): Promise<ExportResult> {
  const out = document.createElement('canvas');
  out.width = p.width;
  out.height = p.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = target.background;
  ctx.fillRect(0, 0, p.width, p.height);

  const cols = Math.ceil(p.width / TILE), rows = Math.ceil(p.height / TILE);
  let done = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = c * TILE, py = r * TILE;
      const w = Math.min(TILE, p.width - px), h = Math.min(TILE, p.height - py);
      const tileRect = { x: rect.x + px / p.scale, y: rect.y + py / p.scale, w: w / p.scale, h: h / p.scale };
      // Пустой кусок уже залит фоном.
      if (target.hasContent?.(around(tileRect, p.scale)) ?? true) {
        const tile = await target.renderTile(tileRect, p.scale, w, h);
        ctx.drawImage(tile as CanvasImageSource, px, py);
      }
      onProgress?.(++done, cols * rows);
    }
  }

  const blob = await new Promise<Blob>((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('Браузер не смог собрать картинку'))), 'image/jpeg', 1),
  );
  return { blob, width: p.width, height: p.height, scale: p.scale, reduced: p.reduced };
}

/**
 * Кусок с запасом: заголовок рамки, толстая линия или тень могут выступать за границы объекта,
 * поэтому «пусто» проверяем чуть шире самой плитки (заголовок рамки на мелком масштабе крупнее в координатах доски).
 */
function around(r: Rect, scale: number): Rect {
  const m = 40 + 40 / scale;
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
}

// ---------- потоковая запись PNG и PDF ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const bytes of parts) for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Кусок PNG: длина, тип, данные, контрольная сумма. */
function pngChunk(type: string, data: Uint8Array): Uint8Array[] {
  const head = new Uint8Array(8);
  const view = new DataView(head.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, crc32([head.subarray(4), data]));
  return [head, data, tail];
}

/**
 * Сжать строки пикселей потоком (zlib — то, что лежит и внутри PNG, и внутри PDF) и собрать сжатое.
 * `rows` отдаёт строки полосами; каждая строка уже готова к записи.
 */
async function deflateRows(rows: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const out: Uint8Array[] = [];
  const reading = (async () => {
    const reader = cs.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  for await (const chunk of rows) {
    await writer.ready;
    await writer.write(chunk as Uint8Array<ArrayBuffer>);
  }
  await writer.close();
  await reading;
  return out;
}

/**
 * Полосы картинки сверху вниз: плитки одной полосы рисуются по очереди и складываются в строки пикселей RGBA.
 * Высота полосы — чтобы строки полосы занимали не больше STRIP_BYTES памяти.
 */
async function* strips(
  target: ExportTarget,
  rect: Rect,
  p: { width: number; height: number; scale: number },
  onProgress?: (done: number, total: number) => void,
): AsyncGenerator<{ rgba: Uint8ClampedArray; rows: number }> {
  const stripH = Math.max(64, Math.min(TILE, Math.floor(STRIP_BYTES / (p.width * 4))));
  const cols = Math.ceil(p.width / TILE), bands = Math.ceil(p.height / stripH);
  const hex = target.background.replace('#', '');
  const bg = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
  let done = 0;
  for (let b = 0; b < bands; b++) {
    const py = b * stripH;
    const h = Math.min(stripH, p.height - py);
    const rgba = new Uint8ClampedArray(p.width * h * 4);
    for (let c = 0; c < cols; c++) {
      const px = c * TILE;
      const w = Math.min(TILE, p.width - px);
      const tileRect = { x: rect.x + px / p.scale, y: rect.y + py / p.scale, w: w / p.scale, h: h / p.scale };
      if (target.hasContent && !target.hasContent(around(tileRect, p.scale))) {
        // Пустой фон (на таймлайне его много) — залить цветом, видеокарту не трогать.
        const row = new Uint8ClampedArray(w * 4);
        for (let i = 0; i < row.length; i += 4) row.set(bg, i);
        for (let y = 0; y < h; y++) rgba.set(row, (y * p.width + px) * 4);
      } else {
        const data = target.renderPixels
          ? await target.renderPixels(tileRect, p.scale, w, h)
          : ((await target.renderTile(tileRect, p.scale, w, h)).getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, w, h).data;
        for (let y = 0; y < h; y++) rgba.set(data.subarray(y * w * 4, (y + 1) * w * 4), (y * p.width + px) * 4);
      }
      onProgress?.(++done, cols * bands);
    }
    yield { rgba, rows: h };
  }
}

async function exportStream(
  target: ExportTarget,
  rect: Rect,
  p: { width: number; height: number; scale: number },
  format: 'png' | 'pdf',
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const { width, height } = p;
  // Строка PNG — байт фильтра (0, без фильтра) и RGBA; строка PDF — просто RGB (прозрачности у доски нет — фон).
  async function* rows(): AsyncGenerator<Uint8Array> {
    for await (const { rgba, rows: n } of strips(target, rect, p, onProgress)) {
      if (format === 'png') {
        const line = width * 4 + 1;
        const buf = new Uint8Array(line * n);
        for (let y = 0; y < n; y++) buf.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * line + 1);
        yield buf;
      } else {
        const buf = new Uint8Array(width * n * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
          buf[j] = rgba[i];
          buf[j + 1] = rgba[i + 1];
          buf[j + 2] = rgba[i + 2];
        }
        yield buf;
      }
    }
  }
  const packed = await deflateRows(rows());
  if (format === 'pdf') return pdfFromPacked(width, height, packed);

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...pngChunk('IHDR', ihdr)];
  for (const chunk of packed) parts.push(...pngChunk('IDAT', chunk));
  parts.push(...pngChunk('IEND', new Uint8Array(0)));
  return new Blob(parts as BlobPart[], { type: 'image/png' });
}

/**
 * PDF из одной страницы размером с картинку. Пиксели лежат внутри сжатыми без потерь (FlateDecode —
 * то же сжатие, что в PNG), поэтому качество не теряется ни на одном пикселе.
 */
function pdfFromPacked(width: number, height: number, packed: Uint8Array[]): Blob {
  const packedLength = packed.reduce((s, c) => s + c.length, 0);
  // Размер страницы в пунктах: картинка при 150 точках на дюйм (для очень больших — плотнее: у PDF-читалок
  // предел страницы 200 дюймов), а сама картинка — все пиксели как есть.
  const dpi = Math.max(150, Math.ceil((Math.max(width, height) * 72) / 14000));
  const pw = (width * 72) / dpi, ph = (height * 72) / dpi;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const content = `q ${pw.toFixed(2)} 0 0 ${ph.toFixed(2)} 0 0 cm /Im0 Do Q`;

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = length;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${packedLength} >>\nstream\n`);
  for (const chunk of packed) push(chunk);
  push('\nendstream\nendobj\n');
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

/** Сохранить файл: окно «Сохранить как» (если браузер умеет), иначе обычная загрузка. */
export async function saveBlob(blob: Blob, name: string): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const ext = name.slice(name.lastIndexOf('.'));
      const handle = await picker({ suggestedName: name, types: [{ description: ext.slice(1).toUpperCase(), accept: { [blob.type]: [ext] } }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return 'saved';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
