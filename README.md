# LuaNote

ブラウザだけで動く **LuaLaTeX** エディタ（Overleaf ライク）。
TeX Live 2026 を WebAssembly 化した [BusyTeX](https://github.com/busytex/busytex)（[texlyre-busytex](https://github.com/TeXlyre/texlyre-busytex) ビルド）を使い、
コンパイルはすべてブラウザ内で行います。サーバーは不要で、GitHub Pages でそのまま公開できます。

**公開ページ:** https://xin1zu2zhai1.github.io/luanote/

## 機能

- **3 ペイン表示**: ファイルツリー / ソース（CodeMirror 6）/ PDF プレビュー（pdf.js）。ペイン幅はドラッグで調整可能。スマホではタブ切り替え。
- **LuaLaTeX（LuaHBTeX 1.24）でレンダリング**: `fontspec`・`unicode-math`・`\directlua` などが使えます。
- **日本語組版**: LuaTeX-ja（`ltjsarticle` など）・原ノ味フォント・`jlreq`（横書き / 縦書き）・`kanbun`（漢文訓読）を同梱。必要なファイルだけを初回使用時に読み込みます。
- **TeX Live 2026**: latex-recommended + fonts-recommended を読み込み、latex-extra のパッケージ（`comment`、`textpos`、`ulem` など）は使うときに必要なファイルだけ取得します（`src/distributions.ts` に追加すれば他のバージョンも選択肢になります）。
- **高速コンパイル**: 通常は 1 パス。`.aux` / `.toc` / `.bbl` などを次回に引き継ぎ、必要なときだけ自動で再実行します。
  「完全ビルド」では BibTeX / Biber / makeindex を含めて複数パス実行します。
- **ファイル管理**: 新規作成、フォルダ、名前の変更・移動（ドラッグ＆ドロップ可）、削除、アップロード（画像・フォント・`.sty` など）、メインファイルの指定。
- **プロジェクト管理**: 複数プロジェクト、テンプレート、複製、ZIP のインポート / エクスポート。データはブラウザの IndexedDB に保存されます。
- **エラー表示**: ログを解析してエラー・警告を一覧表示し、クリックで該当行にジャンプ。エディタにもマーカーを表示。
- **SyncTeX**: PDF をダブルクリックするとソースの該当行へ、「→ PDF」（Ctrl+Alt+J）でソースの位置を PDF 上に表示。
- 自動コンパイル、ダーク / ライトテーマ、PDF ダウンロード。

### ショートカット

| キー | 動作 |
| --- | --- |
| Ctrl/⌘ + S, Ctrl/⌘ + Enter | コンパイル |
| Ctrl/⌘ + Shift + S | 完全ビルド |
| Ctrl/⌘ + Shift + Enter | 編集中のファイルをコンパイル（`\documentclass` を含む .tex のみ。メインファイルの設定は変えない） |
| Ctrl/⌘ + Alt + J | カーソル位置を PDF で表示 |
| PDF をダブルクリック | ソースの該当行へ |
| Ctrl/⌘ + ホイール（PDF 上） | ズーム |

## 注意事項・制限

- 初回は TeX Live の WASM（約 32 MB）とパッケージデータ（約 201 MB）をダウンロードします。
- エンジンのメモリ上限は配布ビルドの 576 MB から約 2 GB に引き上げています（`scripts/fetch-assets.mjs`）。
  原ノ味フォントを多くのサイズ・書体で使う文書（ルビ・見出し・ゴシックなど）は 576 MB では足りないためです。
  2 回目以降はブラウザのキャッシュ（IndexedDB）から読み込みます。
- 日本語組版用の追加パッケージ（`public/core/texmf-extra/`）は TeX Live 2026 の時期に合わせたバージョンに固定しています：
  LuaTeX-ja 20260130.1、原ノ味フォント 20250811、jlreq（2026-02-26 のコミット）、Adobe-Japan1 CMap。は `vendor/answerbox/` にリポジトリ内保存しています（`\usepackage{answerbox}` などで使用可）。
  TeX Live に無いファイルはエンジンがこのディレクトリから必要な分だけ取得します（`scripts/fetch-extras.mjs`）。
- 自作の `.sty` / `.cls` / フォントはプロジェクトにアップロードすればそのまま使えます（例: `\usepackage{mystyle}`、サブフォルダなら `\usepackage{sty/mystyle}`）。
- `--shell-escape` を必要とするパッケージ（`minted` など）や、外部ツールが必要な変換（EPS/SVG → PDF）は使えません。

## 開発

```bash
npm install
npm run fetch-assets   # TeX Live WASM アセット（約 520 MB）と日本語パッケージを public/core/ に取得
npm run dev
```

本番ビルド:

```bash
BASE_PATH=/luanote/ npm run build
```

### 構成

```
src/
  main.ts           アプリ本体（UI・プロジェクト・コンパイルの流れ）
  compiler.ts       BusyTeX ランナーのラッパー（LuaLaTeX、補助ファイル引き継ぎ、自動再実行）
  distributions.ts  選択可能な TeX Live バージョン / パッケージセット
  editor.ts         CodeMirror 6 エディタ
  filetree.ts       ファイルツリー
  pdfview.ts        pdf.js による PDF 表示
  synctex.ts        SyncTeX パーサ
  logparse.ts       TeX ログ解析
  store.ts          IndexedDB 永続化
scripts/fetch-assets.mjs  WASM アセットの取得
scripts/fetch-extras.mjs  luatexja・原ノ味フォント・jlreq などの取得（リモート kpathsea 形式で配置）
scripts/build-lazy-extra.mjs  latex-extra にだけあるファイルを取り出して遅延取得用に配置
.github/workflows/deploy.yml  GitHub Pages へのデプロイ
```

### GitHub Pages へのデプロイ

`main` ブランチへの push で GitHub Actions がアセットの取得とビルドを行い、Pages にデプロイします。
リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にしてください。

## ライセンス

[AGPL-3.0-or-later](LICENSE)。
TeX エンジン部分は [texlyre-busytex](https://github.com/TeXlyre/texlyre-busytex)（AGPL-3.0）、
その元となる [BusyTeX](https://github.com/busytex/busytex)（MIT）、および TeX Live の各パッケージのライセンスに従います。
同梱する日本語関連ファイルはそれぞれのライセンスに従います：LuaTeX-ja（BSD）、原ノ味フォント（SIL Open Font License 1.1）、
jlreq（BSD 2-Clause）、kanbun（LPPL 1.3c）、Adobe CMap / マッピングリソース（BSD 3-Clause）。
