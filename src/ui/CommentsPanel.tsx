// Список обсуждений доски: фильтр по статусам, «Скрыть завершённые», щелчок — перелететь к булавке.
import { createSignal, For, Show } from 'solid-js';
import type { Comments } from '../editor/Comments.ts';
import type { CommentThread } from '../model/types.ts';
import { isDone, pinColor, pinPath, pinShape, STATUSES, statusOf, timeAgo } from '../model/comments.ts';

export function CommentsPanel(props: {
  comments: Comments;
  version: unknown;
  hideDone: boolean;
  openId: string | null;
  onHideDone: (hide: boolean) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  /** Пустой набор — все статусы. */
  const [filter, setFilter] = createSignal<Set<string>>(new Set());
  const [query, setQuery] = createSignal('');

  const all = (): readonly CommentThread[] => (props.version, props.comments.threads);
  const counts = () => {
    const c = new Map<string, number>();
    for (const t of all()) c.set(statusOf(t).id, (c.get(statusOf(t).id) ?? 0) + 1);
    return c;
  };
  const list = () => {
    const q = query().trim().toLowerCase();
    return all()
      .filter((t) => !(props.hideDone && isDone(t)))
      .filter((t) => !filter().size || filter().has(statusOf(t).id))
      .filter((t) => !q || t.messages.some((m) => m.text.toLowerCase().includes(q) || m.author.toLowerCase().includes(q)))
      .slice()
      // Свежие сверху: по времени последнего сообщения.
      .sort((a, b) => (b.messages.at(-1)?.time ?? '').localeCompare(a.messages.at(-1)?.time ?? ''));
  };
  const toggle = (id: string) => {
    const next = new Set(filter());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFilter(next);
  };
  const doneCount = () => all().filter(isDone).length;

  return (
    <aside class="comments-panel" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <header class="layers-head">
        <b>Комментарии</b>
        <span class="layers-sub">{all().length} · Shift+C</span>
        <button class="doc-btn" title="Закрыть" onClick={() => props.onClose()}>×</button>
      </header>
      <div class="cp-tools">
        <input class="cp-search" placeholder="Найти в комментариях…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <label class="cp-hide" title="Прятать завершённые и на доске, и в этом списке">
          <input type="checkbox" checked={props.hideDone} onChange={(e) => props.onHideDone(e.currentTarget.checked)} />
          Скрыть завершённые ({doneCount()})
        </label>
        <div class="cp-filters">
          <For each={STATUSES}>
            {(s) => (
              <button class="cp-chip" classList={{ active: filter().has(s.id) }} onClick={() => toggle(s.id)} title={`Показать только «${s.name}» (можно несколько)`}>
                <svg width="12" height="12" viewBox="0 0 24 24"><path d={pinPath(s.shape)} fill={s.color} /></svg>
                {s.name} <span>{counts().get(s.id) ?? 0}</span>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="cp-list">
        <Show when={list().length} fallback={<div class="empty">{all().length ? 'Ничего не подходит под фильтр.' : 'Комментариев пока нет. Нажми C и щёлкни по доске или по объекту.'}</div>}>
          <For each={list()}>
            {(t) => (
              <button class="cp-row" classList={{ active: props.openId === t.id, done: isDone(t) }} onClick={() => props.onOpen(t.id)}>
                <svg width="18" height="18" viewBox="0 0 24 24" class="cp-pin"><path d={pinPath(pinShape(t))} fill={pinColor(t)} /></svg>
                <span class="cp-main">
                  <span class="cp-meta">
                    <b>{t.messages[0]?.author}</b> · {statusOf(t).name} · {timeAgo(t.messages.at(-1)?.time ?? '')}
                  </span>
                  <span class="cp-text">{preview(t.messages[0]?.text ?? '')}</span>
                  <Show when={t.messages.length > 1}>
                    <span class="cp-replies">{t.messages.length - 1} {plural(t.messages.length - 1, 'ответ', 'ответа', 'ответов')}</span>
                  </Show>
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
}

/** Текст для списка: без значков markdown, ссылки — просто именами. */
function preview(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target.split('/').pop()!)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`~=]{1,3}|^#+\s|^>\s?|^[-+]\s(?:\[.\]\s)?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
