// Панель инструментов слева, как в Miro.
import { createSignal, For, type JSX, Show } from 'solid-js';
import type { Editor, EditorUi } from '../editor/Editor.ts';
import type { PathKind, ShapeKind } from '../model/types.ts';
import { STICKY_PALETTE } from '../format/colors.ts';
import { IconFrame, IconPhoto, IconRedo, IconSelect, IconShapes, IconSticky, IconText, IconUndo } from './icons.tsx';

type Menu = 'sticky' | 'shapes' | null;

const LINES: { label: string; key?: string; path: PathKind; end: 'arrow' | 'none' }[] = [
  { label: 'Линия', key: 'L', path: 'straight', end: 'none' },
  { label: 'Стрелка', path: 'straight', end: 'arrow' },
  { label: 'Ломаная стрелка', path: 'elbow', end: 'arrow' },
  { label: 'Кривая стрелка', path: 'curve', end: 'arrow' },
];

const SHAPES: { label: string; key?: string; shape: ShapeKind }[] = [
  { label: 'Прямоугольник', key: 'R', shape: 'rect' },
  { label: 'Овал', key: 'O', shape: 'ellipse' },
  { label: 'Ромб', shape: 'diamond' },
  { label: 'Треугольник', shape: 'triangle' },
];

const MORE_SHAPES: { label: string; shape: ShapeKind }[] = [
  { label: 'Скруглённый', shape: 'round' },
  { label: 'Параллелограмм', shape: 'parallelogram' },
  { label: 'Шестиугольник', shape: 'hexagon' },
  { label: 'Звезда', shape: 'star' },
  { label: 'Цилиндр', shape: 'cylinder' },
  { label: 'Документ', shape: 'document' },
];

function ToolButton(props: { title: string; active?: boolean; disabled?: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button class="tool" classList={{ active: props.active }} title={props.title} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

export function Toolbar(props: { editor: Editor; ui: EditorUi; onPhoto: () => void }) {
  const [menu, setMenu] = createSignal<Menu>(null);
  const toggle = (m: Menu) => setMenu((cur) => (cur === m ? null : m));
  const pick = (fn: () => void) => {
    fn();
    setMenu(null);
  };

  return (
    <div class="toolbar" onPointerDown={(e) => e.stopPropagation()}>
      <div class="tool-group">
        <ToolButton title="Выделение (V)" active={props.ui.tool === 'select'} onClick={() => pick(() => props.editor.setTool('select'))}>
          <IconSelect />
        </ToolButton>
        <ToolButton title="Стикер (N — сразу под курсором)" active={props.ui.tool === 'sticky' || menu() === 'sticky'} onClick={() => toggle('sticky')}>
          <IconSticky />
        </ToolButton>
        <ToolButton title="Текст (T — сразу под курсором, или двойной щелчок)" active={props.ui.tool === 'text'} onClick={() => pick(() => props.editor.setTool('text'))}>
          <IconText />
        </ToolButton>
        <ToolButton title="Фигуры и линии" active={props.ui.tool === 'shape' || props.ui.tool === 'line' || menu() === 'shapes'} onClick={() => toggle('shapes')}>
          <IconShapes />
        </ToolButton>
        <ToolButton title="Рамка (F)" active={props.ui.tool === 'frame'} onClick={() => pick(() => props.editor.setTool('frame'))}>
          <IconFrame />
        </ToolButton>
        <ToolButton title="Фото и файлы (можно и Ctrl+V, и перетащить из проводника) — кладутся в папку доски без сжатия" onClick={() => pick(props.onPhoto)}>
          <IconPhoto />
        </ToolButton>
      </div>
      <div class="tool-group">
        <ToolButton title="Отменить (Ctrl+Z)" disabled={!props.ui.canUndo} onClick={() => props.editor.undo()}>
          <IconUndo />
        </ToolButton>
        <ToolButton title="Повторить (Ctrl+Y)" disabled={!props.ui.canRedo} onClick={() => props.editor.redo()}>
          <IconRedo />
        </ToolButton>
      </div>

      <Show when={menu() === 'sticky'}>
        <div class="tool-menu palette-menu" style={{ top: '48px' }}>
          <div class="palette-grid">
            <For each={STICKY_PALETTE}>
              {(c) => (
                <button
                  class="swatch big"
                  classList={{ active: props.ui.stickyColor === c }}
                  style={{ background: c }}
                  title="Стикер этого цвета: щёлкни по доске или протяни рамку"
                  onClick={() => pick(() => props.editor.setTool('sticky', { color: c }))}
                />
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={menu() === 'shapes'}>
        <div class="tool-menu list-menu" style={{ top: '130px' }}>
          <For each={LINES}>
            {(l) => (
              <button class="menu-item" onClick={() => pick(() => props.editor.setTool('line', { path: l.path, end: l.end }))}>
                {l.label}
                <Show when={l.key}><span class="key">{l.key}</span></Show>
              </button>
            )}
          </For>
          <div class="menu-sep" />
          <For each={SHAPES}>
            {(s) => (
              <button class="menu-item" classList={{ active: props.ui.tool === 'shape' && props.ui.shape === s.shape }} onClick={() => pick(() => props.editor.setTool('shape', { shape: s.shape }))}>
                {s.label}
                <Show when={s.key}><span class="key">{s.key}</span></Show>
              </button>
            )}
          </For>
          <div class="menu-sep" />
          <div class="menu-caption">Ещё фигуры</div>
          <div class="menu-more">
            <For each={MORE_SHAPES}>
              {(s) => (
                <button class="menu-chip" onClick={() => pick(() => props.editor.setTool('shape', { shape: s.shape }))}>
                  {s.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
