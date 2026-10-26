// Приложение на iPad: папка с досками лежит на самом устройстве — в «Файлах» это «На iPad › vaultboard».
// Сервера нет: всё, что на компьютере делает server/vaultApi.ts, здесь делается прямо из интерфейса через
// Capacitor Filesystem. Набор функций тот же, что у сервера (см. vault.ts), поэтому остальной код не знает, где он.
//
// Чего на iPad нет: публикации на сайт, приглашений и туннеля (для них нужен компьютер, который всегда в сети),
// выбора другой папки (приложение видит только свою) и слежения за папкой — изменения из «Файлов» подхватываются,
// когда приложение снова на экране (см. App.tsx, visibilitychange).
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Encoding, type FileInfo, Filesystem } from '@capacitor/filesystem';
import { parseBoard } from '../format/board.ts';
import { EXT, parseMeta } from '../format/unfurlMeta.ts';
import type { StyleDef } from '../model/types.ts';
import { boardFolderOf, historyPathOf } from '../model/paths.ts';
import type { BoardEntry, Settings, Vault } from './vault.ts';

const ROOT = Directory.Documents;
/** Как папка с досками называется для человека. */
export const LOCAL_ROOT_NAME = 'На iPad › vaultboard';
const BOARD_FILE = /\.(board|canvas)$/i;
const SETTINGS_FILE = 'settings.json';
const UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Адреса папки с досками и кэша для WebView (capacitor://localhost/_capacitor_file_/…) — узнаются в init. */
let rootUrl = '';
let cacheUrl = '';
/** Размер и время файлов из последнего обхода — по ним ключ превью (адрес превью нужен сразу, без запроса). */
const known = new Map<string, { size: number; mtime: number }>();
/** Хэши уже лежащих фото, чтобы не пересчитывать их при каждой вставке. */
const hashCache = new Map<string, { size: number; mtime: number; hash: string }>();

class LocalError extends Error {}
/** Чего на iPad нет: отказ приходит так же, как ошибка сервера, — отклонённым обещанием. */
const unsupported = (what: string) => async (): Promise<never> => {
  throw new LocalError(`${what} на iPad нет — это делается в vaultboard на компьютере`);
};

/** Путь от корня базы: без «..», без пустых частей и без ухода за пределы папки приложения. */
function clean(rel: string): string {
  const parts = rel.split('/');
  if (!rel || parts.some((p) => !p || p === '.' || p === '..')) throw new LocalError(`Путь вне базы: ${rel}`);
  return rel;
}

const hidden = (name: string) => name.startsWith('.') || name === 'node_modules';

function urlOf(base: string, rel: string): string {
  return `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

async function stat(rel: string, directory: Directory = ROOT): Promise<FileInfo | null> {
  try {
    return await Filesystem.stat({ path: rel, directory });
  } catch {
    return null;
  }
}

async function readdir(rel: string): Promise<FileInfo[]> {
  try {
    return (await Filesystem.readdir({ path: rel, directory: ROOT })).files;
  } catch {
    return [];
  }
}

/** Обойти базу, пропуская скрытое (`.obsidian`, `.trash`, история отмены), — как walkVault на сервере. */
async function walk(filter: (rel: string) => boolean): Promise<{ rel: string; size: number; mtime: number }[]> {
  const out: { rel: string; size: number; mtime: number }[] = [];
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of await readdir(dir)) {
      if (hidden(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.type === 'directory') stack.push(rel);
      else if (filter(rel)) {
        known.set(rel, { size: e.size, mtime: e.mtime });
        out.push({ rel, size: e.size, mtime: e.mtime });
      }
    }
  }
  return out;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

async function mkdirp(rel: string, directory: Directory = ROOT): Promise<void> {
  if (!rel) return;
  try {
    await Filesystem.mkdir({ path: rel, directory, recursive: true });
  } catch {
    // Уже есть.
  }
}

/** Переименовать поверх: если на месте цели файл, он заменяется. */
async function replace(from: string, to: string, directory: Directory = ROOT): Promise<void> {
  try {
    await Filesystem.rename({ from, to, directory, toDirectory: directory });
  } catch {
    await Filesystem.deleteFile({ path: to, directory }).catch(() => undefined);
    await Filesystem.rename({ from, to, directory, toDirectory: directory });
  }
}

/** Записать текст через временный файл: оборвётся запись — старый файл останется целым. */
async function writeText(rel: string, text: string, directory: Directory = ROOT): Promise<void> {
  await mkdirp(parentOf(rel), directory);
  const tmp = `${rel}.tmp-${Date.now()}`;
  await Filesystem.writeFile({ path: tmp, data: text, directory, encoding: Encoding.UTF8 });
  await replace(tmp, rel, directory);
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error ?? new Error('Не удалось прочитать файл'));
    r.readAsDataURL(blob);
  });
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Записать файл байт в байт. Мост в приложение передаёт только base64 — шлём кусками, чтобы большие фото не занимали память. */
async function writeBlob(rel: string, blob: Blob, directory: Directory = ROOT): Promise<void> {
  const CHUNK = 3 * 1024 * 1024; // кратно 3 — куски base64 склеиваются без «=» посередине
  await mkdirp(parentOf(rel), directory);
  await Filesystem.writeFile({ path: rel, data: await base64Of(blob.slice(0, CHUNK)), directory });
  for (let at = CHUNK; at < blob.size; at += CHUNK) {
    await Filesystem.appendFile({ path: rel, data: await base64Of(blob.slice(at, at + CHUNK)), directory });
  }
}

async function sha256(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fileHash(rel: string, st: { size: number; mtime: number }): Promise<string> {
  const cached = hashCache.get(rel);
  if (cached && cached.size === st.size && cached.mtime === st.mtime) return cached.hash;
  const { data } = await Filesystem.readFile({ path: rel, directory: ROOT });
  const hash = await sha256(typeof data === 'string' ? bytesOf(data) : await data.arrayBuffer());
  hashCache.set(rel, { size: st.size, mtime: st.mtime, hash });
  return hash;
}

/** Имя файла без символов, запрещённых в Windows: папку потом можно перенести на компьютер. */
function safeName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120);
  return cleaned || 'файл';
}

/** Свободное имя в папке: «фото.jpg», «фото (2).jpg», … */
async function freeName(dir: string, name: string, sep = ' (', close = ')'): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let final = name;
  for (let i = 2; await stat(dir ? `${dir}/${final}` : final); i++) final = `${stem}${sep}${i}${close}${ext}`;
  return final;
}

/** Короткий хэш строки — имя файла превью в кэше. */
function keyOf(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function previewFile(rel: string, level: 0 | 1): string {
  const st = known.get(rel);
  return `previews/${keyOf(`${rel}|${st?.mtime ?? 0}|${st?.size ?? 0}|${level}`)}.webp`;
}

async function readSettings(): Promise<Settings> {
  try {
    const { data } = await Filesystem.readFile({ path: SETTINGS_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
    return JSON.parse(data as string) as Settings;
  } catch {
    return {};
  }
}

/** Записать доску или заметку с той же проверкой чужих правок, что на сервере. */
async function writeChecked(rel: string, text: string, mtime: number | 'new' | 'force', changedOutside: string) {
  try {
    clean(rel);
    const st = await stat(rel);
    if (mtime === 'new' && st) return { ok: false as const, conflict: true, error: `Файл уже есть: ${rel}` };
    if (mtime !== 'new' && mtime !== 'force' && st && Math.abs(st.mtime - mtime) > 1) return { ok: false as const, conflict: true, error: changedOutside };
    await writeText(rel, text);
    const done = await stat(rel);
    return { ok: true as const, mtime: done?.mtime ?? Date.now() };
  } catch (err) {
    return { ok: false as const, conflict: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Скачать страницу или картинку самим приложением: у WebView чужие сайты свои страницы не отдают. */
async function httpGet(url: string, as: 'text' | 'blob'): Promise<{ data: string; type: string; url: string }> {
  const res = await CapacitorHttp.get({
    url,
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' },
    responseType: as,
    connectTimeout: 10_000,
    readTimeout: 10_000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`Сайт ответил ${res.status}`);
  const type = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  return { data: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), type, url: res.url || url };
}

async function saveImage(relDir: string, url: string, prefix: string): Promise<string | undefined> {
  try {
    const { data, type } = await httpGet(url, 'blob');
    const mime = type.split(';')[0].trim().toLowerCase();
    const bytes = bytesOf(data);
    if (!mime.startsWith('image/') || !bytes.length || bytes.length > 10 * 1024 * 1024) return undefined;
    const ext = EXT[mime] ?? (/\.[a-z0-9]{1,5}$/i.exec(new URL(url).pathname)?.[0].toLowerCase() || '.img');
    const rel = `${relDir}/${prefix}-${(await sha256(bytes)).slice(0, 12)}${ext}`;
    if (!(await stat(rel))) await writeBlob(rel, new Blob([bytes]));
    return rel;
  } catch {
    return undefined;
  }
}

export const localVault: Vault = {
  async init() {
    const uriOf = async (directory: Directory) => Capacitor.convertFileSrc((await Filesystem.getUri({ path: '', directory })).uri).replace(/\/+$/, '');
    [rootUrl, cacheUrl] = await Promise.all([uriOf(ROOT), uriOf(Directory.Cache)]);
  },

  async listBoards() {
    const boards: BoardEntry[] = (await walk((rel) => BOARD_FILE.test(rel))).map((f) => ({
      path: f.rel,
      kind: f.rel.toLowerCase().endsWith('.board') ? 'board' : 'canvas',
      size: f.size,
      mtime: f.mtime,
    }));
    boards.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
    return { root: LOCAL_ROOT_NAME, boards };
  },

  fileUrl: (path) => urlOf(rootUrl, path),

  async readText(path) {
    try {
      return (await Filesystem.readFile({ path: clean(path), directory: ROOT, encoding: Encoding.UTF8 })).data as string;
    } catch {
      throw new Error(`Не удалось прочитать ${path}`);
    }
  },

  async readWithMtime(path) {
    const [text, st] = await Promise.all([localVault.readText(path), stat(path)]);
    return { text, mtime: st?.mtime ?? 0 };
  },

  async writeBoard(path, text, mtime) {
    if (!/\.board$/i.test(path)) return { ok: false, conflict: false, error: 'Писать можно только файлы досок .board' };
    try {
      parseBoard(text); // не записываем испорченную доску
    } catch (err) {
      return { ok: false, conflict: false, error: (err as Error).message };
    }
    return writeChecked(path, text, mtime, 'Доску изменили снаружи');
  },

  async listFiles() {
    return { files: (await walk(() => true)).map((f) => ({ path: f.rel, size: 0, mtime: 0 })) };
  },

  async writeDoc(path, text, mtime) {
    if (!/\.md$/i.test(path)) return { ok: false, conflict: false, error: 'Документом может быть только файл .md' };
    return writeChecked(path, text, mtime, 'Заметку изменили снаружи');
  },

  async mtimeOf(path) {
    return (await stat(path))?.mtime ?? null;
  },

  async trash(path) {
    clean(path);
    if (/\.board$/i.test(path) || path.startsWith('.')) throw new Error('Этот файл так удалять нельзя');
    if ((await stat(path))?.type !== 'file') throw new Error(`Нет файла: ${path}`);
    await mkdirp('.trash');
    const target = await freeName('.trash', path.slice(path.lastIndexOf('/') + 1), ' ', '');
    await Filesystem.rename({ from: path, to: `.trash/${target}`, directory: ROOT, toDirectory: ROOT });
    known.delete(path);
    return `.trash/${target}`;
  },

  async readHistory(boardPath) {
    try {
      return (await Filesystem.readFile({ path: historyPathOf(boardPath), directory: ROOT, encoding: Encoding.UTF8 })).data as string;
    } catch {
      return '';
    }
  },

  async appendHistory(boardPath, lines) {
    const rel = historyPathOf(boardPath);
    if (await stat(rel)) await Filesystem.appendFile({ path: rel, data: lines, directory: ROOT, encoding: Encoding.UTF8 });
    else {
      await mkdirp(parentOf(rel));
      await Filesystem.writeFile({ path: rel, data: lines, directory: ROOT, encoding: Encoding.UTF8 });
    }
  },

  async upload(board, name, data) {
    if (!/\.board$/i.test(board)) throw new Error('Фото сохраняются в папку доски — сначала открой доску');
    const folder = boardFolderOf(board);
    const relDir = `${folder ? `${folder}/` : ''}фото`;
    const size = data.size;
    const digest = await sha256(await data.arrayBuffer());
    for (const e of await readdir(relDir)) {
      if (e.type !== 'file' || hidden(e.name) || e.size !== size) continue;
      const rel = `${relDir}/${e.name}`;
      if ((await fileHash(rel, e)) === digest) return { path: rel, deduped: true, size };
    }
    const final = await freeName(relDir, safeName(name));
    const tmp = `${relDir}/.upload-${Date.now()}`;
    await writeBlob(tmp, data);
    const rel = `${relDir}/${final}`;
    await replace(tmp, rel);
    const st = await stat(rel);
    if (st) {
      known.set(rel, { size: st.size, mtime: st.mtime });
      hashCache.set(rel, { size: st.size, mtime: st.mtime, hash: digest });
    }
    return { path: rel, deduped: false, size };
  },

  previewUrl: (path, level) => urlOf(cacheUrl, previewFile(path, level)),

  async putPreview(path, level, data) {
    await writeBlob(previewFile(path, level), data, Directory.Cache).catch(() => undefined);
  },

  async getLibrary() {
    try {
      return JSON.parse((await Filesystem.readFile({ path: '.vaultboard/стили.json', directory: ROOT, encoding: Encoding.UTF8 })).data as string) as Record<string, StyleDef>;
    } catch {
      return {};
    }
  },

  async putLibrary(styles) {
    await writeText('.vaultboard/стили.json', JSON.stringify(styles, null, 1));
  },

  async unfurl(url, board) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Карточка делается только для ссылок http и https');
    const page = await httpGet(u.href, 'text');
    const out: { url: string; title?: string; description?: string; site?: string; image?: string; favicon?: string } = { url: page.url };
    if (!/html|xml/i.test(page.type)) {
      out.title = decodeURIComponent(new URL(page.url).pathname.split('/').pop() || u.hostname);
      out.site = u.hostname.replace(/^www\./, '');
      return out;
    }
    const m = parseMeta(page.data, page.url);
    const pageHost = new URL(page.url).hostname.replace(/^www\./, '');
    const oembedUrl = m.oembed ?? (/(^|\.)(youtube\.com|youtu\.be)$/.test(pageHost) ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page.url)}` : undefined);
    if (oembedUrl && (!m.title || !m.image)) {
      try {
        const o = JSON.parse((await httpGet(oembedUrl, 'text')).data) as { title?: string; author_name?: string; provider_name?: string; thumbnail_url?: string };
        m.title = m.title ?? o.title;
        m.description = m.description ?? o.author_name;
        m.site = o.provider_name ?? m.site;
        m.image = m.image ?? o.thumbnail_url;
      } catch {
        // Нет oEmbed — обойдёмся тем, что нашли на странице.
      }
    }
    Object.assign(out, { title: m.title, description: m.description, site: m.site });
    const folder = /\.board$/i.test(board) ? boardFolderOf(board) : '';
    const relDir = `${folder ? `${folder}/` : ''}ссылки`;
    const host = pageHost.replace(/[^a-z0-9.-]/gi, '_');
    const [image, favicon] = await Promise.all([
      m.image ? saveImage(relDir, m.image, host) : undefined,
      m.icon ? saveImage(relDir, m.icon, `${host}-значок`) : undefined,
    ]);
    if (image) out.image = image;
    if (favicon) out.favicon = favicon;
    return out;
  },

  obsidianVaults: async () => ({ root: '', vaults: null }),

  async getSettings() {
    return { ...(await readSettings()), defaultAuthor: '', fixedRoot: LOCAL_ROOT_NAME };
  },

  async putSettings(change) {
    const next = { ...(await readSettings()) };
    if ('author' in change) {
      if (change.author?.trim()) next.author = change.author.trim().slice(0, 60);
      else delete next.author;
    }
    await writeText(SETTINGS_FILE, JSON.stringify(next, null, 1), Directory.Data);
  },

  // Следить за папкой нечем: изменения из «Файлов» подхватываются, когда приложение снова на экране.
  changesWait: () => new Promise(() => undefined),

  setup: async () => ({ root: LOCAL_ROOT_NAME, fixed: true, defaultAuthor: '', obsidian: false, suggestions: [] }),
  dirs: unsupported('Выбора папки'),
  mkdir: unsupported('Выбора папки'),

  async resolve(from, refs) {
    // Как на сервере: от папки файла вверх до корня — первый существующий путь.
    const out: Record<string, string | null> = {};
    for (const ref of refs) {
      out[ref] = null;
      for (let dir = parentOf(from); ; dir = parentOf(dir)) {
        const p = dir ? `${dir}/${ref}` : ref;
        try {
          if (await stat(clean(p))) {
            out[ref] = p;
            break;
          }
        } catch {
          // путь вне базы — просто не подходит
        }
        if (!dir) break;
      }
    }
    return out;
  },

  publishPlan: unsupported('Публикации на сайт'),
  publishSuggest: unsupported('Публикации на сайт'),
  createGithubRepo: unsupported('Публикации на сайт'),
  siteInfo: unsupported('Публикации на сайт'),
  publish: unsupported('Публикации на сайт'),
  unpublish: unsupported('Публикации на сайт'),

  async guestMe() {
    return { guest: false as const, owner: (await readSettings()).author || 'Я' };
  },
  guestLogin: unsupported('Приглашений'),
  invites: unsupported('Приглашений'),
  createInvite: unsupported('Приглашений'),
  updateInvite: unsupported('Приглашений'),
  deleteInvite: unsupported('Приглашений'),
  tunnel: unsupported('Туннеля для гостей'),
};

/** Начало адресов файлов базы — им проверяется `src` картинок в заметках (format/markdown.ts). */
export const localFileUrlPrefix = () => `${rootUrl}/`;

/** Положить готовый файл (экспорт доски) в папку «Экспорт» — в «Файлах» рядом с досками. Возвращает путь. */
export async function saveToDevice(name: string, blob: Blob): Promise<string> {
  const dir = 'Экспорт';
  const rel = `${dir}/${await freeName(dir, safeName(name))}`;
  await writeBlob(rel, blob);
  return rel;
}
