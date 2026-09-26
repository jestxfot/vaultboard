// Проверка формата: «записать → прочитать → записать» даёт тот же файл,
// и все доски Obsidian из базы импортируются. Базу только читает, ничего в неё не пишет.
// Запуск: npm test  (корень базы — переменная VAULT_ROOT, по умолчанию J:/obsidian)
import { readFile } from 'node:fs/promises';
import { generateBoard } from '../src/bench/generate.ts';
import { parseBoard, serializeBoard } from '../src/format/board.ts';
import { canvasFileRefs, importCanvas, parseCanvas } from '../src/format/canvasImport.ts';
import { resolveRefs, walkVault } from '../server/vaultFs.ts';

const root = process.env.VAULT_ROOT ?? 'J:/obsidian';
let failed = 0;

function check(ok: boolean, message: string): void {
  if (!ok) failed++;
  console.log(`${ok ? '  ok ' : '  FAIL'} ${message}`);
}

function roundTrip(text: string): { same: boolean; parseMs: number; serializeMs: number } {
  let t = performance.now();
  const doc = parseBoard(text);
  const parseMs = performance.now() - t;
  t = performance.now();
  const again = serializeBoard(doc);
  const serializeMs = performance.now() - t;
  return { same: again === text, parseMs, serializeMs };
}

console.log('Свой формат .board');
for (const count of [1000, 5000]) {
  const text = serializeBoard(generateBoard(count));
  const r = roundTrip(text);
  check(
    r.same,
    `${count} объектов: ${(text.length / 1024).toFixed(0)} КБ, чтение ${r.parseMs.toFixed(1)} мс, запись ${r.serializeMs.toFixed(1)} мс`,
  );
}

console.log(`\nИмпорт досок Obsidian из ${root}`);
for await (const f of walkVault(root, (rel) => rel.toLowerCase().endsWith('.canvas'))) {
  try {
    const data = parseCanvas(await readFile(f.abs, 'utf8'));
    const resolved = await resolveRefs(root, f.rel, canvasFileRefs(data));
    const { doc, report } = importCanvas(data, resolved);
    const r = roundTrip(serializeBoard(doc));
    check(
      r.same,
      `${f.rel}: узлов ${report.nodes}, связей ${report.edges}, не найдено файлов ${report.missingFiles.length}, ` +
        `пропущено связей ${report.skippedEdges}`,
    );
    for (const m of report.missingFiles) console.log(`         нет файла: ${m}`);
  } catch (err) {
    check(false, `${f.rel}: ${(err as Error).message}`);
  }
}

console.log(failed ? `\nОшибок: ${failed}` : '\nВсё прошло.');
process.exit(failed ? 1 : 0);
