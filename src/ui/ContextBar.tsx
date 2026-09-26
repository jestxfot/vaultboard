// Панель над выделенным: цвет, вид фигуры и линии, слои, удаление. Как плавающая панель Miro.
import { createSignal, For, Show } from 'solid-js';
import type { Editor, EditorUi } from '../editor/Editor.ts';
import type { ShapeKind } from '../model/types.ts';
import { STICKY_PALETTE } from '../format/colors.ts';
import { IconArrowEnd, IconArrowStart, IconBack, IconCurve, IconElbow, IconFront, IconStraight, IconTrash } from './icons.tsx';

const LINE_COLORS = ['#1a1a1a', '#5b5b5b', '#e93147', '#ec7500', '#e0ac00', '#08b94e', '#00bfbc', '#4262ff', '#7852ee'];

const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Прямоугольник', round: 'Скруглённый', ellipse: 'Овал', diamond: 'Ромб', triangle: 'Треугольник',
  parallelogram: 'Параллелограмм', hexagon: 'Шестиугольник', star: 'Звезда', cylinder: 'Цилиндр', document: 'Документ',
};

export function ContextBar(props: { editor: Editor; ui: EditorUi; onConvertToDoc: () => void }) {
  const [colors, setColors] = createSignal(false);
  const kinds = () => props.ui.kinds;
  const only = (k: string) => kinds().length === 1 && kinds()[0] === k;
  const palette = () => (only('line') ? LINE_COLORS : STICKY_PALETTE);
  const pos = () => {
    const b = props.ui.bbox!;
    const above = b.y - 56;
    return { left: `${b.x + b.w / 2}px`, top: `${above > 8 ? above : b.y + b.h + 16}px` };
  };

  return (
    <Show when={props.ui.bbox && props.ui.selection.length && !props.ui.busy && !props.ui.editing}>
      <div class="context-bar" style={pos()} onPointerDown={(e) => e.stopPropagation()}>
        <button class="ctx-color" title="Цвет" onClick={() => setColors((v) => !v)}>
          <span class="ctx-dot" />
        </button>
        <Show when={only('shape')}>
          <select class="ctx-select" title="Вид фигуры" onChange={(e) => props.editor.setShape(e.currentTarget.value as ShapeKind)}>
            <For each={Object.entries(SHAPE_NAMES)}>{([k, name]) => <option value={k}>{name}</option>}</For>
          </select>
        </Show>
        <Show when={only('line')}>
          <span class="ctx-sep" />
          <button class="ctx-btn" title="Прямая" onClick={() => props.editor.setLinePath('straight')}><IconStraight /></button>
          <button class="ctx-btn" title="Кривая" onClick={() => props.editor.setLinePath('curve')}><IconCurve /></button>
          <button class="ctx-btn" title="Ломаная" onClick={() => props.editor.setLinePath('elbow')}><IconElbow /></button>
          <span class="ctx-sep" />
          <button class="ctx-btn" title="Стрелка в начале" onClick={() => props.editor.toggleCap('start')}><IconArrowStart /></button>
          <button class="ctx-btn" title="Стрелка в конце" onClick={() => props.editor.toggleCap('end')}><IconArrowEnd /></button>
        </Show>
        <Show when={props.ui.selection.length === 1 && ['sticky', 'text', 'card', 'shape'].includes(kinds()[0])}>
          <span class="ctx-sep" />
          <button class="ctx-text" title="Превратить в заметку .md в папке доски — её увидит и Obsidian" onClick={() => props.onConvertToDoc()}>
            В документ
          </button>
        </Show>
        <span class="ctx-sep" />
        <button class="ctx-btn" title="На передний план (Ctrl+])" onClick={() => props.editor.bringToFront()}><IconFront /></button>
        <button class="ctx-btn" title="На задний план (Ctrl+[)" onClick={() => props.editor.sendToBack()}><IconBack /></button>
        <button class="ctx-btn" title="Удалить (Delete)" onClick={() => props.editor.deleteSelection()}><IconTrash /></button>

        <Show when={colors()}>
          <div class="ctx-palette">
            <For each={palette()}>
              {(c) => <button class="swatch" style={{ background: c }} onClick={() => { props.editor.setColor(c); setColors(false); }} />}
            </For>
            <Show when={!only('sticky')}>
              <button class="swatch none" title="Без цвета" onClick={() => { props.editor.setColor(undefined); setColors(false); }} />
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
