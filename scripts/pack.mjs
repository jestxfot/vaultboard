// Готовая сборка для релиза: release/vaultboard.zip.
//
// Внутри — всё, что нужно, чтобы запустить vaultboard одной командой node, без npm install и без сборки:
// собранное приложение (dist), сервер одним файлом (dist-server/server.mjs), обновление и перезапуск,
// vaultboard.vbs, README и package.json с отметкой «готовая сборка» (без списка зависимостей).
// Запускать после npm run build; scripts/release.mjs делает это сам и прикладывает архив к релизу.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOP = 'vaultboard';

const FILES = ['dist-server/server.mjs', 'scripts/update.mjs', 'scripts/restart.mjs', 'vaultboard.vbs', 'vaultboard-stop.vbs', 'README.md', 'LICENSE'];

function walk(rel) {
  const abs = path.join(dir, rel);
  return statSync(abs).isDirectory() ? readdirSync(abs).flatMap((n) => walk(`${rel}/${n}`)) : [rel];
}

for (const need of ['dist/index.html', 'dist-server/server.mjs']) {
  if (!existsSync(path.join(dir, need))) {
    console.error(`Нет ${need} — сначала npm run build`);
    process.exit(1);
  }
}

const src = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
// package.json готовой сборки: версия (по ней сверяются обновления) и отметка — зависимости не нужны.
const pkg = {
  name: src.name,
  version: src.version,
  description: src.description,
  license: src.license,
  type: 'module',
  vaultboardPrebuilt: true,
  scripts: { start: 'node dist-server/server.mjs', update: 'node scripts/update.mjs' },
};

const entries = [
  ...walk('dist').map((rel) => ({ rel, data: readFileSync(path.join(dir, rel)) })),
  ...FILES.map((rel) => ({ rel, data: readFileSync(path.join(dir, rel)) })),
  { rel: 'package.json', data: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`) },
];

// Простой zip: каждый файл сжат deflate, имена в UTF-8 (флаг 0x0800), без шифрования и без zip64 (архив небольшой).
const local = [];
const central = [];
let offset = 0;
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
for (const e of entries) {
  const name = Buffer.from(`${TOP}/${e.rel}`, 'utf8');
  const packed = zlib.deflateRawSync(e.data, { level: 9 });
  const crc = zlib.crc32(e.data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6);
  head.writeUInt16LE(8, 8);
  head.writeUInt16LE(dosTime, 10);
  head.writeUInt16LE(dosDate, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(e.data.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  local.push(head, name, packed);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt16LE(dosTime, 12);
  cen.writeUInt16LE(dosDate, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(packed.length, 20);
  cen.writeUInt32LE(e.data.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(offset, 42);
  central.push(cen, name);
  offset += head.length + name.length + packed.length;
}
const cenSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cenSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(path.join(dir, 'release'), { recursive: true });
const out = path.join(dir, 'release', 'vaultboard.zip');
const zip = Buffer.concat([...local, ...central, end]);
writeFileSync(out, zip);
console.log(`Готовая сборка ${src.version}: release/vaultboard.zip, ${entries.length} файлов, ${(zip.length / 1024 / 1024).toFixed(1)} МБ`);
