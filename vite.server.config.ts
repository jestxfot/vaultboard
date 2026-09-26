// Сборка сервера готовой установки: server/standalone.ts со всеми зависимостями — в один файл dist-server/server.mjs.
// Запускается простым `node`, без node_modules (см. npm run build и scripts/pack.mjs).
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'server/standalone.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rolldownOptions: {
      output: { entryFileNames: 'server.mjs', format: 'es', codeSplitting: false },
    },
  },
  // Все пакеты — внутрь файла: у готовой установки нет node_modules.
  ssr: { noExternal: true, target: 'node' },
});
