# answerbox / answerboxHK（解答欄）

- `answerbox.sty` — Copyright (C) 2017-2022 by hohei（v1.50, 2021/11/14）
- `answerboxHK.sty` — answerbox.sty を hideki kawaguchi 氏が改変したもの
  （小問番号「問一…」、大問番号の漢数字化、`\arabicz` / `\arabick` を追加）

ユーザーから提供されたファイルを無改変で保存している。
`scripts/fetch-extras.mjs` が `core/texmf-extra/` に配置し、`\usepackage{answerbox}` /
`\usepackage{answerboxHK}` で読み込める。依存: tikz, etoolbox, xkeyval, xcolor
（パッケージセット recommended 以上）。
