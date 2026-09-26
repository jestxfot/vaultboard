// Видео, которое можно смотреть прямо на доске: YouTube (в режиме без рекламных cookie) и Vimeo.

/** Адрес плеера для ссылки на видео или null, если это не видео. */
export function embedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    id = u.searchParams.get('v') ?? /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname)?.[2] ?? null;
  }
  if (id && /^[\w-]{6,}$/.test(id)) {
    // Время из ссылки (?t=90 или ?t=1m30s) — видео начнётся с того же места.
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    let start = 0;
    if (t) {
      const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
      if (m) start = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
    }
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ''}`;
  }
  if (host === 'vimeo.com') {
    const vid = /^\/(\d+)/.exec(u.pathname)?.[1];
    if (vid) return `https://player.vimeo.com/video/${vid}?autoplay=1`;
  }
  return null;
}
