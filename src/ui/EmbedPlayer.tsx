// Плеер видео прямо на доске, поверх карточки ссылки: ездит и масштабируется вместе с доской.
import { onCleanup, onMount } from 'solid-js';
import type { Rect } from '../render/geometry.ts';

export function EmbedPlayer(props: { src: string; rect: Rect; title: string; onClose: () => void }) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      props.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  return (
    <div
      class="embed-player"
      style={{ left: `${props.rect.x}px`, top: `${props.rect.y}px`, width: `${props.rect.w}px`, height: `${props.rect.h}px` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <iframe
        src={props.src}
        title={props.title}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
      />
      <button class="embed-close" title="Закрыть видео (Esc)" onClick={() => props.onClose()}>×</button>
    </div>
  );
}
