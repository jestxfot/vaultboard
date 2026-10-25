// Обновления с GitHub Releases (electron-updater). Новая версия скачивается сама, в фоне и только изменившимися
// частями (по .blockmap прошлого установщика), ставится при выходе — или сразу, кнопкой «Перезапустить».
// Запуск из исходников (npm run app) не обновляется: там обновляются через git.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { log } from './log.ts';
import { stopServer } from './server.ts';

/** Как часто спрашивать GitHub о новой версии, пока приложение работает. */
const EVERY = 4 * 60 * 60_000;

let ready: string | null = null;

/** Скачанная новая версия (null — нет). */
export function readyVersion(): string | null {
  return ready;
}

export function checkForUpdates(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates().catch((err: Error) => log(`обновление, ошибка: ${err.message}`));
}

export function watchUpdates(onReady: (version: string) => void): void {
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
    ready = info.version;
    onReady(info.version);
  });
  checkForUpdates();
  setInterval(checkForUpdates, EVERY);
}

/** Перезапуститься с новой версией: сначала сервер дописывает правки на диск, потом установщик. */
export async function installUpdate(beforeQuit: () => void): Promise<void> {
  if (!ready) return;
  beforeQuit();
  await stopServer();
  autoUpdater.quitAndInstall(true, true);
}
