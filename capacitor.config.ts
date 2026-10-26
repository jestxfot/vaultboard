// Приложение для iPad: та же сборка интерфейса (dist), обёрнутая в Capacitor. Доски лежат в папке приложения
// на самом iPad (видна в «Файлах»), сервер не нужен — см. src/io/localVault.ts. Сборка — .github/workflows/ipad.yml.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.jestxfot.vaultboard',
  appName: 'vaultboard',
  webDir: 'dist',
  ios: {
    // Доска сама решает, что делать с жестами: страница не должна прокручиваться и пружинить.
    scrollEnabled: false,
    contentInset: 'never',
  },
};

export default config;
