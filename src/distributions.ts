// 選択可能な TeX ディストリビューション（WASM ビルド）の一覧。
// 新しいバージョンを追加するには、ここにエントリを足し、
// .github/workflows/deploy.yml でアセットを public/core/<id>/ に展開する。

export interface PackageSet {
  id: string;
  label: string;
  description: string;
  sizeMB: number;
}

export interface Distribution {
  id: string;
  label: string;
  year: number;
  /** BASE_URL からの相対パス */
  assetDir: string;
  packageSets: PackageSet[];
  defaultPackageSet: string;
}

export const DISTRIBUTIONS: Distribution[] = [
  {
    id: 'texlive-2026',
    label: 'TeX Live 2026',
    year: 2026,
    assetDir: 'core/texlive-2026',
    defaultPackageSet: 'recommended',
    // basic は日本語組版（luatexja が xkeyval を要求）に使えないため提供しない。
    // extra は丸ごと読み込むと 342 MB のダウンロードとメモリを使うため、latex-extra の
    // ファイルは core/texmf-extra から必要な分だけ取得する（scripts/build-lazy-extra.mjs）。
    // 以前 extra を選んでいたプロジェクトは recommended として扱われる。
    packageSets: [
      {
        id: 'recommended',
        label: 'recommended + extra',
        description:
          'latex-recommended + fonts-recommended を読み込み、latex-extra のパッケージは使うときに取得',
        sizeMB: 201,
      },
    ],
  },
];

export const DEFAULT_DISTRIBUTION = 'texlive-2026';

export function findDistribution(id: string): Distribution {
  return DISTRIBUTIONS.find((d) => d.id === id) ?? DISTRIBUTIONS.find((d) => d.id === DEFAULT_DISTRIBUTION)!;
}

export function assetBase(d: Distribution): string {
  return new URL(import.meta.env.BASE_URL + d.assetDir, location.href).href.replace(/\/$/, '');
}

/**
 * TeX Live に含まれないファイル（luatexja・原ノ味フォント・jlreq）の配信先。
 * エンジンは見つからないファイルを <endpoint>/<kpse format>/<name> から遅延取得する。
 * scripts/fetch-extras.mjs が生成する。
 */
export function extrasEndpoint(): string {
  return new URL(import.meta.env.BASE_URL + 'core/texmf-extra', location.href).href;
}
