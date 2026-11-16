// CodeMirror 6 によるソースエディタ
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  dropCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';

const COMMANDS = [
  'documentclass', 'usepackage', 'begin', 'end', 'section', 'subsection', 'subsubsection', 'paragraph',
  'chapter', 'part', 'title', 'author', 'date', 'maketitle', 'tableofcontents', 'label', 'ref', 'eqref',
  'pageref', 'cite', 'bibliography', 'bibliographystyle', 'addbibresource', 'printbibliography',
  'includegraphics', 'caption', 'centering', 'textbf', 'textit', 'texttt', 'emph', 'underline', 'footnote',
  'item', 'input', 'include', 'newcommand', 'renewcommand', 'NewDocumentCommand', 'setmainfont',
  'setsansfont', 'setmonofont', 'setmathfont', 'directlua', 'luaexec', 'frac', 'sqrt', 'sum', 'int',
  'prod', 'lim', 'infty', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi',
  'sigma', 'phi', 'omega', 'left', 'right', 'mathbb', 'mathrm', 'mathbf', 'mathcal', 'hspace', 'vspace',
  'newpage', 'clearpage', 'noindent', 'hline', 'multicolumn', 'url', 'href', 'today', 'appendix',
  'printindex', 'makeindex', 'index', 'textwidth', 'linewidth', 'small', 'large', 'Large', 'LARGE',
  'huge', 'Huge', 'footnotesize', 'scriptsize', 'tiny', 'normalsize',
].map((c) => ({ label: '\\' + c, type: 'keyword' }));

const ENVIRONMENTS = [
  'document', 'figure', 'table', 'tabular', 'itemize', 'enumerate', 'description', 'equation', 'equation*',
  'align', 'align*', 'gather', 'multline', 'center', 'abstract', 'verbatim', 'quote', 'minipage',
  'tikzpicture', 'theorem', 'proof', 'frame', 'luacode', 'thebibliography', 'cases', 'pmatrix', 'bmatrix',
];

function latexCompletions(ctx: CompletionContext): CompletionResult | null {
  const env = ctx.matchBefore(/\\(begin|end)\{[\w*]*/);
  if (env) {
    const brace = env.text.indexOf('{');
    return {
      from: env.from + brace + 1,
      options: ENVIRONMENTS.map((e) => ({ label: e, type: 'type' })),
      validFor: /^[\w*]*$/,
    };
  }
  const cmd = ctx.matchBefore(/\\[A-Za-z]*/);
  if (!cmd || (cmd.from === cmd.to && !ctx.explicit)) return null;
  return { from: cmd.from, options: COMMANDS, validFor: /^\\[A-Za-z]*$/ };
}

const texHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--cm-command)' },
  { tag: t.keyword, color: 'var(--cm-command)' },
  { tag: t.atom, color: 'var(--cm-atom)' },
  { tag: t.bracket, color: 'var(--cm-bracket)' },
  { tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--cm-string)' },
  { tag: t.number, color: 'var(--cm-number)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: 'var(--editor-font-size, 14px)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--gutter-bg)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
});

export interface EditorCallbacks {
  onChange: (path: string, text: string) => void;
  onCompile: (full: boolean) => void;
  onForwardSync: () => void;
}

export class SourceEditor {
  readonly view: EditorView;
  private states = new Map<string, EditorState>();
  private currentPath: string | null = null;
  private wrap = new Compartment();
  private readOnly = new Compartment();

  constructor(parent: HTMLElement, private cb: EditorCallbacks) {
    this.view = new EditorView({ parent, state: this.makeState('', '') });
  }

  private extensions(path: string): Extension[] {
    const isTexLike = /\.(tex|sty|cls|ltx|dtx|bib|bbx|cbx|def|lua)$/i.test(path) || !path.includes('.');
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(texHighlight),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [latexCompletions] }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      lintGutter(),
      isTexLike ? StreamLanguage.define(stex) : [],
      this.wrap.of(EditorView.lineWrapping),
      this.readOnly.of(EditorState.readOnly.of(false)),
      theme,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (this.cb.onCompile(false), true) },
        { key: 'Shift-Mod-s', preventDefault: true, run: () => (this.cb.onCompile(true), true) },
        { key: 'Mod-Enter', preventDefault: true, run: () => (this.cb.onCompile(false), true) },
        { key: 'Mod-Alt-j', preventDefault: true, run: () => (this.cb.onForwardSync(), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && this.currentPath) this.cb.onChange(this.currentPath, u.state.doc.toString());
      }),
    ];
  }

  private makeState(path: string, text: string): EditorState {
    return EditorState.create({ doc: text, extensions: this.extensions(path) });
  }

  get path(): string | null {
    return this.currentPath;
  }

  open(path: string, text: string): void {
    if (this.currentPath) this.states.set(this.currentPath, this.view.state);
    let st = this.states.get(path);
    if (!st || st.doc.toString() !== text) {
      st = this.makeState(path, text);
    }
    this.currentPath = path;
    this.view.setState(st);
  }

  close(): void {
    if (this.currentPath) this.states.set(this.currentPath, this.view.state);
    this.currentPath = null;
    this.view.setState(this.makeState('', ''));
  }

  forget(path: string): void {
    this.states.delete(path);
    if (this.currentPath === path) this.close();
  }

  rename(from: string, to: string): void {
    const st = this.states.get(from);
    if (st) {
      this.states.delete(from);
      this.states.set(to, st);
    }
    if (this.currentPath === from) this.currentPath = to;
  }

  reset(): void {
    this.states.clear();
    this.close();
  }

  cursorLine(): number {
    const pos = this.view.state.selection.main.head;
    return this.view.state.doc.lineAt(pos).number;
  }

  gotoLine(line: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(doc.lines, line)));
    this.view.dispatch({
      selection: { anchor: l.from, head: l.from },
      effects: EditorView.scrollIntoView(l.from, { y: 'center' }),
    });
    this.view.focus();
  }

  setDiagnostics(items: { line: number; severity: 'error' | 'warning' | 'info'; message: string }[]): void {
    const doc = this.view.state.doc;
    const diags: Diagnostic[] = items
      .filter((d) => d.line >= 1 && d.line <= doc.lines)
      .map((d) => {
        const l = doc.line(d.line);
        return { from: l.from, to: l.to, severity: d.severity, message: d.message };
      });
    this.view.dispatch(setDiagnostics(this.view.state, diags));
  }
}
