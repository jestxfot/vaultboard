// Первая настройка: где хранить доски, как тебя подписывать в комментариях, обновляться ли самому.
// Показывается, пока не выбрана папка с досками — например, на новом компьютере или без Obsidian.
import { createSignal, For, Show } from 'solid-js';
import { type Settings, type SetupInfo, vault } from '../io/vault.ts';
import { FolderPicker } from './FolderPicker.tsx';

/** Имя папки и где она лежит — «FNAF» и «J:\obsidian». */
function splitPath(p: string): { name: string; where: string } {
  const clean = p.replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return i < 0 ? { name: clean, where: '' } : { name: clean.slice(i + 1) || clean, where: clean.slice(0, i + 1) };
}

const KIND: Record<string, { icon: string; note: string }> = {
  obsidian: { icon: '◆', note: 'Хранилище Obsidian — заметки на досках будут те же' },
  folder: { icon: '📁', note: 'Уже есть на диске' },
  new: { icon: '＋', note: 'Новая папка — создам её сам' },
  custom: { icon: '📁', note: 'Своя папка' },
};

export function SetupDialog(props: {
  info: SetupInfo;
  /** Мастер открыт повторно — подставить то, что уже настроено. */
  current?: Settings | null;
  onCancel?: () => void;
  /** `rootChanged` — выбрана другая папка с досками. */
  onDone: (rootChanged: boolean) => void;
}) {
  const first = props.info.suggestions[0];
  const was = props.info.root;
  const [root, setRoot] = createSignal(was ?? first?.path ?? '');
  const [isNew, setIsNew] = createSignal(!was && first?.kind === 'new');
  // Уже выбранная папка, которой нет среди предложенных, — показать её отдельной карточкой.
  const [custom, setCustom] = createSignal<string | null>(was && !props.info.suggestions.some((s) => s.path === was) ? was : null);
  const [author, setAuthor] = createSignal(props.current?.author || props.info.defaultAuthor);
  const [autoUpdate, setAutoUpdate] = createSignal(props.current?.autoUpdate !== false);
  const [proxy, setProxy] = createSignal(props.current?.proxy ?? '');
  const [more, setMore] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const options = () => [
    ...props.info.suggestions.map((s) => ({ path: s.path, kind: s.kind as string })),
    ...(custom() ? [{ path: custom()!, kind: 'custom' }] : []),
  ];

  const start = async () => {
    if (!root().trim()) {
      setError('Выбери папку, где будут лежать доски');
      return;
    }
    setBusy(true);
    try {
      await vault.putSettings({
        ...(props.info.fixed ? {} : { vaultRoot: root().trim(), createRoot: isNew() }),
        author: author().trim(),
        autoUpdate: autoUpdate(),
        proxy: proxy().trim(),
      });
      props.onDone(!props.info.fixed && root().trim() !== (was ?? ''));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="quick-back setup-back">
      <div class="dialog setup" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Show
          when={!picking()}
          fallback={
            <>
              <div class="setup-title">Выбери папку</div>
              <FolderPicker
                start={root()}
                onPick={(p) => {
                  setCustom(p);
                  setRoot(p);
                  setIsNew(false);
                  setPicking(false);
                }}
                onCancel={() => setPicking(false)}
              />
            </>
          }
        >
          <header class="setup-hero">
            <span class="logo big">vb</span>
            <div>
              <div class="setup-title">{props.current ? 'Настройка vaultboard' : 'Добро пожаловать в vaultboard'}</div>
              <div class="setup-sub">{props.current ? 'Папка с досками, имя и обновления — то же, что при первом запуске.' : 'Бесконечные доски поверх обычных файлов. Три вопроса — и можно работать.'}</div>
            </div>
          </header>

          <section class="setup-step">
            <div class="step-head"><span class="step-num">1</span>Где хранить доски</div>
            <div class="step-note">
              Доски, заметки и фото — обычные файлы в этой папке: её можно переносить, класть в облако или в git.
              <Show when={props.info.obsidian}> Пользуешься Obsidian — выбери его хранилище.</Show>
            </div>
            <div class="setup-options">
              <For each={options()}>
                {(o) => {
                  const p = splitPath(o.path);
                  const k = KIND[o.kind] ?? KIND.custom;
                  return (
                    <button
                      class="setup-option"
                      classList={{ active: root() === o.path, obsidian: o.kind === 'obsidian' }}
                      onClick={() => { setRoot(o.path); setIsNew(o.kind === 'new'); setError(''); }}
                    >
                      <span class="so-icon">{k.icon}</span>
                      <span class="so-text">
                        <span class="so-name">{p.name}</span>
                        <span class="so-path">{p.where}</span>
                        <span class="so-kind">{k.note}</span>
                      </span>
                      <span class="so-check">{root() === o.path ? '✓' : ''}</span>
                    </button>
                  );
                }}
              </For>
              <button class="setup-option ghost" onClick={() => setPicking(true)}>
                <span class="so-icon">…</span>
                <span class="so-text"><span class="so-name">Другая папка</span><span class="so-kind">Выбрать на диске или создать новую</span></span>
              </button>
            </div>
          </section>

          <section class="setup-step">
            <div class="step-head"><span class="step-num">2</span>Как тебя подписывать</div>
            <div class="step-note">Имя в комментариях и реакциях на досках.</div>
            <input class="setup-input" value={author()} onInput={(e) => setAuthor(e.currentTarget.value)} placeholder={props.info.defaultAuthor} />
          </section>

          <section class="setup-step">
            <div class="step-head"><span class="step-num">3</span>Обновления</div>
            <label class="switch-row">
              <span class="switch">
                <input type="checkbox" checked={autoUpdate()} onChange={(e) => setAutoUpdate(e.currentTarget.checked)} />
                <span class="switch-track" />
              </span>
              <span>
                Обновляться самому
                <span class="step-note">Когда на GitHub выходит новый релиз, vaultboard.vbs поставит его при следующем запуске.</span>
              </span>
            </label>
          </section>

          <button class="setup-more" onClick={() => setMore(!more())}>{more() ? '▾' : '▸'} Дополнительно</button>
          <Show when={more()}>
            <section class="setup-step">
              <div class="step-head small">Прокси для карточек ссылок</div>
              <div class="step-note">Нужен, только если сайты (например Steam) открываются у тебя через прокси. Можно заполнить потом в ⚙ Настройках.</div>
              <input class="setup-input" value={proxy()} onInput={(e) => setProxy(e.currentTarget.value)} placeholder="http://127.0.0.1:10809 или socks5://127.0.0.1:10808" />
            </section>
          </Show>

          <Show when={error()}>
            <div class="setup-error">{error()}</div>
          </Show>
          <footer class="setup-foot">
            <span class="step-note">{props.current ? '' : 'Это окно потом открывается щелчком по логотипу слева.'}</span>
            <Show when={props.onCancel}>
              <button class="soft-btn" onClick={() => props.onCancel!()}>Отмена</button>
            </Show>
            <button class="setup-start" disabled={busy()} onClick={() => void start()}>{busy() ? 'Сохраняю…' : props.current ? 'Сохранить' : 'Начать →'}</button>
          </footer>
        </Show>
      </div>
    </div>
  );
}
