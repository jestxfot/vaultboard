// Панель инструментов слева, как в Miro.
import { createSignal, For, type JSX, Show } from 'solid-js';
import type { Editor, EditorUi } from '../editor/Editor.ts';
import type { PathKind, ShapeKind } from '../model/types.ts';
import { STICKY_PALETTE } from '../format/colors.ts';
import { IconComment, IconDoc, IconFrame, IconPen, IconPhoto, IconRedo, IconSelect, IconShapes, IconSticky, IconText, IconUndo } from './icons.tsx';

type Menu = 'sticky' | 'shapes' | 'draw' | null;

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

const DRAW_COLORS = ['#1a1a1a', '#5b5b5b', '#e93147', '#ec7500', '#e0ac00', '#08b94e', '#00bfbc', '#4262ff', '#7852ee', '#ffffff'];
const MARKER_COLORS = ['#ffe55c', '#a9e06b', '#8fb3ff', '#ff8be0', '#ffb27a'];
const SIZES = [2, 3, 6, 12, 24];

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

export function Toolbar(props: { editor: Editor; ui: EditorUi; onPhoto: () => void; onDoc: () => void }) {
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
        <ToolButton title="Документ — заметка .md в папке доски (D — сразу под курсором)" onClick={() => pick(props.onDoc)}>
          <IconDoc />
        </ToolButton>
        <ToolButton
          title="Рисование: ручка P, выделитель M, ластик E. Перо планшета рисует по пустому месту сразу, мышь — с зажатым Alt"
          active={['pen', 'marker', 'eraser', 'lasso'].includes(props.ui.tool) || menu() === 'draw'}
          onClick={() => toggle('draw')}
        >
          <IconPen />
        </ToolButton>
        <ToolButton title="Рамка (F)" active={props.ui.tool === 'frame'} onClick={() => pick(() => props.editor.setTool('frame'))}>
          <IconFrame />
        </ToolButton>
        <ToolButton title="Комментарий (C): щёлкни по доске или по объекту. Список — Shift+C" active={props.ui.tool === 'comment'} onClick={() => pick(() => props.editor.setTool('comment'))}>
          <IconComment />
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

      <Show when={menu() === 'draw'}>
        <div class="tool-menu draw-menu" style={{ top: '130px' }}>
          <button class="menu-item" classList={{ active: props.ui.tool === 'pen' && !props.ui.smart }} onClick={() => { if (props.ui.smart) props.editor.toggleSmart(); props.editor.setTool('pen'); }}>
            Ручка <span class="key">P</span>
          </button>
          <button class="menu-item" classList={{ active: props.ui.tool === 'marker' }} onClick={() => props.editor.setTool('marker')}>
            Выделитель <span class="key">M</span>
          </button>
          <button class="menu-item" classList={{ active: props.ui.smart }} title="Нарисованный от руки круг, прямоугольник, ромб, треугольник или прямая станет настоящей фигурой" onClick={() => props.editor.toggleSmart()}>
            Умное рисование {props.ui.smart ? '✓' : ''}
          </button>
          <button class="menu-item" classList={{ active: props.ui.tool === 'eraser' }} title="Стирает штрихи, по которым провёл" onClick={() => props.editor.setTool('eraser')}>
            Ластик <span class="key">E</span>
          </button>
          <button class="menu-item" classList={{ active: props.ui.tool === 'lasso' }} title="Обвести петлёй и выделить всё внутри" onClick={() => props.editor.setTool('lasso')}>
            Лассо
          </button>
          <div class="menu-sep" />
          <div class="menu-caption">Кисти ручки</div>
          <div class="presets">
            <For each={props.ui.presets}>
              {(p, i) => (
                <button class="preset" classList={{ active: props.ui.tool === 'pen' && props.ui.preset === i() }} title={`Кисть ${i() + 1}: толщина ${p.size}`} onClick={() => props.editor.setPreset(i())}>
                  <span style={{ background: p.color, width: `${Math.min(22, 4 + p.size)}px`, height: `${Math.min(22, 4 + p.size)}px` }} />
                </button>
              )}
            </For>
          </div>
          <div class="menu-caption">{props.ui.tool === 'marker' ? 'Цвет выделителя' : 'Цвет кисти'}</div>
          <div class="draw-colors">
            <For each={props.ui.tool === 'marker' ? MARKER_COLORS : DRAW_COLORS}>
              {(c) => <button class="swatch" style={{ background: c }} onClick={() => props.editor.updatePreset({ color: c })} />}
            </For>
          </div>
          <div class="menu-caption">Толщина</div>
          <div class="draw-sizes">
            <For each={SIZES}>
              {(sz) => (
                <button class="ctx-btn" onClick={() => props.editor.updatePreset({ size: props.ui.tool === 'marker' ? sz * 2 : sz })}>
                  <span class="size-dot" style={{ width: `${Math.min(20, sz + 2)}px`, height: `${Math.min(20, sz + 2)}px` }} />
                </button>
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
