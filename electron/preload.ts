// Мост между страницей и настольным приложением. Страница может только то, что здесь перечислено:
// узнать об обновлении и поставить его, выбрать папку окном системы, открыть доску в своём окне, написать в журнал.
// Прямого доступа к диску у неё нет — файлы, как и в браузере, только через сервер.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vaultboardDesktop', {
  /** Сообщить, когда новая версия скачана и готова (и сразу, если уже готова). */
  onUpdateReady(cb: (update: { version: string }) => void): void {
    ipcRenderer.on('update-ready', (_e, update: { version: string }) => cb(update));
    ipcRenderer.send('update-query');
  },
  /** Перезапустить приложение с новой версией. */
  installUpdate(): void {
    ipcRenderer.send('update-install');
  },
  /** Строка в журнал приложения. */
  log(text: string): void {
    ipcRenderer.send('log', String(text).slice(0, 500));
  },
  /** Записать в журнал, кто сейчас занимает видеокарту (Windows). */
  logGpuLoad(when: string): void {
    ipcRenderer.send('log-gpu-load', when);
  },
  /** Выбрать папку окном системы; отмена — null. */
  pickFolder(start?: string): Promise<string | null> {
    return ipcRenderer.invoke('pick-folder', start ?? '');
  },
  /** Окно открывает доску (путь от корня). false — она уже открыта в другом окне, и приложение показало то окно. */
  claimBoard(path: string): Promise<boolean> {
    return ipcRenderer.invoke('claim-board', path);
  },
  /** Открыть доску (путь от корня) в отдельном окне. */
  openInNewWindow(path: string): void {
    ipcRenderer.send('open-in-new-window', path);
  },
});
