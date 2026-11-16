// BusyTeX (TeX Live WASM) を使った LuaLaTeX コンパイラのラッパー
import { BusyTexRunner } from 'texlyre-busytex';
import type { CompileResult, FileInput } from 'texlyre-busytex';
import { assetBase, findDistribution } from './distributions';
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

  /** 補助ファイルのキャッシュを破棄（プロジェクト切替時など） */
  resetAux(key = ''): void {
    this.auxCache.clear();
    this.auxCacheKey = key;
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
    const full = req.full || (hasBib && req.bib !== 'none' && !hasBbl);

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
      const others = files.filter((f) => f !== mainFile);

      const b = full ? bibOpts() : { bibtex: false, biber: false };
      result = await runner.compile(
        [{ path: req.mainFile, content: mainFile.content }, ...others],
        req.mainFile,
        b.bibtex,
        b.biber,
        full ? null : false,
        full ? true : false,
        'silent',
        'luahbtex_bibtex8',
        null,
        undefined,
        false,
        [],
      );
      passes += result.logs?.filter((l) => !/^(bibtex|biber|makeindex)/.test(l.cmd)).length ?? 1;
      logs.push(result.log);

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

function lastTexLog(r: CompileResult): string {
  const tex = (r.logs ?? []).filter((l) => !/^(bibtex|biber|makeindex|xdvipdfmx)/.test(l.cmd) && l.log);
  return tex.length ? tex[tex.length - 1].log : r.log ?? '';
}
