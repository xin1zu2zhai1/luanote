// 追加パッケージ（luatexja・原ノ味フォント・jlreq）を取得し、
// BusyTeX のリモート kpathsea 形式（<endpoint>/<kpse format 番号>/<ファイル名>）で
// public/core/texmf-extra/ に配置する。
//
// エンジンは TeX Live 内でファイルが見つからなかったときだけ、このディレクトリに
// 同期 XHR で問い合わせる（busytex.js の KPSE_REMOTE.fetch）。必要なファイルだけが
// 遅延ダウンロードされ、ワーカーが生きている間はメモリにキャッシュされる。
//
//   node scripts/fetch-extras.mjs            # 既にあればスキップ
//   node scripts/fetch-extras.mjs --force    # 作り直す
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const cacheDir = join(process.env.ASSET_CACHE_DIR ?? join(root, '.asset-cache'), 'extras');
const outDir = join(root, 'public/core/texmf-extra');

// TeX Live 2026 の LaTeX カーネル (2025-11-01) に合わせたバージョンに固定する
const SOURCES = [
  {
    name: 'luatexja',
    repo: 'https://github.com/luatexja/luatexja',
    ref: '20260130.1',
    dirs: ['src'],
  },
  {
    name: 'haranoaji',
    repo: 'https://github.com/trueroad/HaranoAjiFonts',
    ref: '20250811',
    dirs: ['.'],
  },
  {
    name: 'jlreq',
    repo: 'https://github.com/abenori/jlreq',
    // タグが古いので TeX Live 2026 リリース時期のコミットに固定
    ref: '6c6da3775bcac030f891fddf2311d45346965aca',
    dirs: ['.'],
  },
  {
    // ルビ（\ruby, \jruby）。TeX Live の collection-langjapanese に含まれるが WASM ビルドには無い
    name: 'pxrubrica',
    repo: 'https://github.com/zr-tex8r/PXrubrica',
    ref: 'v1.3e',
    dirs: ['.'],
    only: /^pxrubrica\.sty$/,
  },
  {
    // pTeX/upTeX 判定（\ifptex, \ifuptex）。gckanbun などが読み込む。collection-langjapanese 所属
    name: 'ifptex',
    repo: 'https://github.com/zr-tex8r/ifptex',
    ref: 'v2.2c',
    dirs: ['.'],
    only: /^if(u?ptex)\.sty$/,
  },
  {
    // TeX Live の WASM ビルドに無いのでリポジトリに同梱（vendor/kanbun/SOURCE.md 参照）
    name: 'kanbun',
    local: 'vendor/kanbun',
    ref: 'v1.3',
    dirs: ['.'],
    only: /^kanbun\.(sty|lua)$/,
  },
  {
    // ユーザー提供の解答欄パッケージ（vendor/answerbox/SOURCE.md 参照）
    name: 'answerbox',
    local: 'vendor/answerbox',
    ref: 'local',
    dirs: ['.'],
    only: /\.sty$/,
  },
  {
    // luatexja が参照する Adobe-Japan1 の CMap（TeX Live の adobemapping 相当）
    name: 'cmap-resources',
    repo: 'https://github.com/adobe-type-tools/cmap-resources',
    ref: '20231115',
    dirs: ['Adobe-Japan1-7/CMap'],
    cmap: true,
  },
  {
    name: 'mapping-resources-pdf',
    repo: 'https://github.com/adobe-type-tools/mapping-resources-pdf',
    ref: '20230118',
    dirs: ['pdf2unicode'],
    cmap: true,
    only: /^Adobe-Japan1-UCS2$/,
  },
];

// kpathsea の kpse_file_format_type
const FMT = { tex: 26, cmap: 45, opentype: 47, lua: 51 };
const TEX_EXT = new Set(['.sty', '.cls', '.clo', '.tex', '.def', '.cfg', '.fd', '.ltx']);
// ビルド用・テスト用で配信不要なもの
const SKIP = [/^check_/, /^make_/, /^luajfm2pl/, /^jfm-jlreq-.*-template/, /\.dtx$/, /\.ins$/];

const STAMP = JSON.stringify(SOURCES.map((s) => `${s.name}@${s.ref}`));

if (!force && existsSync(join(outDir, 'manifest.json'))) {
  try {
    const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    if (JSON.stringify(m.sources) === STAMP) {
      console.log('✓ texmf-extra already present');
      process.exit(0);
    }
  } catch {
    /* 作り直す */
  }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

mkdirSync(cacheDir, { recursive: true });
rmSync(outDir, { recursive: true, force: true });
for (const f of Object.values(FMT)) mkdirSync(join(outDir, String(f)), { recursive: true });

const manifest = { sources: JSON.parse(STAMP), files: {} };

for (const src of SOURCES) {
  const dest = src.local ? join(root, src.local) : join(cacheDir, `${src.name}-${src.ref}`);
  if (!src.local && !existsSync(dest)) {
    console.log(`Cloning ${src.repo} @ ${src.ref}`);
    if (/^[0-9a-f]{40}$/.test(src.ref)) {
      mkdirSync(dest, { recursive: true });
      const git = (...a) => execFileSync('git', ['-C', dest, ...a], { stdio: 'inherit' });
      git('init', '--quiet');
      git('fetch', '--quiet', '--depth', '1', src.repo, src.ref);
      git('checkout', '--quiet', 'FETCH_HEAD');
    } else {
      execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', src.ref, src.repo, dest], {
        stdio: 'inherit',
      });
    }
  }
  let count = 0;
  for (const d of src.dirs) {
    for (const file of walk(join(dest, d))) {
      const name = basename(file);
      const ext = extname(name).toLowerCase();
      if (SKIP.some((re) => re.test(name))) continue;
      if (src.only && !src.only.test(name)) continue;
      let formats = [];
      if (src.cmap) formats = ext ? [] : [FMT.cmap];
      else if (ext === '.otf') formats = [FMT.opentype];
      else if (ext === '.lua') formats = [FMT.lua, FMT.tex];
      else if (TEX_EXT.has(ext)) formats = [FMT.tex];
      if (!formats.length) continue;
      for (const f of formats) {
        const target = join(outDir, String(f), name);
        if (existsSync(target)) {
          console.warn(`  ! duplicate ${f}/${name} (${src.name}) — skipped`);
          continue;
        }
        copyFileSync(file, target);
        (manifest.files[f] ??= []).push(name);
      }
      count++;
    }
  }
  console.log(`✓ ${src.name}@${src.ref}: ${count} files`);
}

// ---------------------------------------------------------------------------
// jlreq の縦書き用 JFM（本来は Makefile で texlua make_variant_jfm.lua により生成）
// make_variant_jfm.lua と同じく「jlreq オプションを適用しない横書き JFM」に tate() を適用し、
// make_variant_jfm.lua が追記するオプション処理コードをそのまま後ろに付ける。
// 横書き JFM はエンジン内で実行時に読み込む（ここでは Lua を実行しない）。
// ---------------------------------------------------------------------------
{
  const jl = SOURCES.find((s) => s.name === 'jlreq');
  const variant = readFileSync(join(cacheDir, `${jl.name}-${jl.ref}`, 'make_variant_jfm.lua'), 'utf8');
  const m = /local file = "jfm-" \.\. originaljfm \.\. "v\.lua"[\s\S]*?fp:write\(\[\[\n([\s\S]*?)\]\]\)/.exec(variant);
  if (!m) throw new Error('make_variant_jfm.lua の形式が想定と異なります');
  const tail = m[1];
  const loader = (src) => `-- LuaNote: generated from ${src} (equivalent to jlreq's make_variant_jfm.lua)
local jfm
do
  local saved_define, saved_jlreq = luatexja.jfont.define_jfm, jlreq
  jlreq = nil
  luatexja.jfont.define_jfm = function(j) jfm = j end
  dofile(kpse.find_file('${src}'))
  luatexja.jfont.define_jfm = saved_define
  jlreq = saved_jlreq
end
jfm.dir = 'tate'
for key, _ in pairs(jfm) do
  if type(key) == 'number' then
    jfm[key].height = 0.5
    jfm[key].depth = 0.5
  end
end
`;
  const gen = {
    'jfm-jlreqv.lua': loader('jfm-jlreq.lua') + tail,
    'jfm-jlreqv-jidori.lua': loader('jfm-jlreq-jidori.lua') + 'luatexja.jfont.define_jfm(jfm)\n',
  };
  for (const [name, body] of Object.entries(gen)) {
    for (const f of [FMT.lua, FMT.tex]) {
      writeFileSync(join(outDir, String(f), name), body);
      (manifest.files[f] ??= []).push(name);
    }
  }
  console.log('✓ jlreq vertical JFMs generated');
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`✓ texmf-extra → public/core/texmf-extra`);
