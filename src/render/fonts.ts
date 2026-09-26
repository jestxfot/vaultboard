// Шрифты доски: базовые, встроенные в приложение и системные.
//
// Встроенные — открытые шрифты с кириллицей (лицензия OFL), они едут вместе с приложением:
// доска выглядит одинаково на любом компьютере и на опубликованном сайте.
// Системные — установленные в Windows; браузер отдаёт их список по разрешению. Такие шрифты
// есть только на этом компьютере — на другом вместо них будет запасной.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/cyrillic-400.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/cyrillic-700.css';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/cyrillic-400.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/roboto/cyrillic-700.css';
import '@fontsource/pt-sans/latin-400.css';
import '@fontsource/pt-sans/cyrillic-400.css';
import '@fontsource/pt-sans/latin-700.css';
import '@fontsource/pt-sans/cyrillic-700.css';
import '@fontsource/pt-serif/latin-400.css';
import '@fontsource/pt-serif/cyrillic-400.css';
import '@fontsource/pt-serif/latin-700.css';
import '@fontsource/pt-serif/cyrillic-700.css';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/cyrillic-400.css';
import '@fontsource/montserrat/latin-700.css';
import '@fontsource/montserrat/cyrillic-700.css';
import '@fontsource/lora/latin-400.css';
import '@fontsource/lora/cyrillic-400.css';
import '@fontsource/lora/latin-700.css';
import '@fontsource/lora/cyrillic-700.css';
import '@fontsource/playfair-display/latin-400.css';
import '@fontsource/playfair-display/cyrillic-400.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/playfair-display/cyrillic-700.css';
import '@fontsource/oswald/latin-400.css';
import '@fontsource/oswald/cyrillic-400.css';
import '@fontsource/oswald/latin-700.css';
import '@fontsource/oswald/cyrillic-700.css';
import '@fontsource/comfortaa/latin-400.css';
import '@fontsource/comfortaa/cyrillic-400.css';
import '@fontsource/comfortaa/latin-700.css';
import '@fontsource/comfortaa/cyrillic-700.css';
import '@fontsource/caveat/latin-400.css';
import '@fontsource/caveat/cyrillic-400.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/caveat/cyrillic-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/cyrillic-400.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '@fontsource/jetbrains-mono/cyrillic-700.css';
import '@fontsource/pt-mono/latin-400.css';
import '@fontsource/pt-mono/cyrillic-400.css';

export const FONT = '"Segoe UI", "Noto Sans", system-ui, sans-serif';

/** Базовые шрифты — системные шрифты Windows, которые есть везде. */
export const BASE_FONTS: Record<string, { label: string; family: string }> = {
  sans: { label: 'Обычный', family: FONT },
  serif: { label: 'С засечками', family: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Моноширинный', family: 'Consolas, "Cascadia Mono", monospace' },
  hand: { label: 'Рукописный', family: '"Segoe Print", "Comic Sans MS", cursive' },
};

/** Встроенные в приложение: одинаковы на любом компьютере. */
export const BUILTIN_FONTS = [
  'Inter', 'Roboto', 'PT Sans', 'PT Serif', 'Montserrat', 'Lora', 'Playfair Display',
  'Oswald', 'Comfortaa', 'Caveat', 'JetBrains Mono', 'PT Mono',
];

/** CSS-семейство шрифта для объекта: базовый — по ключу, остальные — по имени с запасным. */
export function fontFamily(font: string | undefined): string {
  if (!font) return FONT;
  const base = BASE_FONTS[font];
  return base ? base.family : `"${font}", ${FONT}`;
}

const loading = new Map<string, Promise<void>>();

/**
 * Дождаться, пока шрифт загрузится, — иначе текст нарисуется запасным шрифтом.
 * Возвращает null, если ждать нечего (базовый или уже загружен).
 */
export function ensureFont(font: string | undefined): Promise<void> | null {
  if (!font || BASE_FONTS[font]) return null;
  if (document.fonts.check(`16px "${font}"`) && document.fonts.check(`700 16px "${font}"`)) return null;
  let p = loading.get(font);
  if (!p) {
    p = Promise.all([document.fonts.load(`400 16px "${font}"`), document.fonts.load(`700 16px "${font}"`)]).then(() => undefined, () => undefined);
    loading.set(font, p);
  }
  return p;
}

const SYSTEM_KEY = 'vaultboard:system-fonts';

/** Системные шрифты, которые уже разрешили показать (список запоминается). */
export function knownSystemFonts(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SYSTEM_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Попросить у браузера список шрифтов компьютера (он спросит разрешение один раз). */
export async function querySystemFonts(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!query) throw new Error('Этот браузер не умеет отдавать список шрифтов компьютера');
  const fonts = await query();
  const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b, 'ru'));
  try {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify(families));
  } catch {
    // Не запомнится — спросим в следующий раз.
  }
  return families;
}
