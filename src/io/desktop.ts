// Мост к настольному приложению (electron/preload.ts). В браузере его нет — тогда null.
export interface DesktopBridge {
  /** Новая версия скачана и поставится при выходе (сообщает и сразу, если уже скачана). */
  onUpdateReady(cb: (update: { version: string }) => void): void;
  /** Перезапустить приложение с новой версией. */
  installUpdate(): void;
  /** Строка в журнал приложения (%TEMP%\\vaultboard.log). */
  log(text: string): void;
  /** Записать в журнал, кто сейчас занимает видеокарту (Windows). */
  logGpuLoad(when: string): void;
  /** Выбрать папку окном системы; отмена — null. */
  pickFolder(start?: string): Promise<string | null>;
  /** Окно открывает доску. false — она уже открыта в другом окне (приложение показало то окно). */
  claimBoard(path: string): Promise<boolean>;
  /** Открыть доску в отдельном окне. */
  openInNewWindow(path: string): void;
}

export const desktop: DesktopBridge | null = (window as unknown as { vaultboardDesktop?: DesktopBridge }).vaultboardDesktop ?? null;

/** Окно приложения показывает доску не из папки с досками (адрес vaultboard://ext-…/): папка у него своя. */
export const foreignRoot = !!desktop && location.protocol === 'vaultboard:' && location.host !== 'vault';

/**
 * Выбрать папку: в настольном приложении — окном системы (`onPick` с выбранной папкой, отмена — ничего),
 * в браузере — своим выбором папок (`showPicker`).
 */
export function chooseFolder(start: string, onPick: (path: string) => void, showPicker: () => void): void {
  if (!desktop) return showPicker();
  void desktop.pickFolder(start).then((picked) => {
    if (picked) onPick(picked);
  });
}
