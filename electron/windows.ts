// Окна приложения: по окну на доску, доски из любой папки, недавние доски.
//
// Каждое окно показывает vaultboard://<хост>/ (см. server.ts). Страница, открывая доску, спрашивает приложение
// (claimBoard): если эта доска уже открыта в другом окне — показывается то окно, а не вторая копия доски,
// иначе правки двух окон спорили бы в одном файле.
//
// Закрыть окно — закрыть его, если окон несколько; последнее окно прячется в трей (сервер работает дальше,
// гости по приглашению не отключаются). Выйти совсем — из меню трея.
import { app, BrowserWindow, dialog, nativeTheme, screen, session, shell, type WebContents } from 'electron';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { log } from './log.ts';
import { api, askServerToQuit, hostForRoot, MAIN_HOST, rootOfHost, SCHEME } from './server.ts';
import { readState, writeState } from './state.ts';

/** Сколько недавних досок помнить. */
const RECENT_MAX = 10;
const BOARD_FILE = /\.(board|canvas)$/i;

interface Win {
  win: BrowserWindow;
  host: string;
  /** Полный путь доски, которая сейчас открыта в окне. */
  board: string | null;
}

const wins = new Map<number, Win>();
let iconFile = '';
let preloadFile = '';
/** Выходим по-настоящему: окна закрываются, а не прячутся. */
let quitting = false;
/** Что сделать, когда список недавних досок поменялся (меню трея). */
let onRecentChanged = () => {};

export function setupWindows(opts: { icon: string; preload: string; onRecentChanged: () => void }): void {
  iconFile = opts.icon;
  preloadFile = opts.preload;
  onRecentChanged = opts.onRecentChanged;
  // Встроенные видео YouTube не играют на странице без адреса сайта (ошибка 153): подставляем адрес проекта.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*', 'https://player.vimeo.com/*'] },
    (details, done) => {
      if (!details.referrer || details.referrer.startsWith(`${SCHEME}://`)) details.requestHeaders.Referer = 'https://github.com/jestxfot/vaultboard';
      done({ requestHeaders: details.requestHeaders });
    },
  );
}

export function setQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

// ---------- доски и папки ----------

/** Папка с досками из настроек (null — ещё не выбрана). */
async function mainRoot(): Promise<string | null> {
  try {
    return (await api<{ root: string | null }>(MAIN_HOST, '/api/setup')).root;
  } catch {
    return null;
  }
}

function inside(root: string, file: string): string | null {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
}

/**
 * Корень для доски не из папки с досками: ближайшая папка выше с .obsidian (хранилище Obsidian — заметки доски там же),
 * иначе папка над папкой доски (доска — папка с доска.board) или папка самого файла.
 */
function guessRoot(file: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.obsidian'))) return dir;
    if (path.dirname(dir) === dir) break;
  }
  return path.basename(file).toLowerCase() === 'доска.board' ? path.dirname(path.dirname(file)) : path.dirname(file);
}

/** Хост окна и путь доски от его корня. */
async function locate(file: string): Promise<{ host: string; rel: string }> {
  const root = await mainRoot();
  const rel = root ? inside(root, file) : null;
  if (rel) return { host: MAIN_HOST, rel };
  const own = guessRoot(file);
  return { host: hostForRoot(own), rel: inside(own, file) ?? path.basename(file) };
}

/** Полный путь доски `rel`, открытой в окне с этим хостом. */
async function fullPath(host: string, rel: string): Promise<string | null> {
  const root = host === MAIN_HOST ? await mainRoot() : rootOfHost(host);
  return root ? path.join(root, ...rel.split('/')) : null;
}

const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function windowWithBoard(file: string, except?: number): Win | null {
  for (const [id, w] of wins) if (id !== except && w.board && same(w.board, file)) return w;
  return null;
}

// ---------- недавние доски ----------

export function recentBoards(): string[] {
  return (readState().recent ?? []).filter((f) => existsSync(f));
}

function addRecent(file: string): void {
  const recent = [file, ...(readState().recent ?? []).filter((f) => !same(f, file))].slice(0, RECENT_MAX);
  writeState({ recent });
  // Windows показывает их в списке переходов значка на панели задач, Linux — в «недавних файлах».
  app.addRecentDocument(file);
  onRecentChanged();
}

// ---------- окна ----------

/** Показать окно: последнее, с которым работали (или любое). */
export function showWindow(target?: BrowserWindow): void {
  const win = target ?? BrowserWindow.getFocusedWindow() ?? [...wins.values()].at(-1)?.win;
  if (!win) {
    void openMain();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Сообщить всем окнам (например, «новая версия готова»). */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of wins.values()) w.win.webContents.send(channel, ...args);
}

export function anyWindowVisible(): boolean {
  return [...wins.values()].some((w) => w.win.isVisible());
}

/** Открыть окно папки с досками (без доски — страница откроет последнюю или «Черновик»). */
export async function openMain(): Promise<void> {
  createWindow(`${SCHEME}://${MAIN_HOST}/`);
}

/** Замер скорости в отдельном окне: сгенерированные доски, итог — в журнал (см. runBenchSuite в App.tsx). */
export function openBenchmark(): void {
  createWindow(`${SCHEME}://${MAIN_HOST}/?bench=suite`);
}

/** Открыть файл доски: уже открыт — показать его окно, иначе — новое окно с ним. */
export async function openBoardFile(file: string): Promise<void> {
  if (!BOARD_FILE.test(file) || !existsSync(file) || !statSync(file).isFile()) {
    void dialog.showMessageBox({ type: 'warning', title: 'vaultboard', message: 'Это не файл доски', detail: file });
    return;
  }
  const open = windowWithBoard(file);
  if (open) return showWindow(open.win);
  const { host, rel } = await locate(file);
  createWindow(`${SCHEME}://${host}/?open=${encodeURIComponent(rel)}`);
}

/** Выбрать доску в окне Windows и открыть её. */
export async function openBoardDialog(parent?: BrowserWindow): Promise<void> {
  const options: Electron.OpenDialogOptions = {
    title: 'Открыть доску',
    defaultPath: (await mainRoot()) ?? undefined,
    filters: [{ name: 'Доски', extensions: ['board', 'canvas'] }],
    properties: ['openFile'],
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (!picked.canceled && picked.filePaths[0]) await openBoardFile(picked.filePaths[0]);
}

/** Страница открывает доску `rel`. Уже открыта в другом окне — показать то окно и ответить false. */
export async function claimBoard(sender: WebContents, rel: string): Promise<boolean> {
  const me = wins.get(sender.id);
  if (!me) return true;
  const file = await fullPath(me.host, rel);
  if (!file) return true;
  const other = windowWithBoard(file, sender.id);
  if (other) {
    showWindow(other.win);
    return false;
  }
  me.board = file;
  me.win.setTitle(`${path.basename(file).toLowerCase() === 'доска.board' ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file))} — vaultboard`);
  addRecent(file);
  return true;
}

/** Страница просит открыть доску `rel` (из своей папки) в отдельном окне. */
export async function openInNewWindow(sender: WebContents, rel: string): Promise<void> {
  const me = wins.get(sender.id);
  const file = me ? await fullPath(me.host, rel) : null;
  if (file) await openBoardFile(file);
}

/** Место нового окна: сохранённое для первого, со сдвигом от текущего для следующих. */
function boundsForNew(): { x?: number; y?: number; width: number; height: number; maximized: boolean } {
  const state = readState();
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && wins.size) {
    const b = focused.getNormalBounds();
    return { x: b.x + 32, y: b.y + 32, width: b.width, height: b.height, maximized: false };
  }
  const b = state.bounds;
  if (!b) return { width: 1400, height: 900, maximized: !!state.maximized };
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 10 && b.y < area.y + area.height - 80;
  // Экран, где было окно, отключили — размер тот же, место выберет система.
  return visible ? { ...b, maximized: !!state.maximized } : { width: b.width, height: b.height, maximized: !!state.maximized };
}

/** Ссылка наружу (сайт, письмо, заметка в Obsidian) — в программу, которая её открывает. */
function openOutside(url: string): void {
  if (/^(https?|mailto|obsidian):/i.test(url)) void shell.openExternal(url);
}

const isOwn = (url: string) => url.startsWith(`${SCHEME}://`);

function createWindow(url: string): BrowserWindow {
  const place = boundsForNew();
  const win = new BrowserWindow({
    width: place.width,
    height: place.height,
    x: place.x,
    y: place.y,
    minWidth: 720,
    minHeight: 480,
    title: 'vaultboard',
    icon: iconFile,
    show: false,
    // Цвет фона приложения — чтобы до загрузки страницы окно не мигало белым в тёмной теме.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f7f7f5',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadFile, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  const host = new URL(url).host;
  const id = win.webContents.id;
  wins.set(id, { win, host, board: null });
  win.setMenuBarVisibility(false);
  if (place.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  // Заголовок окна — название доски (его ставит claimBoard), а не <title> страницы.
  win.on('page-title-updated', (e) => e.preventDefault());
  // Свои страницы (предпросмотр сайта /api/site/) — отдельным окном, всё остальное — в браузере.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isOwn(target)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: iconFile } };
    openOutside(target);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, target) => {
    if (isOwn(target)) return;
    e.preventDefault();
    openOutside(target);
  });
  // Клавиши, которые в браузере давало его меню, и свои: открыть доску (Ctrl+O), новое окно (Ctrl+N).
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (input.key === 'F5' || (ctrl && !input.shift && key === 'r')) {
      e.preventDefault();
      wc.reload();
    } else if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) {
      e.preventDefault();
      wc.toggleDevTools();
    } else if (input.key === 'F11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (ctrl && !input.shift && key === 'o') {
      e.preventDefault();
      void openBoardDialog(win);
    } else if (ctrl && !input.shift && key === 'n') {
      e.preventDefault();
      void openMain();
    }
  });

  const remember = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    writeState({ maximized: win.isMaximized(), ...(win.isMaximized() ? {} : { bounds: win.getBounds() }) });
  };
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);

  win.on('close', (e) => {
    if (quitting || wins.size > 1) return;
    // Последнее окно — спрятать в трей: сервер работает дальше. Выход — из меню трея.
    e.preventDefault();
    remember();
    win.hide();
    if (!readState().trayHintShown) {
      writeState({ trayHintShown: true });
      trayHint();
    }
  });
  // Windows выключается или пользователь выходит из системы: не прятать окно (это задержало бы выключение),
  // а попросить сервер дописать правки и закрыться.
  win.on('session-end', () => {
    quitting = true;
    askServerToQuit();
  });
  win.on('closed', () => wins.delete(id));

  log(`окно ${url}`);
  void win.loadURL(url);
  return win;
}

/** Подсказка при первом закрытии (её показывает трей — см. tray.ts). */
let trayHint = () => {};
export function onTrayHint(show: () => void): void {
  trayHint = show;
}
