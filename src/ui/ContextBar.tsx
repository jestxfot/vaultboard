// Панель над выделенным, как плавающая панель Miro: заливка, текст (шрифт, размер, жирный, курсив,
// выравнивание, цвет), граница (цвет и толщина числом), вид фигуры и линии, стиль, слои, удаление.
// Пока идёт набор текста, панель остаётся: «Ж» и «К» тогда оформляют выделенный кусок текста.
import { createSignal, For, type JSX, Show } from 'solid-js';
import type { Editor, EditorUi } from '../editor/Editor.ts';
import type { Align, DashKind, EndCap, FontKind, ShapeKind } from '../model/types.ts';
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
const FONT_NAMES: Record<FontKind, string> = { sans: 'Обычный', serif: 'С засечками', mono: 'Моноширинный', hand: 'Рукописный' };
const INK_COLORS = ['#1a1a1a', '#5b5b5b', '#ffffff', '#e93147', '#ec7500', '#e0ac00', '#08b94e', '#00bfbc', '#4262ff', '#7852ee', '#b04fc8', '#8a5a2b'];
const LINE_COLORS = ['#1a1a1a', '#5b5b5b', '#e93147', '#ec7500', '#e0ac00', '#08b94e', '#00bfbc', '#4262ff', '#7852ee'];

const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Прямоугольник', round: 'Скруглённый', ellipse: 'Овал', diamond: 'Ромб', triangle: 'Треугольник',
  parallelogram: 'Параллелограмм', hexagon: 'Шестиугольник', star: 'Звезда', cylinder: 'Цилиндр', document: 'Документ',
};

const TEXT_KINDS = ['sticky', 'text', 'card', 'shape'];
const BORDER_KINDS = ['sticky', 'text', 'card', 'shape', 'frame', 'doc', 'file', 'link'];

type Pop = 'fill' | 'text' | 'border' | null;

/** Числовое поле: меняется по Enter или при уходе с поля. Пусто — «по умолчанию». */
function NumberField(props: { value: number | undefined; placeholder: string; title: string; min?: number; onChange: (v: number | undefined) => void }) {
  return (
    <input
      class="ctx-num"
      type="number"
      min={props.min ?? 0}
      step="1"
      title={props.title}
      placeholder={props.placeholder}
      value={props.value ?? ''}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      onChange={(e) => {
        const raw = e.currentTarget.value.trim().replace(',', '.');
        const n = Number(raw);
        props.onChange(raw === '' || !Number.isFinite(n) ? undefined : Math.max(props.min ?? 0, n));
      }}
    />
  );
}

function Swatches(props: { colors: readonly string[]; none?: boolean; onPick: (c: string | undefined) => void }) {
  return (
    <div class="ctx-palette">
      <For each={props.colors}>{(c) => <button class="swatch" style={{ background: c }} onClick={() => props.onPick(c)} />}</For>
      <Show when={props.none}>
        <button class="swatch none" title="По умолчанию" onClick={() => props.onPick(undefined)} />
      </Show>
    </div>
  );
}

export function ContextBar(props: {
  editor: Editor;
  ui: EditorUi;
  onConvertToDoc: () => void;
  onOpenLink: (fromId: string, target: string) => void;
  onTrashFile: () => void;
  onOpenStyles: () => void;
}) {
  const [pop, setPop] = createSignal<Pop>(null);
  const toggle = (p: Pop) => setPop((cur) => (cur === p ? null : p));
  const kinds = () => props.ui.kinds;
  const only = (k: string) => kinds().length === 1 && kinds()[0] === k;
  const anyOf = (list: string[]) => kinds().some((k) => list.includes(k));
  const look = () => (props.ui, props.editor.selectedLook());
  const line = () => (props.ui, props.ui.selection.length ? props.editor.selectedLine() : null);
  const links = () => {
    const sel = props.ui.selection.length === 1 ? props.editor.selectedText() : null;
    if (!sel) return [];
    const found = [...sel.text.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => m[1].trim());
    return [...new Set(found)].slice(0, 4).map((target) => ({ id: sel.id, target }));
  };
  const file = () => (props.ui.selection.length === 1 ? props.editor.selectedFile() : null);
  let bar: HTMLDivElement | undefined;
  /**
   * Где стоит панель: над видимой частью выделенного и всегда целиком в окне.
   * Иначе у длинной линии центр уходит за экран, а с ним и панель.
   */
  const pos = () => {
    const b = props.ui.bbox!;
    const stage = bar?.parentElement;
    const W = stage?.clientWidth ?? window.innerWidth, H = stage?.clientHeight ?? window.innerHeight;
    const bw = bar?.offsetWidth ?? 320, bh = bar?.offsetHeight ?? 44;
    const vx0 = Math.max(b.x, 0), vx1 = Math.min(b.x + b.w, W);
    const vy0 = Math.max(b.y, 0), vy1 = Math.min(b.y + b.h, H);
    const cx = vx1 > vx0 ? (vx0 + vx1) / 2 : W / 2;
    const left = Math.min(Math.max(8, cx - bw / 2), Math.max(8, W - bw - 8));
    let top = vy0 - bh - 14;
    if (top < 8) top = vy1 + 16;
    if (top > H - bh - 8) top = Math.max(8, Math.min(vy0 + 8, H - bh - 8));
    return { left: `${left}px`, top: `${top}px` };
  };
  const pick = (fn: () => void) => {
    fn();
    setPop(null);
  };
  // Кнопки панели не должны забирать фокус у поля ввода, иначе набор текста закроется.
  const keepFocus: JSX.EventHandler<HTMLDivElement, MouseEvent> = (e) => {
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) e.preventDefault();
  };

  return (
    <Show when={props.ui.bbox && props.ui.selection.length && !props.ui.busy}>
      <div class="context-bar" ref={bar} style={pos()} onPointerDown={(e) => e.stopPropagation()} onMouseDown={keepFocus}>
        <Show when={!props.ui.editing}>
          <button class="ctx-color" title="Заливка / цвет" onClick={() => toggle('fill')}>
            <span class="ctx-dot" />
          </button>
        </Show>

        <Show when={anyOf(TEXT_KINDS)}>
          <span class="ctx-sep" />
          <Show when={!props.ui.editing}>
            <select class="ctx-select" title="Шрифт" value={look()?.font ?? 'sans'} onChange={(e) => props.editor.setLook({ font: e.currentTarget.value as FontKind })}>
              <For each={Object.entries(FONT_NAMES)}>{([k, name]) => <option value={k}>{name}</option>}</For>
            </select>
            <NumberField
              value={look()?.fontSize}
              min={4}
              placeholder={anyOf(['sticky', 'shape']) ? 'авто' : '18'}
              title="Размер шрифта — любое число; пусто — подбирать под размер (стикер, фигура)"
              onChange={(v) => props.editor.setLook({ fontSize: v })}
            />
          </Show>
          <button class="ctx-btn ctx-b" classList={{ active: !!look()?.bold }} title="Жирный (Ctrl+B)" onClick={() => props.editor.toggleFormat('bold')}>Ж</button>
          <button class="ctx-btn ctx-i" classList={{ active: !!look()?.italic }} title="Курсив (Ctrl+I)" onClick={() => props.editor.toggleFormat('italic')}>К</button>
          <Show when={!props.ui.editing}>
            <For each={[['left', '⇤'], ['center', '↔'], ['right', '⇥']] as [Align, string][]}>
              {([a, icon]) => (
                <button class="ctx-btn" classList={{ active: (look()?.align ?? (anyOf(['sticky', 'shape']) ? 'center' : 'left')) === a }} title={a === 'left' ? 'По левому краю' : a === 'center' ? 'По центру' : 'По правому краю'} onClick={() => props.editor.setLook({ align: a })}>
                  {icon}
                </button>
              )}
            </For>
            <button class="ctx-btn" title="Цвет текста" onClick={() => toggle('text')}>
              <span class="ctx-textcolor" style={{ 'border-color': look()?.textColor ?? '#1f1f1f' }}>A</span>
            </button>
          </Show>
        </Show>

        <Show when={!props.ui.editing && anyOf(BORDER_KINDS) && !anyOf(['line', 'drawing', 'image'])}>
          <span class="ctx-sep" />
          <button class="ctx-btn" title="Цвет границы" onClick={() => toggle('border')}>
            <span class="ctx-border" style={{ 'border-color': look()?.borderColor ?? '#1f1f1f' }} />
          </button>
          <NumberField value={look()?.borderWidth} placeholder="гр." title="Толщина границы — любое число, 0 — без границы" onChange={(v) => props.editor.setLook({ borderWidth: v })} />
        </Show>

        <Show when={!props.ui.editing && only('shape')}>
          <select class="ctx-select" title="Вид фигуры" onChange={(e) => props.editor.setShape(e.currentTarget.value as ShapeKind)}>
            <For each={Object.entries(SHAPE_NAMES)}>{([k, name]) => <option value={k}>{name}</option>}</For>
          </select>
        </Show>

        <Show when={!props.ui.editing && only('line')}>
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
          <NumberField value={line()?.width} min={0.5} placeholder="2" title="Толщина линии — любое число" onChange={(v) => props.editor.setLineWidth(v ?? 2)} />
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

        <Show when={!props.ui.editing}>
          <span class="ctx-sep" />
          <select
            class="ctx-select"
            title="Стиль доски: меняешь стиль в одном месте — меняются все объекты с ним (Alt+1…9)"
            value={look()?.hasStyle ? look()!.style : ''}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v === '__manage') props.onOpenStyles();
              else props.editor.applyStyle(v || null);
            }}
          >
            <option value="">без стиля</option>
            <For each={props.editor.styleNames()}>{(n) => <option value={n}>{n}</option>}</For>
            <option value="__manage">Стили доски…</option>
          </select>

          <Show when={props.ui.selection.length === 1 && TEXT_KINDS.includes(kinds()[0])}>
            <button class="ctx-text" title="Превратить в заметку .md в папке доски — её увидит и Obsidian" onClick={() => props.onConvertToDoc()}>В документ</button>
          </Show>
          <For each={links()}>
            {(l) => (
              <button class="ctx-text ctx-link" title={`Открыть заметку «${l.target}», а если её нет — создать документ рядом`} onClick={() => props.onOpenLink(l.id, l.target)}>
                ↗ {l.target.split('|').pop()}
              </button>
            )}
          </For>
          <Show when={file()}>
            <button class="ctx-text ctx-danger" title="Удалить сам файл с диска — в корзину базы (.trash), как в Obsidian" onClick={() => props.onTrashFile()}>Удалить файл</button>
          </Show>
          <span class="ctx-sep" />
          <button class="ctx-btn" title="На передний план (Ctrl+])" onClick={() => props.editor.bringToFront()}><IconFront /></button>
          <button class="ctx-btn" title="На задний план (Ctrl+[)" onClick={() => props.editor.sendToBack()}><IconBack /></button>
          <button class="ctx-btn" title="Убрать с доски (Delete) — файл на диске остаётся" onClick={() => props.editor.deleteSelection()}><IconTrash /></button>
        </Show>

        <Show when={pop() === 'fill'}>
          <Swatches colors={only('line') || only('drawing') ? LINE_COLORS : STICKY_PALETTE} none={!only('sticky')} onPick={(c) => pick(() => props.editor.setColor(c))} />
        </Show>
        <Show when={pop() === 'text'}>
          <Swatches colors={INK_COLORS} none onPick={(c) => pick(() => props.editor.setLook({ textColor: c }))} />
        </Show>
        <Show when={pop() === 'border'}>
          <Swatches colors={INK_COLORS} none onPick={(c) => pick(() => props.editor.setLook({ borderColor: c }))} />
        </Show>
      </div>
    </Show>
  );
}
