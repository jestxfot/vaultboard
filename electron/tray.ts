// Значок в трее: открыть окно, недавние доски, открыть доску с диска, обновление, выход.
import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { checkForUpdates, readyVersion } from './updates.ts';
import { openBenchmark, openBoardDialog, openBoardFile, recentBoards, showWindow } from './windows.ts';

let tray: Tray | null = null;
let actions = { installUpdate: () => {}, quit: () => {}, softwareRender: false, toggleSoftwareRender: () => {} };

/** Название доски для меню: папка доски (Проект/доска.board → «Проект») или имя файла. */
function title(file: string): string {
  return path.basename(file).toLowerCase() === 'доска.board' ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file));
}

export function updateTrayMenu(): void {
  if (!tray) return;
  const recent = recentBoards();
  const version = readyVersion();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть vaultboard', click: () => showWindow() },
      {
        label: 'Недавние доски',
        enabled: recent.length > 0,
        submenu: recent.map((file) => ({ label: title(file), sublabel: file, toolTip: file, click: () => void openBoardFile(file) })),
      },
      { label: 'Открыть доску…', click: () => void openBoardDialog() },
      { type: 'separator' },
      { label: 'Замер скорости', toolTip: 'Сгенерированные доски на 300 и 2000 объектов; итог — в журнале. Ваши доски не трогает.', click: openBenchmark },
      {
        label: 'Рисовать без видеокарты',
        toolTip: 'Если видеокарту занимает другая программа (например, нейросеть) и доска двигается рывками. Перезапускает vaultboard.',
        type: 'checkbox',
        checked: actions.softwareRender,
        click: () => actions.toggleSoftwareRender(),
      },
      ...(version
        ? [{ label: `Перезапустить с версией ${version}`, click: () => actions.installUpdate() }]
        : app.isPackaged
          ? [{ label: 'Проверить обновления', click: checkForUpdates }]
          : []),
      { label: 'Выйти', click: () => actions.quit() },
    ]),
  );
}

export function createTray(icon: string, opts: typeof actions): void {
  actions = opts;
  // В Windows — сам .ico: система берёт из него размер под свой масштаб экрана.
  tray = new Tray(process.platform === 'win32' ? icon : nativeImage.createFromPath(icon).resize({ width: 24, height: 24 }));
  tray.setToolTip('vaultboard');
  tray.on('click', () => showWindow());
  updateTrayMenu();
}

/** Всплывающая подсказка у значка (только Windows). */
export function trayBalloon(title: string, content: string): void {
  if (process.platform === 'win32') tray?.displayBalloon({ iconType: 'info', title, content });
}
