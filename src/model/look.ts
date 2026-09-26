// Оформление объекта: собственное плюс стиль доски.
//
// Объект хранит имя стиля и только те поля, которыми он отличается от стиля. При отрисовке стиль
// подставляется снизу, поэтому изменение стиля сразу меняет все объекты с ним — доску переписывать не нужно.
import type { Item, StyleDef } from './types.ts';
import { isLine } from './types.ts';

export const BOX_KEYS = ['color', 'textColor', 'fontSize', 'font', 'align', 'bold', 'italic', 'borderColor', 'borderWidth'] as const;
export const LINE_KEYS = ['color', 'width', 'dash', 'start', 'end', 'path'] as const;

export type StyleKey = (typeof BOX_KEYS)[number] | (typeof LINE_KEYS)[number];

export function styleKeys(item: Item): readonly StyleKey[] {
  return isLine(item) ? LINE_KEYS : BOX_KEYS;
}

type Loose = Record<string, unknown>;

/** Объект с подставленным стилем: собственные поля объекта главнее стиля. */
export function resolveLook<T extends Item>(item: T, styles: Record<string, StyleDef> | undefined): T {
  const def = item.style ? styles?.[item.style] : undefined;
  if (!def) return item;
  const merged: Loose = {};
  for (const k of styleKeys(item)) if ((def as Loose)[k] !== undefined) merged[k] = (def as Loose)[k];
  return { ...merged, ...item } as T;
}

/** Оформление объекта в виде стиля — для «Сохранить как стиль» и «Обновить стиль». */
export function lookOf(item: Item): StyleDef {
  const out: Loose = {};
  for (const k of styleKeys(item)) if ((item as unknown as Loose)[k] !== undefined) out[k] = (item as unknown as Loose)[k];
  return out as StyleDef;
}

/** Убрать из объекта поля, которые задаёт стиль, — тогда объект полностью следует стилю. */
export function withoutStyleFields<T extends Item>(item: T, def: StyleDef): T {
  const copy = { ...item } as unknown as Loose;
  for (const k of styleKeys(item)) if ((def as Loose)[k] !== undefined) delete copy[k];
  return copy as unknown as T;
}

/** Отличается ли объект от своего стиля (есть свои поля поверх стиля). */
export function hasOverrides(item: Item, styles: Record<string, StyleDef> | undefined): boolean {
  const def = item.style ? styles?.[item.style] : undefined;
  if (!def) return false;
  return styleKeys(item).some((k) => (def as Loose)[k] !== undefined && (item as unknown as Loose)[k] !== undefined);
}
