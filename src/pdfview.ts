// pdf.js による PDF プレビュー
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type ZoomMode = 'fit-width' | 'fit-page' | number;

interface PageSlot {
  index: number; // 1-based
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  rendered: number; // レンダリング済みの scale（0 = 未）
  width: number; // pt
  height: number; // pt
  page: PDFPageProxy;
}

const GAP = 12;

export class PdfView {
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private slots: PageSlot[] = [];
  private container: HTMLDivElement;
  private zoom: ZoomMode = 'fit-width';
  private scale = 1;
  private observer: IntersectionObserver;
  private renderGen = 0;
  onReverseSync: (page: number, x: number, y: number) => void = () => {};
  onZoomChange: (label: string) => void = () => {};

  constructor(private root: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'pdf-pages';
    root.appendChild(this.container);
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root,
      rootMargin: '200px 0px',
    });
    new ResizeObserver(() => {
      if (typeof this.zoom !== 'number' && this.doc) this.relayout();
    }).observe(root);
    root.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || !this.doc) return;
        e.preventDefault();
        this.setZoom(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );
  }

  get hasDocument(): boolean {
    return !!this.doc;
  }

  get numPages(): number {
    return this.doc?.numPages ?? 0;
  }

  async load(data: Uint8Array): Promise<void> {
    const gen = ++this.renderGen;
    // pdf.js はバッファを transfer するのでコピーを渡す
    const task = pdfjs.getDocument({ data: data.slice() });
    const doc = await task.promise;
    if (gen !== this.renderGen) {
      void task.destroy();
      return;
    }
    const pages: PDFPageProxy[] = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await doc.getPage(i));
    if (gen !== this.renderGen) {
      void task.destroy();
      return;
    }

    // スクロール位置（相対）を保存
    const root = this.root;
    const oldHeight = this.container.scrollHeight || 1;
    const ratio = root.scrollTop / oldHeight;
    const left = root.scrollLeft;

    const oldTask = this.task;
    this.doc = doc;
    this.task = task;
    const newSlots: PageSlot[] = pages.map((page, i) => {
      const vp = page.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(i + 1);
      return { index: i + 1, el, canvas: null, rendered: 0, width: vp.width, height: vp.height, page };
    });
    this.computeScale(newSlots);

    const frag = document.createElement('div');
    frag.className = 'pdf-pages';
    for (const s of newSlots) {
      this.sizeSlot(s);
      frag.appendChild(s.el);
      s.el.addEventListener('dblclick', (e) => this.handleDblClick(s, e));
    }
    // 先に見えている範囲を描画してから差し替える（ちらつき防止）
    const viewTop = ratio * this.totalHeight(newSlots);
    const viewBottom = viewTop + root.clientHeight;
    let y = GAP;
    const visible: PageSlot[] = [];
    for (const s of newSlots) {
      const h = s.height * this.scale;
      if (y + h >= viewTop - 200 && y <= viewBottom + 200) visible.push(s);
      y += h + GAP;
    }
    await Promise.all(visible.map((s) => this.renderSlot(s, gen)));
    if (gen !== this.renderGen) return;

    this.observer.disconnect();
    this.root.replaceChild(frag, this.container);
    this.container = frag;
    this.slots = newSlots;
    for (const s of newSlots) this.observer.observe(s.el);
    root.scrollTop = ratio * this.container.scrollHeight;
    root.scrollLeft = left;
    if (oldTask) void oldTask.destroy();
    this.emitZoom();
  }

  clear(): void {
    this.renderGen++;
    this.observer.disconnect();
    this.container.innerHTML = '';
    this.slots = [];
    if (this.task) void this.task.destroy();
    this.task = null;
    this.doc = null;
  }

  setZoom(z: ZoomMode): void {
    if (typeof z === 'number') z = Math.min(5, Math.max(0.25, z));
    this.zoom = z;
    this.relayout();
  }

  zoomIn(): void {
    this.setZoom(this.scale * 1.2);
  }

  zoomOut(): void {
    this.setZoom(this.scale / 1.2);
  }

  /** 指定ページの領域へスクロールしてハイライト */
  highlight(page: number, x: number, y: number, w: number, h: number): void {
    const s = this.slots[page - 1];
    if (!s) return;
    const mark = document.createElement('div');
    mark.className = 'sync-mark';
    mark.style.left = `${x * this.scale}px`;
    mark.style.top = `${y * this.scale}px`;
    mark.style.width = `${w * this.scale}px`;
    mark.style.height = `${h * this.scale}px`;
    s.el.appendChild(mark);
    const top = s.el.offsetTop + y * this.scale - this.root.clientHeight / 3;
    this.root.scrollTo({ top, behavior: 'smooth' });
    setTimeout(() => mark.remove(), 2000);
  }

  private emitZoom(): void {
    this.onZoomChange(`${Math.round(this.scale * 100)}%`);
  }

  private totalHeight(slots: PageSlot[]): number {
    return slots.reduce((a, s) => a + s.height * this.scale + GAP, GAP);
  }

  private computeScale(slots: PageSlot[]): void {
    if (!slots.length) return;
    const maxW = Math.max(...slots.map((s) => s.width));
    const maxH = Math.max(...slots.map((s) => s.height));
    const availW = Math.max(100, this.root.clientWidth - 2 * GAP - 4);
    const availH = Math.max(100, this.root.clientHeight - 2 * GAP);
    if (this.zoom === 'fit-width') this.scale = availW / maxW;
    else if (this.zoom === 'fit-page') this.scale = Math.min(availW / maxW, availH / maxH);
    else this.scale = this.zoom;
  }

  private sizeSlot(s: PageSlot): void {
    s.el.style.width = `${Math.floor(s.width * this.scale)}px`;
    s.el.style.height = `${Math.floor(s.height * this.scale)}px`;
  }

  private relayout(): void {
    if (!this.doc) return;
    const ratio = this.root.scrollTop / (this.container.scrollHeight || 1);
    const prev = this.scale;
    this.computeScale(this.slots);
    if (Math.abs(prev - this.scale) < 1e-3) return;
    for (const s of this.slots) {
      this.sizeSlot(s);
      if (s.canvas) {
        s.canvas.style.width = '100%';
        s.canvas.style.height = '100%';
      }
    }
    this.root.scrollTop = ratio * this.container.scrollHeight;
    const gen = this.renderGen;
    // 見えているページを再描画
    const rootRect = this.root.getBoundingClientRect();
    for (const s of this.slots) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom >= rootRect.top - 200 && r.top <= rootRect.bottom + 200) void this.renderSlot(s, gen);
      else s.rendered = 0;
    }
    this.emitZoom();
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    const gen = this.renderGen;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const idx = parseInt((e.target as HTMLElement).dataset.page ?? '0', 10);
      const s = this.slots[idx - 1];
      if (s && Math.abs(s.rendered - this.scale) > 1e-3) void this.renderSlot(s, gen);
    }
  }

  private async renderSlot(s: PageSlot, gen: number): Promise<void> {
    const scale = this.scale;
    if (Math.abs(s.rendered - scale) < 1e-3) return;
    s.rendered = scale;
    const dpr = window.devicePixelRatio || 1;
    const vp = s.page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    try {
      await s.page.render({ canvas, viewport: vp }).promise;
    } catch {
      s.rendered = 0;
      return;
    }
    if (gen !== this.renderGen && this.slots.includes(s) === false && s.el.isConnected) return;
    if (Math.abs(s.rendered - scale) > 1e-3) return; // 途中でズームされた
    if (s.canvas) s.canvas.replaceWith(canvas);
    else s.el.prepend(canvas);
    s.canvas = canvas;
  }

  private handleDblClick(s: PageSlot, e: MouseEvent): void {
    const r = s.el.getBoundingClientRect();
    const x = (e.clientX - r.left) / this.scale;
    const y = (e.clientY - r.top) / this.scale;
    this.onReverseSync(s.index, x, y);
  }
}
