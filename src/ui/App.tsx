import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { BoardDoc, ImageItem } from '../model/types.ts';
import { BoardStore } from '../model/store.ts';
import { emptyBoard, parseBoard, serializeBoard } from '../format/board.ts';
import { canvasFileRefs, importCanvas, parseCanvas } from '../format/canvasImport.ts';
import { generateBoard } from '../bench/generate.ts';
import { type PhaseResult, runAutopilot } from '../bench/autopilot.ts';
import { type BoardEntry, SITE, vault } from '../io/vault.ts';
import { PublishDialog } from './PublishDialog.tsx';
import { InviteDialog } from './InviteDialog.tsx';
import { PresenceLayer } from './PresenceLayer.ts';
import { LiveSession, type LivePeer } from '../io/live.ts';
import type { GuestMe } from '../io/vault.ts';
import { applyTheme, BOARD_BACKGROUND, loadTheme, onSystemTheme, saveTheme, THEME_NAMES, type ThemeChoice } from './theme.ts';
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
import { ContextMenu, type MenuEntry } from './ContextMenu.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { StylesPanel } from './StylesPanel.tsx';
import { LayersPanel } from './LayersPanel.tsx';
import { HelpDialog } from './HelpDialog.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { SetupDialog } from './SetupDialog.tsx';
import { CHECK_UPDATE_EVENT, Updater } from './Updater.tsx';
import { SearchBar } from './SearchBar.tsx';
import { Minimap } from './Minimap.ts';
import { searchBoardWith } from '../editor/search.ts';
import type { Settings, SetupInfo, UpdateStatus } from '../io/vault.ts';
import { EmbedLayer } from './EmbedLayer.ts';
import { CommentsLayer } from './CommentsLayer.ts';
import { ThreadPopover } from './ThreadPopover.tsx';
import { CommentsPanel } from './CommentsPanel.tsx';
import { Comments } from '../editor/Comments.ts';
import { isDone, STATUSES } from '../model/comments.ts';
import { embedUrl } from '../format/embed.ts';
import { exportBoard, type ExportFormat, saveBlob } from '../render/export.ts';
import type { Background, GridKind, StyleDef } from '../model/types.ts';
import type { Rect } from '../render/geometry.ts';

const BACKGROUNDS: { color: string; name: string }[] = [
  { color: '#f7f7f5', name: 'Светлый' },
  { color: '#ffffff', name: 'Белый' },
  { color: '#eef2f7', name: 'Голубоватый' },
  { color: '#f5efe6', name: 'Бумага' },
  { color: '#eef5ee', name: 'Мятный' },
  { color: '#2b2b2b', name: 'Тёмный' },
  { color: '#1e2230', name: 'Ночной' },
];
const GRIDS: { grid: GridKind; name: string }[] = [
  { grid: 'dots', name: 'Точки' },
  { grid: 'lines', name: 'Клетка' },
  { grid: 'none', name: 'Без сетки' },
];
import { DocCache, FileIndex } from '../io/files.ts';
import { createMarkdown } from '../format/markdown.ts';
import { BOARD_FILE, boardFolderOf, BoardPaths, boardTitleOf } from '../model/paths.ts';

interface Opened {
  store: BoardStore;
  editor: Editor;
  /** Живые плееры видео поверх карточек. */
  embeds: EmbedLayer;
  comments: Comments;
  /** Булавки обсуждений поверх доски. */
  pins: CommentsLayer;
  /** Миникарта в углу. */
  minimap: Minimap;
  session: BoardSession | null;
  /** Общая доска: правки идут через сервер вживую (тогда `session` нет — файл пишет сервер). */
  live: LiveSession | null;
  /** Курсоры других участников общей доски. */
  presence: PresenceLayer | null;
  off: () => void;
}

/** Имя гостя на общих досках — спрашиваем один раз и запоминаем. */
const GUEST_NAME_KEY = 'vaultboard:guest-name';

const CAMERA_KEY = 'vaultboard:camera:';
/** Какая доска была открыта последней — с неё начинается следующий запуск. */
const LAST_BOARD_KEY = 'vaultboard:last-board';

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

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Не запомнится — не страшно.
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
  /** Доска, для которой запоминается место на ней (у черновика и замера — нет). */
  let cameraPath: string | null = null;

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
  /** Где курсор на доске — показываем координаты в углу. */
  const [cursor, setCursor] = createSignal<{ x: number; y: number } | null>(null);
  const [showPerf, setShowPerf] = createSignal(false);
  const [help, setHelp] = createSignal(false);
  const [settings, setSettings] = createSignal(false);
  /** Первая настройка: папка с досками ещё не выбрана. */
  const [setup, setSetup] = createSignal<SetupInfo | null>(null);
  /** Мастер открыт повторно (не первая настройка) — его можно закрыть, текущие значения подставлены. */
  const [wizardAgain, setWizardAgain] = createSignal<Settings | null>(null);
  /** Вышел новый релиз — показываем плашку (её можно закрыть). */
  const [update, setUpdate] = createSignal<UpdateStatus | null>(null);
  /** Номер версии: вшитый при сборке, пока сервер не сообщил свой. */
  const [version, setVersion] = createSignal(__APP_VERSION__);
  /** Панель досок свёрнута — выезжает поверх доски, когда мышь у левого края. Запоминается. */
  const [collapsed, setCollapsed] = createSignal(readFlag('vaultboard:sidebar-collapsed'));
  const [peek, setPeek] = createSignal(false);
  const [filter, setFilter] = createSignal('');
  const toggleSidebar = () => {
    const next = !collapsed();
    setCollapsed(next);
    setPeek(false);
    writeFlag('vaultboard:sidebar-collapsed', next);
  };
  const shownBoards = () => {
    const q = filter().trim().toLowerCase();
    return q ? boards().filter((b) => b.path.toLowerCase().includes(q)) : boards();
  };
  const [bench, setBench] = createSignal<PhaseResult[] | null>(null);
  const [benchPhase, setBenchPhase] = createSignal('');
  const [newName, setNewName] = createSignal<string | null>(null);
  const [viewer, setViewer] = createSignal<{ items: ImageItem[]; index: number } | null>(null);
  const [panel, setPanel] = createSignal<{ path: string; mode: DocMode } | null>(null);
  const [quick, setQuick] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [exporting, setExporting] = createSignal<{ area: 'board' | 'selection'; selection: Rect | null } | null>(null);
  const [stylesOpen, setStylesOpen] = createSignal(false);
  const [layersOpen, setLayersOpen] = createSignal(false);
  /** Окно публикации доски на сайт. */
  const [publishing, setPublishing] = createSignal(false);
  /** Окно приглашений. */
  const [inviting, setInviting] = createSignal(false);
  /** Гость по приглашению (null — автор на своём компьютере). */
  const [guest, setGuest] = createSignal<Extract<GuestMe, { guest: true }> | null>(null);
  /** Гостю без приглашения — только объяснение, как попасть. */
  const [needInvite, setNeedInvite] = createSignal('');
  /** Уже знаем, кто открыл приложение (автор или гость), — до этого не показываем того, что только для автора. */
  const [known, setKnown] = createSignal(SITE);
  const owner = () => known() && !SITE && !guest() && !needInvite();
  /** Доски автора, у которых есть приглашения: их он тоже открывает вживую. */
  const [shared, setShared] = createSignal<Set<string>>(new Set());
  /** Кто сейчас на открытой общей доске. */
  const [peers, setPeers] = createSignal<LivePeer[]>([]);
  /** Путь открытой доски (обычной или общей). */
  const boardPath = () => opened?.session?.path ?? opened?.live?.path ?? null;
  /** Правка доски доступна (не сайт, не зритель и не комментатор). */
  const canEdit = () => !SITE && (!guest() || guest()!.role === 'edit');
  /** Тема интерфейса: выбор (как в системе / светлая / тёмная) и то, что из него вышло. */
  const [themeChoice, setThemeChoice] = createSignal<ThemeChoice>(loadTheme());
  const [theme, setThemeSignal] = createSignal(applyTheme(themeChoice()));
  function setTheme(choice: ThemeChoice) {
    setThemeChoice(choice);
    saveTheme(choice);
    const t = applyTheme(choice);
    setThemeSignal(t);
    view()?.setDefaultBackground(BOARD_BACKGROUND[t]);
  }
  const nextTheme = (): ThemeChoice => (themeChoice() === 'system' ? (theme() === 'dark' ? 'light' : 'dark') : themeChoice() === 'dark' ? 'light' : 'system');
  /** Строка поиска по доске (Ctrl+F). */
  const [searchOpen, setSearchOpen] = createSignal(false);
  /** Миникарта видна (по умолчанию да; выбор запоминается). */
  const [minimapOn, setMinimapOnSignal] = createSignal(!readFlag('vaultboard:minimap-off'));
  function setMinimapOn(on: boolean) {
    setMinimapOnSignal(on);
    writeFlag('vaultboard:minimap-off', !on);
    opened?.minimap.setVisible(on);
  }
  // Комментарии: открытое обсуждение, новое (точка на доске), список, «скрыть завершённые», имя автора.
  const [openThread, setOpenThread] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal<{ x: number; y: number } | null>(null);
  const [commentsOpen, setCommentsOpen] = createSignal(false);
  const [hideDone, setHideDoneSignal] = createSignal(readFlag('vaultboard:show-done') ? false : true);
  const [author, setAuthor] = createSignal('Я');
  if (!SITE) void vault.getSettings().then((s) => setAuthor(s.author || s.defaultAuthor || 'Я'), () => undefined);
  const [library, setLibrary] = createSignal<Record<string, StyleDef>>({});
  let filePicker!: HTMLInputElement;

  let noticeTimer = 0;
  function flash(text: string) {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => setNotice(''), 3500);
  }

  /** Положить файлы в папку доски (байт в байт) и разложить их на доске у точки. */
  async function uploadFiles(files: File[], at: { x: number; y: number }) {
    const board = boardPath();
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
    const board = boardPath();
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
    if (!path && SITE) {
      flash(`Заметка «${target.split('|')[0]}» не опубликована`);
      return;
    }
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

  /** Развернуть ссылку в карточку. Сайт не ответил — карточка остаётся с адресом, можно обновить позже. */
  async function unfurlLink(id: string, url: string) {
    const board = boardPath() ?? '';
    try {
      const data = await vault.unfurl(url, board);
      opened?.editor.applyUnfurl(id, data);
    } catch (err) {
      let site = url;
      try {
        site = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        // Адрес без хоста — оставим как есть.
      }
      opened?.editor.applyUnfurl(id, { url, site, title: site });
      flash(`Сайт ${site} не ответил (${(err as Error).message}) — карточка с адресом; «Обновить карточку» в меню`);
    }
  }

  // ---------- меню по правой кнопке ----------

  function setBackground(change: Partial<Background>) {
    if (!opened) return;
    const cur = opened.store.doc.background ?? { color: BOARD_BACKGROUND[theme()], grid: 'dots' as GridKind };
    opened.store.transact('Фон доски', () => opened!.store.setProp('background', { ...cur, ...change }));
  }

  function openExport(area: 'board' | 'selection') {
    setExporting({ area, selection: opened?.editor.selectionWorldRect() ?? null });
  }

  async function runExport(area: Rect, scale: number, format: ExportFormat, onProgress: (done: number, total: number) => void) {
    const v = view()!;
    const result = await exportBoard(
      {
        renderTile: (r, s, w, h) => v.renderTile(r, s, w, h),
        renderPixels: (r, s, w, h) => v.renderPixels(r, s, w, h),
        hasContent: (r) => v.hasContent(r),
        begin: () => v.beginExport(),
        end: () => v.endExport(),
        background: v.backgroundColor,
      },
      area,
      scale,
      format,
      onProgress,
    );
    const base = (current() || 'доска').replace(/\/доска\.board$/i, '').split('/').pop()!.replace(/\.board$/i, '');
    const how = await saveBlob(result.blob, `${base}.${format}`);
    if (how !== 'cancelled') flash(`Экспорт: ${result.width}×${result.height}, ${(result.blob.size / 1024 / 1024).toFixed(1)} МБ${how === 'downloaded' ? ' — в папке загрузок' : ''}`);
  }

  function styleSubmenu(): MenuEntry[] {
    const ed = opened!.editor;
    const look = ed.selectedLook();
    return [
      ...ed.styleNames().map((n, i): MenuEntry => ({ label: n, hint: i < 9 ? `Alt+${i + 1}` : undefined, checked: look?.style === n && look.hasStyle, action: () => ed.applyStyle(n) })),
      ...(ed.styleNames().length ? ['sep' as const] : []),
      { label: 'Сохранить как стиль…', action: () => { const n = window.prompt('Название стиля, например «Факт [К]»'); if (n) ed.saveStyle(n); } },
      { label: `Обновить стиль «${look?.style ?? ''}» по этому объекту`, disabled: !look?.hasStyle, action: () => ed.updateStyleFromSelection() },
      { label: 'Сбросить к стилю', disabled: !look?.hasStyle, action: () => ed.resetToStyle() },
      { label: 'Выделить все с этим стилем', disabled: !look?.hasStyle, action: () => look?.style && ed.selectByStyle(look.style) },
      { label: 'Без стиля', disabled: !look?.hasStyle, action: () => ed.applyStyle(null) },
      'sep',
      { label: 'Стили доски…', action: () => setStylesOpen(true) },
    ];
  }

  // ---------- слежение за файлами снаружи ----------

  let filesRefreshTimer = 0;
  /** Список файлов (для [[ссылок]] и поиска заметок) — не чаще раза в 2 секунды, даже если меняется много. */
  function refreshFilesSoon() {
    if (filesRefreshTimer) return;
    filesRefreshTimer = window.setTimeout(() => {
      filesRefreshTimer = 0;
      void files.refresh().catch(() => undefined);
    }, 2000);
  }

  /** Открытую доску поменяли снаружи: нет своих несохранённых правок — перечитать; есть — спросить, чью версию оставить. */
  async function boardChangedOutside(path: string) {
    const s = opened?.session;
    if (!s || s.path !== path) return; // у общей доски (live) нет session — её перечитает сервер
    const mtime = await vault.mtimeOf(path).catch(() => null);
    if (mtime === null || mtime === s.diskMtime) return;
    if (s.hasUnsaved) {
      s.markConflict();
      return;
    }
    await openBoard(path);
    flash('Доску изменили снаружи — открыта новая версия');
  }

  /** Применить то, что поменялось в папке снаружи. */
  async function applyOutsideChanges(paths: string[], reset: boolean) {
    if (reset) {
      await docs.revalidate();
      refreshFilesSoon();
      void refreshBoards().catch(() => undefined);
      const cur = opened?.session?.path;
      if (cur) await boardChangedOutside(cur);
      return;
    }
    // Заметки, которые показаны на досках или открыты в панели, — перечитать (панель обновится, если в ней нет правок).
    for (const p of paths) if (/\.md$/i.test(p) && docs.get(p)) void docs.load(p);
    refreshFilesSoon();
    if (paths.some((p) => /\.(board|canvas)$/i.test(p))) void refreshBoards().catch(() => undefined);
    const cur = opened?.session?.path;
    if (cur && paths.includes(cur)) await boardChangedOutside(cur);
  }

  /** Долгий запрос за изменениями в папке: ответ приходит, как только что-то поменялось снаружи. */
  async function watchOutsideChanges() {
    let since = -1;
    for (;;) {
      try {
        const r = await vault.changesWait(since);
        if (since >= 0 && (r.paths.length || r.reset)) await applyOutsideChanges(r.paths, !!r.reset);
        since = r.seq;
      } catch {
        // Сервер перезапускается или папка ещё не выбрана — подождать и спросить снова.
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /** Открыть мастер настройки ещё раз — щелчком по логотипу в панели досок. */
  async function openWizard() {
    try {
      const [info, s] = await Promise.all([vault.setup(), vault.getSettings()]);
      setWizardAgain(s);
      setSetup(info);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function setHideDone(hide: boolean) {
    setHideDoneSignal(hide);
    writeFlag('vaultboard:show-done', !hide);
    if (opened) {
      opened.pins.hideDone = hide;
      opened.pins.update();
    }
  }

  function closeThread() {
    setOpenThread(null);
    setDraft(null);
    if (opened) {
      opened.pins.openId = null;
      opened.pins.update();
    }
  }

  /** Открыть обсуждение; `fly` — перелететь к булавке (из списка). */
  function showThread(id: string, fly = false) {
    if (!opened) return;
    setDraft(null);
    setOpenThread(id);
    opened.pins.openId = id;
    const t = opened.comments.get(id);
    if (fly && t) {
      const v = view()!;
      const p = opened.comments.point(t);
      const zoom = Math.max(v.cam.zoom, 0.6);
      v.setCamera({ zoom, x: v.screen.w / 2 - p.x * zoom - 150, y: v.screen.h / 2 - p.y * zoom });
    }
    opened.pins.update();
  }

  /** Меню по булавке: статус, удалить. */
  function pinMenu(id: string): MenuEntry[] {
    const c = opened!.comments;
    const t = c.get(id);
    if (!t) return [];
    return [
      { label: 'Открыть', action: () => showThread(id) },
      'sep',
      ...STATUSES.map((s): MenuEntry => ({ label: s.name, swatch: s.color, checked: (t.status ?? 'open') === s.id, action: () => c.setStatus(id, s.id) })),
      'sep',
      { label: 'Удалить обсуждение', danger: true, action: () => { if (window.confirm('Удалить обсуждение целиком?')) c.remove(id); } },
    ];
  }

  /** Подменю «На слой»: все слои доски и новый слой из выделенного. */
  function layerSubmenu(): MenuEntry[] {
    const ed = opened!.editor;
    const sel = ed.ui().selection.map((id) => opened!.store.get(id)?.layer ?? '');
    return [
      ...[...ed.layers()].reverse().map((l): MenuEntry => ({
        label: l.name + (l.hidden ? ' (скрыт)' : l.locked ? ' (закреплён)' : ''),
        checked: sel.length > 0 && sel.every((x) => x === l.id),
        action: () => ed.moveSelectionToLayer(l.id),
      })),
      'sep',
      { label: 'Новый слой из выделенного…', action: () => { const n = window.prompt('Название слоя, например «Фото»'); if (n?.trim()) ed.addLayer(n.trim(), true); } },
      { label: 'Слои…', hint: 'Shift+L', action: () => setLayersOpen(true) },
    ];
  }

  /** Меню по объекту: открыть, буфер обмена, слои, стиль, экспорт выделенного, удаление. */
  function objectMenu(at: { x: number; y: number }): MenuEntry[] {
    const ed = opened!.editor;
    const ui = ed.ui();
    const file = ed.selectedFile();
    const text = ed.selectedText();
    const single = ui.selection.length === 1;
    const items: MenuEntry[] = [];
    if (single && file?.kind === 'doc') {
      items.push({ label: 'Открыть', hint: 'Enter', action: () => setPanel({ path: file.file, mode: 'read' }) });
      items.push({ label: 'Править', hint: 'Shift+Enter', action: () => setPanel({ path: file.file, mode: 'edit' }) });
      items.push('sep');
    }
    if (single && file?.kind === 'image') {
      items.push({ label: 'Открыть в просмотре', hint: 'Enter', action: () => openViewer(ui.selection[0]) }, 'sep');
    }
    const link = single ? ed.selectedLink() : null;
    if (link) {
      items.push(
        ...(embedUrl(link.url) ? [{ label: 'Смотреть здесь', hint: 'щелчок', action: () => opened?.embeds.play(link.id) } as MenuEntry] : []),
        ...(opened?.embeds.isStarted(link.id) ? [{ label: 'Остановить видео', action: () => opened?.embeds.stop(link.id) } as MenuEntry] : []),
        { label: embedUrl(link.url) ? 'Открыть в браузере' : 'Открыть ссылку', hint: embedUrl(link.url) ? undefined : 'Enter', action: () => window.open(link.url, '_blank', 'noopener') },
        { label: 'Обновить карточку', action: () => void unfurlLink(link.id, link.url) },
        { label: 'Копировать адрес', action: () => void navigator.clipboard.writeText(link.url) },
        'sep',
      );
    }
    items.push(
      { label: 'Вырезать', hint: 'Ctrl+X', action: () => ed.clipboardCommand('cut') },
      { label: 'Копировать', hint: 'Ctrl+C', action: () => ed.clipboardCommand('copy') },
      { label: 'Вставить', hint: 'Ctrl+V', action: () => void ed.pasteAt(at) },
      { label: 'Дубликат', hint: 'Ctrl+D', action: () => ed.duplicate() },
      'sep',
      { label: 'На передний план', hint: 'Ctrl+]', action: () => ed.bringToFront() },
      { label: 'На задний план', hint: 'Ctrl+[', action: () => ed.sendToBack() },
      { label: ui.selection.every((id) => opened!.store.get(id)?.locked) ? 'Открепить' : 'Закрепить', action: () => ed.toggleLock() },
      'sep',
    );
    const gs = ed.groupState();
    if (gs.canGroup) items.push({ label: 'Сгруппировать', hint: 'Ctrl+G', action: () => ed.group() });
    if (gs.canUngroup) items.push({ label: 'Разгруппировать', hint: 'Ctrl+Shift+G', action: () => ed.ungroup() });
    if (gs.units > 1) {
      items.push({
        label: 'Выровнять',
        submenu: [
          { label: 'По левому краю', hint: 'Alt+A', action: () => ed.align('left') },
          { label: 'По центру', hint: 'Alt+H', action: () => ed.align('hcenter') },
          { label: 'По правому краю', hint: 'Alt+D', action: () => ed.align('right') },
          'sep',
          { label: 'По верхнему краю', hint: 'Alt+W', action: () => ed.align('top') },
          { label: 'По середине', hint: 'Alt+V', action: () => ed.align('vcenter') },
          { label: 'По нижнему краю', hint: 'Alt+S', action: () => ed.align('bottom') },
          'sep',
          { label: 'Распределить по горизонтали', hint: 'Alt+Shift+H', disabled: gs.units < 3, action: () => ed.distribute('x') },
          { label: 'Распределить по вертикали', hint: 'Alt+Shift+V', disabled: gs.units < 3, action: () => ed.distribute('y') },
          'sep',
          { label: 'Выстроить в ряд', action: () => ed.tidy('x') },
          { label: 'Выстроить в столбец', action: () => ed.tidy('y') },
        ],
      });
    }
    if (gs.canGroup || gs.canUngroup || gs.units > 1) items.push('sep');
    items.push(
      { label: 'Стиль', submenu: styleSubmenu() },
      { label: 'На слой', submenu: layerSubmenu() },
    );
    if (single && text) items.push({ label: 'В документ', action: () => void convertToDoc() });
    items.push('sep', { label: 'Экспорт выделенного…', hint: 'PNG, JPG, PDF', action: () => openExport('selection') }, 'sep');
    if (single && file) items.push({ label: 'Удалить файл с диска…', danger: true, action: () => void trashSelectedFile() });
    items.push({ label: 'Убрать с доски', hint: 'Delete', danger: true, action: () => ed.deleteSelection() });
    return items;
  }

  /** Меню по пустой доске: вставить и создать здесь, выделить всё, фон, стили, экспорт. */
  function boardMenu(at: { x: number; y: number }): MenuEntry[] {
    const ed = opened!.editor;
    const bg = opened!.store.doc.background ?? { color: BOARD_BACKGROUND[theme()], grid: 'dots' as GridKind };
    return [
      { label: 'Вставить здесь', hint: 'Ctrl+V', action: () => void ed.pasteAt(at) },
      {
        label: 'Создать здесь',
        submenu: [
          { label: 'Стикер', hint: 'N', action: () => ed.createStickyAt(at) },
          { label: 'Текст', hint: 'T', action: () => ed.createTextAt(at) },
          { label: 'Документ', hint: 'D', action: () => void createDoc(at) },
          { label: 'Прямоугольник', hint: 'R', action: () => ed.createShapeAt(at, 'rect') },
          { label: 'Овал', hint: 'O', action: () => ed.createShapeAt(at, 'ellipse') },
        ],
      },
      { label: 'Фото и файлы…', action: () => filePicker.click() },
      { label: 'Комментарий здесь', hint: 'C', action: () => { setOpenThread(null); setDraft(at); } },
      'sep',
      { label: 'Выделить всё', hint: 'Ctrl+A', action: () => ed.selectAll() },
      { label: 'Показать всю доску', hint: 'Shift+1', action: () => view()!.fitAll() },
      'sep',
      {
        label: 'Фон',
        submenu: [
          ...GRIDS.map((g): MenuEntry => ({ label: g.name, checked: bg.grid === g.grid, action: () => setBackground({ grid: g.grid }) })),
          'sep',
          ...BACKGROUNDS.map((b): MenuEntry => ({ label: b.name, swatch: b.color, checked: bg.color === b.color, action: () => setBackground({ color: b.color }) })),
        ],
      },
      { label: 'Стили доски…', action: () => setStylesOpen(true) },
      { label: 'Слои…', hint: 'Shift+L', action: () => setLayersOpen(true) },
      { label: 'Комментарии…', hint: 'Shift+C', action: () => setCommentsOpen(true) },
      { label: hideDone() ? 'Показать завершённые комментарии' : 'Скрыть завершённые комментарии', action: () => setHideDone(!hideDone()) },
      'sep',
      { label: 'Экспорт доски…', hint: 'PNG, JPG, PDF', action: () => openExport('board') },
      { label: 'Опубликовать на сайт…', disabled: !opened?.session, action: () => setPublishing(true) },
    ];
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

  function sharedChanged(list: string[]) {
    const next = new Set(list);
    const cur = boardPath();
    const was = cur ? shared().has(cur) : false;
    setShared(next);
    if (cur && was !== next.has(cur)) void openBoard(cur);
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
    if (opened.live) {
      await opened.live.save();
      opened.live.close();
    }
    opened.presence?.destroy();
    setPeers([]);
    opened.editor.destroy();
    opened.embeds.destroy();
    opened.pins.destroy();
    opened.minimap.destroy();
    setOpenThread(null);
    setDraft(null);
    opened.off();
    opened = null;
    setEditor(undefined);
    setUi(undefined);
    setSave(null);
  }

  /** Показать документ на доске: хранилище, редактор, сохранение. */
  async function mount(doc: BoardDoc, path: string | null, mtime: number | 'new', note: string, started: number, live: LiveSession | null = null) {
    await closeCurrent();
    const v = view()!;
    const store = new BoardStore(doc);
    const cam = path ? loadCamera(path) : null;
    v.paths = new BoardPaths(path ? boardFolderOf(path) : '');
    v.load(doc, !cam);
    if (cam) v.setCamera(cam);
    cameraPath = path;

    const ed = new Editor(store, v, host, perf);
    // Сайт и гость без права правки — только смотреть (комментатор ещё и комментирует).
    ed.readOnly = SITE || (!!live && (live.role === 'view' || live.role === 'comment'));
    ed.canComment = !!live && live.role === 'comment';
    let uiQueued = false;
    ed.onUi = () => {
      if (uiQueued) return;
      uiQueued = true;
      queueMicrotask(() => {
        uiQueued = false;
        setUi(ed.ui());
        opened?.embeds.update();
        opened?.pins.update();
      });
    };
    ed.onNotice = flash;
    ed.onFiles = (files, at) => void uploadFiles(files, at);
    ed.onOpenImage = openViewer;
    ed.onOpenDoc = (path, mode) => setPanel({ path, mode });
    ed.onCreateDoc = (at) => void createDoc(at);
    ed.onQuickOpen = () => setQuick(true);
    ed.onUnfurl = (id, url) => void unfurlLink(id, url);
    const embeds = new EmbedLayer(host, v, store, () => ed.ui().selection);
    embeds.sticky = ed.readOnly;
    const minimap = new Minimap(host, v, store);
    minimap.setVisible(minimapOn());
    const comments = new Comments(store, v);
    const pins = new CommentsLayer(host, v, comments);
    pins.hideDone = hideDone();
    pins.onOpen = (id) => showThread(id);
    pins.onContextMenu = (id, e) => setMenu({ x: e.clientX, y: e.clientY, items: pinMenu(id) });
    ed.onComment = (at) => { closeThread(); setDraft(at); };
    ed.onCommentsPanel = () => setCommentsOpen(!commentsOpen());
    ed.onSearch = () => setSearchOpen(true);
    ed.onPlayEmbed = (id) => embeds.play(id);
    ed.onLayers = () => setLayersOpen(!layersOpen());
    ed.onContextMenu = (e) => setMenu({ x: e.clientX, y: e.clientY, items: e.target ? objectMenu(e.at) : boardMenu(e.at) });
    const off = store.onChange((ops) => {
      v.apply(ops);
      ed.storeChanged(ops);
      embeds.itemsChanged();
      pins.update();
      minimap.itemsChanged();
      // Обсуждение удалили (или отменили его создание) — закрыть окно.
      const open = openThread();
      if (open && !comments.get(open)) closeThread();
    });

    let session: BoardSession | null = null;
    let restored = 0;
    let presence: PresenceLayer | null = null;
    if (live) {
      // Общая доска: файл пишет сервер, правки уходят ему; история отмены — только на этот сеанс.
      presence = new PresenceLayer(host, v);
      const p = presence;
      live.onState = setSave;
      live.onPeers = (list) => {
        setPeers([...list]);
        p.setPeers(list, live.client);
      };
      live.onCursor = (id, c) => p.cursor(id, c);
      live.onKicked = () => {
        setError(guest() ? 'Автор отозвал приглашение или поменял твою роль — открой ссылку заново' : 'Сервер отключил эту вкладку от доски');
        ed.readOnly = true;
      };
      live.start(store);
    } else if (path && !SITE) {
      // На сайте доска только читается: ни сохранения, ни истории отмены.
      session = new BoardSession(store, path, mtime);
      session.onState = (st) => {
        setSave(st);
        // Первое сохранение импортированной доски создаёт новый файл — показать его в списке.
        if (st.kind === 'saved' && !boards().some((b) => b.path === path)) void refreshBoards();
      };
      restored = await session.start();
    }
    opened = { store, editor: ed, embeds, comments, pins, minimap, session, live, presence, off };
    if (import.meta.env.DEV) Object.assign(window, { __store: store, __editor: ed });
    setEditor(ed);
    setUi(ed.ui());
    setCurrent(path ?? note);
    if (SITE && path) document.title = `${boardTitleOf(path)} — vaultboard`;
    setError('');
    const historyNote = restored ? ` · история: ${restored} шагов назад` : live ? ' · общая доска, правки видны всем вживую' : '';
    setStatus(`${note} · ${doc.items.length} объектов · открыто за ${(performance.now() - started).toFixed(0)} мс${historyNote}`);
  }

  /** Имя на общей доске: у автора — из настроек, у гостя — спросим один раз. */
  function liveName(): string {
    const g = guest();
    if (!g) return author();
    let name = '';
    try {
      name = localStorage.getItem(GUEST_NAME_KEY) ?? '';
    } catch {
      // Не запомнится — спросим в следующий раз.
    }
    if (!name) {
      name = (window.prompt('Как тебя подписать на доске? Это имя увидят остальные.', g.label || '') ?? '').trim().slice(0, 40) || g.label || 'Гость';
      try {
        localStorage.setItem(GUEST_NAME_KEY, name);
      } catch {
        // Не запомнится.
      }
    }
    return name;
  }

  async function openLive(path: string, started: number) {
    const live = new LiveSession(path, liveName());
    const text = await live.join();
    await mount(parseBoard(text), path, 'new', guest() ? `Доска автора ${guest()!.owner}` : 'Общая доска', started, live);
  }

  async function openBoard(path: string) {
    const started = performance.now();
    setBench(null);
    try {
      if (guest() || shared().has(path)) {
        await openLive(path, started);
        if (!guest()) {
          history.replaceState(null, '', `?open=${encodeURIComponent(path)}`);
          try {
            localStorage.setItem(LAST_BOARD_KEY, path);
          } catch {
            // Не запомнится.
          }
        }
        return;
      }
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
      // Запомнить доску: следующий запуск откроет её же, на том же месте (место на доске помнится отдельно).
      try {
        localStorage.setItem(LAST_BOARD_KEY, path);
      } catch {
        // Не запомнится — откроется черновик.
      }
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
    v.setDefaultBackground(BOARD_BACKGROUND[theme()]);
    // «Как в системе»: Windows переключилась на тёмную — и приложение за ней.
    onCleanup(onSystemTheme(() => {
      if (themeChoice() === 'system') setTheme('system');
    }));
    v.onCamera = () => {
      setZoom(v.cam.zoom);
      opened?.editor.cameraChanged();
      opened?.embeds.update();
      opened?.pins.update();
      opened?.minimap.cameraChanged();
      opened?.presence?.update();
      const path = cameraPath;
      if (path) {
        clearTimeout(cameraTimer);
        cameraTimer = window.setTimeout(() => saveCamera(path, v.cam), 400);
      }
    };
    setView(v);
    // Координаты курсора в углу: не чаще раза в кадр.
    let cursorFrame = 0;
    host.addEventListener('pointermove', (e) => {
      // Курсор для участников общей доски — сразу (сессия сама шлёт не чаще раза в 60 мс).
      if (opened?.live) {
        const r = host.getBoundingClientRect();
        opened.live.cursor(v.screenToWorld(e.clientX - r.left, e.clientY - r.top));
      }
      if (cursorFrame) return;
      cursorFrame = requestAnimationFrame(() => {
        cursorFrame = 0;
        const r = host.getBoundingClientRect();
        setCursor(v.screenToWorld(e.clientX - r.left, e.clientY - r.top));
      });
    });
    host.addEventListener('pointerleave', () => {
      setCursor(null);
      opened?.live?.cursor(null);
    });
    // Щелчок по доске мимо окна обсуждения закрывает его, как в Miro (булавки открывают своё сами).
    host.addEventListener('pointerdown', (e) => {
      if ((openThread() || draft()) && !(e.target as HTMLElement).closest('.comment-pin')) closeThread();
    }, true);
    v.setDocs(docs, markdown);
    /** Гость по приглашению — откроем его доску; без приглашения (blocked) — ничего не открываем. */
    let guestBoard: string | null = null;
    let blocked = false;
    if (SITE) {
      const invite = new URLSearchParams(location.search).get('invite');
      if (invite) {
        // Ссылка-приглашение ведёт на сайт с постоянным адресом, а сайт — к автору, пока его vaultboard в сети.
        try {
          const live = (await (await fetch('live.json', { cache: 'no-store' })).json()) as { url?: string | null };
          if (live.url && (await fetch(`${live.url}/api/guest/ping`, { cache: 'no-store' })).ok) {
            location.replace(`${live.url}/?invite=${encodeURIComponent(invite)}`);
            return;
          }
        } catch {
          // Автора нет в сети — покажем опубликованный снимок.
        }
        setNeedInvite('offline');
        flash('Автор сейчас не в сети — показан опубликованный снимок доски. Правка по приглашению откроется, когда он будет в сети.');
        history.replaceState(null, '', location.pathname);
      }
      // Сайт: список досок и файлов — из манифеста рядом со страницей.
      try {
        await vault.init();
      } catch (err) {
        setError((err as Error).message);
      }
      void files.refresh().catch(() => undefined);
    } else {
      // Пришли по ссылке-приглашению: сервер запомнит приглашение, а ссылку уберём из адреса.
      const invite = new URLSearchParams(location.search).get('invite');
      if (invite) {
        await vault.guestLogin(invite).catch((err: Error) => setNeedInvite(err.message));
        history.replaceState(null, '', location.pathname);
      }
      const me = await vault.guestMe().catch((err: Error) => {
        setNeedInvite((cur) => cur || err.message);
        return null;
      });
      setKnown(true);
      if (me?.guest) {
        setGuest(me);
        setBoards([{ path: me.board, kind: 'board', size: 0, mtime: 0 }]);
        setRoot(`Доска ${me.owner} · ты ${me.role === 'edit' ? 'правишь' : me.role === 'comment' ? 'комментируешь' : 'смотришь'}`);
        document.title = `${me.title} — vaultboard`;
        void files.refresh().catch(() => undefined);
        guestBoard = me.board;
      } else if (!me) {
        blocked = true;
      } else {
        const sharedNow = await vault.invites('').catch(() => null);
        if (sharedNow) setShared(new Set(sharedNow.shared));
        // Папка с досками ещё не выбрана (новый компьютер) — сначала первая настройка, остальное после неё.
        const info = await vault.setup().catch(() => null);
        if (info && !info.root) setSetup(info);
        else {
          void files.refresh().catch(() => undefined);
          void vault.getLibrary().then(setLibrary).catch(() => undefined);
        }
      }
    }
    if (import.meta.env.DEV) Object.assign(window, { __view: v, __docs: docs, __files: files });

    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) setShowPerf((s) => !s);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (opened?.session?.hasUnsaved) {
        void opened.session.save();
        e.preventDefault();
      }
      if (opened?.live?.hasUnsaved) {
        void opened.live.save();
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

    if (guestBoard) {
      await openBoard(guestBoard);
      return;
    }
    if (blocked) return;
    if (!SITE) void watchOutsideChanges();
    const params = new URLSearchParams(location.search);
    if (!setup()) await refreshBoards().catch((err: Error) => setError(err.message));
    if (params.get('bench')) await openBench(Number(params.get('bench')), params.get('auto') === '1');
    else if (params.get('open')) await openBoard(params.get('open')!);
    else {
      // Открыть доску, на которой остановились в прошлый раз (если она ещё есть).
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_BOARD_KEY);
      } catch {
        // Нет доступа к хранилищу браузера — начнём с черновика.
      }
      if (last && boards().some((b) => b.path === last)) await openBoard(last);
      else if (SITE && boards().length) await openBoard(boards()[0].path);
      else await mount(emptyBoard(), null, 'new', 'Черновик (не сохраняется) — создай или открой доску слева', performance.now());
    }
  });

  return (
    <div class="app">
      <aside
        class="sidebar"
        classList={{ collapsed: collapsed(), peek: collapsed() && peek() }}
        onMouseLeave={() => collapsed() && setPeek(false)}
      >
        <div class="side-head">
          <button class="side-brand" title={owner() ? 'Мастер настройки: папка с досками, имя, обновления' : 'vaultboard'} onClick={() => owner() && void openWizard()}>
            <span class="logo">vb</span>
            <span class="side-title">
              <b>
                vaultboard{' '}
                <Show when={owner()}>
                <span
                  class="side-version"
                  role="button"
                  title="Проверить обновления сейчас"
                  onClick={(e) => {
                    // Не открывать мастер настройки (щелчок по шапке) — это отдельная кнопка.
                    e.stopPropagation();
                    window.dispatchEvent(new Event(CHECK_UPDATE_EVENT));
                  }}
                >
                  v{version()} ⟳
                </span>
                </Show>
                <Show when={update()}>
                  {(u) => <span class="side-update" title={`Вышла ${u().latest!.tag} — поставится при следующем запуске`}>↑ {u().latest!.tag}</span>}
                </Show>
              </b>
              <span class="root" title={root()}>{SITE ? 'Опубликованные доски · только просмотр' : root()}</span>
            </span>
          </button>
          <button class="icon-btn" title={collapsed() ? 'Закрепить панель' : 'Свернуть панель — она будет выезжать у левого края'} onClick={toggleSidebar}>
            {collapsed() ? '📌' : '⟨'}
          </button>
        </div>
        <div class="side-search">
          <input placeholder="Найти доску…" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div class="section">
          Доски
          <Show when={owner()}>
            <button class="section-btn" title="Новая доска" onClick={() => setNewName(newName() === null ? 'Доски/Новая доска' : null)}>+</button>
          </Show>
        </div>
        <Show when={newName() !== null}>
          <form class="new-board" onSubmit={(e) => { e.preventDefault(); void createBoard(newName()!); }}>
            <input
              value={newName()!}
              onInput={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setNewName(null); }}
              ref={(el) => setTimeout(() => el.select())}
            />
            <div class="new-board-hint">Папка доски от корня базы — в ней будет всё: доска, фото, документы, история. Enter — создать, Esc — отмена.</div>
            <input type="submit" hidden />
          </form>
        </Show>
        <div class="board-list">
          <For each={shownBoards()} fallback={<div class="empty">{filter() ? 'Ничего не нашлось' : 'Досок пока нет'}</div>}>
            {(b) => (
              <button class="board" classList={{ active: current() === b.path }} onClick={() => openBoard(b.path)} title={b.path}>
                <span class="board-icon">{b.kind === 'canvas' ? '◇' : '▦'}</span>
                <span class="board-name">{b.kind === 'board' ? boardTitleOf(b.path) : b.path.replace(/\.canvas$/i, '')}</span>
                <Show when={b.kind === 'canvas'}><span class="kind">Obsidian</span></Show>
              </button>
            )}
          </For>
        </div>
        <Show when={SITE}>
          <div class="site-foot">
            Доски только для просмотра: двигай мышью, колесо — зум, щелчок по заметке или фото — открыть, Ctrl+F — поиск.
            <br />
            Сделано в <a href="https://github.com/jestxfot/vaultboard" target="_blank" rel="noopener">vaultboard</a>
          </div>
        </Show>
      </aside>
      <main class="stage">
        <div class="board-host" ref={host} />
        <Show when={collapsed() && !peek()}>
          <div class="sidebar-edge" onMouseEnter={() => setPeek(true)} title="Доски" />
        </Show>
        <Show when={editor() && ui() && canEdit() && known()}>
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
            onOpenStyles={() => setStylesOpen(true)}
          />
        </Show>
        <div class="topbar">
          <Show when={collapsed()}>
            <button class="icon-btn topbar-btn" title="Доски" onClick={() => setPeek(!peek())}>☰</button>
          </Show>
          <span class="title">{current() || 'Выбери доску слева'}</span>
          <Show when={owner() && /\.board$/i.test(current())}>
            <button class="topbar-publish" title="Пригласить на эту доску по ссылке: смотреть, комментировать или править вместе вживую" onClick={() => setInviting(true)}>
              {shared().has(current()) ? 'Общая · пригласить' : 'Пригласить'}
            </button>
            <button class="topbar-publish" title="Опубликовать доску на сайт — только для просмотра" onClick={() => setPublishing(true)}>Опубликовать</button>
          </Show>
          <Show when={peers().length > 1}>
            <span class="peers" title={`На доске: ${peers().map((p) => p.name).join(', ')}`}>
              <For each={peers()}>{(p) => <span class="peer-dot" style={{ background: p.color }}>{p.name.slice(0, 1).toUpperCase()}</span>}</For>
            </span>
          </Show>
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
        <div class="corner">
          <Show when={editor() && ui() && !SITE && known()}>
            {(() => {
              const threads = () => (ui(), opened?.comments.threads ?? []);
              const open = () => threads().filter((t) => !isDone(t)).length;
              const done = () => threads().length - open();
              return (
                <>
                  <Show when={done()}>
                    <button
                      class="help-btn layers-btn"
                      classList={{ on: !hideDone() }}
                      title={hideDone() ? `Показать завершённые комментарии (${done()})` : 'Скрыть завершённые комментарии'}
                      onClick={() => setHideDone(!hideDone())}
                    >
                      {hideDone() ? `✓ ${done()} скрыто` : '✓ видны'}
                    </button>
                  </Show>
                  <button class="help-btn layers-btn" classList={{ on: commentsOpen() }} title="Комментарии (Shift+C)" onClick={() => setCommentsOpen(!commentsOpen())}>
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 16V9a6 6 0 1 1 6 6H4Z" /></svg>
                    {open()}
                  </button>
                </>
              );
            })()}
          </Show>
          <Show when={editor() && ui() && canEdit() && known()}>
            <button
              class="help-btn layers-btn"
              classList={{ on: layersOpen() }}
              title="Слои (Shift+L)"
              onClick={() => setLayersOpen(!layersOpen())}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2 14.5 5.5 8 9 1.5 5.5Z" /><path d="M1.5 8.5 8 12 14.5 8.5" /><path d="M1.5 11.5 8 15 14.5 11.5" /></svg>
              {/* Когда слоёв несколько — на кнопке имя активного: сразу видно, куда лягут новые объекты. */}
              {(ui(), editor()!.layers().length > 1 ? editor()!.layers().find((l) => l.id === editor()!.activeLayer)?.name : 'Слои')}
            </button>
          </Show>
          <button
            class="help-btn"
            title={`Тема: ${THEME_NAMES[themeChoice()]}. Щелчок — ${THEME_NAMES[nextTheme()]}`}
            onClick={() => setTheme(nextTheme())}
          >
            {theme() === 'dark' ? '☾' : '☀'}
          </button>
          <button class="help-btn" classList={{ on: minimapOn() }} title={minimapOn() ? 'Скрыть миникарту' : 'Показать миникарту'} onClick={() => setMinimapOn(!minimapOn())}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4" width="15" height="12" rx="1.5" /><rect x="9" y="8.5" width="6" height="5" rx=".8" fill="currentColor" fill-opacity=".25" /></svg>
          </button>
          <Show when={owner()}>
            <button class="help-btn" title="Настройки" onClick={() => setSettings(true)}>⚙</button>
            <button class="help-btn" title="Горячие клавиши" onClick={() => setHelp(true)}>?</button>
          </Show>
          <Show when={cursor()}>
            {(c) => (
              <div class="coords" title="Координаты на доске: центр 0, 0 отмечен крестиком">
                x {Math.round(c().x)} · y {Math.round(c().y)}
              </div>
            )}
          </Show>
          <div class="zoom">{Math.round(zoom() * 100)}%</div>
        </div>
        <Show when={setup()}>
          {(info) => (
            <SetupDialog
              info={info()}
              current={wizardAgain()}
              onCancel={wizardAgain() ? () => { setSetup(null); setWizardAgain(null); } : undefined}
              onDone={(rootChanged) => {
                const again = wizardAgain();
                setSetup(null);
                setWizardAgain(null);
                // Повторный запуск сменил папку — открыть приложение заново с новыми досками.
                if (again && rootChanged) {
                  location.reload();
                  return;
                }
                void refreshBoards().catch((err: Error) => setError(err.message));
                void files.refresh().catch(() => undefined);
                void vault.getLibrary().then(setLibrary).catch(() => undefined);
                void vault.getSettings().then((s) => setAuthor(s.author || s.defaultAuthor || 'Я'), () => undefined);
                flash(again ? 'Настройки сохранены' : 'Готово. Создай первую доску кнопкой «+» слева');
              }}
            />
          )}
        </Show>
        <Show when={owner()}>
        <Updater
          onStatus={setUpdate}
          onNotice={flash}
          onVersion={setVersion}
          beforeRestart={async () => {
            if (opened?.session?.hasUnsaved) await opened.session.save();
          }}
        />
        </Show>
        <Show when={inviting() && /\.board$/i.test(current())}>
          <InviteDialog board={current()} title={boardTitleOf(current())} onClose={() => setInviting(false)} onChanged={sharedChanged} />
        </Show>
        <Show when={needInvite() && needInvite() !== 'offline' && !SITE}>
          <div class="guest-gate">
            <div class="dialog setup">
              <div class="setup-title">Нужна ссылка-приглашение</div>
              <div class="step-note">{needInvite()}</div>
              <div class="step-note">Это доска vaultboard на чужом компьютере. Попроси у автора ссылку-приглашение и открой её.</div>
            </div>
          </div>
        </Show>
        <Show when={publishing() && /\.board$/i.test(current())}>
          <PublishDialog board={current()} onClose={() => setPublishing(false)} onDone={flash} />
        </Show>
        <Show when={settings()}>
          <SettingsDialog onClose={() => setSettings(false)} onSaved={(s) => s.author && setAuthor(s.author)} />
        </Show>
        <Show when={help()}>
          <HelpDialog onClose={() => setHelp(false)} onBench={(n) => void openBench(n, true)} />
        </Show>
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
            readOnly={SITE}
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
        <Show when={menu()}>
          <ContextMenu x={menu()!.x} y={menu()!.y} items={menu()!.items} onClose={() => setMenu(null)} />
        </Show>
        <Show when={exporting() && view()}>
          <ExportDialog
            board={view()!.boardBounds}
            selection={exporting()!.selection}
            initialArea={exporting()!.area}
            onExport={runExport}
            onClose={() => setExporting(null)}
          />
        </Show>
        <Show when={stylesOpen() && editor() && ui()}>
          <StylesPanel
            editor={editor()!}
            ui={ui()!}
            library={library()}
            onSaveToLibrary={(name, def) => {
              const next = { ...library(), [name]: def };
              setLibrary(next);
              void vault.putLibrary(next);
              flash(`Стиль «${name}» в общей библиотеке базы — его можно добавить на любую доску`);
            }}
            onClose={() => setStylesOpen(false)}
          />
        </Show>
        <Show when={searchOpen() && editor() && ui() && opened}>
          <SearchBar
            version={ui()}
            search={(q) => searchBoardWith(opened!.store.items, q, (i) => !view()!.isHidden(i), (id) => view()!.rectOf(id) ?? null)}
            onHighlight={(ids, cur) => opened?.editor.setSearchHighlight(ids, cur)}
            onReveal={(id) => opened?.editor.revealItem(id)}
            onClose={() => setSearchOpen(false)}
          />
        </Show>
        <Show when={commentsOpen() && editor() && ui() && opened}>
          <CommentsPanel
            comments={opened!.comments}
            version={ui()}
            hideDone={hideDone()}
            openId={openThread()}
            onHideDone={setHideDone}
            onOpen={(id) => showThread(id, true)}
            onClose={() => setCommentsOpen(false)}
          />
        </Show>
        <Show when={(openThread() || draft()) && opened && ui()}>
          {(() => {
            const anchor = () => {
              ui();
              zoom();
              const id = openThread();
              if (id) return opened?.pins.screenPoint(id) ?? { x: 0, y: 0 };
              const d = draft()!;
              return view()!.worldToScreen(d.x, d.y);
            };
            return (
              <>
                <Show when={draft()}>
                  <div class="comment-pin draft" style={{ transform: `translate(${anchor().x - 3}px, ${anchor().y - 28}px)` }}>
                    <svg width="30" height="30" viewBox="0 0 24 24"><path d="M2 22V11a9 9 0 1 1 9 9H2Z" fill="#4262ff" stroke="#fff" stroke-width="1.6" /></svg>
                  </div>
                </Show>
                <ThreadPopover
                  comments={opened!.comments}
                  threadId={openThread()}
                  draftAt={draft()}
                  anchor={anchor()}
                  author={author()}
                  markdown={markdown}
                  files={files}
                  from={current()}
                  version={ui()}
                  onCreated={(id) => showThread(id)}
                  onNavigate={(target, resolved) => {
                    // Из комментария заметку не создаём: ссылка на несуществующую — просто сообщение.
                    const path = resolved ?? files.resolve(target, current());
                    if (path) void navigate(target, path);
                    else flash(`Заметки «${target.split('|')[0]}» в базе нет`);
                  }}
                  onClose={closeThread}
                />
              </>
            );
          })()}
        </Show>
        <Show when={layersOpen() && editor() && ui()}>
          <LayersPanel editor={editor()!} ui={ui()!} onClose={() => setLayersOpen(false)} />
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
