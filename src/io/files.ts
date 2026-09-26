// Файлы базы глазами доски: поиск заметок, разрешение [[вики-ссылок]] и кэш текстов документов.
import { vault } from './vault.ts';
import { LinkResolver, linkName } from '../format/links.ts';

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
  private links = new LinkResolver([]);
  onChange: (() => void) | null = null;

  get notes(): string[] {
    return this.paths.filter((p) => p.toLowerCase().endsWith('.md'));
  }

  async refresh(): Promise<void> {
    const { files } = await vault.listFiles();
    this.paths = files.map((f) => f.path);
    this.links = new LinkResolver(this.paths);
    this.onChange?.();
  }

  has(path: string): boolean {
    return this.paths.includes(path);
  }

  /** Куда ведёт [[ссылка]], по правилам Obsidian (см. format/links.ts). */
  resolve(target: string, from = ''): string | null {
    return this.links.resolve(target, from);
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
