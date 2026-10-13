type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** replaceChildren that skips null/false children */
export function fill(el: Element, ...children: (Child | Child[])[]) {
  el.replaceChildren(...children.flat().filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : String(c))));
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];

export interface DialogButton {
  label: string;
  primary?: boolean;
  /** return false to keep the dialog open */
  onClick?: () => boolean | void;
}

/** open dialogs, topmost last – only the top one reacts to Esc / Tab */
const dialogStack: { dlg: HTMLElement; close: () => void }[] = [];
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
document.addEventListener(
  'keydown',
  (e) => {
    const top = dialogStack[dialogStack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      // the editor inside a dialog or an open <select> handle Esc themselves
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      top.close();
    } else if (e.key === 'Tab') {
      // keep keyboard focus inside the (modal) dialog
      const f = Array.from(top.dlg.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const inside = top.dlg.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
  },
  true,
);

/** give every form control in a dialog an accessible name: the <label> placed before it in a
 *  `.form` grid, or the column header (+ row header) of the table cell it sits in */
function autoLabel(root: HTMLElement) {
  for (const c of root.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea')) {
    if (c.hasAttribute('aria-label') || c.closest('label') || (c.id && root.querySelector(`label[for="${CSS.escape(c.id)}"]`))) continue;
    let name = '';
    // the grid cell of a .form that contains the control, and the label before it
    let cell: HTMLElement = c;
    while (cell.parentElement && cell.parentElement !== root && !cell.parentElement.classList.contains('form')) cell = cell.parentElement;
    const prev = cell.parentElement?.classList.contains('form') ? cell.previousElementSibling : null;
    if (prev?.tagName === 'LABEL') {
      name = prev.textContent ?? '';
      const sib = cell === c ? [c] : Array.from(cell.querySelectorAll('input, select, textarea'));
      if (sib.length > 1) name += ` ${sib.indexOf(c) + 1}`;
    } else {
      const td = c.closest('td');
      const tr = td?.parentElement;
      const head = td?.closest('table')?.querySelector('tr');
      if (td && tr && head && head !== tr) {
        const col = Array.from(tr.children).indexOf(td);
        name = [tr.children[0]?.textContent, head.children[col]?.textContent].filter(Boolean).join(' ');
      }
    }
    name = name.replace(/\s+/g, ' ').trim();
    if (name) c.setAttribute('aria-label', name);
  }
}

export function openDialog(o: { title: string; body: Node; buttons?: DialogButton[]; size?: 'wide' | 'narrow'; onClose?: () => void }) {
  const root = document.getElementById('dialogRoot')!;
  const prevFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    mo.disconnect();
    back.remove();
    const i = dialogStack.findIndex((d) => d.dlg === dlg);
    if (i >= 0) dialogStack.splice(i, 1);
    document.body.classList.toggle('dlg-open', dialogStack.length > 0);
    o.onClose?.();
    prevFocus?.focus?.();
  };
  const foot = (o.buttons ?? [{ label: 'Close' }]).map((b) =>
    h('button', { class: b.primary ? 'primary' : '', onclick: () => (b.onClick?.() === false ? null : close()) }, b.label),
  );
  const dlg = h(
    'div',
    { class: `dlg ${o.size ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
    h('div', { class: 'dlg-head' }, h('h2', null, o.title), h('button', { onclick: close, 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'dlg-body' }, o.body),
    h('div', { class: 'dlg-foot' }, foot),
  );
  const back = h('div', { class: 'dlg-backdrop', onmousedown: (e: MouseEvent) => e.target === back && close() }, dlg);
  root.appendChild(back);
  autoLabel(dlg);
  // dialogs re-render parts of themselves (tables, wizard rows) – name the new controls too
  let pending = false;
  const mo = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      autoLabel(dlg);
    });
  });
  mo.observe(dlg, { childList: true, subtree: true });
  dialogStack.push({ dlg, close });
  document.body.classList.add('dlg-open');
  (dlg.querySelector('.dlg-body input, .dlg-body button, .dlg-foot button') as HTMLElement | null)?.focus();
  return close;
}
export const dialogOpen = () => dialogStack.length > 0;

/** true when a global keyboard shortcut must not act on this event: it was already handled
 *  (editor, search panel, autocomplete), or the focus is on a control that uses the key itself */
export function keyBelongsToControl(e: KeyboardEvent) {
  if (e.defaultPrevented) return true;
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest) return false;
  return !!t.closest('.cm-editor, input, textarea, select, button, a[href], [role="button"], [contenteditable="true"], .popover');
}

/** in-page confirmation (native confirm() is not available everywhere) */
export function confirmDialog(message: string, okLabel: string, onOk: () => void) {
  openDialog({ title: 'Please confirm', body: h('p', null, message), size: 'narrow', buttons: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => { onOk(); } }] });
}

/** effective colour theme (explicit choice or the system preference) */
export function isLightTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'light';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

export function toast(msg: string, kind: 'ok' | 'warn' | 'err' | 'info' = 'info', ms = 3500) {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  const host = document.getElementById('toasts')!;
  host.appendChild(t);
  while (host.children.length > 3) host.firstElementChild?.remove();
  setTimeout(() => t.remove(), ms);
}

export function fmtTime(s: number) {
  if (!isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

export function download(name: string, data: string | Blob, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export const store = {
  get<T>(k: string, def: T): T {
    try {
      const v = localStorage.getItem('lathelab:' + k);
      return v ? (JSON.parse(v) as T) : def;
    } catch {
      return def;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem('lathelab:' + k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};
