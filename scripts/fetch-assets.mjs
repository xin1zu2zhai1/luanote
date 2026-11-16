// TeX Live (BusyTeX WASM) のアセットを GitHub Releases から取得して public/core/<id>/ に展開する
//   node scripts/fetch-assets.mjs            # 既にあればスキップ
//   node scripts/fetch-assets.mjs --force    # 再取得
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const cacheDir = process.env.ASSET_CACHE_DIR ?? join(root, '.asset-cache');

// distributions.ts と対応させる
const pkgVersion = JSON.parse(readFileSync(join(root, 'node_modules/texlyre-busytex/package.json'), 'utf8')).version;
const DISTS = [
  {
    id: 'texlive-2026',
    url: `https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-v${pkgVersion}/busytex-assets.tar.gz`,
    archive: `texlyre-busytex-assets-v${pkgVersion}.tar.gz`,
    innerDir: 'busytex',
  },
];

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let done = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    done += c.length;
    if (total && Date.now() - last > 2000) {
      last = Date.now();
      console.log(`  ${((done / total) * 100).toFixed(1)}% (${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`);
    }
  });
  await pipeline(body, createWriteStream(dest + '.part'));
  renameSync(dest + '.part', dest);
}

for (const d of DISTS) {
  const target = join(root, 'public/core', d.id);
  if (existsSync(join(target, 'busytex.wasm')) && !force) {
    console.log(`✓ ${d.id} already present`);
    continue;
  }
  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, d.archive);
  if (!existsSync(archive)) await download(d.url, archive);
  const tmp = join(root, 'public/core/.extract-' + d.id);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  console.log(`Extracting ${d.archive}`);
  execFileSync('tar', ['-xzf', archive, '-C', tmp], { stdio: 'inherit' });
  rmSync(target, { recursive: true, force: true });
  renameSync(join(tmp, d.innerDir), target);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ ${d.id} → public/core/${d.id}`);
}
