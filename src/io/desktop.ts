// Мост к настольному приложению (electron/preload.ts). В браузере его нет — тогда null.
export interface DesktopBridge {
  /** Новая версия скачана и поставится при выходе (сообщает и сразу, если уже скачана). */
  onUpdateReady(cb: (update: { version: string }) => void): void;
  /** Перезапустить приложение с новой версией. */
  installUpdate(): void;
  /** Строка в журнал приложения (%TEMP%\\vaultboard.log). */
  log(text: string): void;
}

export const desktop: DesktopBridge | null = (window as unknown as { vaultboardDesktop?: DesktopBridge }).vaultboardDesktop ?? null;
