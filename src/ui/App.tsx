import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { BoardDoc, ImageItem } from '../model/types.ts';
import { BoardStore } from '../model/store.ts';
import { emptyBoard, parseBoard, serializeBoard } from '../format/board.ts';
import { canvasFileRefs, importCanvas, parseCanvas } from '../format/canvasImport.ts';
import { generateBoard } from '../bench/generate.ts';
import { type PhaseResult, runAutopilot } from '../bench/autopilot.ts';
import { type BoardEntry, vault } from '../io/vault.ts';
import { BoardSession, type SaveState } from '../io/session.ts';
import { BoardView } from '../render/BoardView.ts';
import { Editor, type EditorUi } from '../editor/Editor.ts';
import { PerfMonitor } from '../perf/monitor.ts';
import { PerfOverlay } from './PerfOverlay.tsx';
import { Toolbar } from './Toolbar.tsx';
import { ContextBar } from './ContextBar.tsx';
import { ImageViewer } from './ImageViewer.tsx';
import { DocPanel, type DocMode } from './DocPanel.tsx';
import { QuickOpen } from './QuickOpen.tsx';
import { DocCache, FileIndex } from '../io/files.ts';
import { createMarkdown } from '../format/markdown.ts';
import { BOARD_FILE, boardFolderOf, BoardPaths, boardTitleOf } from '../model/paths.ts';

interface Opened {
  store: BoardStore;
  editor: Editor;
  session: BoardSession | null;
  off: () => void;
}

const CAMERA_KEY = 'vaultboard:camera:';

function loadCamera(path: string): { x: number; y: number; zoom: number } | null {
  try {
    const raw = localStorage.getItem(CAMERA_KEY + path);
    return raw ? (JSON.parse(raw) as { x: number; y: number; zoom: number }) : null;
  } catch {
    return null;
  }
}

function saveCamera(path: string, cam: { x: number; y: number; zoom: number }): void {
  try {
    localStorage.setItem(CAMERA_KEY + path, JSON.stringify(cam));
  } catch {
    // Нет доступа к хранилищу браузера — просто откроем доску целиком в следующий раз.
  }
}

function saveLabel(s: SaveState): string {
  switch (s.kind) {
    case 'saved': return 'Сохранено';
    case 'pending': return 'Изменено…';
    case 'saving': return 'Сохраняю…';
    case 'error': return `Не сохранено: ${s.message}`;
    case 'conflict': return s.message;
  }
}

/** Имя файла из первой строки текста: без markdown-значков и запрещённых в Windows символов. */
function nameFromText(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const clean = first
    .replace(/^[#>\-*\s]+/, '')
    .replace(/[*_=~`[\]]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 60).trim() || 'Документ';
}

export function App() {
  let host!: HTMLDivElement;
  const perf = new PerfMonitor();
  const files = new FileIndex();
  const docs = new DocCache();
  const markdown = createMarkdown(files);
  let opened: Opened | null = null;
  let cameraTimer = 0;

  const [view, setView] = createSignal<BoardView>();
  const [editor, setEditor] = createSignal<Editor>();
  const [ui, setUi] = createSignal<EditorUi>();
  const [root, setRoot] = createSignal('');
  const [boards, setBoards] = createSignal<BoardEntry[]>([]);
  const [current, setCurrent] = createSignal('');
  const [status, setStatus] = createSignal('');
  const [save, setSave] = createSignal<SaveState | null>(null);
  const [notice, setNotice] = createSignal('');
  const [error, setError] = createSignal('');
  const [zoom, setZoom] = createSignal(1);
  const [showPerf, setShowPerf] = createSignal(false);
  const [bench, setBench] = createSignal<PhaseResult[] | null>(null);
  const [benchPhase, setBenchPhase] = createSignal('');
  const [newName, setNewName] = createSignal<string | null>(null);
  const [viewer, setViewer] = createSignal<{ items: ImageItem[]; index: number } | null>(null);
  const [panel, setPanel] = createSignal<{ path: string; mode: DocMode } | null>(null);
  const [quick, setQuick] = createSignal(false);
  let filePicker!: HTMLInputElement;

  let noticeTimer = 0;
  function flash(text: string) {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => setNotice(''), 3500);
  }

  /** Положить файлы в папку доски (байт в байт) и разложить их на доске у точки. */
  async function uploadFiles(files: File[], at: { x: number; y: number }) {
    const board = opened?.session?.path;
    const ed = opened?.editor;
    if (!board || !ed) {
      flash('Фото сохраняются в папку доски — сначала создай или открой доску');
      return;
    }
    flash(files.length > 1 ? `Кладу ${files.length} файлов в папку доски…` : 'Кладу файл в папку доски…');
    const placed: { path: string; name: string; pw?: number; ph?: number }[] = [];
    let deduped = 0;
    const stamp = new Date().toLocaleString('ru-RU').replace(/[.:]/g, '-').replace(', ', ' ');
    for (const [n, f] of files.entries()) {
      let pw: number | undefined, ph: number | undefined;
      if (f.type.startsWith('image/')) {
        try {
          const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
          pw = bmp.width;
          ph = bmp.height;
          bmp.close();
        } catch {
          // Браузер не умеет показать этот формат — положим как обычный файл.
        }
      }
      // У скриншота из буфера имя всегда «image.png» — даём понятное.
      const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
      const name = f.name && f.name !== 'image.png' ? f.name : `Вставка ${stamp}${files.length > 1 ? ` ${n + 1}` : ''}.${ext}`;
      try {
        const up = await vault.upload(board, name, f);
        if (up.deduped) deduped++;
        placed.push({ path: up.path, name, pw, ph });
      } catch (err) {
        setError((err as Error).message);
      }
    }
    ed.placeFiles(placed, at);
    flash(`Добавлено: ${placed.length}${deduped ? ` (${deduped} уже лежали в папке доски — взяты оттуда, без копии)` : ''}`);
  }

  /** Папка файлов доски: `Доски/Таймлайн.board` → `Доски/Таймлайн`. */
  function boardFolder(): string | null {
    const board = opened?.session?.path;
    return board ? boardFolderOf(board) : null;
  }

  /** Путь файла карточки от корня базы. */
  const vaultPath = (stored: string) => view()!.paths.toVault(stored);

  /** Свободное имя файла в папке: «Имя.md», «Имя 2.md», … */
  function freePath(dir: string, name: string): string {
    for (let i = 1; ; i++) {
      const p = `${dir}/${name}${i > 1 ? ` ${i}` : ''}.md`;
      if (!files.has(p)) return p;
    }
  }

  async function writeNewDoc(path: string, text: string): Promise<boolean> {
    const res = await vault.writeDoc(path, text, 'new');
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    docs.set(path, { text, mtime: res.mtime });
    await files.refresh();
    return true;
  }

  /** D: новый документ в папке доски, карточка под курсором, панель сразу в режиме правки. */
  async function createDoc(at: { x: number; y: number }) {
    const dir = boardFolder();
    if (!dir || !opened) return flash('Документы сохраняются в папку доски — сначала создай или открой доску');
    const path = freePath(dir, 'Документ');
    const title = path.slice(path.lastIndexOf('/') + 1, -3);
    if (!(await writeNewDoc(path, `# ${title}\n\n`))) return;
    opened.editor.placeDoc(path, at);
    setPanel({ path, mode: 'edit' });
  }

  /** Стикер или текст превращается в заметку .md с тем же текстом; на доске — карточка на его месте. */
  async function convertToDoc() {
    const dir = boardFolder();
    const sel = opened?.editor.selectedText();
    if (!dir || !opened || !sel) return;
    const name = nameFromText(sel.text);
    const path = freePath(dir, name);
    const rest = sel.text.split('\n').slice(1).join('\n').trim();
    const text = /^#\s/.test(sel.text.trimStart()) ? sel.text : `# ${name}\n\n${rest}${rest ? '\n' : ''}`;
    if (!(await writeNewDoc(path, text))) return;
    opened.editor.replaceWithDoc(sel.id, path);
    flash(`Создана заметка ${path}`);
  }

  /**
   * [[Ссылка]] в стикере или тексте на доске. Заметка есть — открыть её (и показать карточку, если она на доске).
   * Нет — создать документ в папке доски, карточку положить справа и соединить стрелкой.
   */
  async function openLinkFromBoard(fromId: string, target: string) {
    const dir = boardFolder();
    if (!dir || !opened) return flash('Документы сохраняются в папку доски — сначала создай или открой доску');
    const existing = files.resolve(target, `${dir}/`);
    if (existing) {
      setPanel({ path: existing, mode: 'read' });
      const card = opened.store.items.find((i) => i.kind === 'doc' && vaultPath(i.file) === existing);
      if (card) opened.editor.focusItem(card.id);
      else opened.editor.placeDocFrom(fromId, existing);
      return;
    }
    const name = nameFromText(target.split('|')[0].split('#')[0]);
    const path = `${dir}/${name}.md`;
    if (!(await writeNewDoc(path, `# ${name}\n\n`))) return;
    opened.editor.placeDocFrom(fromId, path);
    setPanel({ path, mode: 'edit' });
  }

  /** «Удалить файл» у карточки: файл уходит в корзину базы, все его карточки убираются с доски. */
  async function trashSelectedFile() {
    const sel = opened?.editor.selectedFile();
    if (!sel || !opened) return;
    const what = sel.kind === 'image' ? 'фото' : sel.kind === 'doc' ? 'заметку' : 'файл';
    const ok = window.confirm(`Удалить ${what} «${sel.file}» с диска?\n\nФайл уйдёт в корзину базы (.trash), как в Obsidian, — оттуда его можно вернуть.`);
    if (!ok) return;
    try {
      const trashed = await vault.trash(sel.file);
      opened.editor.removeItemsWithFile(sel.file);
      if (panel()?.path === sel.file) setPanel(null);
      await files.refresh();
      flash(`Файл перемещён в ${trashed}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** Переход по [[ссылке]] из панели. Нет такой заметки — создаём рядом с текущей, как Obsidian. */
  async function navigate(target: string, resolved: string | null) {
    let path = resolved ?? files.resolve(target, panel()?.path ?? '');
    if (!path) {
      const from = panel()?.path ?? '';
      const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      path = `${dir ? `${dir}/` : ''}${target.split('|')[0].split('#')[0].trim()}.md`;
      if (!(await writeNewDoc(path, ''))) return;
      setPanel({ path, mode: 'edit' });
      return;
    }
    if (!path.toLowerCase().endsWith('.md')) return;
    setPanel({ path, mode: 'read' });
    const card = opened?.store.items.find((i) => i.kind === 'doc' && vaultPath(i.file) === path);
    if (card) opened!.editor.focusItem(card.id);
  }

  function openViewer(id: string) {
    const store = opened?.store;
    if (!store) return;
    // Соседние фото — в порядке чтения доски: сверху вниз, слева направо.
    const items = store.items
      .filter((i): i is ImageItem => i.kind === 'image')
      .sort((a, b) => (Math.abs(a.y - b.y) > 50 ? a.y - b.y : a.x - b.x))
      .map((i) => ({ ...i, file: vaultPath(i.file) }));
    setViewer({ items, index: Math.max(0, items.findIndex((i) => i.id === id)) });
  }

  async function refreshBoards() {
    const r = await vault.listBoards();
    setRoot(r.root);
    setBoards(r.boards);
  }

  async function closeCurrent() {
    if (!opened) return;
    if (opened.session?.hasUnsaved) await opened.session.save();
    opened.session?.close();
    opened.editor.destroy();
    opened.off();
    opened = null;
    setEditor(undefined);
    setUi(undefined);
    setSave(null);
  }

  /** Показать документ на доске: хранилище, редактор, сохранение. */
  async function mount(doc: BoardDoc, path: string | null, mtime: number | 'new', note: string, started: number) {
    await closeCurrent();
    const v = view()!;
    const store = new BoardStore(doc);
    const cam = path ? loadCamera(path) : null;
    v.paths = new BoardPaths(path ? boardFolderOf(path) : '');
    v.load(doc, !cam);
    if (cam) v.setCamera(cam);

    const ed = new Editor(store, v, host, perf);
    let uiQueued = false;
    ed.onUi = () => {
      if (uiQueued) return;
      uiQueued = true;
      queueMicrotask(() => {
        uiQueued = false;
        setUi(ed.ui());
      });
    };
    ed.onNotice = flash;
    ed.onFiles = (files, at) => void uploadFiles(files, at);
    ed.onOpenImage = openViewer;
    ed.onOpenDoc = (path, mode) => setPanel({ path, mode });
    ed.onCreateDoc = (at) => void createDoc(at);
    ed.onQuickOpen = () => setQuick(true);
    const off = store.onChange((ops) => {
      v.apply(ops);
      ed.storeChanged(ops);
    });

    let session: BoardSession | null = null;
    let restored = 0;
    if (path) {
      session = new BoardSession(store, path, mtime);
      session.onState = (st) => {
        setSave(st);
        // Первое сохранение импортированной доски создаёт новый файл — показать его в списке.
        if (st.kind === 'saved' && !boards().some((b) => b.path === path)) void refreshBoards();
      };
      restored = await session.start();
    }
    opened = { store, editor: ed, session, off };
    if (import.meta.env.DEV) Object.assign(window, { __store: store, __editor: ed });
    setEditor(ed);
    setUi(ed.ui());
    setCurrent(path ?? note);
    setError('');
    const historyNote = restored ? ` · история: ${restored} шагов назад` : '';
    setStatus(`${note} · ${doc.items.length} объектов · открыто за ${(performance.now() - started).toFixed(0)} мс${historyNote}`);
  }

  async function openBoard(path: string) {
    const started = performance.now();
    setBench(null);
    try {
      if (path.toLowerCase().endsWith('.canvas')) {
        // Доска Obsidian открывается как наша копия — папкой рядом с ней: оригинал .canvas не трогаем.
        const target = `${path.replace(/\.canvas$/i, '')}/${BOARD_FILE}`;
        if (boards().some((b) => b.path === target)) {
          flash(`Открыта сохранённая копия: ${target}`);
          return openBoard(target);
        }
        const data = parseCanvas(await vault.readText(path));
        const resolved = await vault.resolve(path, canvasFileRefs(data));
        const { doc, report } = importCanvas(data, resolved, { source: path });
        const missing = report.missingFiles.length ? ` · не найдено файлов: ${report.missingFiles.length}` : '';
        await mount(doc, target, 'new', `Импорт из Obsidian${missing} · правки сохранятся в ${target}`, started);
      } else {
        const { text, mtime } = await vault.readWithMtime(path);
        await mount(parseBoard(text), path, mtime, 'Доска', started);
      }
      history.replaceState(null, '', `?open=${encodeURIComponent(path)}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createBoard(name: string) {
    // Новая доска — папка с файлом доска.board: всё её содержимое будет лежать внутри.
    const folder = name.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.board$/i, '');
    if (!folder) return;
    const path = `${folder}/${BOARD_FILE}`;
    const doc = emptyBoard();
    doc.meta.id = crypto.randomUUID();
    doc.meta.created = new Date().toISOString().slice(0, 10);
    const res = await vault.writeBoard(path, serializeBoard(doc), 'new');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNewName(null);
    await refreshBoards();
    await openBoard(path);
  }

  async function openBench(count: number, auto: boolean) {
    const started = performance.now();
    await mount(generateBoard(count), null, 'new', `Замер: ${count} объектов (не сохраняется)`, started);
    history.replaceState(null, '', `?bench=${count}${auto ? '&auto=1' : ''}`);
    setBench(null);
    if (!auto) return;
    const results = await runAutopilot(view()!, setBenchPhase);
    setBenchPhase('');
    setBench(results);
    (window as unknown as { __bench: unknown }).__bench = results;
    console.table(results);
  }

  async function resolveConflict(keepMine: boolean) {
    if (!opened?.session) return;
    if (keepMine) await opened.session.overwrite();
    else {
      const path = opened.session.path;
      opened.session.close();
      opened.session = null;
      await openBoard(path);
    }
  }

  onMount(async () => {
    const v = await BoardView.create(host, perf);
    v.onCamera = () => {
      setZoom(v.cam.zoom);
      opened?.editor.cameraChanged();
      const path = opened?.session?.path;
      if (path) {
        clearTimeout(cameraTimer);
        cameraTimer = window.setTimeout(() => saveCamera(path, v.cam), 400);
      }
    };
    setView(v);
    v.setDocs(docs, markdown);
    void files.refresh();
    if (import.meta.env.DEV) Object.assign(window, { __view: v, __docs: docs, __files: files });

    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) setShowPerf((s) => !s);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (opened?.session?.hasUnsaved) {
        void opened.session.save();
        e.preventDefault();
      }
    };
    // Вернулись в окно (например, после правки в Obsidian) — перечитать изменившиеся заметки.
    const onFocus = () => {
      void docs.revalidate();
      void files.refresh();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('focus', onFocus);
    onCleanup(() => window.removeEventListener('focus', onFocus));
    onCleanup(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
      void closeCurrent();
      v.destroy();
    });

    const params = new URLSearchParams(location.search);
    await refreshBoards().catch((err: Error) => setError(err.message));
    if (params.get('bench')) await openBench(Number(params.get('bench')), params.get('auto') === '1');
    else if (params.get('open')) await openBoard(params.get('open')!);
    else await mount(emptyBoard(), null, 'new', 'Черновик (не сохраняется) — создай или открой доску слева', performance.now());
  });

  return (
    <div class="app">
      <aside class="sidebar">
        <div class="brand">vaultboard</div>
        <div class="root" title={root()}>{root()}</div>
        <div class="section">
          Доски
          <button class="section-btn" title="Новая доска" onClick={() => setNewName(newName() === null ? 'Доски/Новая доска' : null)}>+</button>
        </div>
        <Show when={newName() !== null}>
          <form class="new-board" onSubmit={(e) => { e.preventDefault(); void createBoard(newName()!); }}>
            <input
              value={newName()!}
              onInput={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Escape' && setNewName(null)}
              ref={(el) => setTimeout(() => el.select())}
            />
            <div class="new-board-hint">Папка доски от корня базы — в ней будет всё: доска, фото, документы, история. Enter — создать, Esc — отмена.</div>
            <input type="submit" hidden />
          </form>
        </Show>
        <For each={boards()} fallback={<div class="empty">Досок пока нет</div>}>
          {(b) => (
            <button class="board" classList={{ active: current() === b.path }} onClick={() => openBoard(b.path)} title={b.path}>
              <span class="kind">{b.kind === 'canvas' ? 'Obsidian' : 'доска'}</span>
              {b.kind === 'board' ? boardTitleOf(b.path) : b.path}
            </button>
          )}
        </For>
        <div class="section">Замер скорости</div>
        <div class="bench">
          <button onClick={() => openBench(1000, true)}>1000</button>
          <button onClick={() => openBench(5000, true)}>5000</button>
          <button onClick={() => openBench(20000, true)}>20000</button>
        </div>
        <div class="hint">
          <b>Мышь:</b> левая по пустому — двигать доску · по объекту — выделить и тащить · Shift+перетаскивание — выделить рамкой · Alt+перетаскивание — копия · колесо — зум<br />
          <b>Создать под курсором:</b> N стикер · T текст · R прямоугольник · O овал · D документ · двойной щелчок — текст · L линия · F рамка · Ctrl+K — найти заметку базы<br />
          <b>Рисовать:</b> P ручка · M выделитель · E ластик · перо планшета — сразу, мышь — с Alt · Shift при протягивании линии — ровно по 45°<br />
          <b>В стикере:</b> Tab — следующий справа · Ctrl+Enter — ниже · Esc — готово<br />
          <b>Правка:</b> Ctrl+Z / Ctrl+Y · Ctrl+C/X/V · Ctrl+D дубликат · Delete · стрелки сдвиг · Enter править текст<br />
          <b>Вид:</b> Shift+1 вся доска · Shift+2 к выделенному · Shift+0 100% · ` счётчик
        </div>
      </aside>
      <main class="stage">
        <div class="board-host" ref={host} />
        <Show when={editor() && ui()}>
          <Toolbar
            editor={editor()!}
            ui={ui()!}
            onPhoto={() => filePicker.click()}
            onDoc={() => opened && void createDoc(opened.editor.viewCenter())}
          />
          <ContextBar
            editor={editor()!}
            ui={ui()!}
            onConvertToDoc={() => void convertToDoc()}
            onOpenLink={(fromId, target) => void openLinkFromBoard(fromId, target)}
            onTrashFile={() => void trashSelectedFile()}
          />
        </Show>
        <div class="topbar">
          <span class="title">{current() || 'Выбери доску слева'}</span>
          <Show when={save()}>
            <span class="save" classList={{ bad: save()!.kind === 'error' || save()!.kind === 'conflict' }}>{saveLabel(save()!)}</span>
          </Show>
          <Show when={status()}>
            <span class="status">{status()}</span>
          </Show>
        </div>
        <Show when={save()?.kind === 'conflict'}>
          <div class="conflict">
            Файл доски изменили снаружи (git или другая копия). Что делаем?
            <button onClick={() => resolveConflict(true)}>Записать мою версию</button>
            <button onClick={() => resolveConflict(false)}>Перечитать с диска</button>
          </div>
        </Show>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
        <Show when={notice()}>
          <div class="notice">{notice()}</div>
        </Show>
        <div class="zoom">{Math.round(zoom() * 100)}%</div>
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            if (files.length && opened) void uploadFiles(files, opened.editor.viewCenter());
          }}
        />
        <Show when={panel()}>
          <DocPanel
            path={panel()!.path}
            mode={panel()!.mode}
            root={root()}
            docs={docs}
            files={files}
            markdown={markdown}
            onMode={(mode) => setPanel({ ...panel()!, mode })}
            onNavigate={(target, resolved) => void navigate(target, resolved)}
            onClose={() => setPanel(null)}
          />
        </Show>
        <Show when={quick()}>
          <QuickOpen
            files={files}
            onClose={() => setQuick(false)}
            onPlace={(path) => opened?.editor.placeDoc(path, opened.editor.cursorPoint())}
            onOpen={(path) => setPanel({ path, mode: 'read' })}
          />
        </Show>
        <Show when={viewer()}>
          <ImageViewer items={viewer()!.items} index={viewer()!.index} onClose={() => setViewer(null)} />
        </Show>
        <Show when={showPerf() && view()}>
          <PerfOverlay perf={perf} view={view()!} />
        </Show>
        <Show when={benchPhase()}>
          <div class="bench-running">Идёт замер: {benchPhase()}</div>
        </Show>
        <Show when={bench()}>
          <div class="bench-result">
            <div class="bench-head">
              Итог замера <button onClick={() => setBench(null)}>×</button>
            </div>
            <table>
              <thead>
                <tr><th>Фаза</th><th>кадр/с</th><th>95% кадров, мс</th><th>худший, мс</th><th>процессор, мс</th><th>видно</th></tr>
              </thead>
              <tbody>
                <For each={bench()!}>
                  {(r) => (
                    <tr classList={{ bad: r.p95 > 20 }}>
                      <td>{r.name}</td>
                      <td>{r.fps.toFixed(0)}</td>
                      <td>{r.p95.toFixed(1)}</td>
                      <td>{r.worst.toFixed(1)}</td>
                      <td>{r.cpuAvg.toFixed(1)}</td>
                      <td>{r.visibleAvg.toFixed(0)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </main>
    </div>
  );
}
