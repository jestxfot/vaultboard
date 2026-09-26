// Просмотр фото на весь экран в полном качестве. Показывается сам оригинальный файл, без превью и пережатия.
// Масштаб 100% — пиксель в пиксель: один пиксель снимка на один пиксель экрана (с учётом масштаба Windows).
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import type { ImageItem } from '../model/types.ts';
import { vault } from '../io/vault.ts';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

export function ImageViewer(props: { items: ImageItem[]; index: number; onClose: () => void }) {
  let box!: HTMLDivElement;
  const dpr = window.devicePixelRatio;
  const [i, setI] = createSignal(props.index);
  const [nat, setNat] = createSignal<{ w: number; h: number } | null>(null);
  /** 1 — пиксель снимка на пиксель экрана. */
  const [zoom, setZoom] = createSignal(1);
  /** Сдвиг центра снимка от центра окна, CSS-пиксели. */
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [bytes, setBytes] = createSignal<number | null>(null);
  const item = () => props.items[i()];
  const name = () => item().file.slice(item().file.lastIndexOf('/') + 1);

  function fit() {
    const n = nat();
    if (!n) return;
    const r = box.getBoundingClientRect();
    setZoom(Math.min(1, ((r.width - 48) * dpr) / n.w, ((r.height - 96) * dpr) / n.h));
    setPos({ x: 0, y: 0 });
  }

  /** Зум к точке окна: пиксель снимка под курсором остаётся под курсором. */
  function zoomAt(cx: number, cy: number, next: number) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const k = z / zoom();
    const p = pos();
    setPos({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k });
    setZoom(z);
  }

  createEffect(
    on(i, () => {
      setNat(null);
      setBytes(null);
      fetch(vault.fileUrl(item().file), { method: 'HEAD' })
        .then((r) => setBytes(Number(r.headers.get('Content-Length') ?? 0) || null))
        .catch(() => undefined);
    }),
  );

  let drag: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    box.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const p = pos();
    setPos({ x: p.x + e.clientX - drag.x, y: p.y + e.clientY - drag.y });
    drag = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => (drag = null);
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2;
    zoomAt(cx, cy, zoom() * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  };

  onMount(() => {
    // Перехватываем клавиши раньше доски, пока открыт просмотр.
    const onKey = (e: KeyboardEvent) => {
      const n = props.items.length;
      if (e.code === 'Escape') props.onClose();
      else if (e.code === 'Digit1' || e.code === 'Numpad1') zoomAt(0, 0, 1);
      else if (e.code === 'Digit0' || e.code === 'Numpad0') fit();
      else if (e.code === 'ArrowRight' && n > 1) setI((i() + 1) % n);
      else if (e.code === 'ArrowLeft' && n > 1) setI((i() - 1 + n) % n);
      else if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomAt(0, 0, zoom() * 1.5);
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomAt(0, 0, zoom() / 1.5);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  return (
    <div class="viewer" ref={box} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}>
      <img
        src={vault.fileUrl(item().file)}
        alt={name()}
        draggable={false}
        onLoad={(e) => {
          setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
          fit();
        }}
        style={{
          visibility: nat() ? 'visible' : 'hidden',
          width: nat() ? `${(nat()!.w * zoom()) / dpr}px` : 'auto',
          height: nat() ? `${(nat()!.h * zoom()) / dpr}px` : 'auto',
          transform: `translate(calc(-50% + ${pos().x}px), calc(-50% + ${pos().y}px))`,
          // Крупнее 200% видны честные пиксели снимка, без размытия.
          'image-rendering': zoom() >= 2 ? 'pixelated' : 'auto',
        }}
      />
      <div class="viewer-bar" onPointerDown={(e) => e.stopPropagation()}>
        <b>{name()}</b>
        <Show when={nat()}>
          <span>{nat()!.w}×{nat()!.h}</span>
        </Show>
        <Show when={bytes()}>
          <span>{formatBytes(bytes()!)}</span>
        </Show>
        <span class="viewer-zoom">{Math.round(zoom() * 100)}%</span>
        <Show when={props.items.length > 1}>
          <span>{i() + 1} из {props.items.length}</span>
        </Show>
        <span class="viewer-hint">1 — пиксель в пиксель · 0 — вписать · колесо — зум · ←/→ — соседние · Esc — закрыть</span>
        <button onClick={() => props.onClose()}>×</button>
      </div>
    </div>
  );
}
