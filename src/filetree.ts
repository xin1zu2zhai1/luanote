// ファイルツリー UI

export interface TreeItem {
  path: string;
  kind: 'file' | 'dir';
}

export interface TreeCallbacks {
  onOpen: (path: string) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onSetMain: (path: string) => void;
  onDownload: (path: string) => void;
  onMove: (from: string, toDir: string) => void;
  onUpload: (files: File[], dir: string) => void;
}

interface Node {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children: Node[];
}

function buildTree(items: TreeItem[]): Node {
  const root: Node = { name: '', path: '', kind: 'dir', children: [] };
  const dirs = new Map<string, Node>([['', root]]);
  const ensureDir = (path: string): Node => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const idx = path.lastIndexOf('/');
    const parent = ensureDir(idx < 0 ? '' : path.slice(0, idx));
    const node: Node = { name: path.slice(idx + 1), path, kind: 'dir', children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const it of items) {
    if (it.kind === 'dir') ensureDir(it.path);
  }
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const idx = it.path.lastIndexOf('/');
    const parent = ensureDir(idx < 0 ? '' : it.path.slice(0, idx));
    parent.children.push({ name: it.path.slice(idx + 1), path: it.path, kind: 'file', children: [] });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

function iconFor(node: Node, open: boolean): string {
  if (node.kind === 'dir') return open ? '📂' : '📁';
  const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
  if (['tex', 'ltx'].includes(ext)) return '📄';
  if (['bib'].includes(ext)) return '📚';
  if (['sty', 'cls', 'def'].includes(ext)) return '⚙️';
  if (['lua'].includes(ext)) return '🌙';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
  if (['pdf'].includes(ext)) return '📕';
  if (['otf', 'ttf', 'ttc', 'woff'].includes(ext)) return '🔤';
  return '📃';
}

export class FileTree {
  private items: TreeItem[] = [];
  private collapsed = new Set<string>();
  private selected: string | null = null;
  private mainFile = '';
  private menu: HTMLDivElement | null = null;
  private dragPath: string | null = null;

  constructor(private root: HTMLElement, private cb: TreeCallbacks) {
    root.addEventListener('contextmenu', (e) => {
      if (e.target === root || (e.target as HTMLElement).classList.contains('tree-list')) {
        e.preventDefault();
        this.showMenu(e.clientX, e.clientY, { name: '', path: '', kind: 'dir', children: [] });
      }
    });
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('drop-root');
    });
    root.addEventListener('dragleave', (e) => {
      if (e.target === root) root.classList.remove('drop-root');
    });
    root.addEventListener('drop', (e) => {
      root.classList.remove('drop-root');
      e.preventDefault();
      this.handleDrop(e, '');
    });
    document.addEventListener('click', () => this.hideMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideMenu();
    });
  }

  setItems(items: TreeItem[], mainFile: string): void {
    this.items = items;
    this.mainFile = mainFile;
    this.render();
  }

  select(path: string | null): void {
    this.selected = path;
    if (path) {
      // 親ディレクトリを展開
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) this.collapsed.delete(parts.slice(0, i).join('/'));
    }
    this.render();
  }

  /** 新規作成先のディレクトリ（選択中アイテムに基づく） */
  currentDir(): string {
    if (!this.selected) return '';
    const it = this.items.find((i) => i.path === this.selected);
    if (it?.kind === 'dir') return it.path;
    const idx = this.selected.lastIndexOf('/');
    return idx < 0 ? '' : this.selected.slice(0, idx);
  }

  private render(): void {
    const tree = buildTree(this.items);
    const ul = document.createElement('ul');
    ul.className = 'tree-list';
    ul.setAttribute('role', 'tree');
    this.renderChildren(tree, ul, 0);
    this.root.replaceChildren(ul);
  }

  private renderChildren(node: Node, ul: HTMLUListElement, depth: number): void {
    for (const child of node.children) {
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      const row = document.createElement('div');
      row.className = 'tree-row';
      if (child.path === this.selected) row.classList.add('selected');
      if (child.path === this.mainFile) row.classList.add('main');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.draggable = true;
      row.title = child.path;
      const open = child.kind === 'dir' && !this.collapsed.has(child.path);

      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = child.kind === 'dir' ? (open ? '▾' : '▸') : '';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = iconFor(child, open);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = child.name;
      row.append(twisty, icon, name);
      if (child.path === this.mainFile) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'main';
        badge.title = 'メインファイル（コンパイル対象）';
        row.append(badge);
      }
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = '⋯';
      more.title = 'メニュー';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        this.showMenu(r.left, r.bottom, child);
      });
      row.append(more);

      row.addEventListener('click', () => {
        this.selected = child.path;
        if (child.kind === 'dir') {
          if (open) this.collapsed.add(child.path);
          else this.collapsed.delete(child.path);
          this.render();
        } else {
          this.cb.onOpen(child.path);
        }
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showMenu(e.clientX, e.clientY, child);
      });
      row.addEventListener('dragstart', (e) => {
        this.dragPath = child.path;
        e.dataTransfer?.setData('text/plain', child.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => (this.dragPath = null));
      const targetDir =
        child.kind === 'dir' ? child.path : child.path.includes('/') ? child.path.slice(0, child.path.lastIndexOf('/')) : '';
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-target');
        this.handleDrop(e, targetDir);
      });

      li.appendChild(row);
      if (child.kind === 'dir' && open) {
        const sub = document.createElement('ul');
        this.renderChildren(child, sub, depth + 1);
        li.appendChild(sub);
      }
      ul.appendChild(li);
    }
  }

  private handleDrop(e: DragEvent, dir: string): void {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      this.cb.onUpload([...files], dir);
      return;
    }
    const from = this.dragPath ?? e.dataTransfer?.getData('text/plain');
    this.dragPath = null;
    if (from && from !== dir && !dir.startsWith(from + '/')) {
      const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      if (parent !== dir) this.cb.onMove(from, dir);
    }
  }

  private showMenu(x: number, y: number, node: Node): void {
    this.hideMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    const dir = node.kind === 'dir' ? node.path : node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const add = (label: string, fn: () => void, danger = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (danger) b.classList.add('danger');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hideMenu();
        fn();
      });
      menu.appendChild(b);
    };
    add('新規ファイル', () => this.cb.onNewFile(dir));
    add('新規フォルダ', () => this.cb.onNewFolder(dir));
    if (node.path) {
      const sep = document.createElement('hr');
      menu.appendChild(sep);
      if (node.kind === 'file' && node.path.endsWith('.tex') && node.path !== this.mainFile) {
        add('メインファイルに設定', () => this.cb.onSetMain(node.path));
      }
      add('名前の変更 / 移動', () => this.cb.onRename(node.path));
      if (node.kind === 'file') add('ダウンロード', () => this.cb.onDownload(node.path));
      add('削除', () => this.cb.onDelete(node.path), true);
    }
    document.body.appendChild(menu);
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 4)}px`;
    this.menu = menu;
  }

  private hideMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
