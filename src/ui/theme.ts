// Тема интерфейса: светлая, тёмная или как в системе. Выбор запоминается в браузере.
// Пометку data-theme ставит ещё index.html до загрузки приложения — чтобы при запуске не мигало светлым.
// Доска без своего фона берёт фон темы; фон, выбранный в меню доски, — это часть доски, тема его не трогает.

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'vaultboard:theme';

/** Фон доски, у которой он не задан. */
export const BOARD_BACKGROUND: Record<Theme, string> = { light: '#f7f7f5', dark: '#1e2230' };

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Не запомнится — в следующий раз будет как в системе.
  }
}

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === 'system' ? (systemDark() ? 'dark' : 'light') : choice;
}

export function applyTheme(choice: ThemeChoice): Theme {
  const theme = resolveTheme(choice);
  document.documentElement.dataset.theme = theme;
  return theme;
}

/** Следить за темой системы (действует, только пока выбрано «как в системе»). */
export function onSystemTheme(fn: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}

export const THEME_NAMES: Record<ThemeChoice, string> = { system: 'как в системе', light: 'светлая', dark: 'тёмная' };
