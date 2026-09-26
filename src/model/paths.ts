// Доска — это одна папка, которую можно перенести куда угодно:
//
//   Таймлайн/
//     доска.board        ← сама доска
//     .история.jsonl     ← история отмены (с точкой — Obsidian такие файлы не показывает)
//     фото/…             ← фото доски
//     Укус 83.md         ← документы доски
//
// Файлы внутри папки доска хранит относительными путями («фото/IMG.jpg»), поэтому после переноса
// папки всё находится само. Файлы вне папки (заметки из других мест базы) — путём от корня базы
// с «/» в начале («/Canon/Цитаты.md»).
// Старые доски (формат 1) лежали файлом «Имя.board» рядом с папкой «Имя/» — их тоже понимаем.

export const BOARD_FILE = 'доска.board';

function split(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/** Новая доска — папка с файлом доска.board. */
export function isFolderBoard(boardPath: string): boolean {
  return split(boardPath).name.toLowerCase() === BOARD_FILE;
}

/** Папка доски: там лежат её фото, документы и история. */
export function boardFolderOf(boardPath: string): string {
  const { dir, name } = split(boardPath);
  if (name.toLowerCase() === BOARD_FILE) return dir;
  const legacy = name.replace(/\.board$/i, '');
  return dir ? `${dir}/${legacy}` : legacy;
}

/** Файл истории отмены — внутри папки доски, чтобы переезжать вместе с ней. */
export function historyPathOf(boardPath: string): string {
  const { dir, name } = split(boardPath);
  const file = name.toLowerCase() === BOARD_FILE ? '.история.jsonl' : `.${name.replace(/\.board$/i, '')}.история.jsonl`;
  return dir ? `${dir}/${file}` : file;
}

/** Как доска называется в списке: у новой — имя папки, у старой — имя файла. */
export function boardTitleOf(boardPath: string): string {
  return isFolderBoard(boardPath) ? boardFolderOf(boardPath) : boardPath.replace(/\.board$/i, '');
}

/** Перевод путей между «как записано в доске» и «путь от корня базы». */
export class BoardPaths {
  /** Папка доски от корня базы; пусто — у черновика и замера (тогда пути уже от корня). */
  readonly folder: string;

  constructor(folder: string) {
    this.folder = folder;
  }

  /** Путь в доске → путь от корня базы. */
  toVault(stored: string): string {
    if (stored.startsWith('/')) return stored.slice(1);
    return this.folder ? `${this.folder}/${stored}` : stored;
  }

  /** Путь от корня базы → как записать в доску: внутри папки доски — относительно, иначе — от корня с «/». */
  toStored(vaultPath: string): string {
    if (this.folder && vaultPath.startsWith(`${this.folder}/`)) return vaultPath.slice(this.folder.length + 1);
    return this.folder ? `/${vaultPath}` : vaultPath;
  }
}
