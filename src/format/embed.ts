// Видео, которое можно смотреть прямо на доске: YouTube (в режиме без рекламных cookie) и Vimeo.

interface Video {
  host: 'youtube' | 'vimeo';
  id: string;
  start: number;
}

function parse(raw: string): Video | null {
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
    return { host: 'youtube', id, start };
  }
  if (host === 'vimeo.com') {
    const vid = /^\/(\d+)/.exec(u.pathname)?.[1];
    if (vid) return { host: 'vimeo', id: vid, start: 0 };
  }
  return null;
}

/**
 * Адрес плеера для ссылки на видео или null, если это не видео.
 * Плеер слушает команды от доски (enablejsapi): щелчок по карточке запускает видео без перезагрузки плеера.
 */
export function embedUrl(raw: string, autoplay = false): string | null {
  const v = parse(raw);
  if (!v) return null;
  if (v.host === 'youtube') {
    const q = new URLSearchParams({ rel: '0', enablejsapi: '1', playsinline: '1', origin: location.origin });
    if (autoplay) q.set('autoplay', '1');
    if (v.start) q.set('start', String(v.start));
    return `https://www.youtube-nocookie.com/embed/${v.id}?${q}`;
  }
  return `https://player.vimeo.com/video/${v.id}${autoplay ? '?autoplay=1' : ''}`;
}

/** Сказать плееру «играй» или «пауза» — через postMessage, как это делают официальные API YouTube и Vimeo. */
export function playerCommand(frame: HTMLIFrameElement, play: boolean): void {
  const target = frame.contentWindow;
  if (!target) return;
  if (frame.src.includes('vimeo.com')) target.postMessage(JSON.stringify({ method: play ? 'play' : 'pause' }), '*');
  else target.postMessage(JSON.stringify({ event: 'command', func: play ? 'playVideo' : 'pauseVideo', args: [] }), '*');
}
