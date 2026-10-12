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

let openCount = 0;
export function openDialog(o: { title: string; body: Node; buttons?: DialogButton[]; size?: 'wide' | 'narrow'; onClose?: () => void }) {
  const root = document.getElementById('dialogRoot')!;
  const prevFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    openCount--;
    document.removeEventListener('keydown', onKey, true);
    o.onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
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
  openCount++;
  document.addEventListener('keydown', onKey, true);
  (dlg.querySelector('.dlg-body input, .dlg-body button, .dlg-foot button') as HTMLElement | null)?.focus();
  return close;
}
export const dialogOpen = () => openCount > 0;

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
