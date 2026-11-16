# kanbun（漢文訓読）

- 配布元: https://github.com/edward-martyr/kanbun （CTAN: https://ctan.org/pkg/kanbun）
- バージョン: v1.3（2025/03/17、コミット 83c9f69360a11ca60029c01c7b29d34d4a9b9354）
- ライセンス: LaTeX Project Public License 1.3 以降（README.md 参照）
- `kanbun.sty` / `kanbun.tex` は配布元の `replace.sh` と同じ置換で `kanbun-proto.*` から生成したもの（CTAN 配布物と同等）。

TeX Live 2026 の WASM ビルドのパッケージセットに含まれていないため、LuaNote に同梱している。
`scripts/fetch-extras.mjs` が `core/texmf-extra/` に配置し、`\usepackage{kanbun}` で読み込める。
