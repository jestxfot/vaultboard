// Меню по правой кнопке: по объекту — действия с ним, по пустой доске — действия с доской.
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';

export interface MenuItem {
  label: string;
  /** Подсказка справа: горячая клавиша или значение. */
  hint?: string;
  action?: () => void;
  submenu?: MenuEntry[];
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  /** Цветной кружок слева (для выбора цвета). */
  swatch?: string;
}

export type MenuEntry = MenuItem | 'sep';

function List(props: { items: MenuEntry[]; onDone: () => void }) {
  const [open, setOpen] = createSignal<number | null>(null);
  return (
    <div class="menu">
      <For each={props.items}>
        {(item, i) =>
          item === 'sep' ? (
            <div class="menu-sep" />
          ) : (
            <div class="menu-row" onMouseEnter={() => setOpen(item.submenu ? i() : null)}>
              <button
                class="menu-item"
                classList={{ danger: item.danger, checked: item.checked }}
                disabled={item.disabled}
                onClick={() => {
                  if (item.submenu) return setOpen(i());
                  item.action?.();
                  props.onDone();
                }}
              >
                <Show when={item.swatch}>
                  <span class="menu-swatch" style={{ background: item.swatch }} />
                </Show>
                <span class="menu-label">{item.checked ? '✓ ' : ''}{item.label}</span>
                <Show when={item.hint || item.submenu}>
                  <span class="key">{item.submenu ? '›' : item.hint}</span>
                </Show>
              </button>
              <Show when={item.submenu && open() === i()}>
                <div class="submenu">
                  <List items={item.submenu!} onDone={props.onDone} />
                </div>
              </Show>
            </div>
          )
        }
      </For>
    </div>
  );
}

export function ContextMenu(props: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  let box!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });

  onMount(() => {
    // Не вылезать за край окна.
    const r = box.getBoundingClientRect();
    setPos({ x: Math.min(props.x, window.innerWidth - r.width - 8), y: Math.min(props.y, window.innerHeight - r.height - 8) });
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof PointerEvent && box.contains(e.target as Node)) return;
      props.onClose();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('wheel', props.onClose, { passive: true });
    onCleanup(() => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('wheel', props.onClose);
    });
  });

  return (
    <div class="context-menu" ref={box} style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onContextMenu={(e) => e.preventDefault()}>
      <List items={props.items} onDone={props.onClose} />
    </div>
  );
}
