# LuaNote

ブラウザだけで動く **LuaLaTeX** エディタ（Overleaf ライク）。
TeX Live 2026 を WebAssembly 化した [BusyTeX](https://github.com/busytex/busytex)（[texlyre-busytex](https://github.com/TeXlyre/texlyre-busytex) ビルド）を使い、
コンパイルはすべてブラウザ内で行います。サーバーは不要で、GitHub Pages でそのまま公開できます。

**公開ページ:** https://xin1zu2zhai1.github.io/luanote/

## 機能

- **3 ペイン表示**: ファイルツリー / ソース（CodeMirror 6）/ PDF プレビュー（pdf.js）。ペイン幅はドラッグで調整可能。スマホではタブ切り替え。
- **LuaLaTeX（LuaHBTeX 1.24）でレンダリング**: `fontspec`・`unicode-math`・`\directlua` などが使えます。
- **TeX Live のバージョン・パッケージセットを選択**: 既定は TeX Live 2026。`basic` / `recommended` / `extra` から選べます（`src/distributions.ts` に追加すれば他のバージョンも選択肢になります）。
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
| Ctrl/⌘ + Alt + J | カーソル位置を PDF で表示 |
| PDF をダブルクリック | ソースの該当行へ |
| Ctrl/⌘ + ホイール（PDF 上） | ズーム |

## 注意事項・制限

- 初回は TeX Live の WASM（約 32 MB）とパッケージデータ（basic 93 MB / recommended 201 MB / extra 342 MB）をダウンロードします。
  2 回目以降はブラウザのキャッシュ（IndexedDB）から読み込みます。
- **日本語組版（luatexja など）は同梱パッケージセットに含まれていません。** 日本語フォント（`.otf` / `.ttf`）をプロジェクトにアップロードして
  `\setmainfont{フォントファイル名.ttf}` とすれば日本語の表示はできます（禁則処理などは行われません）。
- `--shell-escape` を必要とするパッケージ（`minted` など）や、外部ツールが必要な変換（EPS/SVG → PDF）は使えません。

## 開発

```bash
npm install
npm run fetch-assets   # TeX Live WASM アセット（約 520 MB）を public/core/ に取得
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
.github/workflows/deploy.yml  GitHub Pages へのデプロイ
```

### GitHub Pages へのデプロイ

`main` ブランチへの push で GitHub Actions がアセットの取得とビルドを行い、Pages にデプロイします。
リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にしてください。

## ライセンス

[AGPL-3.0-or-later](LICENSE)。
TeX エンジン部分は [texlyre-busytex](https://github.com/TeXlyre/texlyre-busytex)（AGPL-3.0）、
その元となる [BusyTeX](https://github.com/busytex/busytex)（MIT）、および TeX Live の各パッケージのライセンスに従います。
