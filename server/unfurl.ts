// Карточка ссылки: заголовок, описание, сайт, обложка и значок сайта — как в Miro.
// Страницу читает сервер (браузеру чужие сайты не отдают свои страницы), обложку и значок
// сохраняет в папку доски — карточка показывается без интернета и переезжает вместе с доской.
import { createHash } from 'node:crypto';
import { type Dispatcher, fetch as ufetch, ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EXT, parseMeta } from '../src/format/unfurlMeta.ts';

export interface Unfurled {
  url: string;
  title?: string;
  description?: string;
  site?: string;
  /** Пути от корня базы к сохранённым картинкам. */
  image?: string;
  favicon?: string;
}

const PAGE_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

/** Только внешние http(s)-адреса: ссылка не должна уметь обратиться к службам самого компьютера. */
export function checkUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Карточка делается только для ссылок http и https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0') {
    throw new Error('Ссылки на сам компьютер не разворачиваются в карточку');
  }
  return u;
}

const dispatchers = new Map<string, Dispatcher>();

/**
 * Через что ходить в интернет: напрямую или через прокси — тот же, что в браузере (например, в ZeroOmega).
 * Поддерживаются http(s)://хост:порт и socks5://хост:порт.
 */
function dispatcherFor(proxy: string | undefined): Dispatcher | undefined {
  if (!proxy) return undefined;
  let d = dispatchers.get(proxy);
  if (!d) {
    const u = new URL(proxy);
    d = u.protocol.startsWith('socks')
      ? (socksDispatcher({ type: u.protocol === 'socks4:' ? 4 : 5, host: u.hostname, port: Number(u.port) || 1080 }) as unknown as Dispatcher)
      : new ProxyAgent(proxy);
    dispatchers.set(proxy, d);
  }
  return d;
}

let currentProxy: string | undefined;

async function fetchLimited(url: string, limit: number, accept: string): Promise<{ bytes: Buffer; type: string; url: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await ufetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'ru,en;q=0.8' },
      signal: ctrl.signal,
      redirect: 'follow',
      dispatcher: dispatcherFor(currentProxy),
    });
    if (!res.ok || !res.body) throw new Error(`Сайт ответил ${res.status}`);
    checkUrl(res.url);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > limit) break;
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), type: res.headers.get('content-type') ?? '', url: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/** Скачать картинку в папку доски под именем по её содержимому (одинаковые не дублируются). */
async function saveImage(absRoot: string, relDir: string, url: string, prefix: string): Promise<string | undefined> {
  try {
    const { bytes, type } = await fetchLimited(url, IMAGE_LIMIT, 'image/*');
    const mime = type.split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/') || bytes.length === 0 || bytes.length >= IMAGE_LIMIT) return undefined;
    const ext = EXT[mime] ?? (path.extname(new URL(url).pathname).toLowerCase() || '.img');
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const name = `${prefix}-${hash}${ext}`;
    const absDir = path.join(absRoot, relDir);
    await fs.mkdir(absDir, { recursive: true });
    const abs = path.join(absDir, name);
    if (!(await fs.stat(abs).catch(() => null))) await fs.writeFile(abs, bytes);
    return `${relDir}/${name}`;
  } catch {
    return undefined;
  }
}

export async function unfurl(absRoot: string, boardFolder: string, rawUrl: string, proxy?: string): Promise<Unfurled> {
  const u = checkUrl(rawUrl);
  currentProxy = proxy?.trim() || undefined;
  const page = await fetchLimited(u.href, PAGE_LIMIT, 'text/html,application/xhtml+xml');
  const out: Unfurled = { url: page.url };
  if (!/html|xml/i.test(page.type)) {
    out.title = decodeURIComponent(new URL(page.url).pathname.split('/').pop() || u.hostname);
    out.site = u.hostname.replace(/^www\./, '');
    return out;
  }
  const m = parseMeta(page.bytes.toString('utf8'), page.url);
  // oEmbed — способ, которым сайты (YouTube, Vimeo и др.) сами отдают название и обложку.
  const pageHost = new URL(page.url).hostname.replace(/^www\./, '');
  const oembedUrl = m.oembed ?? (/(^|\.)(youtube\.com|youtu\.be)$/.test(pageHost) ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page.url)}` : undefined);
  if (oembedUrl && (!m.title || !m.image)) {
    try {
      const o = JSON.parse((await fetchLimited(oembedUrl, 200_000, 'application/json')).bytes.toString('utf8')) as {
        title?: string;
        author_name?: string;
        provider_name?: string;
        thumbnail_url?: string;
      };
      m.title = m.title ?? o.title;
      m.description = m.description ?? o.author_name;
      m.site = o.provider_name ?? m.site;
      m.image = m.image ?? o.thumbnail_url;
    } catch {
      // Нет oEmbed — обойдёмся тем, что нашли на странице.
    }
  }
  Object.assign(out, { title: m.title, description: m.description, site: m.site });
  const relDir = `${boardFolder ? `${boardFolder}/` : ''}ссылки`;
  const host = new URL(page.url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '_');
  const [image, favicon] = await Promise.all([
    m.image ? saveImage(absRoot, relDir, m.image, host) : undefined,
    m.icon ? saveImage(absRoot, relDir, m.icon, `${host}-значок`) : undefined,
  ]);
  if (image) out.image = image;
  if (favicon) out.favicon = favicon;
  return out;
}
