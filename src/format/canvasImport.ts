// Импорт досок Obsidian Canvas (`.canvas`, формат JSON Canvas) в наш формат.
// Исходный `.canvas` не меняется: импорт только читает его.
import type { BoardDoc, BoxItem, EndCap, Item, LineItem, Side } from '../model/types.ts';
import { FORMAT } from './board.ts';
import { fromObsidianColor } from './colors.ts';

interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
}

export interface CanvasData {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
}

export interface ImportReport {
  nodes: number;
  edges: number;
  /** Файлы, на которые ссылается доска, но которых нет на диске. */
  missingFiles: string[];
  /** Связи, у которых нет одного из концов. */
  skippedEdges: number;
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export function parseCanvas(text: string): CanvasData {
  const data: unknown = JSON.parse(text);
  if (typeof data !== 'object' || data === null) throw new Error('Файл .canvas должен быть JSON-объектом');
  return data as CanvasData;
}

/** Все пути к файлам, на которые ссылается доска. Их надо найти на диске до импорта. */
export function canvasFileRefs(data: CanvasData): string[] {
  const refs = new Set<string>();
  for (const n of data.nodes ?? []) if (n.type === 'file' && n.file) refs.add(n.file);
  return [...refs];
}

/** Убирает поля со значением `undefined`, чтобы в файле доски не было мусора. */
function compact<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] === undefined) delete obj[key];
  return obj;
}

function nodeToItem(n: CanvasNode, resolved: Record<string, string | null>, missing: string[]): BoxItem {
  const box = { id: n.id, x: n.x, y: n.y, w: n.width, h: n.height, color: fromObsidianColor(n.color) };
  switch (n.type) {
    case 'text':
      return compact({ ...box, kind: 'card', text: n.text ?? '' });
    case 'link':
      return compact({ ...box, kind: 'link', url: n.url ?? '' });
    case 'group':
      return compact({ ...box, kind: 'frame', title: n.label });
    case 'file': {
      const ref = n.file ?? '';
      // Заметки Obsidian лежат вне папки новой доски — записываем путь от корня базы.
      const file = `/${resolved[ref] ?? ref}`;
      if (!resolved[ref]) missing.push(ref);
      if (/\.md$/i.test(file)) return compact({ ...box, kind: 'doc', file, subpath: n.subpath });
      if (IMAGE_EXT.test(file)) return compact({ ...box, kind: 'image', file });
      return compact({ ...box, kind: 'file', file });
    }
    default:
      return compact({ ...box, kind: 'card', text: `Неизвестный тип узла Obsidian: ${n.type}` });
  }
}

export function importCanvas(
  data: CanvasData,
  resolved: Record<string, string | null>,
  meta: Record<string, unknown> = {},
): { doc: BoardDoc; report: ImportReport } {
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  const missing: string[] = [];

  // Группы — под всем остальным, крупные ниже мелких. Дальше узлы в исходном порядке, связи сверху.
  const groups = nodes.filter((n) => n.type === 'group').sort((a, b) => b.width * b.height - a.width * a.height);
  const others = nodes.filter((n) => n.type !== 'group');
  const items: Item[] = [...groups, ...others].map((n) => nodeToItem(n, resolved, missing));

  const ids = new Set(items.map((i) => i.id));
  let skippedEdges = 0;
  for (const e of edges) {
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) {
      skippedEdges++;
      continue;
    }
    // У Obsidian узлы и связи живут в разных пространствах id, у нас — в одном.
    let id = e.id;
    while (ids.has(id)) id = `e-${id}`;
    ids.add(id);
    const line: LineItem = compact({
      id,
      kind: 'line',
      from: compact({ item: e.fromNode, side: e.fromSide }),
      to: compact({ item: e.toNode, side: e.toSide }),
      path: 'curve',
      start: (e.fromEnd === 'arrow' ? 'arrow' : 'none') as EndCap,
      end: (e.toEnd === 'none' ? 'none' : 'arrow') as EndCap,
      color: fromObsidianColor(e.color),
      label: e.label,
    });
    items.push(line);
  }

  return {
    doc: { format: FORMAT, meta: { ...meta, importedFrom: 'obsidian-canvas' }, items, comments: [] },
    report: { nodes: nodes.length, edges: edges.length, missingFiles: [...new Set(missing)], skippedEdges },
  };
}
