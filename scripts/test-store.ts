// Проверка хранилища и журнала истории: правки, отмена, повтор, жесты, восстановление истории с диска.
// Запуск: node scripts/test-store.ts
import { BoardStore, type HistoryEvent } from '../src/model/store.ts';
import { encodeOps, type LogLine, parseLog, rebuildHistory } from '../src/model/historyCodec.ts';
import { emptyBoard, serializeBoard } from '../src/format/board.ts';
import { makeLine, makeSticky } from '../src/model/factory.ts';
import type { StickyItem } from '../src/model/types.ts';
import { recognize } from '../src/editor/recognize.ts';
import { decodePoints, encodePoints, shiftPoints } from '../src/format/strokes.ts';
import { snapRect } from '../src/editor/snap.ts';
import { resolveLook } from '../src/model/look.ts';

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

console.log('\nРисование');
{
  // Дрожание руки — детерминированное, чтобы тест всегда давал один результат.
  let seed = 7;
  const jitter = (a: number) => {
    seed = (seed * 16807) % 2147483647;
    return ((seed / 2147483647) - 0.5) * a;
  };
  const path = (pts: [number, number][], steps = 20) => {
    const out: { x: number; y: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        out.push({ x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t + jitter(3), y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t + jitter(3) });
      }
    }
    out.push({ x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] });
    return out;
  };
  const circle = Array.from({ length: 64 }, (_, i) => ({ x: 100 + Math.cos((i / 60) * Math.PI * 2) * 80 + jitter(4), y: 100 + Math.sin((i / 60) * Math.PI * 2) * 60 + jitter(4) }));
  const cases: [string, { x: number; y: number }[], string][] = [
    ['круг', circle, 'shape:ellipse'],
    ['квадрат', path([[0, 0], [200, 0], [200, 150], [0, 150], [0, 0]]), 'shape:rect'],
    ['ромб', path([[100, 0], [200, 80], [100, 160], [0, 80], [100, 0]]), 'shape:diamond'],
    ['треугольник', path([[100, 0], [200, 170], [0, 170], [100, 0]]), 'shape:triangle'],
    ['прямая', path([[0, 0], [300, 120]]), 'line'],
    ['каракуля', path([[0, 0], [60, 90], [120, 10], [180, 100], [240, 20]]), 'null'],
  ];
  for (const [name, pts, want] of cases) {
    const r = recognize(pts, 30);
    const got = r ? (r.kind === 'shape' ? `shape:${r.shape}` : 'line') : 'null';
    check(got === want, `умное рисование: ${name} → ${got}`);
  }

  const stroke = Array.from({ length: 200 }, (_, i) => ({ x: 1000 + i * 1.37, y: 500 + Math.sin(i / 10) * 40, p: 0.3 + (i % 50) / 100 }));
  const packed = encodePoints(stroke);
  const back = decodePoints(packed);
  const maxErr = Math.max(...stroke.map((p, i) => Math.max(Math.abs(p.x - back[i].x), Math.abs(p.y - back[i].y))));
  const json = JSON.stringify(packed).length, raw = JSON.stringify(stroke).length;
  check(maxErr <= 0.05 + 1e-9, `точки штриха после сжатия отличаются не больше чем на 0,05 (на деле ${maxErr.toFixed(3)})`);
  check(json * 3 < raw, `сжатый штрих занимает ${json} байт вместо ${raw}`);
  const shifted = decodePoints(shiftPoints(packed, 10, -5));
  check(Math.abs(shifted[199].x - back[199].x - 10) < 0.06 && Math.abs(shifted[199].y - back[199].y + 5) < 0.06, 'сдвиг рисунка меняет одну точку, а двигает весь штрих');
}

console.log('\nПривязка и стили');
{
  const other = { x: 300, y: 100, w: 200, h: 100 };
  const a = snapRect({ x: 97, y: 257, w: 200, h: 100 }, [other], 6, 8, ['l', 'c', 'r'], ['t', 'm', 'b']);
  check(a.dx === 3 && a.guides.length >= 1, `правый край прилип к левому краю соседа (сдвиг ${a.dx}) и есть направляющая`);
  const b = snapRect({ x: 403, y: 250, w: 100, h: 50 }, [other], 6, 8, ['l', 'c', 'r'], ['t', 'm', 'b']);
  check(b.dx === -3, `центры встали на одну вертикаль (сдвиг ${b.dx})`);
  const c = snapRect({ x: 1003, y: 2005, w: 50, h: 50 }, [other], 6, 8, ['l', 'c', 'r'], ['t', 'm', 'b']);
  check(c.dx === -3 && c.dy === 3 && c.guides.length === 0, 'соседей рядом нет — объект прилипает к сетке 8');
  const styles = { Факт: { color: '#ff0000', fontSize: 30, bold: true } };
  const item: StickyItem = { id: 's', kind: 'sticky', x: 0, y: 0, w: 1, h: 1, text: '', style: 'Факт', fontSize: 12 };
  const r = resolveLook(item, styles);
  check(r.color === '#ff0000' && r.bold === true && r.fontSize === 12, 'стиль подставляется снизу, своё поле объекта главнее стиля');
}

console.log(failed ? `\nОшибок: ${failed}` : '\nВсё прошло.');
process.exit(failed ? 1 : 0);
