// Экспорт доски или выделенного в PNG, JPG, PDF — в полном качестве.
import { createMemo, createSignal, For, Show } from 'solid-js';
import { type ExportFormat, plan } from '../render/export.ts';
import type { Rect } from '../render/geometry.ts';

const SCALES = [1, 2, 3, 4];

export function ExportDialog(props: {
  board: Rect;
  selection: Rect | null;
  initialArea: 'board' | 'selection';
  onExport: (area: Rect, scale: number, format: ExportFormat, onProgress: (done: number, total: number) => void) => Promise<void>;
  onClose: () => void;
}) {
  const [format, setFormat] = createSignal<ExportFormat>('png');
  const [scale, setScale] = createSignal(2);
  const [area, setArea] = createSignal<'board' | 'selection'>(props.selection ? props.initialArea : 'board');
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal('');
  const rect = () => {
    const r = area() === 'selection' && props.selection ? props.selection : props.board;
    const pad = 40;
    return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  };
  const info = createMemo(() => plan(rect(), scale(), format()));

  const run = async () => {
    setBusy(true);
    try {
      await props.onExport(rect(), scale(), format(), (done, total) => setProgress(total > 1 ? ` ${Math.round((done / total) * 100)}%` : ''));
      props.onClose();
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <div class="quick-back" onPointerDown={() => !busy() && props.onClose()}>
      <div class="dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div class="dialog-title">Экспорт</div>
        <div class="dialog-row">
          <span>Что</span>
          <div class="seg">
            <button classList={{ active: area() === 'board' }} onClick={() => setArea('board')}>Вся доска</button>
            <button classList={{ active: area() === 'selection' }} disabled={!props.selection} onClick={() => setArea('selection')}>Выделенное</button>
          </div>
        </div>
        <div class="dialog-row">
          <span>Формат</span>
          <div class="seg">
            <For each={['png', 'jpg', 'pdf'] as ExportFormat[]}>
              {(f) => <button classList={{ active: format() === f }} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>}
            </For>
          </div>
        </div>
        <div class="dialog-row">
          <span>Чёткость</span>
          <div class="seg">
            <For each={SCALES}>{(s) => <button classList={{ active: scale() === s }} onClick={() => setScale(s)}>×{s}</button>}</For>
          </div>
        </div>
        <div class="dialog-note">
          {info().width.toLocaleString('ru-RU')} × {info().height.toLocaleString('ru-RU')} пикселей.{' '}
          {format() === 'png' && 'PNG — без потерь, каждый пиксель как есть.'}
          {format() === 'jpg' && 'JPG по своей природе сжимает с потерями — ставим максимальное качество. Без потерь — PNG или PDF.'}
          {format() === 'pdf' && 'PDF — внутри картинка, сжатая без потерь (как PNG).'}
          <Show when={info().reduced}>
            <div class="bad">
              {format() === 'jpg'
                ? `JPG браузер собирает одним холстом, а у него предел по размеру — чёткость уменьшена до ×${info().scale.toFixed(2)}. PNG и PDF пишутся по частям и такого предела не имеют.`
                : `Очень большая картинка — чёткость уменьшена до ×${info().scale.toFixed(2)}, чтобы файл остался разумного размера.`}
            </div>
          </Show>
        </div>
        <div class="dialog-actions">
          <button onClick={() => props.onClose()} disabled={busy()}>Отмена</button>
          <button class="primary" onClick={() => void run()} disabled={busy()}>{busy() ? `Собираю…${progress()}` : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  );
}
