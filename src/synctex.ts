// 最小限の SyncTeX パーサ（PDF ⇄ ソースのジャンプ用）
import { gunzipSync } from 'fflate';

export interface SyncRecord {
  type: string;
  file: string;
  line: number;
  page: number;
  /** PDF 座標系（bp, 左上原点） */
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
}

const PROJECT_PREFIX = /^\/home\/web_user\/project_dir\/?/;
const SP_PER_BP = 65781.76;

export class SyncTex {
  records: SyncRecord[] = [];

  static fromGzip(data: Uint8Array): SyncTex | null {
    try {
      const text = new TextDecoder().decode(gunzipSync(data));
      return SyncTex.parse(text);
    } catch {
      return null;
    }
  }

  static parse(text: string): SyncTex {
    const s = new SyncTex();
    const inputs = new Map<number, string>();
    let unit = 1;
    let mag = 1;
    let xOff = 0;
    let yOff = 0;
    let page = 0;
    const conv = (v: string) => (parseInt(v, 10) * unit * mag) / SP_PER_BP;

    const recRe = /^([[(hvxkg$])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

    for (const raw of text.split('\n')) {
      if (!raw) continue;
      const c = raw[0];
      if (raw.startsWith('Input:')) {
        const m = /^Input:(\d+):(.*)$/.exec(raw);
        if (m) {
          let p = m[2].replace(PROJECT_PREFIX, '');
          p = p.replace(/(^|\/)\.\//g, '$1');
          inputs.set(parseInt(m[1], 10), p);
        }
        continue;
      }
      if (raw.startsWith('Unit:')) {
        unit = parseFloat(raw.slice(5)) || 1;
        continue;
      }
      if (raw.startsWith('Magnification:')) {
        mag = (parseFloat(raw.slice(14)) || 1000) / 1000;
        continue;
      }
      if (raw.startsWith('X Offset:')) {
        xOff = parseInt(raw.slice(9), 10) || 0;
        continue;
      }
      if (raw.startsWith('Y Offset:')) {
        yOff = parseInt(raw.slice(9), 10) || 0;
        continue;
      }
      if (c === '{') {
        page = parseInt(raw.slice(1), 10);
        continue;
      }
      const m = recRe.exec(raw);
      if (m && page > 0) {
        const tag = parseInt(m[2], 10);
        const line = parseInt(m[3], 10);
        const file = inputs.get(tag);
        if (!file || line <= 0) continue;
        // LuaTeX は数式中の kern などで y=0 を書き出すことがあるので無視する
        if (m[5] === '0') continue;
        s.records.push({
          type: m[1],
          file,
          line,
          page,
          x: conv(m[4]) + xOff / SP_PER_BP,
          y: conv(m[5]) + yOff / SP_PER_BP,
          w: m[6] ? conv(m[6]) : 0,
          h: m[7] ? conv(m[7]) : 0,
          d: m[8] ? conv(m[8]) : 0,
        });
      }
    }
    return s;
  }

  /** PDF 上の点 → ソース位置 */
  reverse(page: number, x: number, y: number): { file: string; line: number } | null {
    let best: SyncRecord | null = null;
    let bestScore = Infinity;
    for (const r of this.records) {
      if (r.page !== page) continue;
      let score: number;
      if (r.w > 0) {
        // ボックス：内部なら優先、面積の小さいものほど良い
        const top = r.y - r.h;
        const bottom = r.y + r.d;
        const inside = x >= r.x && x <= r.x + r.w && y >= top && y <= bottom;
        const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
        const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
        score = inside ? -1e6 + r.w * (r.h + r.d) * 1e-3 : Math.hypot(dx, dy * 2);
      } else {
        score = Math.hypot(x - r.x, (y - r.y) * 2) + 5;
      }
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best ? { file: best.file, line: best.line } : null;
  }

  /** ソース位置 → PDF 上の位置 */
  forward(file: string, line: number): { page: number; x: number; y: number; w: number; h: number } | null {
    // 垂直ボックスはページ全体を覆うことがあるので除外し、行レベルの記録だけを使う
    const pool = this.records.filter((r) => r.file === file && r.type !== '[' && r.type !== 'v');
    let cand = pool.filter((r) => r.line === line);
    if (!cand.length) {
      // 近い行を探す（後方優先）
      let bestDiff = Infinity;
      for (const r of pool) {
        const diff = r.line >= line ? r.line - line : (line - r.line) + 0.5;
        if (diff < bestDiff) bestDiff = diff;
      }
      if (!isFinite(bestDiff)) return null;
      cand = pool.filter((r) => (r.line >= line ? r.line - line : (line - r.line) + 0.5) === bestDiff);
    }
    // 水平ボックス（行）があればそれを優先
    const boxes = cand.filter((r) => (r.type === '(' || r.type === 'h') && r.w > 0);
    if (boxes.length) cand = boxes;
    // 異常に背の高いボックス（段落全体など）は除く
    const flat = cand.filter((r) => r.h + r.d < 40);
    if (flat.length) cand = flat;
    const page = Math.min(...cand.map((r) => r.page));
    const onPage = cand.filter((r) => r.page === page);
    const x0 = Math.min(...onPage.map((r) => r.x));
    const x1 = Math.max(...onPage.map((r) => r.x + r.w));
    const y0 = Math.min(...onPage.map((r) => r.y - (r.h || 8)));
    const y1 = Math.max(...onPage.map((r) => r.y + (r.d || 2)));
    return { page, x: x0, y: y0, w: Math.max(x1 - x0, 20), h: Math.max(y1 - y0, 10) };
  }
}
