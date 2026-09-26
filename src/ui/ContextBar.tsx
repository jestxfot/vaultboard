// Панель над выделенным: цвет, вид фигуры и линии, слои, удаление. Как плавающая панель Miro.
import { createSignal, For, Show } from 'solid-js';
import type { Editor, EditorUi } from '../editor/Editor.ts';
import type { DashKind, EndCap, ShapeKind } from '../model/types.ts';
import { STICKY_PALETTE } from '../format/colors.ts';
import { IconArrowEnd, IconArrowStart, IconBack, IconCurve, IconElbow, IconFront, IconStraight, IconTrash } from './icons.tsx';

const WIDTHS = [1, 2, 3, 5, 8];
const DASHES: { kind: DashKind; title: string; svg: string }[] = [
  { kind: 'solid', title: 'Сплошная', svg: '' },
  { kind: 'dashed', title: 'Пунктир', svg: '5 3' },
  { kind: 'longdash', title: 'Длинный пунктир', svg: '10 4' },
  { kind: 'dotted', title: 'Точки', svg: '0.1 3.5' },
  { kind: 'dashdot', title: 'Штрихпунктир', svg: '6 3 0.1 3' },
];
const CAPS: { cap: EndCap; label: string }[] = [
  { cap: 'none', label: 'нет' },
  { cap: 'arrow', label: 'стрелка' },
  { cap: 'dot', label: 'точка' },
  { cap: 'diamond', label: 'ромб' },
];

const LINE_COLORS = ['#1a1a1a', '#5b5b5b', '#e93147', '#ec7500', '#e0ac00', '#08b94e', '#00bfbc', '#4262ff', '#7852ee'];

const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Прямоугольник', round: 'Скруглённый', ellipse: 'Овал', diamond: 'Ромб', triangle: 'Треугольник',
  parallelogram: 'Параллелограмм', hexagon: 'Шестиугольник', star: 'Звезда', cylinder: 'Цилиндр', document: 'Документ',
};

export function ContextBar(props: {
  editor: Editor;
  ui: EditorUi;
  onConvertToDoc: () => void;
  onOpenLink: (fromId: string, target: string) => void;
  onTrashFile: () => void;
}) {
  const [colors, setColors] = createSignal(false);
  const kinds = () => props.ui.kinds;
  const only = (k: string) => kinds().length === 1 && kinds()[0] === k;
  const palette = () => (only('line') || only('drawing') ? LINE_COLORS : STICKY_PALETTE);
  /** [[Ссылки]] в тексте выделенного стикера или текста — по ним можно открыть или создать документ. */
  const links = () => {
    const sel = props.ui.selection.length === 1 ? props.editor.selectedText() : null;
    if (!sel) return [];
    const found = [...sel.text.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1].trim());
    return [...new Set(found)].slice(0, 4).map((target) => ({ id: sel.id, target }));
  };
  const file = () => (props.ui.selection.length === 1 ? props.editor.selectedFile() : null);
  /** Текущие настройки выделенной линии — чтобы в панели были видны толщина, тип и наконечники. */
  const line = () => (props.ui.selection.length ? props.editor.selectedLine() : null);
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
          <For each={WIDTHS}>
            {(w) => (
              <button class="ctx-btn" classList={{ active: (line()?.width ?? 2) === w }} title={`Толщина ${w}`} onClick={() => props.editor.setLineWidth(w)}>
                <svg width="20" height="20"><line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width={Math.min(w, 7)} stroke-linecap="round" /></svg>
              </button>
            )}
          </For>
          <span class="ctx-sep" />
          <For each={DASHES}>
            {(d) => (
              <button class="ctx-btn" classList={{ active: (line()?.dash ?? 'solid') === d.kind }} title={d.title} onClick={() => props.editor.setLineDash(d.kind)}>
                <svg width="22" height="20"><line x1="2" y1="10" x2="20" y2="10" stroke="currentColor" stroke-width="2" stroke-dasharray={d.svg || undefined} stroke-linecap={d.kind === 'dotted' || d.kind === 'dashdot' ? 'round' : 'butt'} /></svg>
              </button>
            )}
          </For>
          <span class="ctx-sep" />
          <label class="ctx-cap" title="Наконечник в начале">
            <IconArrowStart />
            <select value={line()?.start ?? 'none'} onChange={(e) => props.editor.setCap('start', e.currentTarget.value as EndCap)}>
              <For each={CAPS}>{(c) => <option value={c.cap}>{c.label}</option>}</For>
            </select>
          </label>
          <label class="ctx-cap" title="Наконечник в конце">
            <IconArrowEnd />
            <select value={line()?.end ?? 'arrow'} onChange={(e) => props.editor.setCap('end', e.currentTarget.value as EndCap)}>
              <For each={CAPS}>{(c) => <option value={c.cap}>{c.label}</option>}</For>
            </select>
          </label>
        </Show>
        <Show when={props.ui.selection.length === 1 && ['sticky', 'text', 'card', 'shape'].includes(kinds()[0])}>
          <span class="ctx-sep" />
          <button class="ctx-text" title="Превратить в заметку .md в папке доски — её увидит и Obsidian" onClick={() => props.onConvertToDoc()}>
            В документ
          </button>
        </Show>
        <For each={links()}>
          {(l) => (
            <button class="ctx-text ctx-link" title={`Открыть заметку «${l.target}», а если её нет — создать документ рядом`} onClick={() => props.onOpenLink(l.id, l.target)}>
              ↗ {l.target.split('|').pop()}
            </button>
          )}
        </For>
        <Show when={file()}>
          <span class="ctx-sep" />
          <button class="ctx-text ctx-danger" title="Удалить сам файл с диска — в корзину базы (.trash), как в Obsidian" onClick={() => props.onTrashFile()}>
            Удалить файл
          </button>
        </Show>
        <span class="ctx-sep" />
        <button class="ctx-btn" title="На передний план (Ctrl+])" onClick={() => props.editor.bringToFront()}><IconFront /></button>
        <button class="ctx-btn" title="На задний план (Ctrl+[)" onClick={() => props.editor.sendToBack()}><IconBack /></button>
        <button class="ctx-btn" title="Убрать с доски (Delete) — файл на диске остаётся" onClick={() => props.editor.deleteSelection()}><IconTrash /></button>

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
