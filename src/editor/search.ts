// Поиск по доске: текст стикеров, фигур, карточек и надписей, заголовки рамок, подписи линий,
// карточки ссылок (заголовок, сайт, адрес), названия документов, фото и файлов.
// Регистр и «ё/е» не важны; ничего не нашлось — пробуем тот же запрос в другой раскладке («ЬСШ» → «MCI»).
import type { Item } from '../model/types.ts';
import { switchLayout } from '../io/files.ts';

export interface SearchHit {
  id: string;
  /** Где совпало — строка с найденным. */
  label: string;
  /** Что это за объект — по-русски, для списка найденного. */
  kind: string;
}

const KIND: Record<string, string> = {
  sticky: 'стикер', text: 'текст', shape: 'фигура', card: 'карточка', frame: 'рамка', line: 'линия',
  link: 'ссылка', doc: 'документ', image: 'фото', file: 'файл', drawing: 'рисунок',
};

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Весь текст объекта, по которому ищем. */
export function searchableText(item: Item): string {
  const parts: string[] = [];
  if ('text' in item && item.text) parts.push(item.text);
  if (item.kind === 'frame' && item.title) parts.push(item.title);
  if (item.kind === 'line' && item.label) parts.push(item.label);
  if (item.kind === 'link') parts.push(item.title ?? '', item.site ?? '', item.url, item.description ?? '');
  if (item.kind === 'doc' || item.kind === 'image' || item.kind === 'file') parts.push(item.file.split('/').pop() ?? '');
  return parts.join('\n');
}

/** Короткая подпись найденного: кусок строки вокруг совпадения, чтобы найденное слово было видно. */
function labelFor(text: string, q: string): string {
  const lines = text.split('\n').map((l) => l.replace(/[*_`#>=~[\]]/g, '').trim());
  const line = lines.find((l) => norm(l).includes(q)) ?? lines[0] ?? '';
  const at = norm(line).indexOf(q);
  if (line.length <= 70 || at < 0) return line.length > 70 ? `${line.slice(0, 69)}…` : line;
  const from = Math.max(0, at - 25);
  const cut = line.slice(from, from + 68);
  return `${from > 0 ? '…' : ''}${cut}${from + 68 < line.length ? '…' : ''}`;
}

function run(items: readonly Item[], q: string, visible: (item: Item) => boolean): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of items) {
    if (!visible(item)) continue;
    const text = searchableText(item);
    if (text && norm(text).includes(q)) hits.push({ id: item.id, label: labelFor(text, q), kind: KIND[item.kind] ?? item.kind });
  }
  return hits;
}

/**
 * Найти объекты доски. Порядок — как читают: сверху вниз, слева направо (по верхнему левому углу).
 * `visible` — не искать на скрытых слоях.
 */
export function searchBoard(items: readonly Item[], query: string, visible: (item: Item) => boolean, pos: (id: string) => { x: number; y: number } | null): SearchHit[] {
  return searchBoardWith(items, query, visible, pos).hits;
}

/** То же, плюс по какому запросу нашлось (после переключения раскладки он другой) — для подсветки в списке. */
export function searchBoardWith(items: readonly Item[], query: string, visible: (item: Item) => boolean, pos: (id: string) => { x: number; y: number } | null): { hits: SearchHit[]; matched: string } {
  const q = norm(query.trim());
  if (!q) return { hits: [], matched: '' };
  let matched = q;
  let hits = run(items, q, visible);
  if (!hits.length) {
    matched = norm(switchLayout(query.trim()));
    hits = run(items, matched, visible);
  }
  return { hits: sortReading(hits, pos), matched };
}

function sortReading(hits: SearchHit[], pos: (id: string) => { x: number; y: number } | null): SearchHit[] {
  return hits.sort((a, b) => {
    const pa = pos(a.id), pb = pos(b.id);
    if (!pa || !pb) return 0;
    // Строки считаем «одной», если верхние края рядом: иначе объекты чуть разной высоты скачут.
    return Math.abs(pa.y - pb.y) > 40 ? pa.y - pb.y : pa.x - pb.x;
  });
}
