// Файл доски `.board`: JSON, по одному объекту на строку.
// Такой файл открывается руками, git показывает понятные изменения, а читается он за миллисекунды.
import type { BoardDoc, CommentThread, Item } from '../model/types.ts';

export const FORMAT = 'vaultboard/1';

export class BoardFormatError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function emptyBoard(): BoardDoc {
  return { format: FORMAT, meta: {}, items: [], comments: [] };
}

export function parseBoard(text: string): BoardDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BoardFormatError(`Файл доски повреждён: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new BoardFormatError('Файл доски должен быть JSON-объектом');
  if (raw.format !== FORMAT) throw new BoardFormatError(`Неизвестный формат доски: ${String(raw.format)}`);
  if (!Array.isArray(raw.items)) throw new BoardFormatError('В доске нет списка items');

  const ids = new Set<string>();
  for (const [i, item] of raw.items.entries()) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.kind !== 'string') {
      throw new BoardFormatError(`Объект №${i} без id или kind`);
    }
    if (ids.has(item.id)) throw new BoardFormatError(`Повторяется id объекта: ${item.id}`);
    ids.add(item.id);
  }

  return {
    ...raw,
    format: FORMAT,
    meta: isObject(raw.meta) ? raw.meta : {},
    items: raw.items as Item[],
    comments: Array.isArray(raw.comments) ? (raw.comments as CommentThread[]) : [],
  };
}

function lines(list: unknown[]): string {
  return list.length ? `[\n${list.map((x) => JSON.stringify(x)).join(',\n')}\n]` : '[]';
}

export function serializeBoard(doc: BoardDoc): string {
  const { format: _format, meta, items, comments, ...extra } = doc;
  const parts = [
    `{"format":${JSON.stringify(FORMAT)},"meta":${JSON.stringify(meta ?? {})}`,
    `"items":${lines(items)}`,
    `"comments":${lines(comments)}`,
  ];
  for (const [key, value] of Object.entries(extra)) parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  return `${parts.join(',\n')}}\n`;
}
