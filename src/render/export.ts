// Экспорт доски (или выделенного) в PNG, JPG и PDF в полном качестве.
//
// Картинка рисуется отдельно от экрана: камера ставится на нужный кусок, все объекты строятся
// в полной детализации, фото грузятся оригиналами. Большая доска собирается по кускам (плиткам),
// потому что видеокарта не рисует картинку больше своего предела за раз. Сетка и выделение
// в экспорт не попадают — только сама доска на её фоне.
import type { Rect } from './geometry.ts';

export type ExportFormat = 'png' | 'jpg' | 'pdf';

/** Больше этого браузер не соберёт одну картинку (ограничение холста), поэтому масштаб при необходимости уменьшается. */
const MAX_PIXELS = 120_000_000;
const MAX_SIDE = 32_000;
const TILE = 4096;

export interface ExportTarget {
  /** Нарисовать кусок доски `rect` в масштабе `scale` на холст размером `w×h`. */
  renderTile(rect: Rect, scale: number, w: number, h: number): Promise<HTMLCanvasElement | OffscreenCanvas>;
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
export function plan(rect: Rect, scale: number): { width: number; height: number; scale: number; reduced: boolean } {
  let s = scale;
  const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (rect.w * rect.h * s * s)), MAX_SIDE / (rect.w * s), MAX_SIDE / (rect.h * s));
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
  const p = plan(rect, scale);
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
      const tile = await target.renderTile(tileRect, p.scale, w, h);
      ctx.drawImage(tile as CanvasImageSource, px, py);
      onProgress?.(++done, cols * rows);
    }
  }

  const blob = format === 'pdf' ? await toPdf(out) : await new Promise<Blob>((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('Браузер не смог собрать картинку'))), format === 'png' ? 'image/png' : 'image/jpeg', 1),
  );
  return { blob, width: p.width, height: p.height, scale: p.scale, reduced: p.reduced };
}

/**
 * PDF из одной страницы размером с картинку. Пиксели лежат внутри сжатыми без потерь (FlateDecode —
 * то же сжатие, что в PNG), поэтому качество не теряется ни на одном пикселе.
 */
async function toPdf(canvas: HTMLCanvasElement): Promise<Blob> {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  const packed = new Uint8Array(await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

  // Размер страницы в пунктах: картинка при 150 точках на дюйм, чтобы страница была разумного размера,
  // а сама картинка — все пиксели как есть.
  const pw = (width * 72) / 150, ph = (height * 72) / 150;
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
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`);
  push(packed);
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
