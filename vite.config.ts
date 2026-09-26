import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { vaultApi } from './server/vaultApi.ts';

// Корень базы, от которого считаются все пути в досках.
const VAULT_ROOT = process.env.VAULT_ROOT ?? 'J:/obsidian';

export default defineConfig({
  plugins: [solid(), vaultApi(VAULT_ROOT)],
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 5180, host: '127.0.0.1' },
});
