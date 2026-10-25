// Сервер приложения и связь окон с ним — без порта.
//
// Сервер (dist-server/server.mjs) работает отдельным процессом (utilityProcess) и слушает только свой канал:
// named pipe в Windows, unix-сокет в Linux. Окна открывают адреса vaultboard://…, а этот модуль передаёт каждый
// такой запрос в канал как есть — со всеми заголовками, телом и потоковым ответом (долгие запросы, события доски).
// Поэтому страница работает так же, как в браузере, а снаружи к серверу не подключиться: порта нет.
//
// Хост в адресе — какая папка: vaultboard://vault/ — папка с досками из настроек; vaultboard://ext-…/ — папка доски,
// открытой не из неё (корень передаётся серверу заголовком x-vaultboard-root).
import { protocol, utilityProcess, type UtilityProcess } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { log } from './log.ts';

export const SCHEME = 'vaultboard';
/** Хост окон папки с досками. */
export const MAIN_HOST = 'vault';
const ROOT_HEADER = 'x-vaultboard-root';
/** Заголовки, которые не передаём: адрес и происхождение страницы — свои (это окно приложения, а не чужой сайт). */
const DROP_REQUEST = new Set(['host', 'origin', 'referer', 'cookie']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding']);

let child: UtilityProcess | null = null;
let pipe = '';
/** Последние строки ошибок сервера — показать, если он не запустился. */
let errors = '';
/** Корни досок не из папки с досками: хост → папка. */
const roots = new Map<string, string>();

/** Схему vaultboard:// надо объявить до готовности приложения: как обычный защищённый сайт, с fetch и потоками. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true } },
  ]);
}

/** Хост окна для доски из этой папки (null — папка с досками). */
export function hostForRoot(root: string | null): string {
  if (!root) return MAIN_HOST;
  const host = `ext-${createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12)}`;
  roots.set(host, path.resolve(root));
  return host;
}

/** Папка, которую показывает окно с этим хостом (null — папка с досками из настроек). */
export function rootOfHost(host: string): string | null {
  return roots.get(host) ?? null;
}

/** Запрос к серверу из самого приложения (не из окна): JSON ответа. */
export function api<T>(host: string, pathAndQuery: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const root = rootOfHost(host);
    const req = http.request(
      { socketPath: pipe, path: pathAndQuery, headers: { host: 'localhost', ...(root ? { [ROOT_HEADER]: encodeURIComponent(root) } : {}) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            if ((res.statusCode ?? 500) >= 400) throw new Error(body || `ответ ${res.statusCode}`);
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('сервер не ответил за 5 секунд')));
    req.end();
  });
}

/** Передать запрос окна серверу через канал и вернуть его ответ потоком. */
function forward(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Только свои страницы: чужая (например, встроенный плеер видео) не может ходить в API приложения.
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null' && !origin.startsWith(`${SCHEME}://`)) return Promise.resolve(new Response('Нельзя', { status: 403 }));
  const root = url.host === MAIN_HOST ? null : rootOfHost(url.host);
  if (url.host !== MAIN_HOST && !root) return Promise.resolve(new Response('Неизвестная папка', { status: 404 }));

  const headers: Record<string, string> = { host: 'localhost' };
  request.headers.forEach((value, key) => {
    if (!DROP_REQUEST.has(key)) headers[key] = value;
  });
  if (root) headers[ROOT_HEADER] = encodeURIComponent(root);

  return new Promise((resolve) => {
    const req = http.request({ socketPath: pipe, method: request.method, path: url.pathname + url.search, headers }, (res) => {
      const out = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined || DROP_RESPONSE.has(key)) continue;
        for (const one of Array.isArray(value) ? value : [value]) out.append(key, one);
      }
      const status = res.statusCode ?? 502;
      const empty = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, statusText: res.statusMessage, headers: out }));
    });
    req.on('error', (err) => resolve(new Response(`Сервер vaultboard не ответил: ${err.message}`, { status: 502 })));
    if (request.body) Readable.fromWeb(request.body as unknown as NodeReadableStream).pipe(req);
    else req.end();
  });
}

/** Запустить сервер, дождаться ответа и начать передавать ему запросы окон. Не вышло — текст ошибки. */
export async function startServer(appDir: string, onCrash: (message: string) => void): Promise<string | null> {
  const entry = path.join(appDir, 'dist-server', 'server.mjs');
  if (!existsSync(entry)) return `Нет файла сервера: ${entry}\nСначала собери приложение: npm run build`;
  const id = `${process.pid}-${randomBytes(4).toString('hex')}`;
  pipe = process.platform === 'win32' ? `\\\\.\\pipe\\vaultboard-${id}` : path.join(os.tmpdir(), `vaultboard-${id}.sock`);

  log(`запускаю сервер ${entry}, канал ${pipe}`);
  const proc = utilityProcess.fork(entry, [], {
    cwd: appDir,
    stdio: 'pipe',
    serviceName: 'vaultboard-server',
    env: { ...process.env, VAULTBOARD_PIPE: pipe },
  });
  child = proc;
  let exited = null as number | null;
  proc.stdout?.on('data', (d: Buffer) => log(`сервер: ${String(d).trimEnd()}`));
  proc.stderr?.on('data', (d: Buffer) => {
    errors = (errors + String(d)).slice(-2000);
    log(`сервер: ${String(d).trimEnd()}`);
  });
  proc.on('exit', (code) => {
    exited = code;
    child = null;
    log(`сервер завершился (${code})`);
    onCrash(`Сервер vaultboard остановился (код ${code}).\n\n${errors.trim()}`);
  });

  for (let i = 0; i < 200; i++) {
    if (exited !== null) return errors.trim() || `Сервер завершился с кодом ${exited}`;
    try {
      await api(MAIN_HOST, '/api/setup');
      protocol.handle(SCHEME, forward);
      return null;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proc.kill();
  return 'Сервер не ответил за 20 секунд.';
}

/** Сервер ещё работает. */
export function serverRunning(): boolean {
  return child !== null;
}

/** Попросить сервер дописать всё на диск и выйти; не уложился в 5 секунд — завершить. */
export function stopServer(): Promise<void> {
  const proc = child;
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('сервер не завершился сам за 5 секунд — завершаю');
      proc.kill();
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.postMessage('quit');
  });
}

/** Windows выключается: попросить сервер дописать правки, не дожидаясь ответа. */
export function askServerToQuit(): void {
  child?.postMessage('quit');
}
