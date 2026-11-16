import { defineConfig, type Connect, type Plugin } from 'vite';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.BASE_PATH ?? '/';

// エンジンはファイルの有無を HTTP ステータスで判断する（404 = 存在しない）。
// Vite の開発 / プレビューサーバーは未知のパスにも index.html を 200 で返すため、
// /core/ 配下では実在しないファイルに 404 を返すようにする（GitHub Pages と同じ挙動）。
function coreNotFound(root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0]);
    const prefix = base + 'core/';
    if (url.startsWith(prefix)) {
      const p = join(root, 'core', url.slice(prefix.length));
      if (!existsSync(p) || !statSync(p).isFile()) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
    }
    next();
  };
}

const strict404: Plugin = {
  name: 'luanote-core-404',
  configureServer(server) {
    server.middlewares.use(coreNotFound(join(server.config.root, 'public')));
  },
  configurePreviewServer(server) {
    server.middlewares.use(coreNotFound(server.config.build.outDir));
  },
};

// GitHub Pages では /luanote/ 配下に配置される
export default defineConfig({
  base,
  plugins: [strict404],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
});
