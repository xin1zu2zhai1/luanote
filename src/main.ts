import './style.css';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  type FileEntry,
  type Project,
  type ProjectSettings,
  type BibMode,
  listProjects,
  getProject,
  putProject,
  deleteProject,
  listFiles,
  putFile,
  putFiles,
  deleteFiles,
  getMeta,
  setMeta,
  uid,
} from './store';
import { DISTRIBUTIONS, DEFAULT_DISTRIBUTION, findDistribution } from './distributions';
import { LuaLatexCompiler, type CompileOutput, type EngineStatus } from './compiler';
import { clearAllPackageCache } from 'texlyre-busytex';
import { SourceEditor } from './editor';
import { FileTree } from './filetree';
import { PdfView } from './pdfview';
import { parseLog, type LogIssue } from './logparse';
import { SyncTex } from './synctex';
import { TEMPLATES } from './templates';
import { $, askText, askConfirm, showDialog, toast, escapeHtml } from './ui';

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

const TEXT_EXT =
  /\.(tex|ltx|sty|cls|bib|bst|bbx|cbx|lbx|dbx|def|cfg|clo|fd|dtx|ins|ist|lua|txt|md|csv|tsv|dat|json|xml|svg|yaml|yml|toml|gp|mp|asy|tikz|pgf|log|gitignore)$/i;

let project: Project | null = null;
const files = new Map<string, FileEntry>();
let lastPdf: Uint8Array | null = null;
let synctex: SyncTex | null = null;
let lastIssues: LogIssue[] = [];
let dirty = false;
let compiling = false;
let pendingCompile: { full: boolean; target?: string } | null = null;
/** 表示中の PDF の元になった .tex（ダウンロード名に使う） */
let lastPdfSource: string | null = null;
let autoTimer: number | undefined;
const saveTimers = new Map<string, number>();

const compiler = new LuaLatexCompiler();

const editor = new SourceEditor($('#editor-host'), {
  onChange: (path, text) => {
    const e = files.get(path);
    if (!e) return;
    e.content = text;
    e.updated = Date.now();
    scheduleSave(path);
    dirty = true;
    scheduleAutoCompile();
  },
  onCompile: (full) => void compile(full),
  onCompileEditing: () => compileEditingFile(),
  onForwardSync: () => forwardSync(),
});

const tree = new FileTree($('#tree'), {
  onOpen: (p) => openFile(p),
  onNewFile: (dir) => void newFile(dir),
  onNewFolder: (dir) => void newFolder(dir),
  onRename: (p) => void renamePath(p),
  onDelete: (p) => void deletePath(p),
  onSetMain: (p) => void setMain(p),
  onDownload: (p) => downloadFile(p),
  onMove: (from, toDir) => void movePath(from, toDir),
  onUpload: (list, dir) => void uploadFiles(list, dir),
});

const pdfView = new PdfView($('#pdf-host'));
pdfView.onZoomChange = (label) => ($('#zoom-label').textContent = label);
pdfView.onReverseSync = (page, x, y) => {
  if (!synctex) return toast('SyncTeX 情報がありません。再コンパイルしてください。');
  const hit = synctex.reverse(page, x, y);
  if (!hit) return;
  if (!files.has(hit.file)) return toast(`${hit.file} はプロジェクト外のファイルです`);
  openFile(hit.file);
  editor.gotoLine(hit.line);
  showPaneMobile('editor');
};

// ---------------------------------------------------------------------------
// プロジェクト
// ---------------------------------------------------------------------------

function defaultSettings(mainFile = 'main.tex'): ProjectSettings {
  const d = findDistribution(DEFAULT_DISTRIBUTION);
  return {
    distribution: d.id,
    packageSet: d.defaultPackageSet,
    mainFile,
    bib: 'auto',
    autoCompile: false,
  };
}

async function createProject(name: string, templateId: string): Promise<Project> {
  const tpl = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const now = Date.now();
  const p: Project = { id: uid(), name, created: now, updated: now, settings: defaultSettings(tpl.mainFile) };
  await putProject(p);
  const entries: FileEntry[] = Object.entries(tpl.files).map(([path, content]) => ({
    projectId: p.id,
    path,
    kind: 'file',
    content,
    updated: now,
  }));
  await putFiles(entries);
  return p;
}

async function loadProject(id: string): Promise<void> {
  await flushSaves();
  const p = await getProject(id);
  if (!p) return;
  project = p;
  // 旧バージョンの設定を補完
  project.settings = { ...defaultSettings(), ...p.settings };
  files.clear();
  for (const e of await listFiles(id)) files.set(e.path, e);
  editor.reset();
  compiler.resetAux(id);
  synctex = null;
  lastIssues = [];
  renderIssues();
  $('#log-raw').textContent = '';
  await setMeta('lastProject', id);
  $('#project-name').textContent = p.name;
  document.title = `${p.name} — LuaNote`;
  syncSettingsUi();
  refreshTree();
  const main = project.settings.mainFile;
  if (files.has(main)) openFile(main);
  else {
    const first = [...files.values()].find((f) => f.kind === 'file' && f.path.endsWith('.tex'));
    if (first) openFile(first.path);
  }
  // 前回の PDF を表示
  pdfView.clear();
  lastPdf = null;
  lastPdfSource = null;
  const cached = await getMeta<Uint8Array>(`pdf:${id}`);
  if (cached) {
    lastPdf = cached;
    lastPdfSource = (await getMeta<string>(`pdfsource:${id}`)) ?? null;
    await pdfView.load(cached);
    ($('#download-pdf') as HTMLButtonElement).disabled = false;
  } else {
    ($('#download-pdf') as HTMLButtonElement).disabled = true;
    showOverlay('まだコンパイルされていません。<br><b>▶ コンパイル</b>（Ctrl+S）で PDF を生成します。');
  }
  dirty = !cached;
}

async function touchProject(): Promise<void> {
  if (!project) return;
  project.updated = Date.now();
  await putProject(project);
}

function refreshTree(): void {
  tree.setItems(
    [...files.values()].map((f) => ({ path: f.path, kind: f.kind })),
    project?.settings.mainFile ?? '',
  );
  const n = [...files.values()].filter((f) => f.kind === 'file').length;
  const bytes = [...files.values()].reduce(
    (a, f) => a + (typeof f.content === 'string' ? f.content.length : f.content?.byteLength ?? 0),
    0,
  );
  $('#tree-footer').textContent = `${n} ファイル · ${formatBytes(bytes)}`;
}

// ---------------------------------------------------------------------------
// ファイル操作
// ---------------------------------------------------------------------------

function scheduleSave(path: string): void {
  clearTimeout(saveTimers.get(path));
  saveTimers.set(
    path,
    window.setTimeout(() => {
      saveTimers.delete(path);
      const e = files.get(path);
      if (e) void putFile(e).then(touchProject);
    }, 400),
  );
}

async function flushSaves(): Promise<void> {
  const paths = [...saveTimers.keys()];
  for (const p of paths) clearTimeout(saveTimers.get(p));
  saveTimers.clear();
  const entries = paths.map((p) => files.get(p)).filter((e): e is FileEntry => !!e);
  if (entries.length) await putFiles(entries);
}

function normalizePath(p: string): string | null {
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  return parts.join('/') || null;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function isText(path: string): boolean {
  return TEXT_EXT.test(path) || !/\.[^/]+$/.test(path);
}

function openFile(path: string): void {
  const e = files.get(path);
  if (!e || e.kind !== 'file') return;
  tree.select(path);
  $('#editor-path').textContent = path;
  const bin = $('#binary-view');
  if (typeof e.content === 'string') {
    bin.hidden = true;
    $('#editor-host').hidden = false;
    editor.open(path, e.content);
    applyDiagnostics();
  } else {
    editor.close();
    $('#editor-host').hidden = true;
    bin.hidden = false;
    renderBinary(path, e.content ?? new Uint8Array());
  }
}

let binaryUrl: string | null = null;
function renderBinary(path: string, data: Uint8Array): void {
  const bin = $('#binary-view');
  if (binaryUrl) URL.revokeObjectURL(binaryUrl);
  binaryUrl = null;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  let preview = '';
  if (mime[ext]) {
    binaryUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: mime[ext] }));
    preview = `<img src="${binaryUrl}" alt="${escapeHtml(path)}">`;
  }
  bin.innerHTML = `
    <div class="binary-info">
      ${preview}
      <p><b>${escapeHtml(path)}</b><br>${formatBytes(data.byteLength)} のバイナリファイル</p>
      <p class="muted">LaTeX からはパスで参照できます（例: <code>\\includegraphics{${escapeHtml(path)}}</code>）</p>
      <button class="ghost" id="bin-dl">ダウンロード</button>
    </div>`;
  $('#bin-dl').addEventListener('click', () => downloadFile(path));
}

async function newFile(dir: string): Promise<void> {
  if (!project) return;
  const name = await askText('新規ファイル', 'ファイル名（例: chapter1.tex, sub/fig.tex）', dir ? `${dir}/` : '', 'untitled.tex');
  if (!name) return;
  const path = normalizePath(name);
  if (!path) return toast('無効なパスです');
  if (files.has(path)) return toast('同名のファイルが既に存在します');
  const e: FileEntry = { projectId: project.id, path, kind: 'file', content: '', updated: Date.now() };
  files.set(path, e);
  await putFile(e);
  refreshTree();
  openFile(path);
  if (isText(path)) setTimeout(() => editor.view.focus());
}

async function newFolder(dir: string): Promise<void> {
  if (!project) return;
  const name = await askText('新規フォルダ', 'フォルダ名', dir ? `${dir}/` : '', 'figures');
  if (!name) return;
  const path = normalizePath(name);
  if (!path) return toast('無効なパスです');
  if (files.has(path) || [...files.keys()].some((k) => k.startsWith(path + '/'))) return toast('既に存在します');
  const e: FileEntry = { projectId: project.id, path, kind: 'dir', updated: Date.now() };
  files.set(path, e);
  await putFile(e);
  refreshTree();
}

function affectedPaths(path: string): string[] {
  return [...files.keys()].filter((k) => k === path || k.startsWith(path + '/'));
}

async function relocate(from: string, to: string): Promise<void> {
  if (!project) return;
  if (from === to) return;
  if (files.has(to) || [...files.keys()].some((k) => k.startsWith(to + '/'))) {
    toast(`${to} は既に存在します`);
    return;
  }
  await flushSaves();
  const moved: FileEntry[] = [];
  const old = affectedPaths(from);
  for (const k of old) {
    const e = files.get(k)!;
    const np = to + k.slice(from.length);
    files.delete(k);
    const ne = { ...e, path: np, updated: Date.now() };
    files.set(np, ne);
    moved.push(ne);
    editor.rename(k, np);
  }
  await deleteFiles(project.id, old);
  await putFiles(moved);
  const main = project.settings.mainFile;
  if (main === from || main.startsWith(from + '/')) {
    project.settings.mainFile = to + main.slice(from.length);
  }
  await touchProject();
  refreshTree();
  if (editor.path) {
    tree.select(editor.path);
    $('#editor-path').textContent = editor.path;
  }
}

async function renamePath(path: string): Promise<void> {
  const name = await askText('名前の変更 / 移動', '新しいパス', '', path);
  if (!name) return;
  const to = normalizePath(name);
  if (!to) return toast('無効なパスです');
  await relocate(path, to);
}

async function movePath(from: string, toDir: string): Promise<void> {
  const base = from.split('/').pop()!;
  await relocate(from, joinPath(toDir, base));
}

async function deletePath(path: string): Promise<void> {
  if (!project) return;
  const targets = affectedPaths(path);
  const ok = await askConfirm(
    '削除の確認',
    targets.length > 1 ? `${path} とその中の ${targets.length - 1} 項目を削除しますか？` : `${path} を削除しますか？`,
    '削除',
  );
  if (!ok) return;
  for (const k of targets) {
    files.delete(k);
    editor.forget(k);
    clearTimeout(saveTimers.get(k));
    saveTimers.delete(k);
  }
  await deleteFiles(project.id, targets);
  await touchProject();
  refreshTree();
  if (!editor.path) {
    $('#editor-path').textContent = '—';
    $('#binary-view').hidden = true;
    $('#editor-host').hidden = false;
  }
}

async function setMain(path: string): Promise<void> {
  if (!project) return;
  project.settings.mainFile = path;
  await touchProject();
  refreshTree();
  syncSettingsUi();
  toast(`メインファイル: ${path}`);
}

function downloadBlob(data: BlobPart, name: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadFile(path: string): void {
  const e = files.get(path);
  if (!e || e.kind !== 'file') return;
  downloadBlob(e.content as BlobPart, path.split('/').pop()!);
}

async function uploadFiles(list: File[], dir: string): Promise<void> {
  if (!project) return;
  const entries: FileEntry[] = [];
  for (const f of list) {
    // webkitRelativePath があればフォルダ構造を保つ
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const path = normalizePath(joinPath(dir, rel));
    if (!path) continue;
    if (f.name.toLowerCase().endsWith('.zip') && list.length === 1) {
      const ok = await askConfirm('ZIP の展開', `${f.name} を展開してプロジェクトに追加しますか？`, '展開する', 'そのまま追加');
      if (ok) {
        await addZipToProject(new Uint8Array(await f.arrayBuffer()), dir);
        return;
      }
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    const content: string | Uint8Array = isText(path) ? new TextDecoder().decode(buf) : buf;
    entries.push({ projectId: project.id, path, kind: 'file', content, updated: Date.now() });
  }
  for (const e of entries) files.set(e.path, e);
  await putFiles(entries);
  await touchProject();
  refreshTree();
  toast(`${entries.length} ファイルを追加しました`);
}

/**
 * @param stripTop true なら zip 全体を包む 1 階層のフォルダを外す（新規プロジェクトとしてのインポート用）。
 *   既存プロジェクトへの追加では false にしてフォルダ構成を保つ（まとめて削除・移動できるように）。
 */
async function addZipToProject(data: Uint8Array, dir: string, stripTop = false): Promise<number> {
  if (!project) return 0;
  const unz = unzipSync(data);
  const names = Object.keys(unz).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'));
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = stripTop && tops.size === 1 && names.every((n) => n.includes('/')) ? [...tops][0] + '/' : '';
  const entries: FileEntry[] = [];
  for (const n of names) {
    const path = normalizePath(joinPath(dir, n.slice(strip.length)));
    if (!path) continue;
    const content = isText(path) ? strFromU8(unz[n]) : unz[n];
    entries.push({ projectId: project.id, path, kind: 'file', content, updated: Date.now() });
  }
  for (const e of entries) files.set(e.path, e);
  await putFiles(entries);
  await touchProject();
  refreshTree();
  return entries.length;
}

function exportZip(): void {
  if (!project) return;
  const out: Record<string, Uint8Array> = {};
  for (const e of files.values()) {
    if (e.kind === 'dir') {
      out[e.path + '/'] = new Uint8Array();
      continue;
    }
    out[e.path] = typeof e.content === 'string' ? strToU8(e.content) : (e.content ?? new Uint8Array());
  }
  downloadBlob(zipSync(out) as BlobPart, `${safeName(project.name)}.zip`, 'application/zip');
}

// ---------------------------------------------------------------------------
// コンパイル
// ---------------------------------------------------------------------------

function scheduleAutoCompile(): void {
  if (!project?.settings.autoCompile) return;
  clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => void compile(false), 1200);
}

/**
 * 編集中のファイルが単独でコンパイルできる文書（\documentclass を含む .tex）ならそのパスを返す。
 * 章ファイルや .sty などは null。
 */
function standaloneEditingFile(): string | null {
  const path = editor.path;
  if (!path || !path.toLowerCase().endsWith('.tex')) return null;
  const e = files.get(path);
  if (!e || typeof e.content !== 'string') return null;
  // コメント行を除いて \documentclass を探す
  return /^[^%\n]*\\documentclass\b/m.test(e.content) ? path : null;
}

/** 編集中のファイルをコンパイルする（メインファイルの設定は変えない） */
function compileEditingFile(full = false): void {
  const target = standaloneEditingFile();
  if (!target) {
    toast('編集中のファイルは単独でコンパイルできません（\\documentclass を含む .tex を開いてください）');
    return;
  }
  void compile(full, target);
}

/**
 * @param target コンパイルするファイル。省略時はメインファイル。
 */
async function compile(full: boolean, target?: string): Promise<void> {
  if (!project) return;
  clearTimeout(autoTimer);
  if (compiling) {
    pendingCompile = { full: full || !!pendingCompile?.full, target: target ?? pendingCompile?.target };
    return;
  }
  const s = project.settings;
  const entry = target ?? s.mainFile;
  if (!files.has(entry) || !entry.endsWith('.tex')) {
    toast(target ? `${entry} が見つかりません` : `メインファイル（.tex）が見つかりません: ${entry}`);
    return;
  }
  compiling = true;
  dirty = false;
  setCompileUi(true);
  const projectId = project.id;
  const input = [...files.values()]
    .filter((f) => f.kind === 'file' && f.content !== undefined)
    .map((f) => ({ path: f.path, content: f.content as string | Uint8Array }));
  let out: CompileOutput | null = null;
  try {
    out = await compiler.compile(
      {
        files: input,
        mainFile: entry,
        distribution: s.distribution,
        packageSet: s.packageSet,
        bib: s.bib,
        full,
      },
      projectId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    $('#compile-status').textContent = 'コンパイル失敗';
    $('#log-raw').textContent = msg;
    lastIssues = [{ level: 'error', message: msg }];
    renderIssues();
    openLog();
  } finally {
    compiling = false;
    setCompileUi(false);
  }
  if (out && project?.id === projectId) await handleResult(out, entry);
  if (pendingCompile) {
    const p = pendingCompile;
    pendingCompile = null;
    void compile(p.full, p.target);
  }
}

async function handleResult(out: CompileOutput, entry: string): Promise<void> {
  if (!project) return;
  $('#log-raw').textContent = out.log;
  lastIssues = parseLog(out.texLog, entry);
  if (out.error) {
    lastIssues.unshift({ level: 'error', message: out.error });
  } else if (!out.success && !lastIssues.some((i) => i.level === 'error')) {
    const tail = out.texLog.trim().split('\n').slice(-6).join('\n');
    lastIssues.unshift({ level: 'error', message: 'コンパイルに失敗しました。生ログを確認してください。', context: tail });
  }
  renderIssues();
  applyDiagnostics();
  const sec = (out.ms / 1000).toFixed(1);
  const name = entry.split('/').pop()!;
  if (out.success && out.pdf) {
    // 壊れた PDF で表示処理が止まってもステータスが「コンパイル中」のまま残らないようにする
    try {
      await withTimeout(pdfView.load(out.pdf), 30000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastIssues.unshift({ level: 'error', message: `PDF を表示できませんでした: ${msg}` });
      renderIssues();
      $('#compile-status').textContent = `✗ ${name} · PDF を表示できません (${sec} 秒)`;
      openLog();
      return;
    }
    hideOverlay();
    lastPdf = out.pdf;
    lastPdfSource = entry;
    synctex = out.synctex ? SyncTex.fromGzip(out.synctex) : null;
    ($('#download-pdf') as HTMLButtonElement).disabled = false;
    void setMeta(`pdf:${project.id}`, out.pdf);
    void setMeta(`pdfsource:${project.id}`, entry);
    $('#compile-status').textContent = `✓ ${name} · ${sec} 秒 · ${out.passes} パス · ${pdfView.numPages} ページ`;
  } else {
    $('#compile-status').textContent = `✗ ${name} · エラー (${sec} 秒)`;
    if (!lastPdf) showOverlay('コンパイルに失敗しました。<br>下のログでエラーを確認してください。');
    openLog();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('タイムアウトしました')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function setCompileUi(busy: boolean): void {
  const btn = $('#compile-btn') as HTMLButtonElement;
  btn.classList.toggle('busy', busy);
  $('#compile-label').textContent = busy ? 'コンパイル中…' : 'コンパイル';
  if (busy) $('#compile-status').textContent = 'コンパイル中…';
}

function forwardSync(): void {
  if (!synctex || !editor.path) return toast('SyncTeX 情報がありません。先にコンパイルしてください。');
  const r = synctex.forward(editor.path, editor.cursorLine());
  if (!r) return toast('この行に対応する PDF 上の位置が見つかりません');
  showPaneMobile('preview');
  pdfView.highlight(r.page, r.x, r.y, r.w, r.h);
}

// ---------------------------------------------------------------------------
// ログ表示
// ---------------------------------------------------------------------------

function renderIssues(): void {
  const host = $('#log-issues');
  host.innerHTML = '';
  const errors = lastIssues.filter((i) => i.level === 'error').length;
  const warnings = lastIssues.filter((i) => i.level === 'warning').length;
  const badge = $('#issue-badge');
  badge.hidden = errors + warnings === 0;
  badge.textContent = errors ? String(errors) : String(warnings);
  badge.classList.toggle('error', errors > 0);
  if (!lastIssues.length) {
    host.innerHTML = '<p class="muted pad">エラーや警告はありません。</p>';
    return;
  }
  const order = { error: 0, warning: 1, badbox: 2 };
  for (const it of [...lastIssues].sort((a, b) => order[a.level] - order[b.level])) {
    const row = document.createElement('button');
    row.className = `issue ${it.level}`;
    const loc = it.file ? `${it.file}${it.line ? ':' + it.line : ''}` : '';
    row.innerHTML = `<span class="lvl">${it.level === 'error' ? 'エラー' : it.level === 'warning' ? '警告' : 'ボックス'}</span>
      <span class="msg">${escapeHtml(it.message)}${it.context ? `<code>${escapeHtml(it.context)}</code>` : ''}</span>
      <span class="loc">${escapeHtml(loc)}</span>`;
    row.addEventListener('click', () => {
      if (it.file && files.has(it.file)) {
        openFile(it.file);
        if (it.line) editor.gotoLine(it.line);
        showPaneMobile('editor');
      }
    });
    host.appendChild(row);
  }
}

function applyDiagnostics(): void {
  const path = editor.path;
  if (!path) return;
  editor.setDiagnostics(
    lastIssues
      .filter((i) => i.file === path && i.line)
      .map((i) => ({
        line: i.line!,
        severity: i.level === 'error' ? 'error' : i.level === 'warning' ? 'warning' : 'info',
        message: i.message,
      })),
  );
}

function openLog(): void {
  $('#log-panel').hidden = false;
  $('#log-btn').classList.add('active');
}

function toggleLog(): void {
  const p = $('#log-panel');
  p.hidden = !p.hidden;
  $('#log-btn').classList.toggle('active', !p.hidden);
}

function showOverlay(html: string): void {
  const o = $('#preview-overlay');
  o.innerHTML = `<div class="overlay-card">${html}</div>`;
  o.hidden = false;
}

function hideOverlay(): void {
  $('#preview-overlay').hidden = true;
}

// ---------------------------------------------------------------------------
// 設定 UI
// ---------------------------------------------------------------------------

function syncSettingsUi(): void {
  if (!project) return;
  const s = project.settings;
  const dsel = $('#dist-select') as HTMLSelectElement;
  dsel.innerHTML = DISTRIBUTIONS.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
  dsel.value = s.distribution;
  const d = findDistribution(s.distribution);
  const psel = $('#pkg-select') as HTMLSelectElement;
  psel.innerHTML = d.packageSets
    .map((p) => `<option value="${p.id}" title="${escapeHtml(p.description)}">${p.label} (${p.sizeMB}MB)</option>`)
    .join('');
  if (!d.packageSets.some((p) => p.id === s.packageSet)) s.packageSet = d.defaultPackageSet;
  psel.value = s.packageSet;
  ($('#auto-compile') as HTMLInputElement).checked = s.autoCompile;
}

async function updateSettings(patch: Partial<ProjectSettings>): Promise<void> {
  if (!project) return;
  const prev = project.settings;
  project.settings = { ...prev, ...patch };
  await touchProject();
  syncSettingsUi();
  if (patch.distribution !== undefined || patch.packageSet !== undefined) {
    if (prev.distribution !== project.settings.distribution || prev.packageSet !== project.settings.packageSet) {
      void warmup();
    }
  }
}

function onEngineStatus(s: EngineStatus): void {
  const el = $('#engine-status');
  el.classList.remove('error');
  switch (s.state) {
    case 'loading':
      el.textContent = `⏳ ${s.label} 読み込み中 ${s.percent}%`;
      if (!lastPdf || !$('#preview-overlay').hidden)
        showOverlay(
          `<div class="spinner"></div><b>${escapeHtml(s.label)}</b> を読み込み中… ${s.percent}%<br>
           <span class="muted">初回のみ TeX Live の WASM とパッケージをダウンロードし、ブラウザにキャッシュします。</span>`,
        );
      break;
    case 'ready':
      el.textContent = `● ${s.label}`;
      if (!lastPdf)
        showOverlay('エンジンの準備ができました。<br><b>▶ コンパイル</b>（Ctrl+S）で PDF を生成します。');
      break;
    case 'error':
      el.textContent = '⚠ エンジンの読み込みに失敗';
      el.classList.add('error');
      showOverlay(`エンジンの読み込みに失敗しました。<br><code>${escapeHtml(s.message)}</code>`);
      break;
    default:
      el.textContent = 'エンジン未起動';
  }
}
compiler.onStatus = onEngineStatus;

async function warmup(): Promise<void> {
  if (!project) return;
  try {
    await compiler.ensure(project.settings.distribution, project.settings.packageSet);
  } catch {
    /* onStatus で表示済み */
  }
}

// ---------------------------------------------------------------------------
// ダイアログ
// ---------------------------------------------------------------------------

async function openProjectDialog(): Promise<void> {
  const projects = await listProjects();
  const rows = projects
    .map(
      (p) => `<li class="${p.id === project?.id ? 'current' : ''}">
        <button class="proj-open" data-id="${p.id}"><b>${escapeHtml(p.name)}</b>
          <span class="muted">${new Date(p.updated).toLocaleString()}</span></button>
        <button class="ghost icon-btn proj-rename" data-id="${p.id}" title="名前の変更">✎</button>
        <button class="ghost icon-btn proj-dup" data-id="${p.id}" title="複製">⧉</button>
        <button class="ghost icon-btn danger proj-del" data-id="${p.id}" title="削除">🗑</button>
      </li>`,
    )
    .join('');
  const tplOptions = TEMPLATES.map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('');
  const dlg = showDialog(`
    <h2>プロジェクト</h2>
    <ul class="project-list">${rows}</ul>
    <div class="dialog-section">
      <h3>新規作成</h3>
      <div class="row">
        <input id="np-name" placeholder="プロジェクト名" value="新しいプロジェクト">
        <select id="np-tpl">${tplOptions}</select>
        <button class="primary" id="np-create">作成</button>
      </div>
    </div>
    <div class="dialog-section row">
      <button class="ghost" id="np-import">ZIP からインポート…</button>
      <button class="ghost" id="np-export">現在のプロジェクトを ZIP で書き出す</button>
      <input type="file" id="np-import-input" accept=".zip" hidden>
    </div>
    <div class="dialog-actions"><button class="ghost" data-close>閉じる</button></div>
  `);
  dlg.querySelectorAll<HTMLButtonElement>('.proj-open').forEach((b) =>
    b.addEventListener('click', async () => {
      dlg.close();
      await loadProject(b.dataset.id!);
    }),
  );
  dlg.querySelectorAll<HTMLButtonElement>('.proj-rename').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = await getProject(b.dataset.id!);
      if (!p) return;
      dlg.close();
      const name = await askText('プロジェクト名の変更', '新しい名前', '', p.name);
      if (name) {
        p.name = name;
        await putProject(p);
        if (project?.id === p.id) {
          project.name = name;
          $('#project-name').textContent = name;
        }
      }
      void openProjectDialog();
    }),
  );
  dlg.querySelectorAll<HTMLButtonElement>('.proj-dup').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = await getProject(b.dataset.id!);
      if (!p) return;
      await flushSaves();
      const np: Project = { ...p, id: uid(), name: `${p.name} のコピー`, created: Date.now(), updated: Date.now() };
      await putProject(np);
      const fs = await listFiles(p.id);
      await putFiles(fs.map((f) => ({ ...f, projectId: np.id })));
      dlg.close();
      void openProjectDialog();
    }),
  );
  dlg.querySelectorAll<HTMLButtonElement>('.proj-del').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = await getProject(b.dataset.id!);
      if (!p) return;
      dlg.close();
      const ok = await askConfirm('プロジェクトの削除', `「${p.name}」を完全に削除しますか？元に戻せません。`, '削除');
      if (ok) {
        await deleteProject(p.id);
        await setMeta(`pdf:${p.id}`, undefined);
        if (project?.id === p.id) {
          const rest = await listProjects();
          if (rest.length) await loadProject(rest[0].id);
          else await loadProject((await createProject('はじめてのプロジェクト', 'sample')).id);
        }
      }
      void openProjectDialog();
    }),
  );
  $('#np-create', dlg).addEventListener('click', async () => {
    const name = ($('#np-name', dlg) as HTMLInputElement).value.trim() || '新しいプロジェクト';
    const tpl = ($('#np-tpl', dlg) as HTMLSelectElement).value;
    const p = await createProject(name, tpl);
    dlg.close();
    await loadProject(p.id);
  });
  const importInput = $('#np-import-input', dlg) as HTMLInputElement;
  $('#np-import', dlg).addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    const now = Date.now();
    const p: Project = {
      id: uid(),
      name: f.name.replace(/\.zip$/i, ''),
      created: now,
      updated: now,
      settings: defaultSettings(),
    };
    await putProject(p);
    dlg.close();
    await loadProject(p.id);
    const n = await addZipToProject(new Uint8Array(await f.arrayBuffer()), '', true);
    // メインファイルを推定
    const texs = [...files.values()].filter((e) => e.kind === 'file' && e.path.endsWith('.tex'));
    const main =
      texs.find((e) => e.path === 'main.tex') ??
      texs.find((e) => typeof e.content === 'string' && /\\documentclass/.test(e.content)) ??
      texs[0];
    if (main) await setMain(main.path);
    if (main) openFile(main.path);
    toast(`${n} ファイルをインポートしました`);
  });
  $('#np-export', dlg).addEventListener('click', () => exportZip());
}

function openSettingsDialog(): void {
  if (!project) return;
  const s = project.settings;
  const texFiles = [...files.values()].filter((f) => f.kind === 'file' && f.path.endsWith('.tex'));
  const d = findDistribution(s.distribution);
  const theme = localStorage.getItem('luanote.theme') ?? 'system';
  const fontSize = localStorage.getItem('luanote.fontSize') ?? '14';
  const dlg = showDialog(`
    <h2>設定</h2>
    <h3>プロジェクト「${escapeHtml(project.name)}」</h3>
    <label class="field"><span>メインファイル</span>
      <select id="st-main">${texFiles
        .map((f) => `<option ${f.path === s.mainFile ? 'selected' : ''}>${escapeHtml(f.path)}</option>`)
        .join('')}</select></label>
    <label class="field"><span>TeX ディストリビューション</span>
      <select id="st-dist">${DISTRIBUTIONS.map(
        (x) => `<option value="${x.id}" ${x.id === s.distribution ? 'selected' : ''}>${x.label}</option>`,
      ).join('')}</select></label>
    <label class="field"><span>パッケージセット</span>
      <select id="st-pkg">${d.packageSets
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === s.packageSet ? 'selected' : ''}>${p.label} — ${escapeHtml(
              p.description,
            )} (${p.sizeMB}MB)</option>`,
        )
        .join('')}</select></label>
    <label class="field"><span>参考文献の処理（完全ビルド時）</span>
      <select id="st-bib">
        ${(
          [
            ['auto', '自動判定'],
            ['bibtex', 'BibTeX (bibtex8)'],
            ['biber', 'Biber (biblatex)'],
            ['none', '使わない'],
          ] as [BibMode, string][]
        )
          .map(([v, l]) => `<option value="${v}" ${v === s.bib ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select></label>
    <label class="field check"><input type="checkbox" id="st-auto" ${s.autoCompile ? 'checked' : ''}> 入力停止後に自動コンパイル</label>
    <h3>エディタ</h3>
    <label class="field"><span>テーマ</span>
      <select id="st-theme">
        <option value="system" ${theme === 'system' ? 'selected' : ''}>システムに合わせる</option>
        <option value="light" ${theme === 'light' ? 'selected' : ''}>ライト</option>
        <option value="dark" ${theme === 'dark' ? 'selected' : ''}>ダーク</option>
      </select></label>
    <label class="field"><span>フォントサイズ</span>
      <input type="number" id="st-font" min="10" max="24" value="${fontSize}"></label>
    <p class="muted small">エンジン: LuaHBTeX（LuaLaTeX） / ${escapeHtml(d.label)} — BusyTeX WebAssembly ビルド</p>
    <div class="dialog-actions">
      <button class="ghost" id="st-clear-cache" title="ダウンロード済みの TeX Live データを削除">キャッシュを削除</button>
      <div class="spacer"></div>
      <button class="ghost" data-close>キャンセル</button>
      <button class="primary" id="st-save">保存</button>
    </div>
  `);
  const distSel = $('#st-dist', dlg) as HTMLSelectElement;
  distSel.addEventListener('change', () => {
    const nd = findDistribution(distSel.value);
    ($('#st-pkg', dlg) as HTMLSelectElement).innerHTML = nd.packageSets
      .map((p) => `<option value="${p.id}">${p.label} — ${escapeHtml(p.description)} (${p.sizeMB}MB)</option>`)
      .join('');
    ($('#st-pkg', dlg) as HTMLSelectElement).value = nd.defaultPackageSet;
  });
  $('#st-save', dlg).addEventListener('click', async () => {
    const main = ($('#st-main', dlg) as HTMLSelectElement).value;
    await updateSettings({
      mainFile: main || s.mainFile,
      distribution: distSel.value,
      packageSet: ($('#st-pkg', dlg) as HTMLSelectElement).value,
      bib: ($('#st-bib', dlg) as HTMLSelectElement).value as BibMode,
      autoCompile: ($('#st-auto', dlg) as HTMLInputElement).checked,
    });
    localStorage.setItem('luanote.theme', ($('#st-theme', dlg) as HTMLSelectElement).value);
    localStorage.setItem('luanote.fontSize', ($('#st-font', dlg) as HTMLInputElement).value);
    applyPrefs();
    refreshTree();
    dlg.close();
  });
  $('#st-clear-cache', dlg).addEventListener('click', async () => {
    const ok = await askConfirm(
      'キャッシュの削除',
      'ダウンロード済みの TeX Live データ（数百 MB）を削除します。次回コンパイル時に再ダウンロードされます。',
      '削除',
    );
    if (!ok) return;
    await clearAllPackageCache();
    toast('キャッシュを削除しました。ページを再読み込みしてください。');
  });
}

function openCompileMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  const add = (label: string, hint: string, fn: () => void, disabled = false) => {
    const b = document.createElement('button');
    b.innerHTML = `${label}<span class="hint">${hint}</span>`;
    b.disabled = disabled;
    b.addEventListener('click', () => {
      menu.remove();
      fn();
    });
    menu.appendChild(b);
  };
  const mainName = escapeHtml(project?.settings.mainFile ?? '');
  add('高速コンパイル', `${mainName} · 1 パス + 自動再実行`, () => void compile(false));
  add('完全ビルド', `${mainName} · BibTeX / Biber / 索引 / 複数パス`, () => void compile(true));
  add('補助ファイルを消去して完全ビルド', '.aux などのキャッシュを破棄', () => {
    compiler.resetAux(project?.id ?? '');
    void compile(true);
  });
  menu.appendChild(document.createElement('hr'));
  const editing = standaloneEditingFile();
  add(
    '編集中のファイルをコンパイル',
    editing
      ? `${escapeHtml(editing)} · Ctrl+Shift+Enter`
      : '\\documentclass を含む .tex を開いているときに使えます',
    () => compileEditingFile(),
    !editing,
  );
  document.body.appendChild(menu);
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(4, r.right - menu.offsetWidth)}px`;
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }));
}

// ---------------------------------------------------------------------------
// レイアウト（ペインのリサイズとモバイルタブ）
// ---------------------------------------------------------------------------

function setupGutters(): void {
  const ws = $('#workspace');
  const saved = JSON.parse(localStorage.getItem('luanote.layout') ?? '{}') as { tree?: number; editor?: number };
  const apply = (treeW: number, editorFrac: number) => {
    ws.style.setProperty('--tree-w', `${treeW}px`);
    ws.style.setProperty('--editor-frac', String(editorFrac));
  };
  let treeW = saved.tree ?? 240;
  let editorFrac = saved.editor ?? 0.5;
  apply(treeW, editorFrac);
  ws.querySelectorAll<HTMLElement>('.gutter').forEach((g) => {
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      const which = g.dataset.gutter;
      const move = (ev: PointerEvent) => {
        const rect = ws.getBoundingClientRect();
        if (which === 'tree') {
          treeW = Math.min(500, Math.max(140, ev.clientX - rect.left));
        } else {
          const start = rect.left + treeW + 6;
          const avail = rect.width - treeW - 12;
          editorFrac = Math.min(0.85, Math.max(0.15, (ev.clientX - start) / avail));
        }
        apply(treeW, editorFrac);
      };
      const up = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
        localStorage.setItem('luanote.layout', JSON.stringify({ tree: treeW, editor: editorFrac }));
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
    g.addEventListener('dblclick', () => {
      if (g.dataset.gutter === 'tree') treeW = 240;
      else editorFrac = 0.5;
      apply(treeW, editorFrac);
    });
  });
}

function showPaneMobile(pane: 'tree' | 'editor' | 'preview'): void {
  document.body.dataset.mobilePane = pane;
  document.querySelectorAll<HTMLButtonElement>('.mobile-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.pane === pane);
  });
}

function applyPrefs(): void {
  const theme = localStorage.getItem('luanote.theme') ?? 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const fs = parseInt(localStorage.getItem('luanote.fontSize') ?? '14', 10);
  document.documentElement.style.setProperty('--editor-font-size', `${Math.min(24, Math.max(10, fs))}px`);
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_') || 'project';
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  applyPrefs();
  setupGutters();
  showPaneMobile('editor');

  $('#project-btn').addEventListener('click', () => void openProjectDialog());
  $('#settings-btn').addEventListener('click', () => openSettingsDialog());
  $('#compile-btn').addEventListener('click', () => void compile(false));
  $('#compile-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openCompileMenu(e.currentTarget as HTMLElement);
  });
  $('#dist-select').addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    void updateSettings({ distribution: id, packageSet: findDistribution(id).defaultPackageSet });
  });
  $('#pkg-select').addEventListener('change', (e) => {
    void updateSettings({ packageSet: (e.target as HTMLSelectElement).value });
  });
  $('#auto-compile').addEventListener('change', (e) => {
    void updateSettings({ autoCompile: (e.target as HTMLInputElement).checked });
    if ((e.target as HTMLInputElement).checked && dirty) scheduleAutoCompile();
  });
  $('#new-file-btn').addEventListener('click', () => void newFile(tree.currentDir()));
  $('#new-folder-btn').addEventListener('click', () => void newFolder(tree.currentDir()));
  const upInput = $('#upload-input') as HTMLInputElement;
  $('#upload-btn').addEventListener('click', () => upInput.click());
  upInput.addEventListener('change', () => {
    if (upInput.files?.length) void uploadFiles([...upInput.files], tree.currentDir());
    upInput.value = '';
  });
  $('#zoom-in').addEventListener('click', () => pdfView.zoomIn());
  $('#zoom-out').addEventListener('click', () => pdfView.zoomOut());
  let fitPage = false;
  $('#zoom-label').addEventListener('click', () => {
    fitPage = !fitPage;
    pdfView.setZoom(fitPage ? 'fit-page' : 'fit-width');
  });
  $('#download-pdf').addEventListener('click', () => {
    if (lastPdf && project) {
      const source = lastPdfSource ?? project.settings.mainFile;
      const base = source.split('/').pop()!.replace(/\.tex$/, '');
      downloadBlob(lastPdf as BlobPart, `${base}.pdf`, 'application/pdf');
    }
  });
  $('#forward-sync-btn').addEventListener('click', () => forwardSync());
  $('#log-btn').addEventListener('click', () => toggleLog());
  $('#log-close').addEventListener('click', () => toggleLog());
  document.querySelectorAll<HTMLButtonElement>('[data-log-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-log-tab]').forEach((x) => x.classList.toggle('active', x === b));
      const raw = b.dataset.logTab === 'raw';
      $('#log-raw').hidden = !raw;
      $('#log-issues').hidden = raw;
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('.mobile-tabs button').forEach((b) =>
    b.addEventListener('click', () => showPaneMobile(b.dataset.pane as 'tree' | 'editor' | 'preview')),
  );
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return; // エディタ側で処理済み
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      compileEditingFile();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 's' || e.key === 'Enter')) {
      e.preventDefault();
      void compile(e.shiftKey);
    }
  });
  window.addEventListener('beforeunload', () => {
    void flushSaves();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSaves();
  });

  // 永続ストレージを要求（TeX Live キャッシュが消されにくくなる）
  void navigator.storage?.persist?.();

  let projects = await listProjects();
  if (!projects.length) {
    await createProject('はじめてのプロジェクト', 'sample');
    projects = await listProjects();
  }
  const last = await getMeta<string>('lastProject');
  const target = projects.find((p) => p.id === last) ?? projects[0];
  await loadProject(target.id);
  // エンジンをバックグラウンドで先読み
  void warmup();
}

void init();

// デバッグ用（開発者ツールから参照可能）
(window as unknown as { luanote: unknown }).luanote = {
  get synctex() {
    return synctex;
  },
  get project() {
    return project;
  },
};
