import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { readFileSync } from 'node:fs';
import { vaultApi } from './server/vaultApi.ts';

// Номер версии — из package.json; его показывает шапка панели досок.
const VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

// Корень базы, от которого считаются все пути в досках. Обычно его выбирают в самом приложении
// (первая настройка, потом ⚙ Настройки); переменная VAULT_ROOT — чтобы разработчику подсунуть тестовую папку.
export default defineConfig({
  // Относительные пути к файлам сборки: та же сборка работает и у себя на компьютере, и как опубликованный сайт —
  // в корне домена, в подпапке хостинга и в предпросмотре /api/site/.
  base: './',
  plugins: [solid(), vaultApi(process.env.VAULT_ROOT || undefined)],
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 5180, host: '127.0.0.1' },
});
