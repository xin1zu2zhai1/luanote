// texlive-extra（latex-extra）にだけあるファイルを BusyTeX のデータパッケージから取り出し、
// リモート kpathsea 形式（core/texmf-extra/<kpse format>/<name>）で配置する。
//
// これにより recommended だけをメモリに読み込んだまま、latex-extra のパッケージを
// 必要なファイルだけ遅延取得で使える（342 MB の extra パッケージの読み込みと
// それに伴う WASM メモリ不足を避けられる）。
//
//   node scripts/build-lazy-extra.mjs
//
// 前提: scripts/fetch-assets.mjs と scripts/fetch-extras.mjs を先に実行していること。
// 既に texmf-extra にあるファイル（luatexja など同梱分）は上書きしない。
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(root, 'public/core/texlive-2026');
const outDir = join(root, 'public/core/texmf-extra');

const extraJs = join(coreDir, 'texlive-extra.js');
const extraData = join(coreDir, 'texlive-extra.data');
if (!existsSync(extraJs) || !existsSync(extraData)) {
  const mf = join(outDir, 'manifest.json');
  if (existsSync(mf) && JSON.parse(readFileSync(mf, 'utf8')).lazyExtra?.files) {
    console.log('✓ lazy extra already built');
    process.exit(0);
  }
  console.error('texlive-extra.{js,data} が見つかりません。先に fetch-assets を実行してください。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Emscripten file_packager のメタデータ
// ---------------------------------------------------------------------------
function readFileList(js) {
  const files = [];
  const re = /"filename": "([^"]+)", "start": (\d+), "end": (\d+)/g;
  for (let m; (m = re.exec(js)); ) files.push({ path: m[1], start: +m[2], end: +m[3] });
  return files;
}

const extraSrc = readFileSync(extraJs, 'utf8');
const recSrc = readFileSync(join(coreDir, 'texlive-recommended.js'), 'utf8');
const extraFiles = readFileList(extraSrc);
const recPaths = new Set(readFileList(recSrc).map((f) => f.path));
const recNames = new Set([...recPaths].map((p) => p.slice(p.lastIndexOf('/') + 1)));

const cm = /var compressedData = (\{[^\n]*\})\s*;/.exec(extraSrc);
if (!cm) throw new Error('compressedData が見つかりません（LZ4 圧縮のパッケージを想定）');
const compressed = JSON.parse(cm[1]);
const CHUNK = 2048; // Emscripten LZ4.CHUNK_SIZE

// ---------------------------------------------------------------------------
// LZ4 ブロックの展開（Emscripten の MiniLZ4 と同じ形式）
// ---------------------------------------------------------------------------
function lz4Block(src, dst) {
  let si = 0;
  let di = 0;
  while (si < src.length) {
    const token = src[si++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do {
        b = src[si++];
        lit += b;
      } while (b === 255);
    }
    for (let i = 0; i < lit; i++) dst[di++] = src[si++];
    if (si >= src.length) break;
    const offset = src[si] | (src[si + 1] << 8);
    si += 2;
    let len = token & 15;
    if (len === 15) {
      let b;
      do {
        b = src[si++];
        len += b;
      } while (b === 255);
    }
    len += 4;
    let from = di - offset;
    for (let i = 0; i < len; i++) dst[di++] = dst[from++];
  }
  return di;
}

const fd = openSync(extraData, 'r');
const chunkCache = new Map();
function chunk(i) {
  let c = chunkCache.get(i);
  if (c) return c;
  const off = compressed.offsets[i];
  const size = compressed.sizes[i];
  const buf = Buffer.alloc(size);
  readSync(fd, buf, 0, size, off);
  if (compressed.successes[i]) {
    const out = new Uint8Array(CHUNK);
    const n = lz4Block(buf, out);
    c = out.subarray(0, n);
  } else {
    c = new Uint8Array(buf);
  }
  if (chunkCache.size > 64) chunkCache.clear();
  chunkCache.set(i, c);
  return c;
}
function readRange(start, end) {
  const out = new Uint8Array(end - start);
  let pos = start;
  let o = 0;
  while (pos < end) {
    const ci = Math.floor(pos / CHUNK);
    const c = chunk(ci);
    const inChunk = pos - ci * CHUNK;
    const n = Math.min(c.length - inChunk, end - pos);
    out.set(c.subarray(inChunk, inChunk + n), o);
    o += n;
    pos += n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// TeX Live のディレクトリ → kpathsea の format 番号
// 拡張子なしでも問い合わせられるもの（TFM など）は拡張子なしの名前でも置く
// ---------------------------------------------------------------------------
const RULES = [
  { dir: '/texlive/texmf-dist/tex/latex-dev/', skip: true },
  { dir: '/texlive/texmf-dist/tex/', fmt: [26], luaAlso: true },
  { dir: '/texlive/texmf-dist/fonts/tfm/', fmt: [3], bare: '.tfm' },
  { dir: '/texlive/texmf-dist/fonts/vf/', fmt: [33], bare: '.vf' },
  { dir: '/texlive/texmf-dist/fonts/ofm/', fmt: [20], bare: '.ofm' },
  { dir: '/texlive/texmf-dist/fonts/ovf/', fmt: [23], bare: '.ovf' },
  { dir: '/texlive/texmf-dist/fonts/type1/', fmt: [32] },
  { dir: '/texlive/texmf-dist/fonts/opentype/', fmt: [47] },
  { dir: '/texlive/texmf-dist/fonts/truetype/', fmt: [36] },
  { dir: '/texlive/texmf-dist/fonts/enc/', fmt: [44] },
  { dir: '/texlive/texmf-dist/fonts/afm/', fmt: [4] },
  { dir: '/texlive/texmf-dist/fonts/cmap/', fmt: [45] },
  { dir: '/texlive/texmf-dist/fonts/sfd/', fmt: [46] },
  { dir: '/texlive/texmf-dist/bibtex/bst/', fmt: [7], bare: '.bst' },
  { dir: '/texlive/texmf-dist/bibtex/bib/', fmt: [6], bare: '.bib' },
  { dir: '/texlive/texmf-dist/makeindex/', fmt: [35] },
];

let written = 0;
let bytes = 0;
let skipped = 0;
const seen = new Set();
const manifestPath = join(outDir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { files: {} };
manifest.lazyExtra = { from: 'texlive-extra (texlyre-busytex)', files: 0 };

for (const f of extraFiles) {
  if (recPaths.has(f.path)) continue;
  const rule = RULES.find((r) => f.path.startsWith(r.dir));
  if (!rule || rule.skip) continue;
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  if (!name || name.startsWith('.')) continue;
  // recommended に同名ファイルがある場合、kpathsea はそちらを先に見つけるので不要
  if (recNames.has(name)) {
    skipped++;
    continue;
  }
  const fmts = [...rule.fmt];
  if (rule.luaAlso && name.endsWith('.lua')) fmts.push(51);
  const names = [name];
  if (rule.bare && name.endsWith(rule.bare)) names.push(name.slice(0, -rule.bare.length));
  let data = null;
  for (const fmt of fmts) {
    for (const n of names) {
      const key = `${fmt}/${n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = join(outDir, String(fmt), n);
      if (existsSync(target)) continue; // 同梱パッケージ（luatexja など）を優先
      data ??= readRange(f.start, f.end);
      mkdirSync(join(outDir, String(fmt)), { recursive: true });
      writeFileSync(target, data);
      written++;
      bytes += data.length;
    }
  }
}
closeSync(fd);

manifest.lazyExtra.files = written;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`✓ lazy extra: ${written} files, ${(bytes / 1e6).toFixed(1)} MB (同名のため省略 ${skipped})`);

// extra パッケージ本体（342 MB）は配信しない
for (const name of readdirSync(coreDir)) {
  if (/^texlive-extra\./.test(name)) rmSync(join(coreDir, name));
}
console.log('✓ removed texlive-extra.* from the site');
