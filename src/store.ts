// IndexedDB を使ったプロジェクト / ファイルの永続化

export type FileContent = string | Uint8Array;

export interface FileEntry {
  projectId: string;
  path: string; // 例: "chapters/intro.tex"（ディレクトリは "chapters"）
  kind: 'file' | 'dir';
  content?: FileContent;
  updated: number;
}

export type BibMode = 'auto' | 'none' | 'bibtex' | 'biber';

export interface ProjectSettings {
  distribution: string; // 例: "texlive-2026"
  packageSet: string; // 例: "recommended"
  mainFile: string;
  bib: BibMode;
  autoCompile: boolean;
}

export interface Project {
  id: string;
  name: string;
  created: number;
  updated: number;
  settings: ProjectSettings;
}

const DB_NAME = 'luanote';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        s.createIndex('byProject', 'projectId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const result = await fn(t);
  await done;
  return result;
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function listProjects(): Promise<Project[]> {
  return tx(['projects'], 'readonly', async (t) => {
    const all = await promisify(t.objectStore('projects').getAll() as IDBRequest<Project[]>);
    return all.sort((a, b) => b.updated - a.updated);
  });
}

export async function getProject(id: string): Promise<Project | undefined> {
  return tx(['projects'], 'readonly', (t) =>
    promisify(t.objectStore('projects').get(id) as IDBRequest<Project | undefined>),
  );
}

export async function putProject(p: Project): Promise<void> {
  await tx(['projects'], 'readwrite', (t) => {
    t.objectStore('projects').put(p);
  });
}

export async function deleteProject(id: string): Promise<void> {
  await tx(['projects', 'files'], 'readwrite', async (t) => {
    t.objectStore('projects').delete(id);
    const idx = t.objectStore('files').index('byProject');
    const keys = await promisify(idx.getAllKeys(id));
    for (const k of keys) t.objectStore('files').delete(k);
  });
}

export async function listFiles(projectId: string): Promise<FileEntry[]> {
  return tx(['files'], 'readonly', (t) =>
    promisify(t.objectStore('files').index('byProject').getAll(projectId) as IDBRequest<FileEntry[]>),
  );
}

export async function putFile(e: FileEntry): Promise<void> {
  await tx(['files'], 'readwrite', (t) => {
    t.objectStore('files').put(e);
  });
}

export async function putFiles(entries: FileEntry[]): Promise<void> {
  await tx(['files'], 'readwrite', (t) => {
    const s = t.objectStore('files');
    for (const e of entries) s.put(e);
  });
}

export async function deleteFiles(projectId: string, paths: string[]): Promise<void> {
  await tx(['files'], 'readwrite', (t) => {
    const s = t.objectStore('files');
    for (const p of paths) s.delete([projectId, p]);
  });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return tx(['meta'], 'readonly', (t) => promisify(t.objectStore('meta').get(key) as IDBRequest<T | undefined>));
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await tx(['meta'], 'readwrite', (t) => {
    t.objectStore('meta').put(value, key);
  });
}
