// Перезапуск с обновлением — его запускает сервер (по кнопке «Обновить сейчас», по минуте без действий
// или сам, когда вышел релиз), а потом завершается.
//
// Этот скрипт живёт отдельно от сервера: ждёт, пока старый сервер освободит порт, обновляет программу
// (scripts/update.mjs: новый релиз и зависимости), собирает её и запускает сервер заново — в фоне, без окон.
// Страница в браузере тем временем ждёт и перезагружается сама, когда новый сервер ответит.
//
// Запуск: node scripts/restart.mjs [порт] [окружение base64] [start]. Лог — во временной папке, vaultboard.log.
// С последним аргументом «start» — первый запуск из vaultboard.vbs: старого сервера нет, обновление уже проверено,
// только собрать и запустить. Так сервер всегда живёт под этим скриптом, и перезапуск ведёт себя одинаково.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 5180);
// Сервер передаёт свои настройки окружения (папка настроек, адрес проверки релизов для тестов):
// на Windows этот процесс создаётся через WMI и окружение сервера не наследует.
if (process.argv[3]) {
  try {
    Object.assign(process.env, JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8')));
  } catch {
    // Не разобрали — работаем с тем окружением, что есть.
  }
}
const log = openSync(path.join(os.tmpdir(), 'vaultboard.log'), 'a');
const say = (text) => writeSync(log, `[перезапуск] ${text}\n`);

async function portBusy() {
  try {
    await fetch(`http://127.0.0.1:${port}/api/setup`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

const firstStart = process.argv[4] === 'start';

if (!firstStart) {
say('жду, пока старый сервер остановится');
for (let i = 0; i < 60 && (await portBusy()); i++) await new Promise((r) => setTimeout(r, 250));

say('обновляю');
// Обновление и зависимости; не вышло (нет сети) — всё равно запускаемся на том, что есть.
// Обновить просили кнопкой — значит, обновляемся, даже если автообновление при запуске выключено.
spawnSync(process.execPath, [path.join(dir, 'scripts', 'update.mjs')], {
  cwd: dir,
  stdio: ['ignore', log, log],
  windowsHide: true,
  env: { ...process.env, VAULTBOARD_FORCE_UPDATE: '1' },
});
}

// Готовая сборка из релиза — сразу запускаем сервер (секунда); из исходников — сначала собираем.
let prebuilt = false;
try {
  prebuilt = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).vaultboardPrebuilt === true;
} catch {
  // Нет package.json — считаем исходниками.
}
say(prebuilt ? 'запускаю' : 'собираю и запускаю');
// Сервер запускаем обычным дочерним процессом и остаёмся рядом, пока он работает: «отсоединённый» процесс
// на Windows получил бы собственное окно консоли (Windows Terminal показывает его даже со скрытием).
// Сам этот скрипт запущен скрыто (WMI со скрытым окном или vaultboard.vbs), и сервер наследует его невидимую консоль.
const child = prebuilt
  ? spawn(process.execPath, [path.join(dir, 'dist-server', 'server.mjs'), String(port)], { cwd: dir, windowsHide: true, stdio: ['ignore', log, log] })
  : spawn('npm run stable', { cwd: dir, shell: true, windowsHide: true, stdio: ['ignore', log, log] });
child.on('exit', (code) => {
  say(`сервер завершился (${code ?? 'сигнал'})`);
  process.exit(0);
});
