// Новые объекты с размерами и оформлением по умолчанию.
import type { Endpoint, FrameItem, LineItem, PathKind, ShapeItem, ShapeKind, StickyItem, TextItem } from './types.ts';
import { DEFAULT_STICKY } from '../format/colors.ts';

export function newId(exists: (id: string) => boolean): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10);
    if (id.length === 8 && !exists(id)) return id;
  }
}

export const STICKY_SIZE = 200;
export const TEXT_WIDTH = 320;
export const TEXT_FONT = 18;

export function makeSticky(id: string, cx: number, cy: number, color: string = DEFAULT_STICKY): StickyItem {
  return { id, kind: 'sticky', x: cx - STICKY_SIZE / 2, y: cy - STICKY_SIZE / 2, w: STICKY_SIZE, h: STICKY_SIZE, color, text: '' };
}

export function makeText(id: string, x: number, y: number): TextItem {
  return { id, kind: 'text', x, y, w: TEXT_WIDTH, h: Math.round(TEXT_FONT * 1.35) + 4, text: '', fontSize: TEXT_FONT };
}

export function shapeSize(shape: ShapeKind): { w: number; h: number } {
  return shape === 'ellipse' || shape === 'star' || shape === 'hexagon' ? { w: 180, h: 180 } : { w: 220, h: 140 };
}

export function makeShape(id: string, shape: ShapeKind, x: number, y: number, w: number, h: number): ShapeItem {
  return { id, kind: 'shape', shape, x, y, w, h, text: '' };
}

export function makeFrame(id: string, x: number, y: number, w: number, h: number, title: string): FrameItem {
  return { id, kind: 'frame', x, y, w, h, title };
}

export function makeLine(id: string, from: Endpoint, to: Endpoint, path: PathKind, end: 'arrow' | 'none'): LineItem {
  return { id, kind: 'line', from, to, path, end };
}
