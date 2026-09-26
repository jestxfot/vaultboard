// Панель слоёв: глаз — скрыть или показать слой целиком, замок — закрепить (виден, но не выделяется),
// щелчок по строке — слой становится активным, и новые объекты ложатся на него.
import { createSignal, For, Show } from 'solid-js';
import type { Editor, EditorUi } from '../editor/Editor.ts';

function Eye(props: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
      <Show when={props.open} fallback={<path d="M3 13 13 3" />}>
        <circle cx="8" cy="8" r="2" />
      </Show>
    </svg>
  );
}

function Lock(props: { closed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d={props.closed ? 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' : 'M5.5 7V5a2.5 2.5 0 0 1 4.8-1'} />
    </svg>
  );
}

export function LayersPanel(props: { editor: Editor; ui: EditorUi; onClose: () => void }) {
  const [renaming, setRenaming] = createSignal<string | null>(null);
  // `ui` меняется после каждой правки — через него панель узнаёт, что слои или объекты поменялись.
  const layers = () => (props.ui, props.editor.layers());
  const usage = () => (props.ui, props.editor.layerUsage());
  const active = () => (props.ui, props.editor.activeLayer);

  const add = (fromSelection: boolean) => {
    const name = window.prompt('Название слоя, например «Фото»', fromSelection ? 'Выделенное' : `Слой ${layers().length + 1}`);
    if (name?.trim()) props.editor.addLayer(name.trim(), fromSelection);
  };

  return (
    <aside class="layers-panel" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <header class="layers-head">
        <b>Слои</b>
        <span class="layers-sub">Shift+L</span>
        <button class="doc-btn" title="Закрыть" onClick={() => props.onClose()}>×</button>
      </header>
      <div class="layers-list">
        {/* Сверху — последний созданный слой, как в редакторах картинок. */}
        <For each={[...layers()].reverse()}>
          {(l) => (
            <div
              class="layer-row"
              classList={{ active: active() === l.id, hidden: !!l.hidden }}
              onClick={() => !l.hidden && !l.locked && props.editor.setActiveLayer(l.id)}
              title={l.hidden || l.locked ? 'Скрытый или закреплённый слой нельзя сделать активным' : 'Сделать активным: новые объекты лягут сюда'}
            >
              <button
                class="layer-icon"
                classList={{ off: !!l.hidden }}
                title="Скрыть / показать слой. Alt+щелчок — показать только этот слой"
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.altKey) props.editor.soloLayer(l.id);
                  else props.editor.toggleLayerHidden(l.id);
                }}
              >
                <Eye open={!l.hidden} />
              </button>
              <button
                class="layer-icon lock"
                classList={{ on: !!l.locked }}
                title="Закрепить слой: виден, но не выделяется и не мешает двигать доску"
                onClick={(e) => { e.stopPropagation(); props.editor.toggleLayerLocked(l.id); }}
              >
                <Lock closed={!!l.locked} />
              </button>
              <Show
                when={renaming() === l.id}
                fallback={<span class="layer-name" onDblClick={(e) => { e.stopPropagation(); setRenaming(l.id); }} title="Двойной щелчок — переименовать">{l.name}</span>}
              >
                <input
                  class="layer-input"
                  value={l.name}
                  ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => {
                    if (renaming() === l.id) props.editor.renameLayer(l.id, e.currentTarget.value);
                    setRenaming(null);
                  }}
                />
              </Show>
              <span class="layer-count">{usage().get(l.id) ?? 0}</span>
              <span class="layer-actions">
                <button title="Выделить все объекты слоя" onClick={(e) => { e.stopPropagation(); props.editor.selectLayer(l.id); }}>⬚</button>
                <Show when={props.ui.selection.length}>
                  <button title="Перенести выделенное на этот слой" onClick={(e) => { e.stopPropagation(); props.editor.moveSelectionToLayer(l.id); }}>⇲</button>
                </Show>
                <Show when={l.id !== ''}>
                  <button
                    class="danger"
                    title="Удалить слой (объекты перейдут на основной)"
                    onClick={(e) => {
                      e.stopPropagation();
                      const n = usage().get(l.id) ?? 0;
                      if (window.confirm(`Удалить слой «${l.name}»? Его объекты (${n}) останутся на доске и перейдут на основной слой.`)) props.editor.deleteLayer(l.id);
                    }}
                  >
                    ×
                  </button>
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
      <footer class="layers-foot">
        <button onClick={() => add(false)}>+ Новый слой</button>
        <Show when={props.ui.selection.length}>
          <button onClick={() => add(true)}>+ Слой из выделенного</button>
        </Show>
      </footer>
    </aside>
  );
}
