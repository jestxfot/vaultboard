// Журнал приложения — тот же файл, куда пишет сервер: %TEMP%\vaultboard.log.
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOG = path.join(os.tmpdir(), 'vaultboard.log');

export function log(text: string): void {
  try {
    appendFileSync(LOG, `[приложение] ${text}\n`);
  } catch {
    // Лог не пишется — не страшно.
  }
}
