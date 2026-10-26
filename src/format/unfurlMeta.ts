// Разбор страницы для карточки ссылки: заголовок, описание, обложка, значок. Общий для сервера (server/unfurl.ts)
// и приложения на iPad, где страницу скачивает само приложение (src/io/localVault.ts).

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

export const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/avif': '.avif' };
