// 小さな UI ヘルパー

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`element not found: ${sel}`);
  return el;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * モーダルダイアログを開く。
 *
 * 毎回新しい <dialog> 要素を作る。同じ要素を使い回すと、直前のダイアログを閉じたときの
 * close イベント（非同期に届く）を次のダイアログ（askConfirm など）が自分の close と
 * 取り違え、開いた直後に「キャンセル」扱いになる（プロジェクトの削除・名前変更が効かない）。
 */
export function showDialog(html: string): HTMLDialogElement {
  document.querySelectorAll<HTMLDialogElement>('dialog.dialog').forEach((old) => {
    if (old.open) old.close();
    // close イベントを受け取った後に取り除く
    setTimeout(() => old.remove(), 0);
  });
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  document.body.appendChild(dlg);
  dlg.innerHTML = html;
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.showModal();
  return dlg;
}

export function askText(title: string, label: string, prefix: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = showDialog(`
      <form method="dialog" class="ask">
        <h2>${escapeHtml(title)}</h2>
        <label class="field"><span>${escapeHtml(label)}</span>
          <input id="ask-input" autocomplete="off" spellcheck="false"></label>
        <div class="dialog-actions">
          <div class="spacer"></div>
          <button type="button" class="ghost" data-close>キャンセル</button>
          <button type="submit" class="primary" value="ok">OK</button>
        </div>
      </form>`);
    const input = $('#ask-input', dlg) as HTMLInputElement;
    input.value = prefix + value;
    // 拡張子の前までを選択
    const dot = value.lastIndexOf('.');
    const end = prefix.length + (dot > 0 ? dot : value.length);
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(prefix.length, end);
    });
    let result: string | null = null;
    $('form', dlg).addEventListener('submit', () => {
      result = input.value.trim() || null;
    });
    dlg.addEventListener('close', () => resolve(result), { once: true });
  });
}

export function askConfirm(title: string, message: string, ok = 'OK', cancel = 'キャンセル'): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = showDialog(`
      <form method="dialog">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <div class="dialog-actions">
          <div class="spacer"></div>
          <button type="button" class="ghost" data-close>${escapeHtml(cancel)}</button>
          <button type="submit" class="primary ${ok === '削除' ? 'danger' : ''}" value="ok">${escapeHtml(ok)}</button>
        </div>
      </form>`);
    let result = false;
    $('form', dlg).addEventListener('submit', () => (result = true));
    dlg.addEventListener('close', () => resolve(result), { once: true });
  });
}

let toastTimer: number | undefined;
export function toast(msg: string): void {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3000);
}
