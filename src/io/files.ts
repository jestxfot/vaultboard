// Файлы базы глазами доски: поиск заметок, разрешение [[вики-ссылок]] и кэш текстов документов.
import { vault } from './vault.ts';

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Имя, по которому Obsidian находит файл в [[ссылке]]: у заметок без .md, у остальных — с расширением. */
function linkName(path: string): string {
  const name = basename(path).toLowerCase();
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';

/** Текст, набранный не в той раскладке: каждая клавиша переводится в букву другой раскладки. */
export function switchLayout(text: string): string {
  return [...text.toLowerCase()]
    .map((ch) => {
      const r = RU.indexOf(ch);
      if (r >= 0) return EN[r];
      const e = EN.indexOf(ch);
      return e >= 0 ? RU[e] : ch;
    })
    .join('');
}

export class FileIndex {
  private paths: string[] = [];
  private readonly byName = new Map<string, string[]>();
  onChange: (() => void) | null = null;

  get notes(): string[] {
    return this.paths.filter((p) => p.toLowerCase().endsWith('.md'));
  }

  async refresh(): Promise<void> {
    const { files } = await vault.listFiles();
    this.paths = files.map((f) => f.path);
    this.byName.clear();
    for (const p of this.paths) {
      const key = linkName(p);
      const list = this.byName.get(key);
      if (list) list.push(p);
      else this.byName.set(key, [p]);
    }
    this.onChange?.();
  }

  has(path: string): boolean {
    return this.paths.includes(path);
  }

  /**
   * Куда ведёт [[ссылка]], по правилам Obsidian: `Заметка`, `Папка/Заметка`, `фото.png`,
   * с хвостом `#заголовок` или `^блок`. Если одноимённых несколько — ближайшая к текущей заметке, потом самая короткая.
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

  /**
   * Нечёткий поиск заметок: буквы запроса должны встретиться по порядку; выше — совпадения в имени и подряд.
   * Если ничего не нашлось — пробуем тот же запрос в другой раскладке («ЬСШ» → «MCI», «ntjhbz» → «теория»).
   */
  search(query: string, limit = 30): string[] {
    const found = this.searchExact(query, limit);
    if (found.length || !query.trim()) return found;
    return this.searchExact(switchLayout(query), limit);
  }

  private searchExact(query: string, limit: number): string[] {
    const q = query.trim().toLowerCase();
    const notes = this.notes;
    if (!q) return notes.slice(0, limit);
    const scored: { path: string; score: number }[] = [];
    for (const path of notes) {
      const hay = path.toLowerCase();
      const name = linkName(path);
      let score = 0, pos = -1, streak = 0;
      let ok = true;
      for (const ch of q) {
        const next = hay.indexOf(ch, pos + 1);
        if (next < 0) {
          ok = false;
          break;
        }
        streak = next === pos + 1 ? streak + 1 : 0;
        score += 1 + streak * 2;
        pos = next;
      }
      if (!ok) continue;
      if (name.includes(q)) score += 50;
      if (name.startsWith(q)) score += 30;
      scored.push({ path, score: score - path.length * 0.05 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.path);
  }
}

export interface DocState {
  text: string;
  mtime: number;
}

/** Тексты документов на доске. Один на всё приложение: карточка и панель правки видят одно и то же. */
export class DocCache {
  private readonly docs = new Map<string, DocState>();
  private readonly loading = new Map<string, Promise<DocState | null>>();
  private readonly listeners = new Set<(path: string) => void>();

  onChange(fn: (path: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(path: string): DocState | undefined {
    return this.docs.get(path);
  }

  load(path: string): Promise<DocState | null> {
    const pending = this.loading.get(path);
    if (pending) return pending;
    const p = vault
      .readWithMtime(path)
      .then(({ text, mtime }) => {
        this.set(path, { text, mtime });
        return this.docs.get(path)!;
      })
      .catch(() => null)
      .finally(() => this.loading.delete(path));
    this.loading.set(path, p);
    return p;
  }

  /** Попросить текст: если его ещё нет — загрузить, а по готовности сообщить подписчикам. */
  request(path: string): void {
    if (!this.docs.has(path)) void this.load(path);
  }

  set(path: string, state: DocState): void {
    const prev = this.docs.get(path);
    this.docs.set(path, state);
    if (prev?.text !== state.text) for (const fn of this.listeners) fn(path);
  }

  /** Заметки могли поменять в Obsidian — проверить время изменения и перечитать изменившиеся. */
  async revalidate(): Promise<void> {
    await Promise.all(
      [...this.docs.entries()].map(async ([path, st]) => {
        const mtime = await vault.mtimeOf(path).catch(() => null);
        if (mtime !== null && Math.abs(mtime - st.mtime) > 1) await this.load(path);
      }),
    );
  }
}
