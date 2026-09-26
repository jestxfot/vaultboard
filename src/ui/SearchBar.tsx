// Строка поиска по доске (Ctrl+F). Под ней сразу — список всего найденного: что за объект и где совпало,
// найденное слово подсвечено. Щелчок по строке или стрелки ↑↓ — перейти к объекту; Enter — к следующему,
// Shift+Enter — к предыдущему, Esc — закрыть. Совпадения подсвечиваются и на доске; поиск пересчитывается,
// когда доска меняется.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { SearchHit } from '../editor/search.ts';

/** Разбить подпись на куски: совпадения с запросом — отдельно, чтобы подсветить. */
function pieces(label: string, q: string): { text: string; hit: boolean }[] {
  if (!q) return [{ text: label, hit: false }];
  const low = label.toLowerCase().replace(/ё/g, 'е');
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) {
    if (at > pos) out.push({ text: label.slice(pos, at), hit: false });
    out.push({ text: label.slice(at, at + q.length), hit: true });
    pos = at + q.length;
  }
  if (pos < label.length) out.push({ text: label.slice(pos), hit: false });
  return out;
}

export function SearchBar(props: {
  /** Найти на доске: найденное и запрос, по которому нашлось (может быть в другой раскладке). */
  search: (query: string) => { hits: SearchHit[]; matched: string };
  /** Меняется после каждой правки доски — тогда поиск пересчитывается. */
  version: unknown;
  /** Показать найденное: подсветка всех и текущего. */
  onHighlight: (ids: string[], current: string | null) => void;
  /** Подвести объект к центру экрана. */
  onReveal: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal('');
  const [index, setIndex] = createSignal(0);
  let input!: HTMLInputElement;
  let list: HTMLDivElement | undefined;

  const result = createMemo(() => (props.version, props.search(query())));
  const hits = () => result().hits;
  const current = () => hits()[Math.min(index(), hits().length - 1)] ?? null;

  createEffect(() => props.onHighlight(hits().map((h) => h.id), current()?.id ?? null));
  // Новый запрос — сразу к первому совпадению.
  createEffect(on(query, () => {
    setIndex(0);
    const first = hits()[0];
    if (first) props.onReveal(first.id);
  }, { defer: true }));
  onCleanup(() => props.onHighlight([], null));

  const go = (i: number) => {
    const n = hits().length;
    if (!n) return;
    const next = ((i % n) + n) % n;
    setIndex(next);
    props.onReveal(hits()[next].id);
    // Текущая строка списка — всегда видна.
    queueMicrotask(() => list?.querySelector('.sb-row.active')?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div class="search-wrap" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div class="search-bar">
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
        <input
          ref={(el) => { input = el; queueMicrotask(() => el.focus()); }}
          placeholder="Найти на доске…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); go(index() + (e.shiftKey ? -1 : 1)); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); go(index() + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); go(index() - 1); }
            else if (e.key === 'Escape') { e.preventDefault(); props.onClose(); }
            else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') { e.preventDefault(); input.select(); }
          }}
        />
        <Show when={query().trim()}>
          <span class="sb-count" classList={{ none: !hits().length }}>
            {hits().length ? `${index() + 1} из ${hits().length}` : 'ничего'}
          </span>
        </Show>
        <button title="Предыдущее (Shift+Enter, ↑)" disabled={!hits().length} onClick={() => go(index() - 1)}>↑</button>
        <button title="Следующее (Enter, ↓)" disabled={!hits().length} onClick={() => go(index() + 1)}>↓</button>
        <button title="Закрыть (Esc)" onClick={() => props.onClose()}>×</button>
      </div>
      <Show when={hits().length}>
        <div class="sb-list" ref={list}>
          <For each={hits()}>
            {(h, i) => (
              <button class="sb-row" classList={{ active: i() === index() }} onClick={() => go(i())}>
                <span class="sb-kind">{h.kind}</span>
                <span class="sb-text">
                  <For each={pieces(h.label, result().matched)}>{(p) => (p.hit ? <mark>{p.text}</mark> : <>{p.text}</>)}</For>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
