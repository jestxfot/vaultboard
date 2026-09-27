// Публикация доски на сайт: папка, которую можно выложить на Vercel (или любой хостинг статических файлов).
//
// В папке сайта лежат: само приложение в режиме просмотра (index.html + assets/), манифест site.json и файлы
// досок в f/ под именами по хэшу содержимого (одинаковое не копируется дважды, изменённое получает новое имя —
// поэтому его можно кэшировать навсегда), готовые превью фото в p/. Пути базы видны только в манифесте.
//
// Публикуется ровно то, что видно на доске: объекты скрытых слоёв, комментарии и история отмены на сайт не уходят.
// Из заметок — только те, что лежат на доске карточками, и картинки, вставленные в них через ![[…]].
import { createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { toAbsolute, walkVault } from './vaultFs.ts';
import { parseBoard, serializeBoard } from '../src/format/board.ts';
import { boardFolderOf, BoardPaths, boardTitleOf } from '../src/model/paths.ts';
import { embedTargets, LinkResolver } from '../src/format/links.ts';
import type { BoardDoc, Item } from '../src/model/types.ts';
import { isLine } from '../src/model/types.ts';

export const SITE_FORMAT = 'vaultboard-site/1';
export const MANIFEST = 'site.json';

export interface SiteFile {
  url: string;
  size: number;
  /** Превью 128 и 512 точек (только у фото, если они уже были готовы в кэше). */
  previews?: (string | null)[];
}

export interface SiteBoard {
  path: string;
  title: string;
  /** Когда опубликовано, ISO-строкой. */
  published: string;
  /** Файлы доски — пути от корня базы (сама доска первой). */
  files: string[];
}

export interface SiteManifest {
  format: typeof SITE_FORMAT;
  updated: string;
  boards: SiteBoard[];
  files: Record<string, SiteFile>;
}

export type PlanKind = 'board' | 'image' | 'doc' | 'file' | 'link' | 'embed';

export interface PlanFile {
  path: string;
  kind: PlanKind;
  size: number;
  /** Лежит вне папки доски — такие файлы показываем отдельно: их легко опубликовать случайно. */
  outside: boolean;
}

export interface PublishPlan {
  board: string;
  title: string;
  files: PlanFile[];
  /** На доске есть, а на диске нет. */
  missing: string[];
  total: number;
  /** Объектов на скрытых слоях — они не публикуются. */
  hiddenItems: number;
  /** Обсуждений на доске — не публикуются. */
  comments: number;
}

/** Доска такой, какой она уйдёт на сайт: без скрытых слоёв, обсуждений и линий к убранным объектам. */
export function publicBoard(doc: BoardDoc): { doc: BoardDoc; hiddenItems: number } {
  const hidden = new Set((doc.layers ?? []).filter((l) => l.hidden).map((l) => l.id));
  const removed = new Set<string>();
  const keep: Item[] = [];
  for (const item of doc.items) {
    if (item.layer && hidden.has(item.layer)) removed.add(item.id);
    else keep.push(item);
  }
  // Линия, прицепленная к убранному объекту, повисла бы в воздухе — тоже убираем.
  const items = keep.filter((i) => !isLine(i) || ![i.from, i.to].some((ep) => 'item' in ep && removed.has(ep.item)));
  const out: BoardDoc = { ...doc, items, comments: [] };
  if (doc.layers) out.layers = doc.layers.filter((l) => !l.hidden);
  return { doc: out, hiddenItems: doc.items.length - items.length };
}

/** Какие файлы нужны доске: фото, файлы, заметки, картинки ссылок и то, что вставлено в тексты через ![[…]]. */
export async function planBoard(root: string, board: string, opts: { all?: boolean } = {}): Promise<PublishPlan & { doc: BoardDoc }> {
  const original = parseBoard(await fs.readFile(toAbsolute(root, board), 'utf8'));
  // `all` — все объекты, со скрытыми слоями (так гостю нужны файлы общей доски); без него — как для сайта.
  const { doc, hiddenItems } = opts.all ? { doc: original, hiddenItems: 0 } : publicBoard(original);
  const folder = boardFolderOf(board);
  const paths = new BoardPaths(folder);
  const wanted = new Map<string, PlanKind>([[board, 'board']]);
  const want = (p: string | undefined, kind: PlanKind) => {
    if (p && !wanted.has(p)) wanted.set(p, kind);
  };
  const texts: { text: string; from: string }[] = [];
  for (const item of doc.items) {
    switch (item.kind) {
      case 'image': want(paths.toVault(item.file), 'image'); break;
      case 'file': want(paths.toVault(item.file), 'file'); break;
      case 'doc': want(paths.toVault(item.file), 'doc'); break;
      case 'link':
        if (item.image) want(paths.toVault(item.image), 'link');
        if (item.favicon) want(paths.toVault(item.favicon), 'link');
        break;
      case 'sticky':
      case 'card':
      case 'text':
      case 'shape':
        if (item.text?.includes('![[')) texts.push({ text: item.text, from: board });
        break;
    }
  }
  for (const [p, kind] of wanted) {
    if (kind !== 'doc') continue;
    const text = await fs.readFile(toAbsolute(root, p), 'utf8').catch(() => '');
    if (text.includes('![[')) texts.push({ text, from: p });
  }
  if (texts.length) {
    // Вставки ищутся по всей базе, как это делает Obsidian, — список путей нужен только в этом случае.
    const all: string[] = [];
    for await (const f of walkVault(root, () => true)) all.push(f.rel);
    const links = new LinkResolver(all);
    for (const t of texts) for (const target of embedTargets(t.text)) want(links.resolve(target, t.from) ?? undefined, 'embed');
  }
  const files: PlanFile[] = [];
  const missing: string[] = [];
  for (const [p, kind] of wanted) {
    const st = await fs.stat(toAbsolute(root, p)).catch(() => null);
    if (!st?.isFile()) {
      missing.push(p);
      continue;
    }
    files.push({ path: p, kind, size: st.size, outside: kind !== 'board' && !(folder ? p.startsWith(`${folder}/`) : !p.includes('/')) });
  }
  return {
    board,
    title: boardTitleOf(board),
    doc,
    files,
    missing,
    total: files.reduce((s, f) => s + f.size, 0),
    hiddenItems,
    comments: original.comments.length,
  };
}

async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), async function* (src) {
    for await (const chunk of src) hash.update(chunk as Buffer);
  });
  return hash.digest('hex');
}

function extOf(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

async function exists(abs: string): Promise<boolean> {
  return !!(await fs.stat(abs).catch(() => null));
}

/** Что можно найти в папке сайта, кроме нашего: следы git, Vercel и описание репозитория. */
const FOREIGN_OK = new Set(['.git', '.gitignore', '.gitattributes', '.vercel', 'README.md', 'LICENSE', 'vercel.json']);

export async function readManifest(siteDir: string): Promise<SiteManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(siteDir, MANIFEST), 'utf8')) as SiteManifest;
    return m.format === SITE_FORMAT ? m : null;
  } catch {
    return null;
  }
}

/** Папка подходит для сайта: пустая, свежий клон репозитория или уже наш сайт. Чужое не трогаем. */
async function checkSiteDir(siteDir: string): Promise<SiteManifest | null> {
  await fs.mkdir(siteDir, { recursive: true });
  const manifest = await readManifest(siteDir);
  if (manifest) return manifest;
  const foreign = (await fs.readdir(siteDir)).filter((n) => !FOREIGN_OK.has(n));
  if (foreign.length) {
    throw new Error(`В папке ${siteDir} уже есть другие файлы (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? '…' : ''}). Выбери пустую папку или папку сайта vaultboard.`);
  }
  return null;
}

export function isGitRepo(siteDir: string): boolean {
  return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: siteDir, encoding: 'utf8', windowsHide: true }).stdout?.trim() === 'true';
}

export function gitRemote(siteDir: string): string | null {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Запустить git и дождаться (не блокируя сервер: push может идти секунды). */
function git(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    p.on('error', (err) => resolve({ status: -1, stdout, stderr: err.message }));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Закоммитить и отправить сайт. Возвращает, что сказал git. */
export async function gitPush(siteDir: string, message: string): Promise<{ ok: boolean; output: string }> {
  const run = (args: string[]) => git(siteDir, args);
  const log: string[] = [];
  const add = await run(['add', '-A']);
  if (add.status !== 0) return { ok: false, output: add.stderr || add.stdout };
  const status = await run(['status', '--porcelain']);
  if (status.stdout.trim()) {
    const commit = await run(['commit', '-q', '-m', message]);
    log.push((commit.stdout + commit.stderr).trim());
    if (commit.status !== 0) return { ok: false, output: log.join('\n') };
  } else {
    log.push('Изменений нет — коммит не нужен');
  }
  const push = await run(['push', '-q', '-u', 'origin', 'HEAD']);
  log.push((push.stdout + push.stderr).trim());
  return { ok: push.status === 0, output: log.filter(Boolean).join('\n') };
}

/** Копировать приложение (готовую сборку) в папку сайта: index.html — с пометкой «это сайт», assets — только новые. */
async function copyApp(appDir: string, siteDir: string): Promise<void> {
  const index = await fs.readFile(path.join(appDir, 'index.html'), 'utf8').catch(() => null);
  if (!index) throw new Error(`Нет готовой сборки приложения (${appDir}). В копии для разработки сначала выполни npm run build.`);
  const marked = index.replace('<head>', '<head>\n    <meta name="vaultboard-site" content="1" />');
  await fs.writeFile(path.join(siteDir, 'index.html'), marked, 'utf8');
  const keep = new Set<string>();
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(path.join(appDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === 'index.html') continue;
      if (e.isDirectory()) {
        await fs.mkdir(path.join(siteDir, r), { recursive: true });
        await walk(r);
      } else {
        keep.add(r);
        // Файлы сборки с хэшем в имени не меняются — копируем только недостающие.
        const target = path.join(siteDir, r);
        if (!rel.startsWith('assets') || !(await exists(target))) await fs.copyFile(path.join(appDir, r), target);
      }
    }
  };
  await walk('');
  // Старые файлы прошлых версий приложения больше не нужны.
  const assets = path.join(siteDir, 'assets');
  for (const name of await fs.readdir(assets).catch(() => [] as string[])) {
    if (!keep.has(`assets/${name}`)) await fs.rm(path.join(assets, name), { force: true, recursive: true });
  }
}

const VERCEL_JSON = {
  headers: [
    { source: '/f/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/p/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/site.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
};

export interface PublishOptions {
  root: string;
  board: string;
  siteDir: string;
  /** Готовая сборка приложения (папка dist). */
  appDir: string;
  /** Где лежит готовое превью фото в кэше (или null, если его ещё не делали). */
  previewOf: (rel: string, level: 0 | 1) => Promise<string | null>;
  push: boolean;
}

export interface PublishResult {
  title: string;
  files: number;
  copied: number;
  copiedBytes: number;
  removed: number;
  missing: string[];
  git: { ok: boolean; output: string } | null;
}

/** Убрать из папки сайта файлы, на которые больше не ссылается ни одна опубликованная доска. */
async function sweep(siteDir: string, manifest: SiteManifest): Promise<number> {
  const used = new Set<string>();
  for (const f of Object.values(manifest.files)) {
    used.add(f.url);
    for (const p of f.previews ?? []) if (p) used.add(p);
  }
  let removed = 0;
  for (const dir of ['f', 'p']) {
    for (const name of await fs.readdir(path.join(siteDir, dir)).catch(() => [] as string[])) {
      if (used.has(`${dir}/${name}`)) continue;
      await fs.rm(path.join(siteDir, dir, name), { force: true });
      removed++;
    }
  }
  return removed;
}

async function writeManifest(siteDir: string, manifest: SiteManifest): Promise<void> {
  const file = path.join(siteDir, MANIFEST);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(manifest, null, 1), 'utf8');
  await fs.rename(`${file}.tmp`, file);
}

export async function publishBoard(o: PublishOptions): Promise<PublishResult> {
  const siteDir = path.resolve(o.siteDir);
  const old = await checkSiteDir(siteDir);
  const plan = await planBoard(o.root, o.board);
  await copyApp(o.appDir, siteDir);
  if (!(await exists(path.join(siteDir, 'vercel.json')))) await fs.writeFile(path.join(siteDir, 'vercel.json'), JSON.stringify(VERCEL_JSON, null, 2), 'utf8');
  await fs.mkdir(path.join(siteDir, 'f'), { recursive: true });
  await fs.mkdir(path.join(siteDir, 'p'), { recursive: true });

  const manifest: SiteManifest = old ?? { format: SITE_FORMAT, updated: '', boards: [], files: {} };
  let copied = 0, copiedBytes = 0;
  const entries: Record<string, SiteFile> = {};
  for (const f of plan.files) {
    const abs = toAbsolute(o.root, f.path);
    let hash: string;
    let data: string | null = null;
    if (f.kind === 'board') {
      // Доска уходит без скрытых слоёв и обсуждений.
      data = serializeBoard(plan.doc);
      hash = createHash('sha256').update(data).digest('hex');
    } else {
      hash = await hashFile(abs);
    }
    const url = `f/${hash.slice(0, 20)}${extOf(f.path)}`;
    const target = path.join(siteDir, url);
    if (!(await exists(target))) {
      if (data !== null) await fs.writeFile(target, data, 'utf8');
      else await fs.copyFile(abs, target);
      copied++;
      copiedBytes += f.size;
    }
    const entry: SiteFile = { url, size: data !== null ? Buffer.byteLength(data) : f.size };
    if (f.kind === 'image') {
      const previews: (string | null)[] = [];
      for (const level of [0, 1] as const) {
        const src = await o.previewOf(f.path, level);
        if (!src) {
          previews.push(null);
          continue;
        }
        const purl = `p/${hash.slice(0, 20)}-${level}.webp`;
        if (!(await exists(path.join(siteDir, purl)))) await fs.copyFile(src, path.join(siteDir, purl));
        previews.push(purl);
      }
      if (previews.some(Boolean)) entry.previews = previews;
    }
    entries[f.path] = entry;
  }

  const boards = manifest.boards.filter((b) => b.path !== o.board);
  boards.push({ path: o.board, title: plan.title, published: new Date().toISOString(), files: plan.files.map((f) => f.path) });
  boards.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  // Файлы других опубликованных досок остаются как были (их не перечитываем), этой доски — новые.
  const files: Record<string, SiteFile> = {};
  for (const b of boards) for (const p of b.files) if (manifest.files[p] || entries[p]) files[p] = entries[p] ?? manifest.files[p];
  const next: SiteManifest = { format: SITE_FORMAT, updated: new Date().toISOString(), boards, files };
  await writeManifest(siteDir, next);
  const removed = await sweep(siteDir, next);
  const pushed = o.push ? await gitPush(siteDir, `Публикация: ${plan.title}`) : null;
  return { title: plan.title, files: plan.files.length, copied, copiedBytes, removed, missing: plan.missing, git: pushed };
}

/** Снять доску с сайта: убрать из манифеста и удалить файлы, которые больше никому не нужны. */
export async function unpublishBoard(siteDir: string, board: string, push: boolean): Promise<{ removed: number; git: { ok: boolean; output: string } | null }> {
  const manifest = await readManifest(path.resolve(siteDir));
  if (!manifest) throw new Error('В этой папке нет сайта vaultboard');
  const boards = manifest.boards.filter((b) => b.path !== board);
  const files: Record<string, SiteFile> = {};
  for (const b of boards) for (const p of b.files) if (manifest.files[p]) files[p] = manifest.files[p];
  const next: SiteManifest = { ...manifest, updated: new Date().toISOString(), boards, files };
  await writeManifest(siteDir, next);
  const removed = await sweep(siteDir, next);
  const title = manifest.boards.find((b) => b.path === board)?.title ?? board;
  return { removed, git: push ? await gitPush(siteDir, `Снята с сайта: ${title}`) : null };
}
