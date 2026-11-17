// TeX の .log からエラー / 警告を抽出する簡易パーサ

export interface LogIssue {
  level: 'error' | 'warning' | 'badbox';
  message: string;
  file?: string; // プロジェクト内の相対パス
  line?: number;
  context?: string;
}

const encoder = new TextEncoder();

/**
 * TeX は max_print_line = 79「バイト」で折り返す。LuaTeX は UTF-8 の文字を途中で切らず、
 * 多バイト文字の前では早めに折り返すため、日本語を含む行は 76〜78 バイトで折り返されることがある
 * （実ログで確認）。
 */
function isWrapped(segment: string): boolean {
  const bytes = encoder.encode(segment).length;
  if (bytes === 79) return true;
  return bytes >= 76 && bytes < 79 && /[^\x00-\x7f]/.test(segment);
}

/** 折り返された行を可能な範囲で連結する */
function unwrap(log: string): string[] {
  const raw = log.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let seg = raw[i];
    let l = seg;
    while (isWrapped(seg) && i + 1 < raw.length) {
      seg = raw[++i];
      l += seg;
    }
    out.push(l);
  }
  return out;
}

function normalize(path: string): string {
  let p = path.replace(/^"|"$/g, '');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** システム側ファイルの表示名（リモート取得ファイルの "26_" 接頭辞は除く） */
function systemName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return `${base.replace(/^\d+_/, '')}（システム）`;
}

// WASM 環境では意味のない / 冗長なメッセージ
const NOISE = [
  /^==> Fatal error occurred/,
  /epstopdf Warning: Shell escape feature is not enabled/,
  /luatexja-preset Warning: Japanese fonts will be scaled by/,
];

export function parseLog(log: string, mainFile: string): LogIssue[] {
  const lines = unwrap(log);
  const issues: LogIssue[] = [];
  const stack: (string | null)[] = [];
  const currentFile = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f) return f;
    }
    return mainFile;
  };

  const fileRe = /^\(("?)((?:\.\/|\/|[A-Za-z]:)?[^\s()"]+\.[A-Za-z0-9]+)\1/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // エラー
    if (line.startsWith('! ')) {
      let message = line.slice(2);
      let lineNo: number | undefined;
      let context: string | undefined;
      for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
        const m = /^l\.(\d+)\s?(.*)$/.exec(lines[j]);
        if (m) {
          lineNo = parseInt(m[1], 10);
          context = m[2];
          break;
        }
        if (j === i + 1 && lines[j] && !lines[j].startsWith('l.') && !lines[j].startsWith('<')) {
          // 複数行メッセージ
          if (!/^(See the|Type|\?)/.test(lines[j])) message += ' ' + lines[j].trim();
        }
      }
      issues.push({ level: 'error', message, file: currentFile(), line: lineNo, context });
      continue;
    }

    // LuaTeX の Lua エラーなど "file:line: message" 形式
    const fl = /^(\.\/[^:]+):(\d+): (.*)$/.exec(line);
    if (fl) {
      issues.push({ level: 'error', message: fl[3], file: normalize(fl[1]), line: parseInt(fl[2], 10) });
      continue;
    }

    // 警告
    const w = /^((?:LaTeX|Package|Class|Module) ?(?:[\w-]+ )?Warning:|LaTeX Font Warning:)\s*(.*)$/.exec(line);
    if (w) {
      let message = w[2];
      // 続き行（(pkg)  で始まる）
      let j = i + 1;
      while (j < lines.length && /^\([\w-]+\)\s+/.test(lines[j])) {
        message += ' ' + lines[j].replace(/^\([\w-]+\)\s+/, '');
        j++;
      }
      if (!message && j < lines.length) message = lines[j];
      const lm = /on input line (\d+)/.exec(message);
      issues.push({
        level: 'warning',
        message: `${w[1].replace(/:$/, '')}: ${message}`.trim(),
        file: currentFile(),
        line: lm ? parseInt(lm[1], 10) : undefined,
      });
    }

    const bb = /^(Overfull|Underfull) \\[hv]box .*?(?:at lines? (\d+)(?:--\d+)?)?$/.exec(line);
    if (bb) {
      issues.push({
        level: 'badbox',
        message: line,
        file: currentFile(),
        line: bb[2] ? parseInt(bb[2], 10) : undefined,
      });
    }

    // ファイルスタックの追跡
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '(') {
        const m = fileRe.exec(line.slice(k));
        if (m) {
          const p = m[2];
          const isProject = !p.startsWith('/');
          // TeX Live / 追加パッケージ側のファイルは名前だけ記録する（クリックしてもジャンプしない）
          stack.push(isProject ? normalize(p) : systemName(p));
          k += m[0].length - 1;
        } else {
          stack.push(null);
        }
      } else if (ch === ')') {
        stack.pop();
      }
    }
  }

  // 重複除去とノイズ除去
  const seen = new Set<string>();
  return issues.filter((x) => {
    if (NOISE.some((re) => re.test(x.message))) return false;
    const key = `${x.level}|${x.file}|${x.line}|${x.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
