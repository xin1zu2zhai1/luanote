// 新規プロジェクト用テンプレート

export interface Template {
  id: string;
  label: string;
  mainFile: string;
  files: Record<string, string>;
}

const SAMPLE_MAIN = String.raw`\documentclass[11pt]{article}
\usepackage{fontspec}        % LuaLaTeX ではOpenTypeフォントを直接扱える
\usepackage{amsmath}
\usepackage{unicode-math}
\usepackage{graphicx}
\usepackage{hyperref}
\usepackage[margin=25mm]{geometry}

\setmathfont{Latin Modern Math}

\title{Welcome to LuaNote}
\author{LuaLaTeX in your browser}
\date{\today}

\begin{document}
\maketitle
\tableofcontents

\section{Introduction}\label{sec:intro}
This document is typeset with \textbf{LuaLaTeX} (Lua\TeX{} + HarfBuzz) running
entirely in your browser via WebAssembly. Nothing is sent to a server.

\section{Mathematics}
Unicode math works out of the box:
\begin{equation}\label{eq:gauss}
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\end{equation}
Equation~\eqref{eq:gauss} is referenced from Section~\ref{sec:intro}.

\section{Lua scripting}
\directlua{
  local s = 0
  for i = 1, 100 do s = s + i end
  tex.sprint("The sum of the integers from 1 to 100 is " .. s .. " (computed in " .. _VERSION .. ").")
}

\input{sections/extra}

\section{References}
Knuth's book~\cite{knuth1984} is the classic reference.

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;

const SAMPLE_EXTRA = String.raw`\section{Multiple files}
This section lives in \texttt{sections/extra.tex} and is included with
\verb|\input|. Double-click on the PDF to jump to the corresponding source line.

\begin{itemize}
  \item Files are stored locally in your browser (IndexedDB).
  \item Press \texttt{Ctrl+S} / \texttt{Ctrl+Enter} to compile.
\end{itemize}
`;

const SAMPLE_BIB = `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`;

export const TEMPLATES: Template[] = [
  {
    id: 'sample',
    label: 'サンプル（LuaLaTeX 機能紹介）',
    mainFile: 'main.tex',
    files: { 'main.tex': SAMPLE_MAIN, 'sections/extra.tex': SAMPLE_EXTRA, 'refs.bib': SAMPLE_BIB },
  },
  {
    id: 'blank',
    label: '空の文書',
    mainFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\usepackage{fontspec}

\begin{document}

Hello, LuaLaTeX!

\end{document}
`,
    },
  },
  {
    id: 'ja-ltjs',
    label: '日本語（ltjsarticle・横書き）',
    mainFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[a4paper,11pt]{ltjsarticle}
\usepackage[haranoaji]{luatexja-preset} % 原ノ味フォント
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{hyperref}

\title{LuaLaTeX による日本語文書}
\author{著者名}
\date{\today}

\begin{document}
\maketitle

\section{はじめに}
これは LuaTeX-ja を使った日本語文書の例です。
禁則処理や和欧文間のスペース（LuaLaTeX など）は自動で調整されます。
\textbf{太字}は{\gtfamily ゴシック体}になります。

\section{数式}
数式もそのまま書けます。
\begin{equation}
  e^{i\pi} + 1 = 0
\end{equation}

\end{document}
`,
    },
  },
  {
    id: 'ja-jlreq',
    label: '日本語（jlreq・横書き）',
    mainFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[paper=a4paper,fontsize=11pt]{jlreq}
\usepackage[haranoaji]{luatexja-preset}

\title{jlreq による日本語文書}
\author{著者名}

\begin{document}
\maketitle

\section{概要}
jlreq は「日本語組版処理の要件」（JLREQ）に基づく文書クラスです。
見出しや段落の体裁が日本語の慣習に沿って組まれます。

\end{document}
`,
    },
  },
  {
    id: 'ja-tate',
    label: '日本語（jlreq・縦書き）',
    mainFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[tate,paper=a5paper,fontsize=10pt]{jlreq}
\usepackage[haranoaji]{luatexja-preset}

\begin{document}
\section{縦書きの例}
吾輩は猫である。名前はまだ無い。
どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。

数字は\tatechuyoko{12}月\tatechuyoko{25}日のように縦中横にできます。
\end{document}
`,
    },
  },
  {
    id: 'ja-kanbun',
    label: '漢文訓読（kanbun・縦書き）',
    mainFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass{ltjtarticle}
\usepackage[haranoaji]{luatexja-preset}

% kanbun パッケージ（https://ctan.org/pkg/kanbun）
% 返り点は [レ] [一] [二]、送り仮名はカタカナ、振り仮名は 漢字(かな) で書く
\newlength\myzw
\setlength\myzw{2.25\zw}
\usepackage[kumi=beta, unit=\myzw, yokoaki=3.5]{kanbun}

\Kanbun
學ビテ而時ニ習フ[レ]之ヲ，不[二]亦タ說バシカラ[一]乎。有リ[レ]朋自リ[二]遠方[一]來タル，不[二]亦タ樂シカラ[一]乎。
\EndKanbun

\begin{document}
\section{論語}
\printkanbun
\end{document}
`,
    },
  },
  {
    id: 'beamer',
    label: 'Beamer スライド',
    mainFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass{beamer}
\usetheme{Madrid}
\title{My Presentation}
\author{Author}
\date{\today}

\begin{document}
\frame{\titlepage}

\begin{frame}{First slide}
  \begin{itemize}
    \item Typeset with LuaLaTeX
    \item Runs in the browser
  \end{itemize}
\end{frame}
\end{document}
`,
    },
  },
];
