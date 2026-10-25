// Настройки этого компьютера (не доски): папка с досками, имя в комментариях,
// прокси, через который сервер ходит за карточками ссылок.
import { createSignal, onMount, Show } from 'solid-js';
import { vault } from '../io/vault.ts';
import { FolderPicker } from './FolderPicker.tsx';
import { chooseFolder, foreignRoot } from '../io/desktop.ts';

export function SettingsDialog(props: { onClose: () => void; onSaved?: (s: { author?: string }) => void }) {
  const [proxy, setProxy] = createSignal('');
  const [author, setAuthor] = createSignal('');
  const [defaultAuthor, setDefaultAuthor] = createSignal('');
  const [root, setRoot] = createSignal('');
  const [savedRoot, setSavedRoot] = createSignal('');
  const [fixedRoot, setFixedRoot] = createSignal<string | null>(null);
  const [picking, setPicking] = createSignal(false);
  const [status, setStatus] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    vault.getSettings().then((s) => {
      setProxy(s.proxy ?? '');
      setAuthor(s.author ?? '');
      setDefaultAuthor(s.defaultAuthor ?? '');
      setRoot(s.vaultRoot ?? '');
      setSavedRoot(s.vaultRoot ?? '');
      setFixedRoot(s.fixedRoot ?? null);
    }, () => undefined);
  });

  const save = async () => {
    setBusy(true);
    try {
      const rootChanged = !!root() && root() !== savedRoot();
      await vault.putSettings({
        proxy: proxy().trim(),
        author: author().trim(),
        ...(rootChanged ? { vaultRoot: root() } : {}),
      });
      props.onSaved?.({ author: author().trim() || defaultAuthor() });
      setStatus('Сохранено');
      // Сменили папку с досками — открываем приложение заново: другие доски, другие заметки.
      if (rootChanged) location.reload();
      return true;
    } catch (err) {
      setStatus((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!(await save())) return;
    setBusy(true);
    setStatus('Проверяю…');
    try {
      const r = await vault.unfurl('https://store.steampowered.com/app/319510/', '');
      setStatus(`Прокси работает: «${r.title ?? r.url}»`);
    } catch (err) {
      setStatus(`Не получилось: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="quick-back" onPointerDown={() => props.onClose()}>
      <div class="dialog setup settings" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Show
          when={!picking()}
          fallback={
            <>
              <div class="setup-title">Папка с досками</div>
              <FolderPicker start={root()} onPick={(p) => { setRoot(p); setPicking(false); }} onCancel={() => setPicking(false)} />
            </>
          }
        >
          <div class="setup-title">Настройки</div>

          <section class="setup-step">
            <div class="step-head small">Папка с досками</div>
            <Show
              when={!fixedRoot()}
              fallback={
                <div class="step-note">
                  {fixedRoot()} — {foreignRoot ? 'папка этой доски: окно открыто для доски не из папки с досками' : 'задана переменной VAULT_ROOT при запуске сервера'}.
                </div>
              }
            >
              <div class="settings-row">
                <span class="settings-path" title={root()}>{root() || 'не выбрана'}</span>
                <button class="soft-btn" onClick={() => chooseFolder(root(), setRoot, () => setPicking(true))}>Изменить…</button>
              </div>
              <Show when={root() !== savedRoot()}>
                <div class="step-note">После сохранения приложение откроется заново с досками из новой папки.</div>
              </Show>
            </Show>
          </section>

          <section class="setup-step">
            <div class="step-head small">Имя в комментариях</div>
            <input class="setup-input" placeholder={defaultAuthor() || 'Имя'} value={author()} onInput={(e) => setAuthor(e.currentTarget.value)} />
          </section>

          <section class="setup-step">
            <div class="step-head small">Прокси для карточек ссылок</div>
            <div class="step-note">
              Страницу по ссылке читает сервер приложения, а не браузер. Если сайт открывается у тебя через прокси
              (например ZeroOmega), укажи тот же адрес. Пусто — системный прокси, иначе напрямую.
            </div>
            <div class="settings-row">
              <input class="setup-input" placeholder="http://127.0.0.1:10809 или socks5://127.0.0.1:10808" value={proxy()} onInput={(e) => setProxy(e.currentTarget.value)} />
              <button class="soft-btn" onClick={() => void test()} disabled={busy()}>Проверить на Steam</button>
            </div>
          </section>

          <Show when={status()}>
            <div class="step-note">{status()}</div>
          </Show>
          <footer class="setup-foot">
            <button class="soft-btn" onClick={() => props.onClose()}>Отмена</button>
            <button class="setup-start" onClick={() => void save().then((ok) => ok && props.onClose())} disabled={busy()}>Сохранить</button>
          </footer>
        </Show>
      </div>
    </div>
  );
}
