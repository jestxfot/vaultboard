// Настольное приложение vaultboard: запуск и выход. Остальное — по модулям:
//   server.ts  — сервер отдельным процессом и связь окон с ним через канал, без порта (адреса vaultboard://);
//   windows.ts — окна (по окну на доску), доски из любой папки, недавние доски;
//   tray.ts    — значок в трее и его меню;
//   updates.ts — обновления с GitHub Releases;
//   state.ts   — что помнить между запусками; log.ts — журнал.
//
// Второй запуск (ярлык, двойной щелчок по .board) не запускает вторую копию: первая открывает доску или показывает окно.
import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { LOG, log } from './log.ts';
import { registerScheme, serverRunning, startServer, stopServer } from './server.ts';
import { readState, writeState } from './state.ts';
import { createTray, trayBalloon, updateTrayMenu } from './tray.ts';
import { installUpdate, readyVersion, watchUpdates } from './updates.ts';
import {
  anyWindowVisible,
  broadcast,
  claimBoard,
  isQuitting,
  onTrayHint,
  openBoardFile,
  openInNewWindow,
  openMain,
  setQuitting,
  setupWindows,
  showWindow,
} from './windows.ts';

/** В Windows уведомления и закреплённые ярлыки находят приложение по этому имени (как appId в electron-builder.yml). */
const APP_ID = 'io.github.jestxfot.vaultboard';

/**
 * Папка программы. В установленном приложении сервер и собранная страница лежат рядом с app.asar,
 * в app.asar.unpacked: их читает отдельный процесс сервера и копирует публикация — обычными файлами надёжнее.
 */
const appDir = app.isPackaged ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked') : app.getAppPath();
const iconFile = path.join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/** Файл доски из командной строки (двойной щелчок по .board в проводнике). */
function boardArg(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (/\.(board|canvas)$/i.test(a) && existsSync(a)) return path.resolve(a);
  }
  return null;
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

/** Что Chromium думает о видеокарте: включено ли ускорение и какое устройство. Для разбора «тормозит». */
function logGpu(): void {
  const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  log(`ускорение: webgl ${status.webgl}, композитинг ${status.gpu_compositing}, растр ${status.rasterization}`);
  void app.getGPUInfo('basic').then(
    (info) => {
      const devices = (info as { gpuDevice?: { vendorId: number; deviceId: number; active: boolean; driverVersion?: string }[] }).gpuDevice ?? [];
      const hex = (n: number) => n.toString(16).padStart(4, '0');
      log(`видеокарты: ${devices.map((d) => `${hex(d.vendorId)}:${hex(d.deviceId)}${d.active ? ' (работает)' : ''}${d.driverVersion ? ` драйвер ${d.driverVersion}` : ''}`).join(', ') || 'нет данных'}`);
    },
    (err: Error) => log(`видеокарты: не узнать (${err.message})`),
  );
}

/**
 * Кто сейчас занимает видеокарту (как столбец «Графический процессор» в диспетчере задач): программы и их загрузка
 * по видам работы (3D, вычисления, копирование). Только Windows; для разбора «тормозит» — например, когда
 * видеокарту делит нейросеть. Пишется в журнал (замер скорости вызывает это в начале и в конце).
 */
function logGpuLoad(when: string): void {
  if (process.platform !== 'win32') return;
  // Класс WMI, а не Get-Counter: имена счётчиков Get-Counter переведены на язык Windows, имя класса — нет.
  const ps =
    'Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ' +
    'Where-Object UtilizationPercentage -gt 1 | ForEach-Object { ' +
    "if ($_.Name -match 'pid_(\\d+).*engtype_(.+)$') { " +
    '$p = Get-Process -Id $matches[1] -ErrorAction SilentlyContinue; ' +
    "'{0}|{1}|{2}' -f $p.ProcessName, $matches[2], $_.UtilizationPercentage } }";
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }, (err, out) => {
    if (err) return log(`видеокарта занята (${when}): не узнать (${err.message.split('\n')[0]})`);
    // Процесс и вид работы → наибольшая загрузка (у одного процесса бывает несколько движков одного вида).
    const load = new Map<string, number>();
    for (const line of out.split(/\r?\n/)) {
      const [name, engine, value] = line.trim().split('|');
      if (!name || !engine) continue;
      const key = `${name} (${engine})`;
      load.set(key, Math.max(load.get(key) ?? 0, Number(value.replace(',', '.')) || 0));
    }
    const top = [...load].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v.toFixed(0)}%`);
    log(`видеокарта занята (${when}): ${top.join(', ') || 'почти свободна'}`);
  });
}

/** Раз в 30 секунд, если какой-то процесс приложения заметно занят: кто сколько ест процессора и памяти. */
function watchLoad(): void {
  app.getAppMetrics();
  setInterval(() => {
    const metrics = app.getAppMetrics();
    if (!metrics.some((m) => m.cpu.percentCPUUsage >= 5)) return;
    const describe = (m: Electron.ProcessMetric) =>
      `${m.name || m.serviceName || m.type} ${m.cpu.percentCPUUsage.toFixed(0)}% ${Math.round(m.memory.workingSetSize / 1024)} МБ`;
    log(`нагрузка: ${metrics.map(describe).join(', ')}`);
  }, 30_000);
}

function quit(): void {
  setQuitting();
  app.quit();
}

function restartWithUpdate(): void {
  void installUpdate(setQuitting);
}

// Рисовать без видеокарты (переключатель в меню трея) — выбирается только до запуска, поэтому переключение перезапускает.
const softwareRender = readState().softwareRender === true;
if (softwareRender) app.disableHardwareAcceleration();
// Ноутбуки с двумя видеокартами: просим мощную (встроенная может не успевать за большой доской).
else app.commandLine.appendSwitch('force_high_performance_gpu');

/** Переключить рисование видеокартой / процессором и перезапуститься. */
function toggleSoftwareRender(): void {
  writeState({ softwareRender: !softwareRender });
  log(`рисование: переключаю на ${softwareRender ? 'видеокарту' : 'процессор'}, перезапуск`);
  app.relaunch();
  quit();
}
registerScheme();

if (!app.requestSingleInstanceLock()) {
  // Уже запущен — тот экземпляр получит second-instance.
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  app.on('second-instance', (_e, argv) => {
    const file = boardArg(argv);
    if (file) void openBoardFile(file);
    else showWindow();
  });

  // Мост страницы (preload.ts).
  ipcMain.on('update-query', (e) => {
    const version = readyVersion();
    if (version) e.sender.send('update-ready', { version });
  });
  ipcMain.on('update-install', restartWithUpdate);
  ipcMain.on('log', (_e, text: unknown) => log(`окно: ${String(text).slice(0, 500)}`));
  ipcMain.on('log-gpu-load', (_e, when: unknown) => logGpuLoad(String(when).slice(0, 60)));
  ipcMain.handle('claim-board', (e, rel: unknown) => claimBoard(e.sender, String(rel)));
  ipcMain.on('open-in-new-window', (e, rel: unknown) => void openInNewWindow(e.sender, String(rel)));
  ipcMain.handle('pick-folder', async (e, start: unknown) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.OpenDialogOptions = {
      defaultPath: typeof start === 'string' && start ? start : undefined,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });

  app.on('before-quit', (e) => {
    setQuitting();
    if (!serverRunning()) return;
    // Сначала сервер дописывает правки на диск, потом выходим уже по-настоящему.
    e.preventDefault();
    void stopServer().then(() => app.quit());
  });

  // Окна спрятаны в трей, но приложение работает, — не выходить, когда «закрылись все окна».
  app.on('window-all-closed', () => {
    if (isQuitting()) app.quit();
  });

  void app.whenReady().then(async () => {
    const error = await startServer(appDir, (message) => {
      // Сервер упал сам, пока приложение работает, — без него окна пустые: честно сказать и выйти.
      if (isQuitting()) return;
      dialog.showErrorBox('vaultboard', `${message}\n\nПодробности: ${LOG}`);
      quit();
    });
    if (error) {
      log(`не запустился: ${error}`);
      dialog.showErrorBox('vaultboard не запустился', `${error}\n\nПодробности: ${LOG}`);
      quit();
      return;
    }
    await clearCacheIfNewBuild();
    log(`рисование: ${softwareRender ? 'процессором (видеокарта выключена в меню трея)' : 'видеокартой'}`);
    logGpu();
    watchLoad();
    setupWindows({ icon: iconFile, preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'), onRecentChanged: updateTrayMenu });
    createTray(iconFile, { installUpdate: restartWithUpdate, quit, softwareRender, toggleSoftwareRender });
    onTrayHint(() => trayBalloon('vaultboard работает в трее', 'Открыть — щелчок по значку. Выйти совсем — правой кнопкой → «Выйти».'));
    const file = boardArg(process.argv);
    if (file) await openBoardFile(file);
    else await openMain();
    watchUpdates((version) => {
      broadcast('update-ready', { version });
      updateTrayMenu();
      if (!anyWindowVisible()) trayBalloon(`Готова версия ${version}`, 'Поставится при выходе из vaultboard.');
    });
  });
}
