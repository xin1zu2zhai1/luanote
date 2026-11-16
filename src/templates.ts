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
