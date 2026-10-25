// Настольное приложение vaultboard: своё окно вместо вкладки браузера.
//
// Сервер (dist-server/server.mjs) работает отдельным процессом (utilityProcess) на 127.0.0.1, на порту, который
// приложение выбирает само при первом запуске и запоминает. Через сервер ходят и это окно, и приглашённые гости
// (туннель), и публикация. Окно показывает http://localhost:<порт>/.
//
// Закрыть окно — спрятать его в трей, сервер продолжает работать (гости по приглашению не отключаются).
// Выйти совсем — «Выйти» в меню трея: сервер дописывает правки на диск и завершается.
// Второй запуск (ярлык, двойной щелчок по .board) не запускает вторую копию, а показывает это окно.
// Установленное приложение само обновляется с GitHub Releases (electron-updater); запущенное из исходников — нет.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, session, shell, Tray, utilityProcess, type UtilityProcess } from 'electron';
import { autoUpdater } from 'electron-updater';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Общий лог сервера — тот же файл, куда пишет сам сервер. */
const LOG = path.join(os.tmpdir(), 'vaultboard.log');
/** В Windows уведомления и закреплённые ярлыки находят приложение по этому имени (как appId в electron-builder.yml). */
const APP_ID = 'io.github.jestxfot.vaultboard';
/** Как часто спрашивать GitHub о новой версии, пока приложение работает. */
const UPDATE_EVERY = 4 * 60 * 60_000;

/**
 * Папка программы. В установленном приложении сервер и собранная страница лежат рядом с app.asar,
 * в app.asar.unpacked: их читает отдельный процесс сервера и копирует публикация — обычными файлами надёжнее.
 */
const appDir = app.isPackaged ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked') : app.getAppPath();
const iconFile = path.join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/** Порт сервера — выбирается при запуске (см. choosePort). */
let port = 0;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: UtilityProcess | null = null;
/** Последние строки ошибок сервера — показать, если он не запустился. */
let serverErrors = '';
/** Выходим по-настоящему (а не прячем окно в трей). */
let quitting = false;
/** Сервер уже остановлен — можно закрываться. */
let serverStopped = false;
/** Скачанная новая версия: поставится при выходе или по кнопке «Перезапустить». */
let readyVersion: string | null = null;

// Ноутбуки с двумя видеокартами: Windows по умолчанию даёт новой программе встроенную (медленную),
// и большая доска двигается рывками. Просим мощную — так же, как её получает браузер.
app.commandLine.appendSwitch('force_high_performance_gpu');

/** Адрес окна. Именно localhost: с адреса-цифр (127.0.0.1) страница сама уходит на localhost — из-за YouTube. */
const origin = () => `http://localhost:${port}`;

function log(text: string): void {
  try {
    appendFileSync(LOG, `[приложение] ${text}\n`);
  } catch {
    // Лог не пишется — не страшно.
  }
}

// ---------- что запомнить между запусками ----------

interface AppState {
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  /** Подсказку «vaultboard остался в трее» уже показывали. */
  trayHintShown?: boolean;
  /** Порт сервера. Один и тот же от запуска к запуску: от адреса страницы зависит её хранилище (тема, последняя доска). */
  port?: number;
  /** Какая сборка запускалась в прошлый раз — после обновления кэш страницы очищается. */
  build?: string;
}

const stateFile = path.join(app.getPath('userData'), 'window.json');

function readState(): AppState {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as AppState;
  } catch {
    return {};
  }
}

function writeState(patch: Partial<AppState>): void {
  try {
    writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }));
  } catch {
    // Не запомнится — в следующий раз начнём с настроек по умолчанию.
  }
}

/** Сохранённые размер и место окна. Экран, где было окно, отключили — размер тот же, место выберет система. */
function savedBounds(): { x?: number; y?: number; width: number; height: number } | undefined {
  const b = readState().bounds;
  if (!b) return undefined;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 10 && b.y < area.y + area.height - 80;
  return visible ? b : { width: b.width, height: b.height };
}

/**
 * Новая сборка (обновились или пересобрали) — очистить кэш страницы и скомпилированных скриптов,
 * чтобы окно точно показало новую версию. Хранилище страницы (тема, последняя доска) не трогаем.
 */
async function clearCacheIfNewBuild(): Promise<void> {
  let build = app.getVersion();
  try {
    build += `|${statSync(path.join(appDir, 'dist', 'index.html')).mtimeMs}`;
  } catch {
    // Нет собранной страницы — сервер всё равно не запустится и скажет об этом.
  }
  if (readState().build === build) return;
  await session.defaultSession.clearCache();
  await session.defaultSession.clearCodeCaches({});
  writeState({ build });
  log(`новая сборка ${build} — кэш страницы очищен`);
}

// ---------- сервер ----------

/** Свободен ли порт на 127.0.0.1; 0 — любой свободный. Возвращает занятый на миг и отпущенный порт или null. */
function tryPort(wanted: number): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(null));
    probe.listen(wanted, '127.0.0.1', () => {
      const got = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(got));
    });
  });
}

/** Порт сервера: тот же, что в прошлый раз; занят (другой программой) — новый свободный, и запомнить его. */
async function choosePort(): Promise<number> {
  const saved = readState().port;
  const got = (saved && (await tryPort(saved))) || (await tryPort(0));
  if (!got) throw new Error('Не нашлось свободного порта на 127.0.0.1');
  if (got !== saved) writeState({ port: got });
  return got;
}

/** Отвечает ли сервер. */
async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setup`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Запустить сервер и дождаться, пока он ответит. Не вышло — текст ошибки. */
async function startServer(): Promise<string | null> {
  const entry = path.join(appDir, 'dist-server', 'server.mjs');
  if (!existsSync(entry)) return `Нет файла сервера: ${entry}\nСначала собери приложение: npm run build`;
  try {
    port = await choosePort();
  } catch (err) {
    return (err as Error).message;
  }

  log(`запускаю сервер ${entry} на порту ${port}`);
  const child = utilityProcess.fork(entry, [String(port)], { cwd: appDir, stdio: 'pipe', serviceName: 'vaultboard-server' });
  server = child;
  let exited = null as number | null;
  child.stdout?.on('data', (d: Buffer) => log(`сервер: ${String(d).trimEnd()}`));
  child.stderr?.on('data', (d: Buffer) => {
    serverErrors = (serverErrors + String(d)).slice(-2000);
    log(`сервер: ${String(d).trimEnd()}`);
  });
  child.on('exit', (code) => {
    exited = code;
    server = null;
    serverStopped = true;
    log(`сервер завершился (${code})`);
    // Сервер упал сам, пока приложение работает, — без него окно пустое: честно сказать и выйти.
    if (!quitting && win) {
      dialog.showErrorBox('vaultboard', `Сервер vaultboard остановился (код ${code}).\n\n${serverErrors.trim()}\n\nПодробности: ${LOG}`);
      quitting = true;
      app.quit();
    }
  });

  for (let i = 0; i < 200; i++) {
    if (exited !== null) return serverErrors.trim() || `Сервер завершился с кодом ${exited}`;
    if (await serverUp()) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  return 'Сервер не ответил за 20 секунд.';
}

/** Попросить сервер дописать всё на диск и выйти; не уложился в 5 секунд — завершить. */
function stopServer(): Promise<void> {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('сервер не завершился сам за 5 секунд — завершаю');
      child.kill();
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage('quit');
  });
}

/** Что Chromium думает о видеокарте: включено ли ускорение и какое устройство. Для разбора «тормозит». */
function logGpu(): void {
  const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  log(`ускорение: webgl ${status.webgl}, webgl2 ${status.webgl2}, композитинг ${status.gpu_compositing}, растр ${status.rasterization}`);
  void app.getGPUInfo('basic').then(
    (info) => {
      const devices = (info as { gpuDevice?: { vendorId: number; deviceId: number; active: boolean; driverVersion?: string }[] }).gpuDevice ?? [];
      const hex = (n: number) => n.toString(16).padStart(4, '0');
      log(`видеокарты: ${devices.map((d) => `${hex(d.vendorId)}:${hex(d.deviceId)}${d.active ? ' (работает)' : ''}${d.driverVersion ? ` драйвер ${d.driverVersion}` : ''}`).join(', ') || 'нет данных'}`);
    },
    (err: Error) => log(`видеокарты: не узнать (${err.message})`),
  );
}

// ---------- обновления ----------

/**
 * Обновления с GitHub Releases. Новая версия скачивается сама, в фоне и только изменившимися частями
 * (по .blockmap предыдущего установщика), ставится при выходе — или сразу, кнопкой «Перезапустить» на плашке.
 * Запуск из исходников (npm run app) не обновляется: там обновляются через git.
 */
function watchUpdates(): void {
  if (!app.isPackaged) return;
  autoUpdater.logger = {
    info: (m: unknown) => log(`обновление: ${String(m)}`),
    warn: (m: unknown) => log(`обновление: ${String(m)}`),
    error: (m: unknown) => log(`обновление, ошибка: ${String(m)}`),
    debug: () => undefined,
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version;
    win?.webContents.send('update-ready', { version: readyVersion });
    updateTrayMenu();
    if (process.platform === 'win32' && !win?.isVisible()) {
      tray?.displayBalloon({ iconType: 'info', title: `Готова версия ${readyVersion}`, content: 'Поставится при выходе из vaultboard.' });
    }
  });
  const check = () => void autoUpdater.checkForUpdates().catch((err: Error) => log(`обновление, ошибка: ${err.message}`));
  check();
  setInterval(check, UPDATE_EVERY);
}

/** Перезапуститься с новой версией: сначала сервер дописывает правки на диск, потом установщик. */
async function installUpdate(): Promise<void> {
  if (!readyVersion) return;
  quitting = true;
  await stopServer();
  serverStopped = true;
  autoUpdater.quitAndInstall(true, true);
}

// ---------- окно ----------

/** Файл доски из командной строки (двойной щелчок по .board в проводнике). */
function boardArg(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (/\.(board|canvas)$/i.test(a) && existsSync(a)) return path.resolve(a);
  }
  return null;
}

/** Адрес окна для этого файла доски: доска открывается, только если она в папке с досками. */
async function urlForBoard(file: string | null): Promise<string> {
  if (!file) return `${origin()}/`;
  try {
    const { root } = (await (await fetch(`http://127.0.0.1:${port}/api/setup`)).json()) as { root: string | null };
    const rel = root ? path.relative(root, file) : '';
    if (root && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${origin()}/?open=${encodeURIComponent(rel.split(path.sep).join('/'))}`;
    }
    void dialog.showMessageBox({
      type: 'info',
      title: 'vaultboard',
      message: 'Эта доска лежит не в папке с досками',
      detail: `${file}\n\nvaultboard открывает доски из своей папки${root ? ` (${root})` : ''}. Перенеси файл туда или выбери другую папку в ⚙ Настройках.`,
    });
  } catch (err) {
    log(`не открыть ${file}: ${(err as Error).message}`);
  }
  return `${origin()}/`;
}

/** Ссылка наружу (сайт, письмо, заметка в Obsidian) — в программу, которая её открывает, а не в окно vaultboard. */
function openOutside(url: string): void {
  if (/^(https?|mailto|obsidian):/i.test(url)) void shell.openExternal(url);
}

function isOwn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.port === String(port) && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(url: string): void {
  const state = readState();
  const bounds = savedBounds();
  win = new BrowserWindow({
    width: bounds?.width ?? 1400,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 480,
    title: 'vaultboard',
    icon: iconFile,
    show: false,
    // Цвет фона приложения — чтобы до загрузки страницы окно не мигало белым в тёмной теме.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f7f7f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.setMenuBarVisibility(false);
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());

  const wc = win.webContents;
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
  // Клавиши, которые в браузере давало его меню: обновить страницу, инструменты разработчика, полный экран.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F5' || (ctrl && !input.shift && input.key.toLowerCase() === 'r')) {
      e.preventDefault();
      wc.reload();
    } else if (input.key === 'F12' || (ctrl && input.shift && input.key.toLowerCase() === 'i')) {
      e.preventDefault();
      wc.toggleDevTools();
    } else if (input.key === 'F11') {
      e.preventDefault();
      win?.setFullScreen(!win.isFullScreen());
    }
  });

  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    writeState({ maximized: win.isMaximized(), ...(win.isMaximized() ? {} : { bounds: win.getBounds() }) });
  };
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);

  win.on('close', (e) => {
    if (quitting) return;
    // Закрыть — значит спрятать в трей: сервер работает дальше. Выход — из меню трея.
    e.preventDefault();
    remember();
    win?.hide();
    if (!readState().trayHintShown) {
      writeState({ trayHintShown: true });
      if (process.platform === 'win32') {
        tray?.displayBalloon({ iconType: 'info', title: 'vaultboard работает в трее', content: 'Открыть — щелчок по значку. Выйти совсем — правой кнопкой → «Выйти».' });
      }
    }
  });
  // Windows выключается или пользователь выходит из системы: не прятать окно в трей (это задержало бы выключение),
  // а попросить сервер дописать правки и закрыться.
  win.on('session-end', () => {
    quitting = true;
    server?.postMessage('quit');
  });
  win.on('closed', () => {
    win = null;
  });

  void win.loadURL(url);
}

function updateTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть vaultboard', click: showWindow },
      { type: 'separator' },
      ...(readyVersion
        ? [{ label: `Перезапустить с версией ${readyVersion}`, click: () => void installUpdate() }]
        : app.isPackaged
          ? [{ label: 'Проверить обновления', click: () => void autoUpdater.checkForUpdates().catch((err: Error) => log(`обновление, ошибка: ${err.message}`)) }]
          : []),
      {
        label: 'Выйти',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  // В Windows — сам .ico: система берёт из него размер под свой масштаб экрана.
  tray = new Tray(process.platform === 'win32' ? iconFile : nativeImage.createFromPath(iconFile).resize({ width: 24, height: 24 }));
  tray.setToolTip('vaultboard');
  updateTrayMenu();
  tray.on('click', showWindow);
}

// ---------- запуск и выход ----------

if (!app.requestSingleInstanceLock()) {
  // Уже запущен — тот экземпляр получит second-instance и покажет окно.
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  app.on('second-instance', (_e, argv) => {
    const file = boardArg(argv);
    if (file && win) void urlForBoard(file).then((url) => win?.loadURL(url));
    showWindow();
  });

  // Страница спрашивает, не скачана ли уже новая версия (она могла скачаться до загрузки страницы), и просит её поставить.
  ipcMain.on('update-query', (e) => {
    if (readyVersion) e.sender.send('update-ready', { version: readyVersion });
  });
  ipcMain.on('update-install', () => void installUpdate());
  ipcMain.on('log', (_e, text: unknown) => log(`окно: ${String(text).slice(0, 500)}`));

  app.on('before-quit', (e) => {
    quitting = true;
    if (serverStopped || !server) return;
    // Сначала сервер дописывает правки на диск, потом выходим уже по-настоящему.
    e.preventDefault();
    void stopServer().then(() => {
      serverStopped = true;
      app.quit();
    });
  });

  // Окно спрятано в трей, но приложение работает, — не выходить, когда «закрылись все окна».
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  void app.whenReady().then(async () => {
    const error = await startServer();
    if (error) {
      log(`не запустился: ${error}`);
      dialog.showErrorBox('vaultboard не запустился', `${error}\n\nПодробности: ${LOG}`);
      quitting = true;
      app.quit();
      return;
    }
    await clearCacheIfNewBuild();
    logGpu();
    createTray();
    createWindow(await urlForBoard(boardArg(process.argv)));
    watchUpdates();
  });
}
