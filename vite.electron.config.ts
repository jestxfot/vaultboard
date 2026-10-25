// Сборка настольного приложения — два файла в dist-electron (их запускает Electron):
//   vite build -c vite.electron.config.ts                 → main.cjs: electron/main.ts (окно, трей, сервер, обновления);
//   vite build -c vite.electron.config.ts --mode preload  → preload.cjs: electron/preload.ts (мост страница ↔ приложение).
// Всё, что им нужно (и electron-updater), — внутри файлов: у приложения нет node_modules. Снаружи — только сам Electron.
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const name = mode === 'preload' ? 'preload' : 'main';
  return {
    // Папка public (значок страницы) нужна только самой странице — в dist.
    publicDir: false,
    build: {
      ssr: `electron/${name}.ts`,
      outDir: 'dist-electron',
      // main собирается первым и очищает папку, preload — вторым и её не трогает.
      emptyOutDir: name === 'main',
      target: 'node22',
      minify: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: `${name}.cjs`, format: 'cjs', codeSplitting: false },
      },
    },
    ssr: { noExternal: true, external: ['electron'], target: 'node' },
  };
});
