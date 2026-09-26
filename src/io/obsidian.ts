// Открыть заметку в Obsidian: какое его хранилище её содержит и откроется ли она вообще.
import { vault } from './vault.ts';

export type ObsidianTarget =
  | { kind: 'ok'; url: string; vaultName: string; vaultPath: string }
  /** Файл не лежит ни в одном хранилище Obsidian — ссылка открыла бы только ошибку. */
  | { kind: 'outside' }
  /** Obsidian на этом компьютере не установлен (или ни разу не запускался). */
  | { kind: 'no-obsidian' };

let cache: { at: number; data: Promise<{ root: string; vaults: string[] | null }> } | null = null;

/** Список хранилищ живёт полминуты: хранилище могли добавить в Obsidian, пока открыта доска. */
function vaults(): Promise<{ root: string; vaults: string[] | null }> {
  if (!cache || performance.now() - cache.at > 30_000) cache = { at: performance.now(), data: vault.obsidianVaults() };
  return cache.data;
}

/** Путь для сравнения: прямые слэши, без слэша в конце; на Windows регистр букв не важен. */
function norm(p: string, windows: boolean): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return windows ? s.toLowerCase() : s;
}

/** Куда откроется заметка `path` (путь от корня базы). Obsidian выбирает самое глубокое хранилище с этим файлом — мы так же. */
export async function obsidianTarget(path: string): Promise<ObsidianTarget> {
  const { root, vaults: list } = await vaults();
  if (!list) return { kind: 'no-obsidian' };
  const windows = /^[a-z]:[\\/]/i.test(root);
  const abs = `${root.replace(/[\\/]+$/, '')}/${path}`;
  const file = norm(abs, windows);
  let best: string | null = null;
  for (const v of list) {
    const n = norm(v, windows);
    if (file.startsWith(`${n}/`) && (!best || n.length > norm(best, windows).length)) best = v;
  }
  if (!best) return { kind: 'outside' };
  const native = windows ? abs.replace(/\//g, '\\') : abs;
  return {
    kind: 'ok',
    url: `obsidian://open?path=${encodeURIComponent(native)}`,
    vaultName: best.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? best,
    vaultPath: best,
  };
}
