// Карточка ссылки: заголовок, описание, сайт, обложка и значок сайта — как в Miro.
// Страницу читает сервер (браузеру чужие сайты не отдают свои страницы), обложку и значок
// сохраняет в папку доски — карточка показывается без интернета и переезжает вместе с доской.
import { createHash } from 'node:crypto';
import { type Dispatcher, fetch as ufetch, ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/** Метаданные страницы: Open Graph, Twitter, обычные meta и title. */
export function parseMeta(html: string, base: string): { title?: string; description?: string; site?: string; image?: string; icon?: string; oembed?: string } {
  // Не только <head>: у тяжёлых страниц (YouTube) нужные теги бывают далеко от начала.
  const head = html;
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (key && content && !meta.has(key)) meta.set(key, decode(content));
  }
  let icon: string | undefined;
  let oembed: string | undefined;
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    if (rel === 'alternate' && /json\+oembed/i.test(attr(tag, 'type') ?? '')) oembed = href;
    if (rel.includes('apple-touch-icon')) icon = href;
    else if (rel.split(/\s+/).includes('icon') && !icon) icon = href;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const abs = (u?: string) => {
    if (!u) return undefined;
    try {
      return new URL(decode(u), base).href;
    } catch {
      return undefined;
    }
  };
  return {
    title: meta.get('og:title') ?? meta.get('twitter:title') ?? (titleTag ? decode(titleTag) : undefined),
    description: meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
    site: meta.get('og:site_name') ?? new URL(base).hostname.replace(/^www\./, ''),
    image: abs(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src')),
    icon: abs(icon) ?? new URL('/favicon.ico', base).href,
    oembed: abs(oembed),
  };
}

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/avif': '.avif' };

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
