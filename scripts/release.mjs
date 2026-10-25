// Выпуск релиза: npm run release -- 0.2.0   (или patch / minor / major)
//
// Что делает, по шагам — и останавливается на первой ошибке:
//   1. Проверяет, что всё закоммичено, типы сходятся, тесты проходят и приложение собирается.
//   2. Ставит новую версию в package.json и package-lock.json, коммитит «Релиз vX.Y.Z», ставит тег vX.Y.Z.
//   3. Отправляет ветку и тег на GitHub.
// Дальше всё делает GitHub (.github/workflows/release.yml): собирает установщики на Windows и Linux
// и выкладывает релиз — с latest*.yml и .blockmap, по которым установленные копии обновляются сами.
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

console.log(`Релиз ${current} → ${tag}\n\nПроверяю типы и тесты…`);
sh('npm run check');
sh('npm test');
// Релиз, который не собирается, у людей не запустится — проверяем сборку до публикации.
sh('npm run build');

sh(`npm version ${next} --no-git-tag-version`, { stdio: 'ignore' });
sh('git add package.json package-lock.json');
sh(`git commit -q -m "Релиз ${tag}"`);
sh(`git tag -a ${tag} -m "Релиз ${tag}"`);
sh('git push');
sh(`git push origin ${tag}`);
console.log(`\n✓ Тег ${tag} отправлен. GitHub соберёт установщики и выложит релиз за 10–15 минут:`);
console.log('  https://github.com/jestxfot/vaultboard/actions');
