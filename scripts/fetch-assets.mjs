// TeX Live (BusyTeX WASM) のアセットを GitHub Releases から取得して public/core/<id>/ に展開する
//   node scripts/fetch-assets.mjs            # 既にあればスキップ
//   node scripts/fetch-assets.mjs --force    # 再取得
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    // basic は日本語組版に使えないので配信しない。
    // extra は build-lazy-extra.mjs が必要なファイルを取り出した後に削除する。
    exclude: /^texlive-basic\./,
  },
];

// 2 GB 未満（32767 ページ = 約 2047 MB）
const MAX_MEMORY_PAGES = 32767;

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
  // 提供しないパッケージセット（src/distributions.ts 参照）は公開サイトに含めない
  for (const name of readdirSync(target)) {
    if (d.exclude?.test(name)) rmSync(join(target, name));
  }
  raiseMemoryLimit(join(target, 'busytex.wasm'), join(target, 'busytex.js'), MAX_MEMORY_PAGES);
  console.log(`✓ ${d.id} → public/core/${d.id}`);
}

// ---------------------------------------------------------------------------
// WASM のメモリ上限の引き上げ
//
// 配布ビルドは最大 576 MB（9216 ページ）で、和文フォント（原ノ味）を多くのサイズで使う
// 文書（ルビ・見出し・本文・ゴシックなど）では出力時にメモリ不足で落ちる。
// メモリはモジュール内で定義されているので、メモリセクションの上限と JS 側の定数を書き換える。
// 2 GB 以上はポインタを符号なしで扱うビルド設定が必要なため、2 GB 未満に留める。
// ---------------------------------------------------------------------------
function raiseMemoryLimit(wasmPath, jsPath, newMax) {
  const b = readFileSync(wasmPath);
  const leb = (buf, i) => {
    let r = 0;
    let s = 0;
    let x;
    do {
      x = buf[i++];
      r |= (x & 0x7f) << s;
      s += 7;
    } while (x & 0x80);
    return [r >>> 0, i];
  };
  const enc = (v) => {
    const o = [];
    do {
      let x = v & 0x7f;
      v >>>= 7;
      if (v) x |= 0x80;
      o.push(x);
    } while (v);
    return Buffer.from(o);
  };
  const out = [b.subarray(0, 8)];
  let i = 8;
  let oldMax = null;
  while (i < b.length) {
    const id = b[i];
    const [size, s] = leb(b, i + 1);
    const end = s + size;
    if (id === 5) {
      let [count, j] = leb(b, s);
      if (count !== 1) throw new Error(`unexpected memory count ${count}`);
      const flag = b[j++];
      const [min, j2] = leb(b, j);
      let j3 = j2;
      if (flag & 1) [oldMax, j3] = leb(b, j2);
      const body = Buffer.concat([enc(1), Buffer.from([flag | 1]), enc(min), enc(newMax), b.subarray(j3, end)]);
      out.push(Buffer.from([5]), enc(body.length), body);
    } else {
      out.push(b.subarray(i, end));
    }
    i = end;
  }
  if (oldMax == null) throw new Error('memory section not found in busytex.wasm');
  if (oldMax >= newMax) return;
  const js = readFileSync(jsPath, 'utf8');
  const oldBytes = String(oldMax * 65536);
  if (!js.includes(oldBytes)) throw new Error(`heap max ${oldBytes} not found in busytex.js`);
  writeFileSync(wasmPath, Buffer.concat(out));
  writeFileSync(jsPath, js.replace(oldBytes, String(newMax * 65536)));
  console.log(`  memory limit: ${(oldMax * 65536) / 2 ** 20} MB → ${((newMax * 65536) / 2 ** 20).toFixed(0)} MB`);
}
