// Панель документа справа от доски (или на весь экран): чтение и правка обычной заметки .md.
// Правка — в CodeMirror: источник правды — сам текст файла, поэтому ничего не переформатируется
// и Obsidian видит ровно то, что написано. Сохранение — через полсекунды после правки, атомарно.
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import type { DocCache, FileIndex } from '../io/files.ts';
import type { Markdown } from '../format/markdown.ts';
import { vault } from '../io/vault.ts';
import { obsidianTarget, type ObsidianTarget } from '../io/obsidian.ts';

export type DocMode = 'read' | 'edit';

const SAVE_DELAY_MS = 500;

// Оформление markdown в редакторе: заголовки крупнее, жирный жирный, служебные знаки бледные — как в Obsidian.
// Цвета — переменные темы, поэтому в тёмной теме редактор тоже тёмный.
const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.6em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: '#8a8a8a' },
  { tag: tags.monospace, fontFamily: 'Consolas, "Cascadia Mono", monospace', backgroundColor: 'var(--hover)' },
  { tag: tags.quote, color: 'var(--quote)' },
  { tag: tags.processingInstruction, color: 'var(--faint)' },
]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

export function DocPanel(props: {
  path: string;
  mode: DocMode;
  root: string;
  docs: DocCache;
  files: FileIndex;
  markdown: Markdown;
  /** Опубликованная доска: заметку можно только читать. */
  readOnly?: boolean;
  onMode: (mode: DocMode) => void;
  onNavigate: (target: string, resolved: string | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal('');
  const [conflict, setConflict] = createSignal(false);
  const [wide, setWide] = createSignal(false);
  let editorHost!: HTMLDivElement;
  let cm: EditorView | null = null;
  let mtime: number | 'new' = 0;
  let saveTimer = 0;
  let dirty = false;
  let loadedPath = '';

  async function save(force = false) {
    clearTimeout(saveTimer);
    const value = text();
    if (value === null || (!dirty && !force)) return;
    const path = loadedPath;
    dirty = false;
    setStatus('Сохраняю…');
    const res = await vault.writeDoc(path, value, force ? 'force' : mtime);
    if (res.ok) {
      mtime = res.mtime;
      props.docs.set(path, { text: value, mtime: res.mtime });
      setConflict(false);
      setStatus('Сохранено');
    } else {
      dirty = true;
      setConflict(res.conflict);
      setStatus(res.error);
    }
  }

  function scheduleSave() {
    dirty = true;
    setStatus('Изменено…');
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  }

  function mountEditor(value: string) {
    cm?.destroy();
    cm = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholder('Пустая заметка — начни писать. # заголовок, **жирный**, [[ссылка]]'),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            setText(u.state.doc.toString());
            scheduleSave();
          }),
        ],
      }),
    });
    cm.focus();
  }

  async function load(path: string) {
    if (loadedPath && dirty) await save();
    loadedPath = path;
    setText(null);
    setStatus('');
    setConflict(false);
    const doc = await props.docs.load(path);
    if (loadedPath !== path) return;
    mtime = doc ? doc.mtime : 'new';
    setText(doc?.text ?? '');
    if (!doc) setStatus('Новая заметка — появится на диске после первой правки');
  }

  createEffect(on(() => props.path, (path) => void load(path)));

  // Режим правки: редактор создаётся, когда текст загружен.
  createEffect(
    on([() => props.mode, () => text() !== null, () => props.path], ([mode, ready]) => {
      if (mode === 'edit' && ready && editorHost && (!cm || cm.state.doc.toString() !== text())) mountEditor(text()!);
      if (mode === 'read' && cm) {
        cm.destroy();
        cm = null;
      }
    }),
  );

  // Заметку поменяли снаружи (в Obsidian) — если у нас нет несохранённых правок, показываем новую версию.
  const off = props.docs.onChange((path) => {
    if (path !== loadedPath || dirty) return;
    const doc = props.docs.get(path);
    if (!doc || doc.text === text()) return;
    mtime = doc.mtime;
    setText(doc.text);
    if (cm) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: doc.text } });
  });

  onCleanup(() => {
    off();
    void save();
    cm?.destroy();
  });

  const onReadClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    props.onNavigate(a.getAttribute('data-target') ?? '', a.getAttribute('data-path') || null);
  };

  // Куда откроется заметка в Obsidian — проверяем по его собственному списку хранилищ, а не надеемся.
  const [target, setTarget] = createSignal<ObsidianTarget | null>(null);
  createEffect(() => {
    const p = props.path;
    setTarget(null);
    obsidianTarget(p).then((t) => { if (p === props.path) setTarget(t); }, () => undefined);
  });
  const okTarget = () => {
    const t = target();
    return t?.kind === 'ok' ? t : null;
  };

  return (
    <aside class="doc-panel" classList={{ wide: wide() }} onPointerDown={(e) => e.stopPropagation()}>
      <header class="doc-head">
        <div class="doc-title">
          <b>{basename(props.path)}</b>
          <span class="doc-path" title={props.path}>{props.path}</span>
        </div>
        <Show when={!props.readOnly}>
          <div class="doc-modes">
            <button classList={{ active: props.mode === 'read' }} onClick={() => props.onMode('read')}>Чтение</button>
            <button classList={{ active: props.mode === 'edit' }} onClick={() => props.onMode('edit')}>Правка</button>
          </div>
        </Show>
        <Show
          when={!props.readOnly && okTarget()}
          fallback={
            <Show when={!props.readOnly && target()?.kind === 'outside'}>
              <span
                class="doc-btn disabled"
                title="Эта заметка не лежит ни в одном хранилище Obsidian — он её не откроет. Добавь её папку как хранилище в Obsidian."
              >
                Obsidian
              </span>
            </Show>
          }
        >
          {(t) => <a class="doc-btn" href={t().url} title={`Откроется в хранилище Obsidian «${t().vaultName}» (${t().vaultPath})`}>Obsidian</a>}
        </Show>
        <button class="doc-btn" title={wide() ? 'Обратно в панель' : 'На весь экран'} onClick={() => setWide(!wide())}>{wide() ? '⤡' : '⤢'}</button>
        <button class="doc-btn" title="Закрыть (Esc)" onClick={() => props.onClose()}>×</button>
      </header>
      <Show when={status()}>
        <div class="doc-status" classList={{ bad: conflict() }}>
          {status()}
          <Show when={conflict()}>
            <button onClick={() => void save(true)}>Записать мою версию</button>
            <button onClick={() => { dirty = false; void load(loadedPath); }}>Взять версию с диска</button>
          </Show>
        </div>
      </Show>
      <Show when={text() !== null} fallback={<div class="doc-loading">Загружаю…</div>}>
        <Show when={props.mode === 'read'}>
          <div class="doc-read" onClick={onReadClick} innerHTML={props.markdown.render(text()!, { from: props.path })} />
        </Show>
      </Show>
      <div class="doc-edit" ref={editorHost} style={{ display: props.mode === 'edit' ? '' : 'none' }} />
    </aside>
  );
}
