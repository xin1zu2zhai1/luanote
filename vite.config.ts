import { defineConfig } from 'vite';

// GitHub Pages では /luanote/ 配下に配置される
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
});
