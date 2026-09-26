// Окно обсуждения рядом с булавкой: сообщения деревом (ответ на конкретное сообщение — ветка),
// текст — тот же markdown, что в документах ([[ссылки]] на заметки базы открываются), реакции,
// статус, цвет и форма булавки. Новое обсуждение — то же окно без сообщений.
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import type { Comments } from '../editor/Comments.ts';
import type { Markdown } from '../format/markdown.ts';
import type { FileIndex } from '../io/files.ts';
import type { CommentMessage, CommentThread, PinShape } from '../model/types.ts';
import { PIN_COLORS, PIN_SHAPES, pinColor, pinPath, pinShape, REACTIONS, STATUSES, statusOf, timeAgo } from '../model/comments.ts';

/** Глубже этого ветки не сдвигаются вправо — иначе на узком окне текст уедет в столбик. */
const MAX_DEPTH = 4;

function PinIcon(props: { shape: PinShape; color: string; size?: number }) {
  return (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" class="pin-icon">
      <path d={pinPath(props.shape)} fill={props.color} stroke="#fff" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  );
}

/** Цвет кружка автора — всегда один и тот же для одного имени. */
function authorColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 48%)`;
}

export function ThreadPopover(props: {
  comments: Comments;
  /** Открытое обсуждение или null — новое (тогда задан `draftAt`). */
  threadId: string | null;
  draftAt: { x: number; y: number } | null;
  /** Точка булавки на экране. */
  anchor: { x: number; y: number };
  author: string;
  markdown: Markdown;
  /** Заметки базы: подсказка после [[ и проверка, что ссылка ведёт на существующую заметку. */
  files: FileIndex;
  /** Откуда считаются [[ссылки]] — путь доски. */
  from: string;
  /** Меняется после каждой правки доски: окно перечитывает обсуждение. */
  version: unknown;
  onCreated: (id: string) => void;
  onNavigate: (target: string, resolved: string | null) => void;
  onClose: () => void;
}) {
  const thread = (): CommentThread | undefined => (props.version, props.threadId ? props.comments.get(props.threadId) : undefined);
  const [replyTo, setReplyTo] = createSignal<CommentMessage | null>(null);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [picker, setPicker] = createSignal<string | null>(null);
  const [lookOpen, setLookOpen] = createSignal(false);
  const [draftStatus, setDraftStatus] = createSignal('open');
  const [error, setError] = createSignal('');
  /** Подсказка заметок после [[: для какого поля, с какого места заменять, что нашлось, что выбрано. */
  const [suggest, setSuggest] = createSignal<{ el: HTMLTextAreaElement; start: number; items: string[]; index: number } | null>(null);
  let input!: HTMLTextAreaElement;
  let editEl: HTMLTextAreaElement | undefined;

  /** Как записать ссылку: коротко по имени, если оно однозначно, иначе с папками — как делает Obsidian. */
  const linkText = (path: string): string => {
    const noExt = path.replace(/\.md$/i, '');
    const name = noExt.split('/').pop()!;
    return props.files.resolve(name, props.from) === path ? name : noExt;
  };

  /** Курсор стоит после незакрытого [[ — показать подходящие заметки. */
  const updateSuggest = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart);
    const m = /\[\[([^\]\n|#^]*)$/.exec(before);
    if (!m) {
      if (suggest()?.el === el) setSuggest(null);
      return;
    }
    setSuggest({ el, start: before.length - m[1].length, items: props.files.search(m[1], 8), index: 0 });
  };

  const pickSuggest = (path: string) => {
    const s = suggest();
    if (!s) return;
    const { el, start } = s;
    const end = el.selectionStart;
    const rest = el.value.slice(end);
    const close = rest.startsWith(']]') ? '' : ']]';
    const text = linkText(path);
    el.value = el.value.slice(0, start) + text + close + rest;
    const caret = start + text.length + 2;
    el.setSelectionRange(caret, caret);
    setSuggest(null);
    setError('');
    autosize(el);
    el.focus();
    el.dispatchEvent(new Event('input'));
  };

  /** Ссылки на заметки, которых в базе нет. Такие комментарии не отправляем: ссылка вела бы в пустоту. */
  const missingLinks = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
      const target = m[1].split('|')[0].trim();
      if (!props.files.resolve(target, props.from) && !out.includes(target)) out.push(target);
    }
    return out;
  };

  /** Проверить ссылки; всё в порядке — true. */
  const checkLinks = (text: string): boolean => {
    const missing = missingLinks(text);
    if (!missing.length) return true;
    setError(`Нет такой заметки: ${missing.map((m) => `«${m}»`).join(', ')}. Ссылаться можно только на существующие — начни с [[ и выбери из списка.`);
    return false;
  };

  const children = createMemo(() => {
    const map = new Map<string, CommentMessage[]>();
    const t = thread();
    if (!t) return map;
    const ids = new Set(t.messages.map((m) => m.id));
    for (const m of t.messages.slice(1)) {
      // Ответ на сообщение, которого уже нет, — показываем как ответ на всё обсуждение.
      const key = m.parent && ids.has(m.parent) ? m.parent : t.messages[0].id;
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return map;
  });

  const send = () => {
    const text = input.value.trim();
    if (!text || !checkLinks(text)) return;
    setError('');
    if (!props.threadId && props.draftAt) {
      const id = props.comments.create(props.draftAt, text, props.author, draftStatus());
      props.onCreated(id);
    } else if (props.threadId) {
      props.comments.reply(props.threadId, text, props.author, replyTo()?.id);
    }
    input.value = '';
    autosize(input);
    setReplyTo(null);
  };

  const onKey = (e: KeyboardEvent, submit: () => void, cancel: () => void) => {
    e.stopPropagation();
    // Открыт список заметок после [[ — стрелки ходят по нему, Enter/Tab выбирают, Esc закрывает.
    const s = suggest();
    if (s && s.el === e.currentTarget) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = s.items.length;
        if (n) setSuggest({ ...s, index: (s.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && s.items.length) {
        e.preventDefault();
        pickSuggest(s.items[s.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyB' || e.code === 'KeyI')) {
      e.preventDefault();
      wrap(e.currentTarget as HTMLTextAreaElement, e.code === 'KeyB' ? '**' : '*');
    }
  };

  // Позиция: справа от булавки, но целиком в окне.
  const style = (): JSX.CSSProperties => {
    const w = 380, margin = 10;
    let x = props.anchor.x + 26, y = props.anchor.y - 30;
    if (x + w > window.innerWidth - margin) x = Math.max(margin, props.anchor.x - w - 26);
    y = Math.max(margin, Math.min(y, window.innerHeight - 320));
    return { left: `${x}px`, top: `${y}px`, width: `${w}px` };
  };

  const onBodyClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('wikilink')) props.onNavigate(a.getAttribute('data-target') ?? '', a.getAttribute('data-path') || null);
    else if (a.getAttribute('href')) window.open(a.getAttribute('href')!, '_blank', 'noopener');
  };

  /**
   * Подсветка ссылок прямо в поле ввода. В textarea нельзя раскрасить часть текста, поэтому под ней лежит
   * копия текста, где [[ссылки]] закрашены плашкой (есть заметка — синей, нет — красной), а сама textarea прозрачна.
   */
  const highlight = (text: string): string => {
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    let out = '', last = 0;
    for (const m of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
      out += esc(text.slice(last, m.index));
      const ok = !!props.files.resolve(m[1].split('|')[0].trim(), props.from);
      out += `<mark class="${ok ? 'ok' : 'bad'}">${esc(m[0])}</mark>`;
      last = m.index! + m[0].length;
    }
    // Лишний перевод строки — чтобы копия не была короче поля, когда текст кончается переносом.
    return `${out}${esc(text.slice(last))}\n`;
  };

  /** Подключить подсветку к полю: копия текста — соседний элемент перед ним. */
  const withBackdrop = (el: HTMLTextAreaElement) => {
    const back = el.previousElementSibling as HTMLDivElement | null;
    if (!back) return;
    const paint = () => {
      back.innerHTML = highlight(el.value);
      back.scrollTop = el.scrollTop;
    };
    for (const ev of ['input', 'keyup', 'scroll', 'focus']) el.addEventListener(ev, paint);
    queueMicrotask(paint);
  };

  /** Список заметок под полем, в котором набирают [[. */
  const Suggest = (p: { el: () => HTMLTextAreaElement | undefined }): JSX.Element => (
    <Show when={suggest() && suggest()!.el === p.el() ? suggest() : null}>
      {(s) => (
        <div class="cm-suggest">
          <Show when={s().items.length} fallback={<div class="cm-suggest-empty">Нет такой заметки в базе</div>}>
            <For each={s().items}>
              {(path, i) => (
                <button
                  class="cm-suggest-item"
                  classList={{ active: i() === s().index }}
                  onPointerDown={(e) => { e.preventDefault(); pickSuggest(path); }}
                >
                  <b>{path.replace(/\.md$/i, '').split('/').pop()}</b>
                  <span>{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      )}
    </Show>
  );

  const Message = (p: { m: CommentMessage; depth: number; first: boolean }): JSX.Element => {
    const t = () => thread()!;
    const mine = () => p.m.author === props.author;
    return (
      <div class="cm-msg" classList={{ first: p.first }} style={{ 'margin-left': `${Math.min(p.depth, MAX_DEPTH) * 16}px` }}>
        <div class="cm-head">
          <span class="cm-avatar" style={{ background: authorColor(p.m.author) }}>{p.m.author.charAt(0).toUpperCase()}</span>
          <b>{p.m.author}</b>
          <span class="cm-time" title={new Date(p.m.time).toLocaleString('ru-RU')}>{timeAgo(p.m.time)}{p.m.edited ? ' · изменено' : ''}</span>
          <span class="cm-actions">
            <button title="Ответить на это сообщение" onClick={() => { setReplyTo(p.m); input?.focus(); }}>↩</button>
            <button title="Реакция" onClick={() => setPicker(picker() === p.m.id ? null : p.m.id)}>☺</button>
            <Show when={mine()}>
              <button title="Изменить" onClick={() => setEditing(p.m.id)}>✎</button>
            </Show>
            <button
              title={p.first ? 'Удалить всё обсуждение' : 'Удалить сообщение вместе с ответами на него'}
              onClick={() => {
                const n = props.comments.branch(t(), p.m.id).size;
                const ask = p.first ? 'Удалить всё обсуждение?' : n > 1 ? `Удалить сообщение и ответы на него (${n - 1})?` : 'Удалить сообщение?';
                if (window.confirm(ask)) {
                  props.comments.deleteMessage(t().id, p.m.id);
                  if (p.first) props.onClose();
                }
              }}
            >
              🗑
            </button>
          </span>
        </div>
        <Show
          when={editing() === p.m.id}
          fallback={<div class="cm-body vbmd" onClick={onBodyClick} innerHTML={props.markdown.render(p.m.text, { from: props.from })} />}
        >
          <div class="cm-field">
          <div class="cm-backdrop" />
          <textarea
            class="cm-input"
            ref={(el) => { editEl = el; withBackdrop(el); queueMicrotask(() => { autosize(el); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }}
            value={p.m.text}
            onInput={(e) => { autosize(e.currentTarget); updateSuggest(e.currentTarget); }}
            onClick={(e) => updateSuggest(e.currentTarget)}
            onKeyDown={(e) => onKey(e, () => {
              const text = (e.currentTarget as HTMLTextAreaElement).value.trim() || p.m.text;
              if (!checkLinks(text)) return;
              setError('');
              props.comments.editMessage(t().id, p.m.id, text);
              setEditing(null);
            }, () => setEditing(null))}
          />
          </div>
          <Suggest el={() => editEl} />
          <div class="cm-hint">Enter — сохранить, Esc — отмена</div>
        </Show>
        <Show when={Object.keys(p.m.reactions ?? {}).length || picker() === p.m.id}>
          <div class="cm-reactions">
            <For each={Object.entries(p.m.reactions ?? {})}>
              {([emoji, who]) => (
                <button class="cm-reaction" classList={{ mine: who.includes(props.author) }} title={who.join(', ')} onClick={() => props.comments.toggleReaction(t().id, p.m.id, emoji, props.author)}>
                  {emoji} {who.length}
                </button>
              )}
            </For>
            <Show when={picker() === p.m.id}>
              <span class="cm-picker">
                <For each={REACTIONS}>
                  {(emoji) => <button onClick={() => { props.comments.toggleReaction(t().id, p.m.id, emoji, props.author); setPicker(null); }}>{emoji}</button>}
                </For>
              </span>
            </Show>
          </div>
        </Show>
        <For each={children().get(p.m.id) ?? []}>{(c) => <Message m={c} depth={p.depth + 1} first={false} />}</For>
      </div>
    );
  };

  return (
    <div class="thread-popover" style={style()} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header class="cm-top">
        <Show
          when={thread()}
          fallback={
            <div class="cm-statuses">
              <For each={STATUSES.filter((s) => !s.done)}>
                {(s) => (
                  <button class="cm-status" classList={{ active: draftStatus() === s.id }} onClick={() => setDraftStatus(s.id)} title={s.name}>
                    <PinIcon shape={s.shape} color={s.color} /> {s.name}
                  </button>
                )}
              </For>
            </div>
          }
        >
          {(t) => (
            <>
              <select
                class="cm-status-select"
                value={t().status ?? 'open'}
                style={{ color: statusOf(t()).color }}
                onChange={(e) => props.comments.setStatus(t().id, e.currentTarget.value)}
                title="Статус обсуждения"
              >
                <For each={STATUSES}>{(s) => <option value={s.id}>{s.name}</option>}</For>
              </select>
              <button class="cm-look" title="Цвет и форма булавки" onClick={() => setLookOpen(!lookOpen())}>
                <PinIcon shape={pinShape(t())} color={pinColor(t())} size={18} />
              </button>
              <span class="cm-spacer" />
              <Show
                when={statusOf(t()).done}
                fallback={<button class="cm-done" onClick={() => props.comments.setStatus(t().id, 'done')} title="Отметить завершённым — оно спрячется кнопкой «Скрыть завершённые»">✓ Завершить</button>}
              >
                <button class="cm-done" onClick={() => props.comments.setStatus(t().id, 'open')}>↺ Открыть снова</button>
              </Show>
            </>
          )}
        </Show>
        <button class="doc-btn" title="Закрыть (Esc)" onClick={() => props.onClose()}>×</button>
      </header>
      <Show when={lookOpen() && thread()}>
        {(t) => (
          <div class="cm-lookpanel">
            <div class="cm-row">
              <For each={PIN_COLORS}>
                {(c) => <button class="swatch" classList={{ active: t().color === c }} style={{ background: c }} title={c} onClick={() => props.comments.setColor(t().id, c)} />}
              </For>
              <label class="swatch custom" title="Свой цвет">
                <input type="color" value={pinColor(t())} onChange={(e) => props.comments.setColor(t().id, e.currentTarget.value)} />
              </label>
            </div>
            <div class="cm-row">
              <For each={PIN_SHAPES}>
                {(s) => (
                  <button class="cm-shape" classList={{ active: pinShape(t()) === s.shape }} title={s.name} onClick={() => props.comments.setShape(t().id, s.shape)}>
                    <PinIcon shape={s.shape} color={pinColor(t())} size={18} />
                  </button>
                )}
              </For>
            </div>
            <Show when={t().color || t().shape}>
              <button class="cm-reset" onClick={() => { props.comments.setColor(t().id, null); props.comments.setShape(t().id, null); }}>Как у статуса</button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={thread()}>
        {(t) => (
          <div class="cm-list">
            <Message m={t().messages[0]} depth={0} first />
          </div>
        )}
      </Show>
      <div class="cm-compose">
        <Show when={replyTo()}>
          {(r) => (
            <div class="cm-replyto">
              ↩ в ответ <b>{r().author}</b>: {r().text.slice(0, 60)}
              <button onClick={() => setReplyTo(null)}>×</button>
            </div>
          )}
        </Show>
        <div class="cm-field">
        <div class="cm-backdrop" />
        <textarea
          ref={(el) => { input = el; withBackdrop(el); queueMicrotask(() => { autosize(el); el.focus(); }); }}
          class="cm-input"
          rows={1}
          placeholder={thread() ? 'Ответить… (markdown, [[заметка]])' : 'Комментарий… (markdown, [[заметка]])'}
          onInput={(e) => { autosize(e.currentTarget); updateSuggest(e.currentTarget); setError(''); }}
          onClick={(e) => updateSuggest(e.currentTarget)}
          onKeyDown={(e) => onKey(e, send, () => { if (replyTo()) setReplyTo(null); else props.onClose(); })}
        />
        </div>
        <Suggest el={() => input} />
        <Show when={error()}>
          <div class="cm-error">{error()}</div>
        </Show>
        <div class="cm-hint">Enter — отправить · Shift+Enter — новая строка · Ctrl+B / Ctrl+I</div>
      </div>
    </div>
  );
}

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`;
  // Полоса прокрутки — только когда текст правда не влез.
  el.style.overflowY = el.scrollHeight + 2 > 240 ? 'auto' : 'hidden';
}

/** Обернуть выделенное в textarea значками markdown (Ctrl+B — **, Ctrl+I — *). */
function wrap(el: HTMLTextAreaElement, mark: string): void {
  const { selectionStart: a, selectionEnd: b, value } = el;
  el.value = value.slice(0, a) + mark + value.slice(a, b) + mark + value.slice(b);
  el.setSelectionRange(a + mark.length, b + mark.length);
}
