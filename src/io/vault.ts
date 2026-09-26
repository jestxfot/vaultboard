// Доступ к файлам базы из интерфейса. Два режима с одним и тем же набором функций:
// - редактор — через локальный сервер (в настольной версии — прямой доступ к диску);
// - сайт (опубликованные доски, только просмотр) — готовые файлы рядом со страницей, по манифесту site.json.
// Остальной код не знает, в каком он режиме, кроме мест, где прячется правка (см. SITE).

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
  /** Папка сайта для публикации досок. */
  siteDir?: string;
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

/** Что уйдёт на сайт с доской (см. server/publish.ts). */
export interface PublishPlan {
  board: string;
  title: string;
  files: { path: string; kind: 'board' | 'image' | 'doc' | 'file' | 'link' | 'embed'; size: number; outside: boolean }[];
  missing: string[];
  total: number;
  hiddenItems: number;
  comments: number;
}

export interface SiteInfo {
  dir: string;
  exists: boolean;
  boards: { path: string; title: string; published: string }[];
  /** Когда эта доска публиковалась в последний раз (null — ещё нет). */
  published: string | null;
  git: boolean;
  remote: string | null;
}

export interface PublishResult {
  title: string;
  files: number;
  copied: number;
  copiedBytes: number;
  removed: number;
  missing: string[];
  git: { ok: boolean; output: string } | null;
}

export interface UpdateStatus {
  current: string;
  git: boolean;
  enabled: boolean;
  latest: { tag: string; name: string; notes: string; url: string } | null;
  available: boolean;
  /** Можно обновиться кнопкой, не закрывая приложение. */
  canApply: boolean;
}

const serverVault = {
  /** Подготовиться к работе (у сайта — прочитать манифест). */
  init: async (): Promise<void> => undefined,

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

  /**
   * Долгий запрос: что поменялось в папке с досками снаружи (Obsidian, git, проводник) после изменения `since`.
   * `since` = −1 — только узнать текущий номер. `reset` — изменений было слишком много или сервер перезапустился:
   * перечитать всё.
   */
  changesWait: (since: number) => request<{ seq: number; paths: string[]; reset?: boolean }>(`/api/changes/wait?since=${since}`),

  /** Первая настройка: выбрана ли папка с досками и что предложить. */
  setup: () => request<SetupInfo>('/api/setup'),

  /** Папки внутри `path` (пусто — диски компьютера). */
  dirs: (path: string) => request<DirList>(`/api/fs/dirs?path=${encodeURIComponent(path)}`),

  mkdir: (parent: string, name: string) => request<{ path: string }>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ parent, name }) }),

  /** Вышел ли новый релиз на GitHub. `force` — спросить GitHub сейчас, а не взять ответ часовой давности. */
  updateStatus: (force = false) => request<UpdateStatus>(`/api/update${force ? '?force' : ''}`),

  /**
   * Долгий запрос: сервер ответит, когда узнает о версии, отличной от `known` (или через 4 минуты).
   * Оборвался — значит, сервер перезапускается.
   */
  updateWait: (known: string) => request<UpdateStatus>(`/api/update/wait?known=${encodeURIComponent(known)}`),

  /** Обновиться сейчас: сервер перезапустится с новой версией (страницу потом перезагрузить). */
  applyUpdate: () => request<{ ok: boolean }>('/api/update/apply', { method: 'POST' }),

  resolve: (from: string, refs: string[]) =>
    request<Record<string, string | null>>('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, refs }),
    }),

  /** Что уйдёт на сайт с доской и что уже лежит в папке сайта (`dir` пусто — папка из настроек). */
  publishPlan: (board: string, dir = '') =>
    request<{ plan: PublishPlan; site: SiteInfo }>(`/api/publish/plan?board=${encodeURIComponent(board)}&dir=${encodeURIComponent(dir)}`),

  siteInfo: (dir: string, board: string) => request<SiteInfo>(`/api/publish/site?dir=${encodeURIComponent(dir)}&board=${encodeURIComponent(board)}`),

  publish: (board: string, dir: string, push: boolean) =>
    request<PublishResult>('/api/publish', { method: 'POST', body: JSON.stringify({ board, dir, push }) }),

  unpublish: (board: string, dir: string, push: boolean) =>
    request<{ removed: number; git: { ok: boolean; output: string } | null }>('/api/publish/remove', { method: 'POST', body: JSON.stringify({ board, dir, push }) }),
};

// ---------- сайт: только просмотр ----------

/** Страница — опубликованный сайт (пометку ставит публикация в index.html). */
export const SITE = typeof document !== 'undefined' && !!document.querySelector('meta[name="vaultboard-site"]');

interface SiteManifest {
  format: string;
  updated: string;
  boards: { path: string; title: string; published: string; files: string[] }[];
  files: Record<string, { url: string; size: number; previews?: (string | null)[] }>;
}

let manifest: SiteManifest = { format: '', updated: '', boards: [], files: {} };
const readOnly = (): never => {
  throw new Error('Это опубликованная доска — только просмотр');
};
/** Запрос, который на сайте никогда не ответит (долгие запросы редактора там не нужны). */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const siteVault: typeof serverVault = {
  async init() {
    const res = await fetch('site.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Не удалось загрузить список досок сайта');
    manifest = (await res.json()) as SiteManifest;
  },
  listBoards: async () => ({
    root: '',
    boards: manifest.boards.map((b) => ({ path: b.path, kind: 'board' as const, size: manifest.files[b.path]?.size ?? 0, mtime: Date.parse(b.published) || 0 })),
  }),
  // Неопубликованный файл — адрес, которого нет: картинка просто не загрузится.
  fileUrl: (path) => manifest.files[path]?.url ?? `f/-${encodeURIComponent(path)}`,
  async readText(path) {
    const res = await fetch(siteVault.fileUrl(path));
    if (!res.ok) throw new Error(`Не опубликовано: ${path}`);
    return res.text();
  },
  async readWithMtime(path) {
    return { text: await siteVault.readText(path), mtime: 0 };
  },
  writeBoard: async () => readOnly(),
  listFiles: async () => ({ files: Object.entries(manifest.files).map(([path, f]) => ({ path, size: f.size, mtime: 0 })) }),
  writeDoc: async () => readOnly(),
  mtimeOf: async (path) => (manifest.files[path] ? 0 : null),
  trash: async () => readOnly(),
  readHistory: async () => '',
  appendHistory: async () => undefined,
  upload: async () => readOnly(),
  // Готового превью нет — приложение сделает его само из оригинала (и никуда не сохранит).
  previewUrl: (path, level) => manifest.files[path]?.previews?.[level] ?? `p/-${encodeURIComponent(path)}`,
  putPreview: async () => undefined,
  getLibrary: async () => ({}),
  putLibrary: async () => undefined,
  unfurl: async () => readOnly(),
  obsidianVaults: async () => ({ root: '', vaults: null }),
  getSettings: async () => ({}),
  putSettings: async () => undefined,
  changesWait: () => never(),
  setup: async () => ({ root: 'site', fixed: true, defaultAuthor: '', obsidian: false, suggestions: [] }),
  dirs: async () => readOnly(),
  mkdir: async () => readOnly(),
  updateStatus: () => never(),
  updateWait: () => never(),
  applyUpdate: async () => readOnly(),
  async resolve(from, refs) {
    // Как на сервере: от папки файла вверх до корня — первый существующий путь.
    const out: Record<string, string | null> = {};
    for (const ref of refs) {
      out[ref] = null;
      for (let dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
        const p = dir ? `${dir}/${ref}` : ref;
        if (manifest.files[p]) {
          out[ref] = p;
          break;
        }
        if (!dir) break;
      }
    }
    return out;
  },
  publishPlan: async () => readOnly(),
  siteInfo: async () => readOnly(),
  publish: async () => readOnly(),
  unpublish: async () => readOnly(),
};

export const vault: typeof serverVault = SITE ? siteVault : serverVault;
