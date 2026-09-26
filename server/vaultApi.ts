// Плагин dev-сервера Vite: отдаёт браузеру файлы базы. Слушает только 127.0.0.1.
// В настольной версии (Tauri) этот слой заменится прямым доступом к диску.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRefs, toAbsolute, VaultPathError, walkVault } from './vaultFs.ts';
import { BoardFormatError, parseBoard } from '../src/format/board.ts';
import { boardFolderOf, historyPathOf } from '../src/model/paths.ts';
import { unfurl } from './unfurl.ts';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.board': 'application/json; charset=utf-8',
  '.canvas': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const BOARD_FILE = /\.(board|canvas)$/i;

/** Настройки этого компьютера (не доски): например, прокси для карточек ссылок. */
const SETTINGS_FILE = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'vaultboard', 'settings.json');

async function readSettings(): Promise<{ proxy?: string }> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) as { proxy?: string };
  } catch {
    return {};
  }
}

/** Кэш превью фото — вне базы, чтобы не раздувать её и git. Можно удалить целиком: превью сделаются заново. */
const PREVIEW_DIR = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'vaultboard', 'cache', 'previews');

/** Имя файла без символов, запрещённых в Windows. */
function safeName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120);
  return cleaned || 'файл';
}

/** Хэши уже лежащих файлов, чтобы не пересчитывать их при каждой вставке. */
const hashCache = new Map<string, { size: number; mtime: number; hash: string }>();

async function fileHash(abs: string): Promise<string> {
  const st = await fs.stat(abs);
  const cached = hashCache.get(abs);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.hash;
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), async function* (src) {
    for await (const chunk of src) hash.update(chunk as Buffer);
  });
  const digest = hash.digest('hex');
  hashCache.set(abs, { size: st.size, mtime: st.mtimeMs, hash: digest });
  return digest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function vaultApi(root: string): Plugin {
  const absRoot = path.resolve(root);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/boards') {
      const boards = [];
      for await (const f of walkVault(absRoot, (rel) => BOARD_FILE.test(rel))) {
        boards.push({ path: f.rel, kind: f.rel.toLowerCase().endsWith('.board') ? 'board' : 'canvas', size: f.size, mtime: f.mtime });
      }
      boards.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
      return sendJson(res, 200, { root: absRoot, boards });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/file') {
      const rel = url.searchParams.get('path') ?? '';
      const abs = toAbsolute(absRoot, rel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) return sendJson(res, 404, { error: `Нет файла: ${rel}` });
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Mtime', String(st.mtimeMs));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(abs).pipe(res);
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/board') {
      // Писать можно только файлы досок — сервер не должен уметь портить заметки и фото.
      const rel = url.searchParams.get('path') ?? '';
      if (!/\.board$/i.test(rel)) return sendJson(res, 403, { error: 'Писать можно только файлы досок .board' });
      const abs = toAbsolute(absRoot, rel);
      const expected = url.searchParams.get('mtime');
      const st = await fs.stat(abs).catch(() => null);
      if (expected === 'new' && st) return sendJson(res, 409, { error: `Файл уже есть: ${rel}`, exists: true });
      // Файл изменили снаружи (git, другая копия приложения) — не затираем молча.
      if (expected !== 'new' && expected !== 'force' && expected !== null && st && Math.abs(st.mtimeMs - Number(expected)) > 1) {
        return sendJson(res, 409, { error: 'Доску изменили снаружи', mtime: st.mtimeMs });
      }
      const body = await readBody(req);
      parseBoard(body); // не записываем испорченную доску
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // Атомарно: сначала во временный файл, потом переименование. Доска не останется полузаписанной.
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, abs);
      const done = await fs.stat(abs);
      return sendJson(res, 200, { mtime: done.mtimeMs });
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      // Все заметки и файлы базы — для поиска (Ctrl+K) и для [[вики-ссылок]].
      const files = [];
      for await (const f of walkVault(absRoot, () => true)) files.push({ path: f.rel, size: f.size, mtime: f.mtime });
      return sendJson(res, 200, { files });
    }

    if (req.method === 'PUT' && url.pathname === '/doc') {
      // Документ — обычная заметка .md, общая с Obsidian. Пишем атомарно и не затираем чужие правки молча.
      const rel = url.searchParams.get('path') ?? '';
      if (!/\.md$/i.test(rel)) return sendJson(res, 403, { error: 'Документом может быть только файл .md' });
      const abs = toAbsolute(absRoot, rel);
      const expected = url.searchParams.get('mtime');
      const st = await fs.stat(abs).catch(() => null);
      if (expected === 'new' && st) return sendJson(res, 409, { error: `Файл уже есть: ${rel}`, exists: true });
      if (expected !== 'new' && expected !== 'force' && expected !== null && st && Math.abs(st.mtimeMs - Number(expected)) > 1) {
        return sendJson(res, 409, { error: 'Заметку изменили снаружи (например, в Obsidian)', mtime: st.mtimeMs });
      }
      const body = await readBody(req);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, abs);
      const done = await fs.stat(abs);
      return sendJson(res, 200, { mtime: done.mtimeMs });
    }

    if (req.method === 'POST' && url.pathname === '/trash') {
      // Удаление файла с доски — не насовсем, а в корзину базы `.trash`, как делает Obsidian. Оттуда можно вернуть.
      const rel = url.searchParams.get('path') ?? '';
      if (/\.board$/i.test(rel) || rel.startsWith('.')) return sendJson(res, 403, { error: 'Этот файл так удалять нельзя' });
      const abs = toAbsolute(absRoot, rel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st?.isFile()) return sendJson(res, 404, { error: `Нет файла: ${rel}` });
      const trashDir = path.join(absRoot, '.trash');
      await fs.mkdir(trashDir, { recursive: true });
      const name = path.basename(abs);
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let target = path.join(trashDir, name);
      for (let i = 2; await fs.stat(target).then(() => true, () => false); i++) target = path.join(trashDir, `${stem} ${i}${ext}`);
      await fs.rename(abs, target);
      return sendJson(res, 200, { trashed: `.trash/${path.basename(target)}` });
    }

    if (url.pathname === '/history') {
      // История отмены лежит в папке доски (.история.jsonl) и переезжает вместе с ней. Только дописывается.
      const board = url.searchParams.get('board') ?? '';
      if (!/\.board$/i.test(board)) return sendJson(res, 400, { error: 'Неверный путь доски' });
      const abs = toAbsolute(absRoot, historyPathOf(board));
      if (req.method === 'POST') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.appendFile(abs, await readBody(req), 'utf8');
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        const text = await fs.readFile(abs, 'utf8').catch(() => '');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(text);
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      // Файл кладётся в папку доски байт в байт, без пережатия. Одинаковые файлы не дублируются.
      const board = url.searchParams.get('board') ?? '';
      if (!/\.board$/i.test(board)) return sendJson(res, 400, { error: 'Фото сохраняются в папку доски — сначала открой доску' });
      const name = safeName(url.searchParams.get('name') ?? '');
      const folder = boardFolderOf(board);
      const relDir = `${folder ? `${folder}/` : ''}фото`;
      const absDir = toAbsolute(absRoot, relDir);
      await fs.mkdir(absDir, { recursive: true });

      const tmp = path.join(absDir, `.upload-${process.pid}-${Date.now()}`);
      const hash = createHash('sha256');
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(req, counter, createWriteStream(tmp));
      const digest = hash.digest('hex');

      for (const e of await fs.readdir(absDir, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        const abs = path.join(absDir, e.name);
        const st = await fs.stat(abs);
        if (st.size === size && (await fileHash(abs)) === digest) {
          await fs.rm(tmp);
          return sendJson(res, 200, { path: `${relDir}/${e.name}`, deduped: true, size });
        }
      }

      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let final = name;
      for (let i = 2; await fs.stat(path.join(absDir, final)).then(() => true, () => false); i++) final = `${stem} (${i})${ext}`;
      const abs = path.join(absDir, final);
      await fs.rename(tmp, abs);
      const st = await fs.stat(abs);
      hashCache.set(abs, { size: st.size, mtime: st.mtimeMs, hash: digest });
      return sendJson(res, 200, { path: `${relDir}/${final}`, deduped: false, size });
    }

    if (url.pathname === '/preview') {
      const rel = url.searchParams.get('path') ?? '';
      const level = url.searchParams.get('level') ?? '';
      if (level !== '0' && level !== '1') return sendJson(res, 400, { error: 'Неверный уровень превью' });
      const st = await fs.stat(toAbsolute(absRoot, rel)).catch(() => null);
      if (!st) return sendJson(res, 404, { error: `Нет файла: ${rel}` });
      // Ключ зависит от времени и размера оригинала: поменялся файл — превью пересоздастся само.
      const key = createHash('sha1').update(`${absRoot}|${rel}|${st.mtimeMs}|${st.size}|${level}`).digest('hex');
      const file = path.join(PREVIEW_DIR, `${key}.webp`);
      if (req.method === 'GET') {
        const pst = await fs.stat(file).catch(() => null);
        if (!pst) return sendJson(res, 404, { error: 'Превью ещё нет' });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Content-Length', String(pst.size));
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of req) {
          total += (c as Buffer).length;
          if (total > 8 * 1024 * 1024) return sendJson(res, 413, { error: 'Превью слишком большое' });
          chunks.push(c as Buffer);
        }
        await fs.mkdir(PREVIEW_DIR, { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, Buffer.concat(chunks));
        await fs.rename(tmp, file);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && url.pathname === '/unfurl') {
      // Карточка ссылки: сервер читает страницу, картинки кладёт в папку доски «ссылки/».
      const body = JSON.parse(await readBody(req)) as { url: string; board: string };
      const folder = /\.board$/i.test(body.board ?? '') ? boardFolderOf(body.board) : '';
      try {
        // Как браузер: через прокси из настроек, иначе через системный (HTTPS_PROXY); не вышло — напрямую.
        const proxy = (await readSettings()).proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;
        try {
          return sendJson(res, 200, await unfurl(absRoot, folder, body.url, proxy));
        } catch (err) {
          if (!proxy) throw err;
          return sendJson(res, 200, await unfurl(absRoot, folder, body.url, undefined));
        }
      } catch (err) {
        return sendJson(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (url.pathname === '/settings') {
      if (req.method === 'GET') return sendJson(res, 200, await readSettings());
      if (req.method === 'PUT') {
        const next = JSON.parse(await readBody(req)) as { proxy?: string };
        if (next.proxy) new URL(next.proxy);
        await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
        await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 1), 'utf8');
        return sendJson(res, 200, next);
      }
    }

    if (url.pathname === '/library') {
      // Общая библиотека стилей базы — чтобы переносить удачные стили между досками.
      const abs = toAbsolute(absRoot, '.vaultboard/стили.json');
      if (req.method === 'GET') {
        const text = await fs.readFile(abs, 'utf8').catch(() => '{}');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(text);
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, body, 'utf8');
        await fs.rename(tmp, abs);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && url.pathname === '/resolve') {
      const body = JSON.parse(await readBody(req)) as { from: string; refs: string[] };
      return sendJson(res, 200, await resolveRefs(absRoot, body.from, body.refs));
    }

    sendJson(res, 404, { error: 'Нет такого запроса' });
  }

  return {
    name: 'vaultboard-vault-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        handle(req, res).catch((err: unknown) => {
          const status = err instanceof VaultPathError ? 403 : err instanceof BoardFormatError ? 400 : 500;
          sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        });
      });
    },
  };
}
