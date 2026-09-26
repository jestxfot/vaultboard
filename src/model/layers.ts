// Слои доски: список с основным слоем в начале и быстрые проверки «скрыт / закреплён».
import type { BoardDoc, Item, LayerDef } from './types.ts';

export const BASE_LAYER = '';
export const BASE_NAME = 'Основной';

/** Все слои доски; основной всегда первый, даже если в файле его нет. */
export function layersOf(doc: BoardDoc): LayerDef[] {
  const list = doc.layers ?? [];
  return list.some((l) => l.id === BASE_LAYER) ? list : [{ id: BASE_LAYER, name: BASE_NAME }, ...list];
}

export function layerOf(item: Item): string {
  return item.layer ?? BASE_LAYER;
}

/** Скрытые и закреплённые слои — множествами, чтобы проверка объекта стоила одного поиска. */
export function layerFlags(doc: BoardDoc): { hidden: Set<string>; locked: Set<string> } {
  const hidden = new Set<string>(), locked = new Set<string>();
  for (const l of doc.layers ?? []) {
    if (l.hidden) hidden.add(l.id);
    if (l.locked) locked.add(l.id);
  }
  return { hidden, locked };
}
