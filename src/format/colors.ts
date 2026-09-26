// Цвета доски.

/** Предустановленные цвета Obsidian Canvas (`"1"`…`"6"`), светлая тема. */
const OBSIDIAN_PRESETS: Record<string, string> = {
  '1': '#e93147', // красный
  '2': '#ec7500', // оранжевый
  '3': '#e0ac00', // жёлтый
  '4': '#08b94e', // зелёный
  '5': '#00bfbc', // бирюзовый
  '6': '#7852ee', // фиолетовый
};

export function fromObsidianColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return OBSIDIAN_PRESETS[color] ?? (/^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined);
}

/** Палитра стикеров, как в Miro: 16 цветов, по два в ряд. */
export const STICKY_PALETTE = [
  '#fff6a0', '#ffe55c',
  '#ffb27a', '#ff9494',
  '#ffc4e6', '#ff8be0',
  '#b5c7ff', '#b39cff',
  '#a6e9ff', '#8fb3ff',
  '#7de3d2', '#6ddb8c',
  '#c5eda0', '#a9e06b',
  '#f2f2f2', '#1a1a1a',
] as const;

export const DEFAULT_STICKY = STICKY_PALETTE[0];

export function hexToNum(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

/** Смешивает цвет с белым: `amount` = 0 — исходный цвет, 1 — белый. */
export function tint(hex: string, amount: number): number {
  const n = hexToNum(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return (mix((n >> 16) & 255) << 16) | (mix((n >> 8) & 255) << 8) | mix(n & 255);
}

/** Тёмный ли цвет — чтобы на тёмном стикере писать белым. */
export function isDark(hex: string): boolean {
  const n = hexToNum(hex);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}
