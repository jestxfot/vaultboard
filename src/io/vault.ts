// Доступ к файлам базы из интерфейса. Сейчас — через локальный сервер,
// в настольной версии этот модуль заменится прямым доступом к диску.

export interface BoardEntry {
  path: string;
  kind: 'board' | 'canvas';
  size: number;
  mtime: number;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Ошибка сервера ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface Settings {
  proxy?: string;
  author?: string;
  vaultRoot?: string;
  autoUpdate?: boolean;
  /** Имя пользователя системы — имя в комментариях по умолчанию. */
  defaultAuthor?: string;
  /** Папка базы задана переменной VAULT_ROOT (разработка) — в настройках её не поменять. */
  fixedRoot?: string | null;
}

export interface SetupInfo {
  root: string | null;
  fixed: boolean;
  defaultAuthor: string;
  obsidian: boolean;
  suggestions: { path: string; kind: 'obsidian' | 'new' | 'folder' }[];
}

export interface DirList {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  home: string;
}

export interface UpdateStatus {
  current: string;
  git: boolean;
  enabled: boolean;
  latest: { tag: string; name: string; notes: string; url: string } | null;
  available: boolean;
}

export const vault = {
  listBoards: () => request<{ root: string; boards: BoardEntry[] }>('/api/boards'),

  fileUrl: (path: string) => `/api/file?path=${encodeURIComponent(path)}`,

  async readText(path: string): Promise<string> {
    const res = await fetch(vault.fileUrl(path));
    if (!res.ok) throw new Error(`Не удалось прочитать ${path}`);
    return res.text();
  },

  /** Текст файла и время его изменения — чтобы при сохранении заметить чужие правки. */
  async readWithMtime(path: string): Promise<{ text: string; mtime: number }> {
    const res = await fetch(vault.fileUrl(path));
    if (!res.ok) throw new Error(`Не удалось прочитать ${path}`);
    return { text: await res.text(), mtime: Number(res.headers.get('X-Mtime') ?? 0) };
  },

  /** Записать доску. `mtime`: время, с которым файл читали; 'new' — новая доска; 'force' — записать поверх чужих правок. */
  async writeBoard(path: string, text: string, mtime: number | 'new' | 'force'): Promise<{ ok: true; mtime: number } | { ok: false; conflict: boolean; error: string }> {
    const res = await fetch(`/api/board?path=${encodeURIComponent(path)}&mtime=${mtime}`, { method: 'PUT', body: text });
    const body = (await res.json().catch(() => ({}))) as { mtime?: number; error?: string };
    if (res.ok) return { ok: true, mtime: body.mtime ?? 0 };
    return { ok: false, conflict: res.status === 409, error: body.error ?? `Ошибка сервера ${res.status}` };
  },

  listFiles: () => request<{ files: { path: string; size: number; mtime: number }[] }>('/api/files'),

  /** Записать заметку .md. `mtime` — как у доски: время чтения, 'new' или 'force'. */
  async writeDoc(path: string, text: string, mtime: number | 'new' | 'force'): Promise<{ ok: true; mtime: number } | { ok: false; conflict: boolean; error: string }> {
    const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}&mtime=${mtime}`, { method: 'PUT', body: text });
    const body = (await res.json().catch(() => ({}))) as { mtime?: number; error?: string };
    if (res.ok) return { ok: true, mtime: body.mtime ?? 0 };
    return { ok: false, conflict: res.status === 409, error: body.error ?? `Ошибка сервера ${res.status}` };
  },

  async mtimeOf(path: string): Promise<number | null> {
    const res = await fetch(vault.fileUrl(path), { method: 'HEAD' });
    return res.ok ? Number(res.headers.get('X-Mtime') ?? 0) : null;
  },

  /** Убрать файл в корзину базы `.trash` (как Obsidian). */
  async trash(path: string): Promise<string> {
    const res = await fetch(`/api/trash?path=${encodeURIComponent(path)}`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { trashed?: string; error?: string };
    if (!res.ok || !body.trashed) throw new Error(body.error ?? 'Не удалось удалить файл');
    return body.trashed;
  },

  async readHistory(boardPath: string): Promise<string> {
    const res = await fetch(`/api/history?board=${encodeURIComponent(boardPath)}`);
    return res.ok ? res.text() : '';
  },

  async appendHistory(boardPath: string, lines: string): Promise<void> {
    const res = await fetch(`/api/history?board=${encodeURIComponent(boardPath)}`, { method: 'POST', body: lines });
    if (!res.ok) throw new Error('Не удалось записать историю');
  },

  /** Положить файл в папку доски байт в байт. Если такой уже есть — вернётся путь к нему. */
  async upload(board: string, name: string, data: Blob): Promise<{ path: string; deduped: boolean; size: number }> {
    const res = await fetch(`/api/upload?board=${encodeURIComponent(board)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
    const body = (await res.json().catch(() => ({}))) as { path?: string; deduped?: boolean; size?: number; error?: string };
    if (!res.ok || !body.path) throw new Error(body.error ?? `Не удалось загрузить ${name}`);
    return { path: body.path, deduped: !!body.deduped, size: body.size ?? data.size };
  },

  previewUrl: (path: string, level: 0 | 1) => `/api/preview?path=${encodeURIComponent(path)}&level=${level}`,

  async putPreview(path: string, level: 0 | 1, data: Blob): Promise<void> {
    await fetch(vault.previewUrl(path, level), { method: 'PUT', body: data }).catch(() => undefined);
  },

  /** Общая библиотека стилей базы (`.vaultboard/стили.json`). */
  async getLibrary(): Promise<Record<string, import('../model/types.ts').StyleDef>> {
    const res = await fetch('/api/library');
    return res.ok ? res.json() : {};
  },

  async putLibrary(styles: Record<string, import('../model/types.ts').StyleDef>): Promise<void> {
    await fetch('/api/library', { method: 'PUT', body: JSON.stringify(styles, null, 1) });
  },

  /** Развернуть ссылку в карточку: заголовок, описание, сайт, обложка и значок (картинки — в папку доски). */
  async unfurl(url: string, board: string): Promise<{ url: string; title?: string; description?: string; site?: string; image?: string; favicon?: string }> {
    const res = await fetch('/api/unfurl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, board }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? 'Сайт не ответил');
    return body as { url: string };
  },

  /** Хранилища Obsidian на этом компьютере; null — Obsidian не установлен. */
  obsidianVaults: () => request<{ root: string; vaults: string[] | null }>('/api/obsidian-vaults'),

  getSettings: () => request<Settings>('/api/settings'),

  /** Меняются только присланные поля; пустая строка — убрать поле. */
  async putSettings(settings: Partial<Omit<Settings, 'defaultAuthor' | 'fixedRoot'>> & { createRoot?: boolean }): Promise<void> {
    await request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
  },

  /** Первая настройка: выбрана ли папка с досками и что предложить. */
  setup: () => request<SetupInfo>('/api/setup'),

  /** Папки внутри `path` (пусто — диски компьютера). */
  dirs: (path: string) => request<DirList>(`/api/fs/dirs?path=${encodeURIComponent(path)}`),

  mkdir: (parent: string, name: string) => request<{ path: string }>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ parent, name }) }),

  /** Вышел ли новый релиз на GitHub. `force` — спросить GitHub сейчас, а не взять ответ часовой давности. */
  updateStatus: (force = false) => request<UpdateStatus>(`/api/update${force ? '?force' : ''}`),

  resolve: (from: string, refs: string[]) =>
    request<Record<string, string | null>>('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, refs }),
    }),
};
