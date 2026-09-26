// [[Вики-ссылки]] по правилам Obsidian — без обращения к диску: на входе список путей базы.
// Этим пользуются и приложение (переходы по ссылкам, картинки в заметках), и сервер при сборке сайта:
// какие картинки вставлены в опубликованные заметки, он находит по тем же правилам, что и показ заметки.

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Имя, по которому Obsidian находит файл в [[ссылке]]: у заметок без .md, у остальных — с расширением. */
export function linkName(path: string): string {
  const name = basename(path).toLowerCase();
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

export class LinkResolver {
  private readonly paths: string[];
  private readonly byName = new Map<string, string[]>();

  constructor(paths: string[]) {
    this.paths = paths;
    for (const p of paths) {
      const key = linkName(p);
      const list = this.byName.get(key);
      if (list) list.push(p);
      else this.byName.set(key, [p]);
    }
  }

  /**
   * Куда ведёт [[ссылка]]: `Заметка`, `Папка/Заметка`, `фото.png`, с хвостом `#заголовок` или `^блок`.
   * Если одноимённых несколько — ближайшая к текущей заметке, потом самая короткая.
   */
  resolve(target: string, from = ''): string | null {
    const clean = target.split('|')[0].split('#')[0].split('^')[0].trim();
    if (!clean) return null;
    const lower = clean.toLowerCase().replace(/\\/g, '/');
    if (lower.includes('/')) {
      const withMd = lower.endsWith('.md') || /\.[a-z0-9]{2,5}$/.test(lower) ? lower : `${lower}.md`;
      return this.paths.find((p) => p.toLowerCase() === withMd || p.toLowerCase().endsWith(`/${withMd}`)) ?? null;
    }
    const key = lower.endsWith('.md') ? lower.slice(0, -3) : lower;
    const list = this.byName.get(key);
    if (!list?.length) return null;
    if (list.length === 1) return list[0];
    const here = dirname(from);
    return [...list].sort((a, b) => {
      const sa = dirname(a) === here ? 0 : 1, sb = dirname(b) === here ? 0 : 1;
      return sa - sb || a.length - b.length;
    })[0];
  }
}

/** Что вставлено в текст через `![[…]]` (картинки и другие файлы) — цели без подписи и размера. */
export function embedTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/!\[\[([^\]\n]+)\]\]/g)) out.push(m[1].split('|')[0].trim());
  return out;
}
