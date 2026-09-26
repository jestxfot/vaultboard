// Ctrl+K: поиск заметки по всей базе. Enter — положить карточку на доску, Shift+Enter — открыть в панели.
import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import type { FileIndex } from '../io/files.ts';

export function QuickOpen(props: { files: FileIndex; onPlace: (path: string) => void; onOpen: (path: string) => void; onClose: () => void }) {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal('');
  const [active, setActive] = createSignal(0);
  const results = createMemo(() => props.files.search(query(), 40));

  onMount(() => input.focus());

  const choose = (path: string | undefined, open: boolean) => {
    if (!path) return;
    props.onClose();
    if (open) props.onOpen(path);
    else props.onPlace(path);
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') props.onClose();
    else if (e.key === 'ArrowDown') setActive((i) => Math.min(results().length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') choose(results()[active()], e.shiftKey);
    else return;
    e.preventDefault();
  };

  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  return (
    <div class="quick-back" onPointerDown={() => props.onClose()}>
      <div class="quick" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          placeholder="Найти заметку в базе…"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <div class="quick-list">
          <For each={results()} fallback={<div class="quick-empty">Ничего не нашлось</div>}>
            {(p, i) => (
              <button class="quick-item" classList={{ active: i() === active() }} onMouseEnter={() => setActive(i())} onClick={(e) => choose(p, e.shiftKey)}>
                <span class="quick-name">{name(p)}</span>
                <Show when={dir(p)}><span class="quick-dir">{dir(p)}</span></Show>
              </button>
            )}
          </For>
        </div>
        <div class="quick-hint">Enter — на доску под курсор · Shift+Enter — открыть в панели · Esc — закрыть</div>
      </div>
    </div>
  );
}
