// Сервер приложения: отдаёт собранное приложение (папка dist) и API (/api/…).
// Без Vite и без node_modules — его вместе со всеми зависимостями собирают в один файл dist-server/server.mjs
// (npm run build).
//
// Два режима:
//   node dist-server/server.mjs [порт] — для браузера: слушает 127.0.0.1:порт (по умолчанию 5180).
//   Из настольного приложения (electron/server.ts задаёт VAULTBOARD_PIPE) — слушает только свой канал
//   (named pipe в Windows, unix-сокет в Linux), через который ходят окна приложения; порта нет вовсе,
//   пока доску не откроют гостям: тогда для туннеля открывается порт на 127.0.0.1.
//   Окно может показывать доску не из папки с досками — тогда в запросе заголовок x-vaultboard-root с её корнем,
//   и для этого корня работает свой сервер. Заголовок принимается только из канала, от гостей — никогда.
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVaultServer, type VaultServer } from './vaultApi.ts';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectDir, 'dist');
const port = Number(process.argv[2] ?? process.env.PORT ?? 5180);
/** Канал настольного приложения; нет его — обычный режим с портом. */
const pipe = process.env.VAULTBOARD_PIPE || null;
const ROOT_HEADER = 'x-vaultboard-root';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Файл приложения из dist. Файлы с отпечатком в имени (assets/…) кэшируются навсегда, index.html — никогда. */
async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  let abs = path.join(distDir, rel);
  if (!abs.startsWith(distDir)) {
    res.statusCode = 403;
    res.end();
    return;
  }
  let st = await fs.stat(abs).catch(() => null);
  // Нет такого файла и это не файл с расширением — отдать приложение (адреса вроде /?open=… разбирает оно само).
  if (!st?.isFile() && !path.extname(rel)) {
    rel = 'index.html';
    abs = path.join(distDir, rel);
    st = await fs.stat(abs).catch(() => null);
  }
  if (!st?.isFile()) {
    res.statusCode = 404;
    res.end('Не найдено');
    return;
  }
  res.setHeader('Content-Type', TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Cache-Control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  createReadStream(abs).pipe(res);
}

/** Какие запросы приходили за последние 30 секунд — чтобы по журналу понять, чем сервер занят. */
const hits = new Map<string, number>();
let lastCpu = process.cpuUsage();
setInterval(() => {
  const used = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const percent = ((used.user + used.system) / 1000 / 30_000) * 100;
  if (percent >= 10) {
    const top = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => `${p} ×${n}`).join(', ');
    console.log(`сервер занят: ${percent.toFixed(0)}% процессора за 30 с; запросы: ${top || 'нет'}`);
  }
  hits.clear();
}, 30_000).unref();

const servers: http.Server[] = [];

/** Порт для туннеля гостей. В обычном режиме — тот, что уже слушаем; в приложении — открывается по первой просьбе. */
let guestPort: Promise<number> | null = null;
function listen(): Promise<number> {
  if (!pipe) return Promise.resolve(port);
  guestPort ??= new Promise((resolve, reject) => {
    const tcp = http.createServer(handler(false));
    servers.push(tcp);
    tcp.once('error', reject);
    tcp.listen(0, '127.0.0.1', () => {
      const opened = (tcp.address() as AddressInfo).port;
      console.log(`порт для гостей: ${opened}`);
      resolve(opened);
    });
  });
  return guestPort;
}

/** Свой сервер на каждый корень: папка с досками (ключ '') и папки досок, открытых не из неё. */
const vaults = new Map<string, VaultServer>();
function vaultFor(root: string): VaultServer {
  let vault = vaults.get(root);
  if (!vault) {
    vault = createVaultServer(root || process.env.VAULT_ROOT || undefined);
    vault.start({ projectDir, listen });
    vaults.set(root, vault);
  }
  return vault;
}
vaultFor('');

/** Обработчик запросов. `fromPipe` — запрос из окна приложения: ему можно назвать корень доски заголовком. */
function handler(fromPipe: boolean): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const header = fromPipe ? req.headers[ROOT_HEADER] : undefined;
      const root = typeof header === 'string' && header ? path.resolve(decodeURIComponent(header)) : '';
      // API ждёт адрес без «/api» — так же, как в сервере разработки Vite.
      req.url = req.url!.slice(4) || '/';
      vaultFor(root).api(req, res);
      return;
    }
    serveStatic(url.pathname, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  };
}

const server = http.createServer(handler(!!pipe));
servers.push(server);
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? (pipe ? `Канал ${pipe} занят` : `Порт ${port} занят — vaultboard уже запущен?`) : err.message);
  process.exit(1);
});
if (pipe) server.listen(pipe, () => console.log(`vaultboard: канал ${pipe}`));
else server.listen(port, '127.0.0.1', () => console.log(`vaultboard: http://localhost:${port}/`));

/** Выход: сохранить то, что ещё не на диске, и завершиться. Повторная просьба во время выхода ничего не меняет. */
let quitting = false;
async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  for (const s of servers) s.close();
  await Promise.all([...vaults.values()].map((v) => v.shutdown().catch((err: unknown) => console.error(err))));
  process.exit(0);
}
process.on('SIGINT', () => void quit());
process.on('SIGTERM', () => void quit());
// Настольное приложение запускает сервер через utilityProcess (у процесса есть parentPort) и просит выйти сообщением «quit».
const parentPort = (process as NodeJS.Process & { parentPort?: { on: (event: 'message', cb: (e: { data: unknown }) => void) => void } }).parentPort;
parentPort?.on('message', (e) => {
  if (e.data === 'quit') void quit();
});
