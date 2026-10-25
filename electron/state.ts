// Что приложение помнит между запусками (не настройки досок — те у сервера): окно, недавние доски, сборка.
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AppState {
  /** Размер и место последнего окна, которое двигали. */
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  /** Подсказку «vaultboard остался в трее» уже показывали. */
  trayHintShown?: boolean;
  /** Какая сборка запускалась в прошлый раз — после обновления кэш страницы очищается. */
  build?: string;
  /** Недавние доски — полные пути, последняя первой. */
  recent?: string[];
  /**
   * Рисовать без видеокарты (процессором). Нужно, когда видеокарту целиком занимает другая программа
   * (например, нейросеть): тогда каждый кадр доски ждёт своей очереди на видеокарте и доска двигается рывками.
   */
  softwareRender?: boolean;
}

const file = () => path.join(app.getPath('userData'), 'window.json');

export function readState(): AppState {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as AppState;
  } catch {
    return {};
  }
}

export function writeState(patch: Partial<AppState>): void {
  try {
    writeFileSync(file(), JSON.stringify({ ...readState(), ...patch }));
  } catch {
    // Не запомнится — в следующий раз начнём с настроек по умолчанию.
  }
}
