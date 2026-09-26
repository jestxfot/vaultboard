// Проверка формата: «записать → прочитать → записать» даёт тот же файл,
// и все доски Obsidian из базы импортируются. Базу только читает, ничего в неё не пишет.
// Запуск: npm test  (корень базы — переменная VAULT_ROOT, по умолчанию J:/obsidian)
import { readFile } from 'node:fs/promises';
import { generateBoard } from '../src/bench/generate.ts';
import { parseBoard, serializeBoard } from '../src/format/board.ts';
import { canvasFileRefs, importCanvas, parseCanvas } from '../src/format/canvasImport.ts';
import { resolveRefs, walkVault } from '../server/vaultFs.ts';
import { BoardPaths, boardFolderOf, historyPathOf } from '../src/model/paths.ts';

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

console.log('\nДоска — одна папка');
{
  const p = new BoardPaths('Доски/Таймлайн');
  check(p.toStored('Доски/Таймлайн/фото/IMG.jpg') === 'фото/IMG.jpg', 'файл внутри папки доски записывается относительно неё');
  check(p.toStored('Canon/Цитаты.md') === '/Canon/Цитаты.md', 'файл вне папки — от корня базы с «/»');
  check(new BoardPaths('Архив/2026/Таймлайн').toVault('фото/IMG.jpg') === 'Архив/2026/Таймлайн/фото/IMG.jpg', 'после переноса папки относительный путь находит файл в новом месте');
  check(p.toVault('/Canon/Цитаты.md') === 'Canon/Цитаты.md', 'путь от корня базы не зависит от места папки');
  check(boardFolderOf('Доски/Таймлайн/доска.board') === 'Доски/Таймлайн', 'папка новой доски — та, где лежит доска.board');
  check(boardFolderOf('Доски/Старая.board') === 'Доски/Старая', 'папка старой доски — рядом с файлом');
  check(historyPathOf('Доски/Таймлайн/доска.board') === 'Доски/Таймлайн/.история.jsonl', 'история лежит внутри папки доски');
  const v1 = parseBoard('{"format":"vaultboard/1","meta":{},"items":[{"id":"a","kind":"image","x":0,"y":0,"w":1,"h":1,"file":"Доски/Старая/фото/a.png"}],"comments":[]}');
  check(v1.format === 'vaultboard/2' && (v1.items[0] as { file: string }).file === '/Доски/Старая/фото/a.png', 'доска формата 1 переводится в формат 2 без потери путей');
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
