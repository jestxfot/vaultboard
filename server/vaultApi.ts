// Сервер vaultboard: отдаёт браузеру файлы базы, настройки, первую настройку и обновления. Слушает только 127.0.0.1.
// Ядро (createVaultServer) подключают и Vite при разработке (vaultApi), и сервер готовой сборки (standalone.ts).
// В настольной версии (Tauri) этот слой заменится прямым доступом к диску.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync, createReadStream, createWriteStream, type FSWatcher, promises as fs, watch as fsWatch } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRefs, toAbsolute, VaultPathError, walkVault } from './vaultFs.ts';
import { BoardFormatError, parseBoard } from '../src/format/board.ts';
import { boardFolderOf, historyPathOf } from '../src/model/paths.ts';
import { unfurl } from './unfurl.ts';
import { spawn, spawnSync } from 'node:child_process';
import { checkRelease, currentVersion, isGitCheckout, isNewer, type Release, settingsFile } from '../scripts/update.mjs';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.board': 'application/json; charset=utf-8',
  '.canvas': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const BOARD_FILE = /\.(board|canvas)$/i;

/** Настройки этого компьютера (не доски): папка с досками, имя, прокси, автообновление. */
const SETTINGS_FILE = settingsFile();

/**
 * Хранилища, которые знает Obsidian на этом компьютере (его собственный список в obsidian.json).
 * Ссылка obsidian://open?path=… открывается, только если файл лежит в одном из них.
 */
async function obsidianVaults(): Promise<string[] | null> {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')]
    : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')]
      : [path.join(home, '.config', 'obsidian', 'obsidian.json'), path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json')];
  for (const file of candidates) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as { vaults?: Record<string, { path?: string }> };
      return Object.values(data.vaults ?? {}).map((v) => v.path).filter((p): p is string => typeof p === 'string');
    } catch {
      // Нет файла — Obsidian тут не установлен или ни разу не запускался.
    }
  }
  return null;
}

interface Settings {
  proxy?: string;
  /** Имя в комментариях. */
  author?: string;
  /** Папка с досками и заметками (корень базы). */
  vaultRoot?: string;
  /** Обновляться на новые релизы при запуске. Нет поля — да. */
  autoUpdate?: boolean;
}

/** Настройки читаются на каждый запрос (нужна папка базы) — держим в памяти, перечитываем после записи. */
let settingsCache: Settings | null = null;

async function readSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  try {
    settingsCache = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) as Settings;
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

async function writeSettings(next: Settings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 1), 'utf8');
  settingsCache = next;
}

/** Строка в общий лог запуска (%TEMP%\vaultboard.log) — там же пишут vaultboard.vbs и перезапуск. */
function logLine(text: string): void {
  try {
    appendFileSync(path.join(os.tmpdir(), 'vaultboard.log'), `${text}\n`);
  } catch {
    // Лог не пишется — не страшно.
  }
}

/** Диски компьютера (на Windows) или корень файловой системы — начало просмотра папок. */
async function fsRoots(): Promise<{ name: string; path: string }[]> {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }];
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found = await Promise.all(letters.map(async (l) => ((await fs.stat(`${l}:\\`).catch(() => null)) ? l : null)));
  return found.filter((l): l is string => !!l).map((l) => ({ name: `${l}:`, path: `${l}:\\` }));
}


/** Кэш превью фото — вне базы, чтобы не раздувать её и git. Можно удалить целиком: превью сделаются заново. */
const PREVIEW_DIR = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'vaultboard', 'cache', 'previews');

/** Имя файла без символов, запрещённых в Windows. */
function safeName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120);
  return cleaned || 'файл';
}

/** Хэши уже лежащих файлов, чтобы не пересчитывать их при каждой вставке. */
const hashCache = new Map<string, { size: number; mtime: number; hash: string }>();

async function fileHash(abs: string): Promise<string> {
  const st = await fs.stat(abs);
  const cached = hashCache.get(abs);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.hash;
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), async function* (src) {
    for await (const chunk of src) hash.update(chunk as Buffer);
  });
  const digest = hash.digest('hex');
  hashCache.set(abs, { size: st.size, mtime: st.mtimeMs, hash: digest });
  return digest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `fixedRoot` — папка базы из переменной VAULT_ROOT (для разработки). Нет её — берётся из настроек компьютера,
 * а пока её не выбрали, работают только запросы первой настройки: приложение показывает окно выбора папки.
 */
export interface VaultServer {
  /** Обработчик запросов /api/… (адрес уже без «/api»). */
  api: (req: IncomingMessage, res: ServerResponse) => void;
  /** Запустить: папка программы, порт; `canRestart` — это обычная установка, её можно перезапускать с обновлением. */
  start: (opts: { projectDir: string; port: number; canRestart: boolean }) => void;
}

/**
 * Ядро сервера vaultboard: доступ к папке с досками, настройки, первая настройка, обновления.
 * Его подключает и Vite (разработка), и собственный сервер готовой сборки (server/standalone.ts).
 */
export function createVaultServer(fixedRoot?: string): VaultServer {
  const envRoot = fixedRoot ? path.resolve(fixedRoot) : null;
  /** Папка проекта — задаётся при старте сервера (там же лежит package.json с версией). */
  let projectDir = process.cwd();
  /** Работает собранная копия (vite preview, как запускает vaultboard.vbs) — её можно перезапустить с обновлением. */
  let canRestart = false;
  let servePort = 5180;
  /** Когда кто-то в последний раз работал с доской (опрос версии не считается). */
  let lastActivity = Date.now();

  /**
   * Перезапуск с обновлением: отдельный процесс дождётся, пока этот сервер завершится, обновит и запустит заново.
   *
   * На Windows npm запускает сервер внутри «задания» (job): всё, что сервер породит, Windows убьёт вместе с ним,
   * даже «отсоединённое». Поэтому процесс перезапуска создаём через WMI — он ни к какому заданию не привязан,
   * окно скрыто. Окружение сервера он не наследует, поэтому нужные переменные передаём ему в аргументе.
   */
  function restartWithUpdate(): void {
    const pass: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && (k.startsWith('VAULTBOARD_') || ['LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'VAULT_ROOT'].includes(k))) pass[k] = v;
    }
    const args = [path.join(projectDir, 'scripts', 'restart.mjs'), String(servePort), Buffer.from(JSON.stringify(pass)).toString('base64')];
    let started = false;
    if (process.platform === 'win32') {
      const q = (s: string) => `"${s}"`;
      const line = [process.execPath, ...args].map(q).join(' ').replace(/'/g, "''");
      const ps =
        `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ` +
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${line}'; CurrentDirectory = '${projectDir.replace(/'/g, "''")}'; ProcessStartupInformation = $si }; ` +
        `exit $r.ReturnValue`;
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
      started = r.status === 0;
      logLine(`[сервер] перезапуск через WMI: ${started ? 'запущен' : `не вышло (${r.status ?? r.error?.message}) ${(r.stderr ?? '').trim().slice(0, 400)}`}`);
    }
    if (!started) spawn(process.execPath, args, { cwd: projectDir, detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 400);
  }

  // ---------- слежение за файлами папки с досками ----------

  /**
   * Что поменялось в папке снаружи (Obsidian, git, проводник): номер изменения и путь от корня базы.
   * Свои записи (доска, заметка, фото) сервер помечает заранее и не пересылает — иначе каждая правка
   * возвращалась бы эхом. Вкладки узнают о переменах долгим запросом /changes/wait.
   */
  let watcher: FSWatcher | null = null;
  let watchedRoot = '';
  let changeSeq = 0;
  const changeLog: { seq: number; path: string }[] = [];
  const pendingChanges = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Свои записи: путь → когда. Событие по такому пути в ближайшие секунды — эхо, его пропускаем. */
  const ownWrites = new Map<string, number>();
  const changeWaiters = new Set<() => void>();
  /** Не следим: служебные папки, история отмены, временные файлы записи. */
  const IGNORE = /(^|\/)(\.git|\.obsidian|\.trash|\.vaultboard|node_modules)(\/|$)|\.история\.jsonl$|\.tmp-\d+-\d+$|\.vb-update$|(^|\/)\.upload-\d+-\d+$/;

  const rel = (abs: string) => path.relative(watchedRoot, abs).split(path.sep).join('/');

  /** Пометить файл как свою запись — до записи, чтобы событие о ней не ушло во вкладки. */
  function markOwn(abs: string): void {
    if (!watchedRoot) return;
    ownWrites.set(rel(abs), Date.now());
    if (ownWrites.size > 500) for (const [k, t] of ownWrites) if (Date.now() - t > 10_000) ownWrites.delete(k);
  }

  function flushChanges(): void {
    flushTimer = null;
    for (const p of pendingChanges) {
      changeLog.push({ seq: ++changeSeq, path: p });
    }
    pendingChanges.clear();
    if (changeLog.length > 1000) changeLog.splice(0, changeLog.length - 1000);
    for (const wake of [...changeWaiters]) wake();
  }

  /** Следить за папкой с досками (перезапускается, если папку сменили в настройках). */
  function ensureWatcher(root: string): void {
    if (root === watchedRoot) return;
    watcher?.close();
    watcher = null;
    watchedRoot = root;
    try {
      watcher = fsWatch(root, { recursive: true }, (_event, name) => {
        if (!name) return;
        const p = String(name).split(path.sep).join('/');
        if (IGNORE.test(p)) return;
        const own = ownWrites.get(p);
        if (own && Date.now() - own < 3000) return;
        pendingChanges.add(p);
        // Редактор пишет файл в несколько приёмов — собираем события за 150 мс в одно.
        if (!flushTimer) flushTimer = setTimeout(flushChanges, 150);
      });
      watcher.on('error', () => {
        // Папку удалили или она недоступна — перестаём следить; вкладки обновятся при возврате фокуса.
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  /** Что поменялось после номера `since`. Номер из будущего или слишком старый — вкладке надо перечитать всё. */
  function changesSince(since: number): { seq: number; paths: string[]; reset?: boolean } {
    if (since < 0) return { seq: changeSeq, paths: [] };
    const oldest = changeLog[0]?.seq ?? changeSeq + 1;
    if (since > changeSeq || (since < oldest - 1 && changeLog.length)) return { seq: changeSeq, paths: [], reset: true };
    return { seq: changeSeq, paths: [...new Set(changeLog.filter((c) => c.seq > since).map((c) => c.path))] };
  }

  // ---------- релизы: одна фоновая проверка на весь сервер ----------

  /** Последний релиз, как его знает сервер. Все вкладки берут его отсюда, а не спрашивают GitHub каждая. */
  let known: Release | null = null;
  let etag = '';
  let checkedAt = 0;
  /** GitHub сказал, что лимит кончился, — до этого времени не спрашиваем. */
  let retryAt = 0;
  /** Вкладки, которые ждут новостей о версии (долгий запрос /update/wait). */
  const waiters = new Set<() => void>();

  /**
   * Спросить GitHub условным запросом (ETag): если ничего не поменялось, ответ «304» лимит не тратит.
   * Не чаще раза в 20 секунд, даже по просьбе «проверить сейчас».
   */
  async function refreshRelease(): Promise<void> {
    const now = Date.now();
    if (now < retryAt || now - checkedAt < 20_000) return;
    checkedAt = now;
    const r = await checkRelease(etag);
    if (r.error !== undefined) {
      if (r.retryAt) retryAt = r.retryAt;
      return;
    }
    if (!r.changed) return;
    const was = known?.tag;
    known = r.release;
    etag = r.etag;
    if (known?.tag !== was) for (const wake of [...waiters]) wake();
  }

  async function updateStatus() {
    const git = isGitCheckout(projectDir);
    const current = currentVersion(projectDir);
    return {
      current,
      git,
      enabled: (await readSettings()).autoUpdate !== false,
      latest: known,
      available: !!known && isNewer(known.tag, current),
      // Кнопка «Обновить сейчас»: только у обычной установки (не git и не сервер разработки).
      canApply: canRestart && !git,
    };
  }

  /**
   * Следить за релизами. Раз в 3 минуты — условный запрос к GitHub (почти всегда «304», лимит не тратит).
   * Вышла новая версия, автообновление включено, а с доской давно никто не работает (вкладки закрыты
   * или брошены) — сервер обновляется и перезапускается сам. Открытая вкладка ждёт его и перезагружается.
   * Для проверки сценария можно ускорить: VAULTBOARD_WATCH_MS — как часто смотреть, VAULTBOARD_IDLE_MS — сколько тишины ждать.
   */
  function watchReleases(): void {
    const every = Number(process.env.VAULTBOARD_WATCH_MS) || 3 * 60_000;
    const quiet = Number(process.env.VAULTBOARD_IDLE_MS) || 10 * 60_000;
    // Копия из git (разработка) по таймеру GitHub не спрашивает: обновляется она через git pull, а лимит API
    // (60 запросов в час с одного адреса) общий с установкой на этом же компьютере — его нельзя тратить зря.
    // Узнать версию в ней можно щелчком по номеру версии.
    if (isGitCheckout(projectDir)) return;
    void refreshRelease();
    setInterval(async () => {
      checkedAt = Math.min(checkedAt, Date.now() - 20_000);
      await refreshRelease();
      if (!canRestart) return;
      if ((await readSettings()).autoUpdate === false) return;
      if (Date.now() - lastActivity < quiet) return;
      if (known && isNewer(known.tag, currentVersion(projectDir))) restartWithUpdate();
    }, every).unref();
  }

  async function currentRoot(): Promise<string | null> {
    if (envRoot) return envRoot;
    const s = await readSettings();
    return s.vaultRoot ? path.resolve(s.vaultRoot) : null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // ---------- первая настройка: работает и без выбранной папки ----------

    if (req.method === 'GET' && url.pathname === '/setup') {
      // Что предложить: хранилища Obsidian (если он есть) и «Документы/vaultboard».
      const vaults = (await obsidianVaults()) ?? [];
      const docs = path.join(os.homedir(), 'Documents', 'vaultboard');
      const suggestions: { path: string; kind: 'obsidian' | 'new' | 'folder' }[] = [];
      for (const v of vaults) if (await fs.stat(v).catch(() => null)) suggestions.push({ path: v, kind: 'obsidian' });
      suggestions.push({ path: docs, kind: (await fs.stat(docs).catch(() => null)) ? 'folder' : 'new' });
      return sendJson(res, 200, {
        root: await currentRoot(),
        fixed: !!envRoot,
        defaultAuthor: os.userInfo().username,
        obsidian: vaults.length > 0,
        suggestions,
      });
    }

    if (req.method === 'GET' && url.pathname === '/fs/dirs') {
      // Просмотр папок для выбора корня базы. Сервер слушает только этот компьютер — чужим он не виден.
      const p = url.searchParams.get('path') ?? '';
      if (!p) return sendJson(res, 200, { path: '', parent: null, dirs: await fsRoots(), home: os.homedir() });
      const abs = path.resolve(p);
      const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => null);
      if (!entries) return sendJson(res, 404, { error: 'Папку не открыть' });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'node_modules')
        .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      const up = path.dirname(abs);
      return sendJson(res, 200, { path: abs, parent: up === abs ? '' : up, dirs, home: os.homedir() });
    }

    if (req.method === 'POST' && url.pathname === '/fs/mkdir') {
      const body = JSON.parse(await readBody(req)) as { parent: string; name: string };
      const name = safeName(body.name ?? '').trim();
      if (!name) return sendJson(res, 400, { error: 'Пустое имя папки' });
      const abs = path.join(path.resolve(body.parent), name);
      await fs.mkdir(abs, { recursive: true });
      return sendJson(res, 200, { path: abs });
    }

    if (req.method === 'GET' && url.pathname === '/update') {
      // Что известно о версии. «force» — спросить GitHub сейчас (всё равно не чаще раза в 20 секунд).
      if (url.searchParams.has('force') || (!checkedAt && !isGitCheckout(projectDir))) await refreshRelease();
      return sendJson(res, 200, await updateStatus());
    }

    if (req.method === 'GET' && url.pathname === '/update/wait') {
      // Долгий запрос: вкладка говорит, какую версию уже знает, а сервер отвечает, только когда узнает о другой
      // (или через 4 минуты — тогда вкладка просто спросит снова). Так новости о релизе приходят сразу,
      // без постоянных опросов; а оборванное соединение значит, что сервер перезапускается.
      const knownTag = url.searchParams.get('known') ?? '';
      if ((known?.tag ?? '') !== knownTag) return sendJson(res, 200, await updateStatus());
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 240_000);
        waiters.add(finish);
        req.on('close', finish);
      });
      if (res.writableEnded || res.destroyed) return;
      return sendJson(res, 200, await updateStatus());
    }

    if (req.method === 'POST' && url.pathname === '/update/apply') {
      if (!canRestart || isGitCheckout(projectDir)) {
        return sendJson(res, 400, { error: 'Обновление кнопкой работает только в обычной установке (vaultboard.vbs)' });
      }
      sendJson(res, 200, { ok: true });
      restartWithUpdate();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/obsidian-vaults') {
      // Читаем каждый раз: хранилище могли только что добавить в Obsidian.
      return sendJson(res, 200, { root: (await currentRoot()) ?? '', vaults: await obsidianVaults() });
    }

    if (url.pathname === '/settings') {
      // Имя по умолчанию — имя пользователя системы, пока автор не впишет своё.
      if (req.method === 'GET') return sendJson(res, 200, { ...(await readSettings()), defaultAuthor: os.userInfo().username, fixedRoot: envRoot });
      if (req.method === 'PUT') {
        // Меняются только присланные поля; пустая строка — убрать поле.
        const raw = JSON.parse(await readBody(req)) as Settings & { createRoot?: boolean };
        const next: Settings = { ...(await readSettings()) };
        if ('proxy' in raw) {
          if (raw.proxy) next.proxy = String(new URL(raw.proxy)).replace(/\/$/, '');
          else delete next.proxy;
        }
        if ('author' in raw) {
          if (raw.author?.trim()) next.author = raw.author.trim().slice(0, 60);
          else delete next.author;
        }
        if ('autoUpdate' in raw) next.autoUpdate = raw.autoUpdate !== false;
        if (raw.vaultRoot) {
          const abs = path.resolve(raw.vaultRoot);
          if (raw.createRoot) await fs.mkdir(abs, { recursive: true });
          const st = await fs.stat(abs).catch(() => null);
          if (!st?.isDirectory()) return sendJson(res, 400, { error: `Нет такой папки: ${abs}` });
          next.vaultRoot = abs;
        }
        await writeSettings(next);
        return sendJson(res, 200, next);
      }
    }

    // ---------- дальше — всё, что работает с папкой базы ----------

    const absRoot = await currentRoot();
    if (!absRoot) return sendJson(res, 409, { error: 'Сначала выбери папку с досками', setup: true });
    ensureWatcher(absRoot);

    if (req.method === 'GET' && url.pathname === '/changes/wait') {
      // Долгий запрос: ответ — как только в папке что-то поменялось снаружи (или через 50 секунд, пусто).
      const since = Number(url.searchParams.get('since') ?? -1);
      const now = changesSince(since);
      if (now.paths.length || now.reset || since < 0) return sendJson(res, 200, now);
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          changeWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 50_000);
        changeWaiters.add(finish);
        req.on('close', finish);
      });
      if (res.writableEnded || res.destroyed) return;
      return sendJson(res, 200, changesSince(since));
    }

    if (req.method === 'GET' && url.pathname === '/boards') {
      const boards = [];
      for await (const f of walkVault(absRoot, (rel) => BOARD_FILE.test(rel))) {
        boards.push({ path: f.rel, kind: f.rel.toLowerCase().endsWith('.board') ? 'board' : 'canvas', size: f.size, mtime: f.mtime });
      }
      boards.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
      return sendJson(res, 200, { root: absRoot, boards });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/file') {
      const rel = url.searchParams.get('path') ?? '';
      const abs = toAbsolute(absRoot, rel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) return sendJson(res, 404, { error: `Нет файла: ${rel}` });
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Mtime', String(st.mtimeMs));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(abs).pipe(res);
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/board') {
      // Писать можно только файлы досок — сервер не должен уметь портить заметки и фото.
      const rel = url.searchParams.get('path') ?? '';
      if (!/\.board$/i.test(rel)) return sendJson(res, 403, { error: 'Писать можно только файлы досок .board' });
      const abs = toAbsolute(absRoot, rel);
      const expected = url.searchParams.get('mtime');
      const st = await fs.stat(abs).catch(() => null);
      if (expected === 'new' && st) return sendJson(res, 409, { error: `Файл уже есть: ${rel}`, exists: true });
      // Файл изменили снаружи (git, другая копия приложения) — не затираем молча.
      if (expected !== 'new' && expected !== 'force' && expected !== null && st && Math.abs(st.mtimeMs - Number(expected)) > 1) {
        return sendJson(res, 409, { error: 'Доску изменили снаружи', mtime: st.mtimeMs });
      }
      const body = await readBody(req);
      parseBoard(body); // не записываем испорченную доску
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // Атомарно: сначала во временный файл, потом переименование. Доска не останется полузаписанной.
      markOwn(abs);
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, abs);
      const done = await fs.stat(abs);
      return sendJson(res, 200, { mtime: done.mtimeMs });
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      // Все заметки и файлы базы — для поиска (Ctrl+K) и для [[вики-ссылок]].
      const files = [];
      for await (const f of walkVault(absRoot, () => true)) files.push({ path: f.rel, size: f.size, mtime: f.mtime });
      return sendJson(res, 200, { files });
    }

    if (req.method === 'PUT' && url.pathname === '/doc') {
      // Документ — обычная заметка .md, общая с Obsidian. Пишем атомарно и не затираем чужие правки молча.
      const rel = url.searchParams.get('path') ?? '';
      if (!/\.md$/i.test(rel)) return sendJson(res, 403, { error: 'Документом может быть только файл .md' });
      const abs = toAbsolute(absRoot, rel);
      const expected = url.searchParams.get('mtime');
      const st = await fs.stat(abs).catch(() => null);
      if (expected === 'new' && st) return sendJson(res, 409, { error: `Файл уже есть: ${rel}`, exists: true });
      if (expected !== 'new' && expected !== 'force' && expected !== null && st && Math.abs(st.mtimeMs - Number(expected)) > 1) {
        return sendJson(res, 409, { error: 'Заметку изменили снаружи (например, в Obsidian)', mtime: st.mtimeMs });
      }
      const body = await readBody(req);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      markOwn(abs);
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, abs);
      const done = await fs.stat(abs);
      return sendJson(res, 200, { mtime: done.mtimeMs });
    }

    if (req.method === 'POST' && url.pathname === '/trash') {
      // Удаление файла с доски — не насовсем, а в корзину базы `.trash`, как делает Obsidian. Оттуда можно вернуть.
      const rel = url.searchParams.get('path') ?? '';
      if (/\.board$/i.test(rel) || rel.startsWith('.')) return sendJson(res, 403, { error: 'Этот файл так удалять нельзя' });
      const abs = toAbsolute(absRoot, rel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) return sendJson(res, 404, { error: `Нет файла: ${rel}` });
      const trashDir = path.join(absRoot, '.trash');
      await fs.mkdir(trashDir, { recursive: true });
      const name = path.basename(abs);
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let target = path.join(trashDir, name);
      for (let i = 2; await fs.stat(target).then(() => true, () => false); i++) target = path.join(trashDir, `${stem} ${i}${ext}`);
      markOwn(abs);
      await fs.rename(abs, target);
      return sendJson(res, 200, { trashed: `.trash/${path.basename(target)}` });
    }

    if (url.pathname === '/history') {
      // История отмены лежит в папке доски (.история.jsonl) и переезжает вместе с ней. Только дописывается.
      const board = url.searchParams.get('board') ?? '';
      if (!/\.board$/i.test(board)) return sendJson(res, 400, { error: 'Неверный путь доски' });
      const abs = toAbsolute(absRoot, historyPathOf(board));
      if (req.method === 'POST') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.appendFile(abs, await readBody(req), 'utf8');
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        const text = await fs.readFile(abs, 'utf8').catch(() => '');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(text);
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      // Файл кладётся в папку доски байт в байт, без пережатия. Одинаковые файлы не дублируются.
      const board = url.searchParams.get('board') ?? '';
      if (!/\.board$/i.test(board)) return sendJson(res, 400, { error: 'Фото сохраняются в папку доски — сначала открой доску' });
      const name = safeName(url.searchParams.get('name') ?? '');
      const folder = boardFolderOf(board);
      const relDir = `${folder ? `${folder}/` : ''}фото`;
      const absDir = toAbsolute(absRoot, relDir);
      await fs.mkdir(absDir, { recursive: true });

      const tmp = path.join(absDir, `.upload-${process.pid}-${Date.now()}`);
      const hash = createHash('sha256');
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(req, counter, createWriteStream(tmp));
      const digest = hash.digest('hex');

      for (const e of await fs.readdir(absDir, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        const abs = path.join(absDir, e.name);
        const st = await fs.stat(abs);
        if (st.size === size && (await fileHash(abs)) === digest) {
          await fs.rm(tmp);
          return sendJson(res, 200, { path: `${relDir}/${e.name}`, deduped: true, size });
        }
      }

      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let final = name;
      for (let i = 2; await fs.stat(path.join(absDir, final)).then(() => true, () => false); i++) final = `${stem} (${i})${ext}`;
      const abs = path.join(absDir, final);
      markOwn(abs);
      await fs.rename(tmp, abs);
      const st = await fs.stat(abs);
      hashCache.set(abs, { size: st.size, mtime: st.mtimeMs, hash: digest });
      return sendJson(res, 200, { path: `${relDir}/${final}`, deduped: false, size });
    }

    if (url.pathname === '/preview') {
      const rel = url.searchParams.get('path') ?? '';
      const level = url.searchParams.get('level') ?? '';
      if (level !== '0' && level !== '1') return sendJson(res, 400, { error: 'Неверный уровень превью' });
      const st = await fs.stat(toAbsolute(absRoot, rel)).catch(() => null);
      if (!st) return sendJson(res, 404, { error: `Нет файла: ${rel}` });
      // Ключ зависит от времени и размера оригинала: поменялся файл — превью пересоздастся само.
      const key = createHash('sha1').update(`${absRoot}|${rel}|${st.mtimeMs}|${st.size}|${level}`).digest('hex');
      const file = path.join(PREVIEW_DIR, `${key}.webp`);
      if (req.method === 'GET') {
        const pst = await fs.stat(file).catch(() => null);
        if (!pst) return sendJson(res, 404, { error: 'Превью ещё нет' });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Content-Length', String(pst.size));
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of req) {
          total += (c as Buffer).length;
          if (total > 8 * 1024 * 1024) return sendJson(res, 413, { error: 'Превью слишком большое' });
          chunks.push(c as Buffer);
        }
        await fs.mkdir(PREVIEW_DIR, { recursive: true });
        markOwn(file);
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, Buffer.concat(chunks));
        await fs.rename(tmp, file);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && url.pathname === '/unfurl') {
      // Карточка ссылки: сервер читает страницу, картинки кладёт в папку доски «ссылки/».
      const body = JSON.parse(await readBody(req)) as { url: string; board: string };
      const folder = /\.board$/i.test(body.board ?? '') ? boardFolderOf(body.board) : '';
      try {
        // Как браузер: через прокси из настроек, иначе через системный (HTTPS_PROXY); не вышло — напрямую.
        const proxy = (await readSettings()).proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;
        try {
          return sendJson(res, 200, await unfurl(absRoot, folder, body.url, proxy));
        } catch (err) {
          if (!proxy) throw err;
          return sendJson(res, 200, await unfurl(absRoot, folder, body.url, undefined));
        }
      } catch (err) {
        return sendJson(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (url.pathname === '/library') {
      // Общая библиотека стилей базы — чтобы переносить удачные стили между досками.
      const abs = toAbsolute(absRoot, '.vaultboard/стили.json');
      if (req.method === 'GET') {
        const text = await fs.readFile(abs, 'utf8').catch(() => '{}');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(text);
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        markOwn(abs);
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, body, 'utf8');
        await fs.rename(tmp, abs);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && url.pathname === '/resolve') {
      const body = JSON.parse(await readBody(req)) as { from: string; refs: string[] };
      return sendJson(res, 200, await resolveRefs(absRoot, body.from, body.refs));
    }

    sendJson(res, 404, { error: 'Нет такого запроса' });
  }

  const api = (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith('/update') && !req.url?.startsWith('/setup')) lastActivity = Date.now();
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof VaultPathError ? 403 : err instanceof BoardFormatError ? 400 : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  };

  return {
    api,
    start(opts) {
      projectDir = opts.projectDir;
      servePort = opts.port;
      canRestart = opts.canRestart;
      watchReleases();
    },
  };
}

/** Плагин Vite: тот же сервер внутри сервера разработки (npm run dev) и предпросмотра сборки. */
export function vaultApi(fixedRoot?: string): Plugin {
  const vault = createVaultServer(fixedRoot);
  return {
    name: 'vaultboard-vault-api',
    configureServer(server) {
      vault.start({ projectDir: server.config.root, port: server.config.server.port ?? 5173, canRestart: false });
      server.middlewares.use('/api', vault.api);
    },
    configurePreviewServer(server) {
      vault.start({ projectDir: server.config.root, port: server.config.preview.port ?? 5180, canRestart: true });
      server.middlewares.use('/api', vault.api);
    },
  };
}
