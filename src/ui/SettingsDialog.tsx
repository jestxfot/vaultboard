// Настройки этого компьютера (не доски): прокси, через который сервер ходит за карточками ссылок.
import { createSignal, onMount, Show } from 'solid-js';
import { vault } from '../io/vault.ts';

export function SettingsDialog(props: { onClose: () => void }) {
  const [proxy, setProxy] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    vault.getSettings().then((s) => setProxy(s.proxy ?? ''), () => undefined);
  });

  const save = async () => {
    setBusy(true);
    try {
      await vault.putSettings({ proxy: proxy().trim() || undefined });
      setStatus('Сохранено');
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    await save();
    setBusy(true);
    setStatus('Проверяю…');
    try {
      const r = await vault.unfurl('https://store.steampowered.com/app/319510/', '');
      setStatus(`Работает: «${r.title ?? r.url}»`);
    } catch (err) {
      setStatus(`Не получилось: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="quick-back" onPointerDown={() => props.onClose()}>
      <div class="dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div class="dialog-title">Настройки</div>
        <div class="dialog-note" style={{ margin: '0 0 8px' }}>
          <b>Прокси для карточек ссылок.</b> Страницу по ссылке читает сервер приложения, а не браузер. Если в браузере сайт открывается
          через прокси (например ZeroOmega), укажи тот же адрес — и сервер пойдёт тем же путём. Пусто — системный прокси Windows (если он есть), иначе напрямую.
        </div>
        <input
          class="settings-input"
          placeholder="http://127.0.0.1:10809 или socks5://127.0.0.1:10808"
          value={proxy()}
          onInput={(e) => setProxy(e.currentTarget.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Show when={status()}>
          <div class="dialog-note">{status()}</div>
        </Show>
        <div class="dialog-actions">
          <button onClick={() => void test()} disabled={busy()}>Проверить на Steam</button>
          <button class="primary" onClick={() => void save().then(() => props.onClose())} disabled={busy()}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}
