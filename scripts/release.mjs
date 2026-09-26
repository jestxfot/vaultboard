// Выпуск релиза: npm run release -- 0.2.0   (или patch / minor / major)
//
// Что делает, по шагам — и останавливается на первой ошибке:
//   1. Проверяет, что всё закоммичено, типы сходятся, тесты проходят и приложение собирается.
//   2. Ставит новую версию в package.json и package-lock.json, коммитит «Релиз vX.Y.Z», ставит тег vX.Y.Z.
//   3. Отправляет ветку и тег на GitHub и создаёт релиз (gh release create) с описанием из коммитов
//      и готовой сборкой vaultboard.zip (scripts/pack.mjs): ей не нужны ни npm install, ни сборка.
// После этого у всех, кто запускает vaultboard.vbs с включённым автообновлением, при следующем запуске
// поставится эта версия (см. scripts/update.mjs).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: dir, stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { cwd: dir, encoding: 'utf8' }).trim();

function fail(text) {
  console.error(`\n✗ ${text}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail('Укажи версию: npm run release -- 0.2.0 (или patch / minor / major)');

const current = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const [a, b, c] = current.split('.').map(Number);
const next = arg === 'major' ? `${a + 1}.0.0` : arg === 'minor' ? `${a}.${b + 1}.0` : arg === 'patch' ? `${a}.${b}.${c + 1}` : arg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`Непонятная версия: ${arg}`);
const tag = `v${next}`;

if (out('git status --porcelain')) fail('Есть незакоммиченные правки — сначала закоммить их.');
if (out(`git tag --list ${tag}`)) fail(`Тег ${tag} уже есть.`);
try {
  out('gh auth status');
} catch {
  fail('Нет входа в GitHub CLI: gh auth login');
}

console.log(`Релиз ${current} → ${tag}\n\nПроверяю типы и тесты…`);
sh('npm run check');
sh('npm test');
// Релиз, который не собирается, у людей не запустится — проверяем сборку до публикации.
sh('npm run build');

// Описание релиза — заголовки коммитов с прошлого релиза.
const prev = out('git tag --list "v*" --sort=-v:refname').split('\n').filter(Boolean)[0];
const log = out(`git log --pretty=format:"- %s" ${prev ? `${prev}..HEAD` : ''}`);
const notes = `## Что нового\n\n${log || '- первый релиз'}\n\n**Установка:** скачай vaultboard.zip ниже, распакуй и дважды щёлкни vaultboard.vbs.\nУ кого vaultboard уже стоит — обновление поставится само.`;

sh(`npm version ${next} --no-git-tag-version`, { stdio: 'ignore' });
// Готовая сборка — уже с новым номером версии (по нему установки сверяют обновления).
sh('npm run build', { stdio: 'ignore' });
sh('npm run pack');
sh('git add package.json package-lock.json');
sh(`git commit -q -m "Релиз ${tag}"`);
sh(`git tag -a ${tag} -m "Релиз ${tag}"`);
sh('git push');
sh(`git push origin ${tag}`);
// Связь с GitHub иногда рвётся («unexpected EOF») — пробуем до трёх раз; если релиз успел создаться, второй не делаем.
const exists = () => {
  try {
    out(`gh release view ${tag} --json tagName`);
    return true;
  } catch {
    return false;
  }
};
for (let attempt = 1; ; attempt++) {
  try {
    execSync(`gh release create ${tag} release/vaultboard.zip --title "vaultboard ${tag}" --notes-file -`, { cwd: dir, input: notes, stdio: ['pipe', 'inherit', 'inherit'] });
    break;
  } catch (err) {
    if (exists()) break;
    if (attempt >= 3) throw err;
    console.log(`Создать релиз не вышло (попытка ${attempt}), пробую ещё раз…`);
    execSync(process.platform === 'win32' ? 'timeout /t 5 >nul' : 'sleep 5', { stdio: 'ignore', shell: true });
  }
}
console.log(`\n✓ Релиз ${tag} опубликован: https://github.com/jestxfot/vaultboard/releases/tag/${tag}`);
