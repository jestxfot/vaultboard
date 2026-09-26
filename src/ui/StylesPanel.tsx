// Стили доски: список, выделить все объекты со стилем, заменить стиль на другой, переименовать, удалить,
// общая библиотека базы. Стиль меняется так: поправил один объект → «Обновить стиль по выделенному».
import { createSignal, For, Show } from 'solid-js';
import type { Editor, EditorUi } from '../editor/Editor.ts';
import type { StyleDef } from '../model/types.ts';
import { fontFamily } from '../render/fonts.ts';

function Preview(props: { def: StyleDef }) {
  const d = () => props.def;
  const isLine = () => d().width !== undefined || d().dash !== undefined || d().start !== undefined || d().end !== undefined;
  return (
    <Show
      when={!isLine()}
      fallback={
        <svg class="style-preview" width="44" height="28">
          <line x1="4" y1="14" x2="40" y2="14" stroke={d().color ?? '#5b5b5b'} stroke-width={Math.min(d().width ?? 2, 8)}
            stroke-dasharray={d().dash === 'dashed' ? '6 4' : d().dash === 'dotted' ? '0.1 4' : d().dash === 'longdash' ? '12 4' : d().dash === 'dashdot' ? '7 3 0.1 3' : undefined}
            stroke-linecap="round" />
        </svg>
      }
    >
      <span
        class="style-preview"
        style={{
          background: d().color ?? '#ffffff',
          color: d().textColor ?? '#1f1f1f',
          border: `${Math.min(d().borderWidth ?? 1, 4)}px solid ${d().borderColor ?? '#d4d4d4'}`,
          'font-family': fontFamily(d().font),
          'font-weight': d().bold ? 700 : 400,
          'font-style': d().italic ? 'italic' : 'normal',
        }}
      >
        Аа
      </span>
    </Show>
  );
}

export function StylesPanel(props: {
  editor: Editor;
  ui: EditorUi;
  library: Record<string, StyleDef>;
  onSaveToLibrary: (name: string, def: StyleDef) => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = createSignal<string | null>(null);
  // `ui` меняется после каждой правки — через него панель узнаёт, что стили обновились.
  const styles = () => (props.ui, props.editor.styles());
  const usage = () => {
    props.ui;
    const count: Record<string, number> = {};
    for (const name of props.editor.styleNames()) count[name] = props.editor.styleUsage(name);
    return count;
  };
  const libraryOnly = () => Object.entries(props.library).filter(([name]) => !styles()[name]);
  const selectedLook = () => (props.ui, props.editor.selectedLook());

  return (
    <aside class="styles-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header class="doc-head">
        <div class="doc-title"><b>Стили доски</b><span class="doc-path">Хранятся в самой доске и переезжают вместе с её папкой</span></div>
        <button class="doc-btn" onClick={() => props.onClose()}>×</button>
      </header>
      <div class="styles-body">
        <Show when={props.ui.selection.length}>
          <div class="styles-actions">
            <button onClick={() => { const n = window.prompt('Название стиля, например «Факт [К]»'); if (n) props.editor.saveStyle(n); }}>Сохранить выделенное как стиль</button>
            <Show when={selectedLook()?.hasStyle}>
              <button onClick={() => props.editor.updateStyleFromSelection()} title="Все объекты с этим стилем станут как выделенный">Обновить стиль «{selectedLook()!.style}» по выделенному</button>
              <button onClick={() => props.editor.resetToStyle()}>Сбросить выделенное к стилю</button>
            </Show>
          </div>
        </Show>
        <Show when={Object.keys(styles()).length} fallback={<div class="empty">Стилей пока нет. Оформи объект как нравится, выдели его и нажми «Сохранить выделенное как стиль».</div>}>
          <For each={Object.entries(styles())}>
            {([name, def], i) => (
              <div class="style-row">
                <Preview def={def} />
                <div class="style-main">
                  <Show when={renaming() === name} fallback={<b onDblClick={() => setRenaming(name)} title="Двойной щелчок — переименовать">{name}</b>}>
                    <input
                      value={name}
                      ref={(el) => setTimeout(() => el.select())}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') { props.editor.renameStyle(name, e.currentTarget.value); setRenaming(null); }
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => setRenaming(null)}
                    />
                  </Show>
                  <span class="doc-path">{usage()[name] ?? 0} объектов{i() < 9 ? ` · Alt+${i() + 1}` : ''}</span>
                </div>
                <div class="style-buttons">
                  <button title="Применить к выделенному" disabled={!props.ui.selection.length} onClick={() => props.editor.applyStyle(name)}>Применить</button>
                  <button title="Выделить все объекты с этим стилем" onClick={() => props.editor.selectByStyle(name)}>Выделить все</button>
                  <select title="Заменить этот стиль на другой у всех объектов" value="" onChange={(e) => { if (e.currentTarget.value) props.editor.replaceStyle(name, e.currentTarget.value); e.currentTarget.value = ''; }}>
                    <option value="">Заменить на…</option>
                    <For each={Object.keys(styles()).filter((n) => n !== name)}>{(n) => <option value={n}>{n}</option>}</For>
                  </select>
                  <button title="Положить в общую библиотеку базы — пригодится на других досках" onClick={() => props.onSaveToLibrary(name, def)}>В библиотеку</button>
                  <button class="danger" title="Удалить стиль — объекты сохранят свой вид" onClick={() => props.editor.deleteStyle(name)}>Удалить</button>
                </div>
              </div>
            )}
          </For>
        </Show>
        <Show when={libraryOnly().length}>
          <div class="section">Общая библиотека базы</div>
          <For each={libraryOnly()}>
            {([name, def]) => (
              <div class="style-row">
                <Preview def={def} />
                <div class="style-main"><b>{name}</b></div>
                <div class="style-buttons">
                  <button onClick={() => props.editor.addStyle(name, def)}>На доску</button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
}
