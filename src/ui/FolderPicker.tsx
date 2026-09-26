// Выбор папки на этом компьютере: браузер сам не отдаёт путь к папке, поэтому папки показывает наш сервер.
// Диски → папки → «Выбрать эту папку»; можно создать новую папку прямо здесь.
import { createSignal, For, onMount, Show } from 'solid-js';
import { type DirList, vault } from '../io/vault.ts';

export function FolderPicker(props: { start?: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [list, setList] = createSignal<DirList | null>(null);
  const [error, setError] = createSignal('');

  const open = async (path: string) => {
    try {
      setList(await vault.dirs(path));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  onMount(() => {
    // Начинаем с предложенной папки, а если её ещё нет — с той, где она будет создана.
    const start = props.start ?? '';
    void vault.dirs(start).then(
      (l) => setList(l),
      () => void open(start.replace(/[\\/][^\\/]*$/, '')),
    );
  });

  const mkdir = async () => {
    const cur = list();
    if (!cur?.path) return;
    const name = window.prompt('Название новой папки', 'vaultboard');
    if (!name?.trim()) return;
    try {
      const made = await vault.mkdir(cur.path, name.trim());
      await open(made.path);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div class="folder-picker">
      <div class="fp-bar">
        <button onClick={() => void open('')} title="Диски компьютера">💽 Диски</button>
        <button onClick={() => void open(list()?.home ?? '')} title="Папка пользователя">🏠 Моя папка</button>
        <Show when={list()?.parent !== null && list()?.path}>
          <button onClick={() => void open(list()!.parent ?? '')}>↑ Вверх</button>
        </Show>
      </div>
      <div class="fp-path">{list()?.path || 'Диски'}</div>
      <div class="fp-list">
        <For each={list()?.dirs ?? []} fallback={<div class="empty">Папок нет</div>}>
          {(d) => (
            <button class="fp-dir" onClick={() => void open(d.path)}>
              📁 {d.name}
            </button>
          )}
        </For>
      </div>
      <Show when={error()}>
        <div class="dialog-note bad">{error()}</div>
      </Show>
      <div class="dialog-actions">
        <Show when={list()?.path}>
          <button onClick={() => void mkdir()}>+ Новая папка здесь</button>
        </Show>
        <span style={{ flex: 1 }} />
        <button onClick={() => props.onCancel()}>Отмена</button>
        <button class="primary" disabled={!list()?.path} onClick={() => props.onPick(list()!.path)}>
          Выбрать эту папку
        </button>
      </div>
    </div>
  );
}
