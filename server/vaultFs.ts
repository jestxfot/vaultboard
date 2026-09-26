// Работа с файлами базы на стороне Node. Используется и dev-сервером, и тестами.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface VaultFile {
  /** Путь от корня базы, всегда через `/`. */
  rel: string;
  abs: string;
  size: number;
  mtime: number;
}

export class VaultPathError extends Error {}

/** Переводит путь от корня базы в абсолютный и не даёт выйти за пределы базы. */
export function toAbsolute(root: string, rel: string): string {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new VaultPathError(`Путь вне базы: ${rel}`);
  }
  return abs;
}

/** Обходит базу, пропуская служебные папки (`.obsidian`, `.trash`, `.git` и прочие скрытые). */
export async function* walkVault(root: string, filter: (rel: string) => boolean): AsyncGenerator<VaultFile> {
  const absRoot = path.resolve(root);
  const stack: string[] = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(absRoot, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile() && filter(rel)) {
        const abs = path.join(absRoot, rel);
        const st = await fs.stat(abs);
        yield { rel, abs, size: st.size, mtime: st.mtimeMs };
      }
    }
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Находит, от какой папки считаются пути в доске Obsidian Canvas.
 *
 * Пути в `.canvas` отсчитаны от корня той базы, где доску создали, а базы бывают вложенными
 * (J:\obsidian и J:\obsidian\FNAF — обе с `.obsidian`). Поэтому пробуем все папки от доски
 * вверх до корня и берём первую, где файл реально есть.
 */
export async function resolveRefs(root: string, fromRel: string, refs: string[]): Promise<Record<string, string | null>> {
  const dirs: string[] = [];
  let dir = path.posix.dirname(fromRel);
  for (;;) {
    dirs.push(dir === '.' ? '' : dir);
    if (dir === '.' || dir === '') break;
    dir = path.posix.dirname(dir);
  }
  const out: Record<string, string | null> = {};
  for (const ref of refs) {
    out[ref] = null;
    for (const d of dirs) {
      const rel = d ? `${d}/${ref}` : ref;
      try {
        if (await exists(toAbsolute(root, rel))) {
          out[ref] = rel;
          break;
        }
      } catch {
        // путь вне базы — просто не подходит
      }
    }
  }
  return out;
}
