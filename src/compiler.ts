// BusyTeX (TeX Live WASM) を使った LuaLaTeX コンパイラのラッパー
import { BusyTexRunner } from 'texlyre-busytex';
import type { CompileResult, FileInput } from 'texlyre-busytex';
import { assetBase, extrasEndpoint, findDistribution } from './distributions';
import type { BibMode } from './store';

export interface CompileRequest {
  files: FileInput[];
  mainFile: string;
  distribution: string;
  packageSet: string;
  bib: BibMode;
  /** true: bibtex/makeindex を含む完全ビルド（複数パス） */
  full: boolean;
}

export interface CompileOutput {
  success: boolean;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log: string;
  /** TeX のログ以外の原因による失敗（メモリ不足など） */
  error?: string;
  /** 最後の TeX パスの .log 本文 */
  texLog: string;
  passes: number;
  ms: number;
}

export type EngineStatus =
  | { state: 'idle' }
  | { state: 'loading'; percent: number; label: string }
  | { state: 'ready'; label: string }
  | { state: 'error'; message: string };

const OOM_PATTERN = /Cannot enlarge memory|memory exhausted|Aborted\(OOM\)/;

// 補助ファイル。次回のコンパイルに引き継いで 1 パスで済むようにする
const AUX_EXT = /\.(aux|toc|lof|lot|loa|out|bbl|nav|snm|vrb|ind|gls|glg|acr|brf|thm|xref|lol)$/i;
const RERUN_PATTERNS = [
  'Rerun to get',
  'Rerun LaTeX',
  'Label(s) may have changed',
  'run LaTeX again',
];
const MAX_AUTO_RERUN = 2;

export class LuaLatexCompiler {
  private runner: BusyTexRunner | null = null;
  private runnerKey = '';
  private initPromise: Promise<void> | null = null;
  private auxCache = new Map<string, Uint8Array>(); // path -> content
  private auxCacheKey = '';
  /** 補助ファイルキャッシュ作成後に完全ビルドを実行済みか（.bbl が出ない文書で毎回完全ビルドしないため） */
  private fullBuilt = false;
  private queue: Promise<unknown> = Promise.resolve();
  onStatus: (s: EngineStatus) => void = () => {};

  /** エンジンを（必要なら）初期化する。distribution / packageSet が変わったら作り直す */
  async ensure(distributionId: string, packageSetId: string): Promise<BusyTexRunner> {
    const key = `${distributionId}/${packageSetId}`;
    if (this.runner && this.runnerKey === key && this.initPromise) {
      await this.initPromise;
      return this.runner;
    }
    if (this.runner) {
      this.runner.terminate();
      this.runner = null;
    }
    const dist = findDistribution(distributionId);
    const pkg = dist.packageSets.find((p) => p.id === packageSetId) ?? dist.packageSets[0];
    const base = assetBase(dist);
    const label = `${dist.label} (${pkg.label})`;
    this.runnerKey = key;
    this.auxCache.clear();
    this.fullBuilt = false;
    const runner = new BusyTexRunner({
      busytexBasePath: base,
      preloadDataPackages: [`${base}/texlive-${pkg.id}.js`],
      catalogDataPackages: [],
      engineMode: 'combined',
      onDownloadProgress: (p) => {
        if (this.runner === runner) this.onStatus({ state: 'loading', percent: p.percent, label });
      },
    });
    this.runner = runner;
    this.onStatus({ state: 'loading', percent: 0, label });
    this.initPromise = runner.initialize(true).then(
      () => {
        if (this.runner === runner) this.onStatus({ state: 'ready', label });
      },
      (err: unknown) => {
        if (this.runner === runner) {
          this.runner = null;
          this.initPromise = null;
          this.runnerKey = '';
        }
        const message = err instanceof Error ? err.message : String(err);
        this.onStatus({ state: 'error', message });
        throw err;
      },
    );
    await this.initPromise;
    return runner;
  }

  /** エンジンを破棄する（次回のコンパイルで作り直す） */
  private dropRunner(): void {
    this.runner?.terminate();
    this.runner = null;
    this.initPromise = null;
    this.runnerKey = '';
  }

  /** 補助ファイルのキャッシュを破棄（プロジェクト切替時など） */
  resetAux(key = ''): void {
    this.auxCache.clear();
    this.auxCacheKey = key;
    this.fullBuilt = false;
  }

  compile(req: CompileRequest, cacheKey: string): Promise<CompileOutput> {
    const job = this.queue.then(() => this.doCompile(req, cacheKey));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async doCompile(req: CompileRequest, cacheKey: string): Promise<CompileOutput> {
    const t0 = performance.now();
    const runner = await this.ensure(req.distribution, req.packageSet);
    if (cacheKey !== this.auxCacheKey) this.resetAux(cacheKey);

    const userPaths = new Set(req.files.map((f) => f.path));
    const hasBib = req.files.some((f) => f.path.toLowerCase().endsWith('.bib'));
    const bibOpts = (): { bibtex: boolean | null; biber: boolean | null } => {
      switch (req.bib) {
        case 'none':
          return { bibtex: false, biber: false };
        case 'bibtex':
          return { bibtex: true, biber: false };
        case 'biber':
          return { bibtex: true, biber: true };
        default:
          return { bibtex: null, biber: null };
      }
    };

    // .bib があるのに .bbl がまだ無い場合は自動的に完全ビルド
    const hasBbl = [...this.auxCache.keys()].some((p) => p.endsWith('.bbl'));
    const full = req.full || (hasBib && req.bib !== 'none' && !hasBbl && !this.fullBuilt);

    // Overleaf と同様、メインファイルがサブフォルダにあってもプロジェクト直下を基準にコンパイルする。
    // エンジンはメインファイルのフォルダで実行されるため、直下に起動用ファイルを置いて \input する。
    // \input@path にメインファイルのフォルダも加え、同じフォルダからの相対参照も解決できるようにする。
    const entry = rootEntry(req.mainFile, userPaths);

    let passes = 0;
    let result: CompileResult;
    const logs: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const files: FileInput[] = [...req.files];
      for (const [path, content] of this.auxCache) {
        if (!userPaths.has(path)) files.push({ path, content });
      }
      const mainFile = files.find((f) => f.path === req.mainFile);
      if (!mainFile) throw new Error(`メインファイル ${req.mainFile} が見つかりません`);
      const others = entry ? files : files.filter((f) => f !== mainFile);
      const head: FileInput = entry
        ? { path: entry.path, content: entry.content }
        : { path: req.mainFile, content: mainFile.content };

      const b = full ? bibOpts() : { bibtex: false, biber: false };
      result = await runner.compile(
        [head, ...others],
        head.path,
        b.bibtex,
        b.biber,
        full ? null : false,
        full ? true : false,
        'silent',
        'luahbtex_bibtex8',
        null,
        extrasEndpoint(),
        false,
        [],
      );
      passes += result.logs?.filter((l) => !/^(bibtex|biber|makeindex)/.test(l.cmd)).length ?? 1;
      logs.push(result.log);

      // WASM のメモリ不足。終了コードや PDF が不完全なまま返ることがあるので失敗として扱い、
      // 壊れた状態のエンジンは作り直す
      if (OOM_PATTERN.test(result.log ?? '')) {
        this.dropRunner();
        return {
          success: false,
          error:
            'エンジンのメモリが不足しました。和文フォントのサイズや書体の種類が非常に多い文書で起こることがあります。',
          log: logs.join('\n\n'),
          texLog: lastTexLog(result),
          passes,
          ms: performance.now() - t0,
        };
      }

      // 補助ファイルを回収（失敗時は不完全な .aux になり得るので更新しない）
      if (result.success) try {
        const produced = await runner.readProjectFiles();
        for (const f of produced) {
          if (AUX_EXT.test(f.path) && !userPaths.has(f.path)) {
            const c = f.content;
            this.auxCache.set(f.path, typeof c === 'string' ? new TextEncoder().encode(c) : c);
          }
        }
      } catch {
        /* 読めなくても致命的ではない */
      }

      if (full && result.success) this.fullBuilt = true;
      const texLog = lastTexLog(result);
      const needsRerun = RERUN_PATTERNS.some((p) => texLog.includes(p));
      if (!result.success || full || !needsRerun || attempt >= MAX_AUTO_RERUN) break;
    }

    return {
      success: result.success,
      pdf: result.pdf ?? undefined,
      synctex: result.synctex ?? undefined,
      log: logs.join('\n\n'),
      texLog: lastTexLog(result),
      passes,
      ms: performance.now() - t0,
    };
  }
}

/** メインファイルがサブフォルダにあるとき、プロジェクト直下に置く起動用ファイルを作る */
function rootEntry(mainFile: string, userPaths: Set<string>): { path: string; content: string } | null {
  const slash = mainFile.lastIndexOf('/');
  if (slash < 0) return null;
  const dir = mainFile.slice(0, slash + 1);
  const base = mainFile.slice(slash + 1);
  // 出力ファイル名（\jobname）をメインファイルと同じにする。直下に同名ファイルがあれば別名にする
  let path = base;
  for (let i = 1; userPaths.has(path); i++) path = `luanote-entry${i}-${base}`;
  const content =
    `\\expandafter\\gdef\\csname input@path\\endcsname{{${dir}}}%\n` +
    `\\input{${mainFile}}\n`;
  return { path, content };
}

function lastTexLog(r: CompileResult): string {
  const tex = (r.logs ?? []).filter((l) => !/^(bibtex|biber|makeindex|xdvipdfmx)/.test(l.cmd) && l.log);
  return tex.length ? tex[tex.length - 1].log : r.log ?? '';
}
