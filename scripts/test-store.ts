// Проверка хранилища и журнала истории: правки, отмена, повтор, жесты, восстановление истории с диска.
// Запуск: node scripts/test-store.ts
import { BoardStore, type HistoryEvent } from '../src/model/store.ts';
import { encodeOps, type LogLine, parseLog, rebuildHistory } from '../src/model/historyCodec.ts';
import { emptyBoard, serializeBoard } from '../src/format/board.ts';
import { makeLine, makeSticky } from '../src/model/factory.ts';
import type { StickyItem } from '../src/model/types.ts';

let failed = 0;
function check(ok: boolean, message: string): void {
  if (!ok) failed++;
  console.log(`${ok ? '  ok ' : '  FAIL'} ${message}`);
}

const snapshot = (s: BoardStore) => serializeBoard(s.doc);

// Журнал так же, как его пишет приложение.
function attachLog(store: BoardStore): LogLine[] {
  const log: LogLine[] = [{ v: 1, start: store.rev }];
  store.onHistory((e: HistoryEvent) => {
    if (e.kind === 'do') log.push({ d: e.label, o: encodeOps(e.ops), r: store.rev });
    else if (e.kind === 'undo') log.push({ u: 1, r: store.rev });
    else log.push({ re: 1, r: store.rev });
  });
  return log;
}

console.log('Хранилище');
const store = new BoardStore(emptyBoard());
const log = attachLog(store);
const states: string[] = [snapshot(store)];

store.transact('Стикеры', () => {
  store.insert(makeSticky('a', 0, 0));
  store.insert(makeSticky('b', 300, 0));
});
states.push(snapshot(store));
store.insert(makeLine('l', { item: 'a' }, { item: 'b' }, 'curve', 'arrow'));
states.push(snapshot(store));
check(store.linesOf('a').includes('l'), 'линия прицеплена к объекту');

// Перетаскивание: много кадров — одна запись в истории.
store.beginGesture('Перемещение');
for (let i = 1; i <= 30; i++) store.live(() => store.update<StickyItem>('a', { x: -100 + i * 10 }));
store.endGesture();
states.push(snapshot(store));
check(store.historySize.undo === 3, `30 кадров перетаскивания — одна запись (записей: ${store.historySize.undo})`);

// Создание и подпись в одном жесте — одна вставка с готовым текстом.
store.beginGesture('Стикер');
store.live(() => store.insert(makeSticky('c', 0, 400)));
for (const t of ['У', 'Ук', 'Уку', 'Укус']) store.live(() => store.update<StickyItem>('c', { text: t }));
store.endGesture();
states.push(snapshot(store));
const lastDo = log[log.length - 1] as { o: unknown[] };
check(lastDo.o.length === 1 && 'i' in (lastDo.o[0] as object), 'создание с подписью записано одной вставкой');

// Пустой текст, созданный и закрытый, не попадает в историю.
const before = store.historySize.undo;
store.beginGesture('Текст');
store.live(() => store.insert(makeSticky('tmp', 0, 800)));
store.live(() => store.remove('tmp'));
store.endGesture();
check(store.historySize.undo === before, 'созданный и тут же удалённый объект не оставляет следа');

store.remove('a');
states.push(snapshot(store));
check(!store.has('l'), 'удаление объекта удаляет прицепленные линии');

store.moveToIndex('c', 0);
states.push(snapshot(store));

// Отмена до самого начала и повтор до конца.
let ok = true;
for (let i = states.length - 2; i >= 0; i--) {
  store.undo();
  if (snapshot(store) !== states[i]) ok = false;
}
check(ok, `отмена проходит все ${states.length - 1} шагов назад точно`);
for (let i = 1; i < states.length; i++) {
  store.redo();
  if (snapshot(store) !== states[i]) ok = false;
}
check(ok, 'повтор проходит все шаги вперёд точно');

// Вернёмся на пару шагов, чтобы в журнале были и отмены, и повторы.
store.undo();
store.undo();
const saved = snapshot(store);

console.log('\nЖурнал истории на диске');
const text = log.map((l) => JSON.stringify(l)).join('\n') + '\n';
console.log(`  журнал: ${log.length} строк, ${text.length} байт`);

const reopened = new BoardStore(JSON.parse(saved.replace('"meta":{}', `"meta":{"rev":${store.rev}}`)));
const rebuilt = rebuildHistory(reopened.items, parseLog(text), store.rev);
check(rebuilt !== null, 'журнал сходится с доской');
reopened.restoreHistory(rebuilt!.undo, rebuilt!.redo);
check(
  reopened.historySize.undo === store.historySize.undo && reopened.historySize.redo === store.historySize.redo,
  `после «перезапуска» столько же шагов отмены (${reopened.historySize.undo}) и повтора (${reopened.historySize.redo})`,
);
const strip = (s: string) => s.replace(/"meta":\{[^}]*\}/, '"meta":{}');
ok = true;
const pos = states.indexOf(saved);
for (let i = pos - 1; i >= 0; i--) {
  reopened.undo();
  if (strip(snapshot(reopened)) !== states[i]) ok = false;
}
check(ok, 'после перезапуска отмена доходит до пустой доски');
for (let i = 1; i < states.length; i++) {
  reopened.redo();
  if (strip(snapshot(reopened)) !== states[i]) ok = false;
}
check(ok, 'после перезапуска повтор доходит до последней правки');

const fresh = new BoardStore(JSON.parse(saved));
check(rebuildHistory(fresh.items, parseLog(text), store.rev + 5) === null, 'чужая версия доски — журнал не применяется');
check(rebuildHistory(fresh.items, parseLog(text + '{"d":"обрыв'), store.rev) !== null, 'недописанная строка в конце не ломает журнал');

console.log(failed ? `\nОшибок: ${failed}` : '\nВсё прошло.');
process.exit(failed ? 1 : 0);
