// Автообновление vaultboard для тех, кто скачал архив с GitHub (а не git clone).
//
// Запуск: node scripts/update.mjs — его делает vaultboard.vbs перед каждым стартом.
// Обновляемся по релизам: https://github.com/jestxfot/vaultboard/releases
//   1. Копия из git (есть папка .git) не трогается: разработчик обновляется через git pull.
//   2. Спрашиваем у GitHub последний релиз. Нет сети, релизов нет, GitHub не ответил за несколько секунд —
//      молча запускаемся на том, что есть.
//   3. Номер релиза (тег v1.2.3) больше версии в package.json — скачиваем архив этого тега и раскладываем
//      файлы поверх. Сравниваем именно номера: кто скачал свежий main, не откатится на старый релиз.
//      Файлы, которые из проекта удалили, удаляем и у себя (по списку прошлой установки).
//      node_modules, dist и всё, чего нет в архиве (например, свои заметки рядом), не трогаем.
//   4. Поменялись зависимости (package-lock.json) или их ещё нет — npm install.
//
// Только встроенные модули Node: скрипт должен работать до того, как поставлены зависимости.
// Zip распаковываем сами (zlib) — без внешних программ, одинаково на любой системе.
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/** Откуда обновляться. Для проверки можно подменить переменными окружения. */
export const REPO = process.env.VAULTBOARD_REPO ?? 'jestxfot/vaultboard';
/** Для проверки на своей машине: адрес, где лежит «последний релиз» (JSON как у GitHub) — вместо GitHub. */
const RELEASE_API = process.env.VAULTBOARD_RELEASE_API ?? `https://api.github.com/repos/${REPO}/releases/latest`;
/** Файл в папке проекта: какая версия установлена и какие файлы она положила. */
export const STATE_FILE = '.vaultboard-version.json';
/** Эти папки обновление не трогает никогда. */
const KEEP = ['node_modules/', 'dist/', '.git/'];

/** Настройки этого компьютера — те же, что читает сервер (папка базы, прокси, автообновление). */
export function settingsFile() {
  const home = os.homedir();
  const dir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'vaultboard')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'vaultboard')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'vaultboard');
  return path.join(dir, 'settings.json');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Что положило прошлое обновление: { tag, date, files } или null (первый запуск распакованного архива). */
export function installedState(projectDir) {
  return readJson(path.join(projectDir, STATE_FILE));
}

export function isGitCheckout(projectDir) {
  return existsSync(path.join(projectDir, '.git'));
}

async function get(url, accept, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'vaultboard-updater', Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

/** Номер версии «1.2.3» или «v1.2.3» → [1, 2, 3]; не номер — null. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a новее b? */
export function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Версия установленной копии — из её package.json. */
export function currentVersion(projectDir) {
  return readJson(path.join(projectDir, 'package.json'))?.version ?? '0.0.0';
}

/** Разобрать ответ GitHub о релизе. Готовая сборка (vaultboard.zip в файлах релиза) — лучше архива исходников. */
function toRelease(r) {
  if (!r?.tag_name || !parseVersion(r.tag_name)) return null;
  const asset = (r.assets ?? []).find((a) => a?.name === 'vaultboard.zip');
  return {
    tag: r.tag_name,
    name: r.name || r.tag_name,
    notes: r.body ?? '',
    url: r.html_url ?? `https://github.com/${REPO}/releases`,
    // Готовая сборка не требует ни npm install, ни сборки; нет её — архив исходников тега.
    // Для проверки можно отдать свой адрес в поле vaultboard_zip.
    zip: r.vaultboard_zip ?? asset?.browser_download_url ?? `https://codeload.github.com/${REPO}/zip/refs/tags/${encodeURIComponent(r.tag_name)}`,
    prebuilt: !!(r.vaultboard_prebuilt ?? asset),
  };
}

/**
 * Последний релиз с условным запросом: передай ETag прошлого ответа — если на GitHub ничего не поменялось,
 * он ответит «304 не изменилось», и такой ответ не тратит лимит (60 запросов в час без входа).
 * Ответ: { changed: false } | { changed: true, release, etag } | { error, retryAt? } (retryAt — когда кончится лимит).
 */
export async function checkRelease(etag = '', timeoutMs = 6000) {
  try {
    const headers = { 'User-Agent': 'vaultboard-updater', Accept: 'application/vnd.github+json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(RELEASE_API, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 304) return { changed: false };
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      return { error: `лимит GitHub (${res.status})`, retryAt: reset ? reset * 1000 : Date.now() + 15 * 60_000 };
    }
    // Релизов ещё нет — это тоже ответ: новой версии нет.
    if (res.status === 404) return { changed: true, release: null, etag: res.headers.get('etag') ?? '' };
    if (!res.ok) return { error: `GitHub ответил ${res.status}` };
    return { changed: true, release: toRelease(await res.json()), etag: res.headers.get('etag') ?? '' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Последний релиз на GitHub: { tag, name, notes, url, zip, prebuilt } или null (нет сети, нет релизов).
 * Черновики и предрелизы GitHub в «latest» не отдаёт — обновляются только на настоящие релизы.
 */
export async function latestRelease(timeoutMs = 6000) {
  const r = await checkRelease('', timeoutMs);
  return r.changed ? r.release : null;
}

/**
 * Разобрать zip в памяти: центральный каталог в конце файла → для каждого файла его локальный заголовок → данные.
 * Сжатие — «без сжатия» (0) или deflate (8); другого GitHub не выдаёт.
 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Архив повреждён: нет оглавления');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Архив повреждён: запись оглавления');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Архив повреждён: заголовок файла');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`Неизвестное сжатие в архиве: ${method}`);
    out.push({ name, data });
  }
  return out;
}

function hashOf(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Путь из архива без верхней папки («vaultboard/» или «vaultboard-<версия>/»); опасные пути («..», абсолютные) отбрасываем.
 * `prebuilt` — готовая сборка: в ней dist уже собран и приходит из архива; из исходников dist не трогаем — его собирают у себя.
 */
function relName(name, prebuilt = false) {
  const rel = name.split('/').slice(1).join('/');
  if (!rel || rel.includes('..') || rel.startsWith('/') || /^[a-z]:/i.test(rel)) return null;
  if (KEEP.some((k) => rel.startsWith(k) && !(prebuilt && k === 'dist/'))) return null;
  return rel;
}

/** Установка — готовая сборка из релиза (vaultboard.zip): зависимости и сборка ей не нужны. */
export function isPrebuilt(projectDir) {
  return readJson(path.join(projectDir, 'package.json'))?.vaultboardPrebuilt === true;
}

/** Скачать релиз и разложить его поверх папки проекта. Возвращает, поменялся ли package-lock.json. */
export async function applyUpdate(projectDir, release, log = console.log) {
  log(`Скачиваю ${release.tag}…`);
  const res = await get(release.zip, 'application/zip', 120000);
  const entries = readZip(Buffer.from(await res.arrayBuffer()));
  const lockBefore = hashOf(path.join(projectDir, 'package-lock.json'));

  const files = [];
  // package.json — последним: в нём номер версии. Если запись оборвётся посреди обновления,
  // версия останется старой, и следующий запуск честно обновится ещё раз, а не застрянет на смеси файлов.
  const ordered = entries
    .map((e) => ({ rel: relName(e.name, release.prebuilt), data: e.data }))
    .filter((e) => e.rel)
    .sort((a, b) => (a.rel === 'package.json' ? 1 : 0) - (b.rel === 'package.json' ? 1 : 0));
  for (const e of ordered) {
    const rel = e.rel;
    const dest = path.join(projectDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // Сначала во временный файл, потом переименование: оборванная запись не оставит половину файла.
    const tmp = `${dest}.vb-update`;
    await fs.writeFile(tmp, e.data);
    await fs.rename(tmp, dest);
    files.push(rel);
  }

  // Файлы прошлой версии, которых в новой нет, — удалить (только по списку прошлой установки).
  const prev = installedState(projectDir);
  if (prev?.files) {
    const now = new Set(files);
    for (const rel of prev.files) {
      if (now.has(rel) || !relName(`x/${rel}`, true)) continue;
      const file = path.join(projectDir, ...rel.split('/'));
      await fs.rm(file, { force: true });
      // Опустевшие папки тоже убираем — вверх до папки проекта.
      for (let dir = path.dirname(file); dir.startsWith(projectDir) && dir !== projectDir; dir = path.dirname(dir)) {
        if ((await fs.readdir(dir).catch(() => ['?'])).length) break;
        await fs.rmdir(dir).catch(() => undefined);
      }
    }
  }

  await fs.writeFile(
    path.join(projectDir, STATE_FILE),
    JSON.stringify({ tag: release.tag, date: new Date().toISOString(), files }, null, 1),
    'utf8',
  );
  log(`Обновлено до ${release.tag}: ${files.length} файлов`);
  return lockBefore !== hashOf(path.join(projectDir, 'package-lock.json'));
}

/** Отметка «зависимости поставлены под такой package-lock.json» — пишется только после успешной установки. */
const DEPS_MARK = path.join('node_modules', '.vaultboard-deps');

/**
 * Нужна ли установка зависимостей: их нет, или они ставились под другой package-lock.json
 * (например, прошлая установка оборвалась — тогда отметки нет, и установка повторится).
 */
export function depsOutdated(projectDir) {
  const lock = hashOf(path.join(projectDir, 'package-lock.json'));
  let mark = null;
  try {
    mark = readFileSync(path.join(projectDir, DEPS_MARK), 'utf8').trim();
  } catch {
    // Отметки нет.
  }
  return !existsSync(path.join(projectDir, 'node_modules', '.package-lock.json')) || mark !== lock;
}

/** Поставить зависимости и отметить, под какой package-lock.json они стоят. */
export function installDeps(projectDir, log = console.log) {
  log('Ставлю зависимости (npm install)…');
  execSync('npm install --no-audit --no-fund', { cwd: projectDir, stdio: 'inherit' });
  const lock = hashOf(path.join(projectDir, 'package-lock.json'));
  if (lock) writeFileSync(path.join(projectDir, DEPS_MARK), lock, 'utf8');
}

async function main() {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const settings = readJson(settingsFile()) ?? {};

  if (isGitCheckout(projectDir)) {
    console.log('Копия из git — обновление через git pull, автообновление пропущено.');
  } else if (settings.autoUpdate === false && !process.env.VAULTBOARD_FORCE_UPDATE) {
    console.log('Автообновление выключено в настройках.');
  } else {
    const latest = await latestRelease();
    const current = currentVersion(projectDir);
    if (!latest) console.log('Релиз на GitHub не найден или GitHub не ответил — запускаюсь на текущей версии.');
    else if (!isNewer(latest.tag, current)) console.log(`Версия ${current} — последняя (релиз ${latest.tag}).`);
    else {
      try {
        await applyUpdate(projectDir, latest);
      } catch (err) {
        // Не вышло обновиться — не страшно: запускаемся на том, что есть.
        console.log(`Обновление не удалось: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Готовой сборке из релиза зависимости не нужны: сервер — один файл со всем внутри.
  if (!isPrebuilt(projectDir) && depsOutdated(projectDir)) installDeps(projectDir);
}

// Запущен как программа (node scripts/update.mjs), а не подключён сервером. Проверяем и имя файла:
// сервер готовой сборки — один файл, куда этот модуль вшит, и там import.meta.url — это сам сервер.
if (process.argv[1] && path.basename(process.argv[1]) === 'update.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
