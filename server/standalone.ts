// Собственный сервер готовой сборки: отдаёт собранное приложение (папка dist) и API (/api/…).
// Без Vite и без node_modules — его вместе со всеми зависимостями собирают в один файл dist-server/server.mjs
// (npm run build), поэтому готовой установке из релиза не нужны ни npm install, ни сборка: запуск — секунда.
//
// Запуск: node dist-server/server.mjs [порт]. Слушает только этот компьютер (127.0.0.1).
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVaultServer } from './vaultApi.ts';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectDir, 'dist');
const port = Number(process.argv[2] ?? process.env.PORT ?? 5180);

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

const vault = createVaultServer(process.env.VAULT_ROOT || undefined);
vault.start({ projectDir, port, canRestart: true });

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    // API ждёт адрес без «/api» — так же, как в сервере разработки Vite.
    req.url = req.url!.slice(4) || '/';
    vault.api(req, res);
    return;
  }
  serveStatic(url.pathname, res).catch(() => {
    res.statusCode = 500;
    res.end();
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Порт ${port} занят — vaultboard уже запущен?` : err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`vaultboard: http://localhost:${port}/`);
});
