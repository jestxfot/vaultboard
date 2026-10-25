// Мост между страницей и настольным приложением: страница узнаёт о скачанном обновлении и может попросить поставить его.
// Больше ничего страница через него не может — доступ к диску у неё, как и в браузере, только через сервер.
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
});
