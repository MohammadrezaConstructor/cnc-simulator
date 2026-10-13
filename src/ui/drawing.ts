// Generates a simple engineering drawing (half section + ordinate dimensions) from contours.

import type { P } from '../types';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};

function emptyDrawing(W: number, H: number): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'drawing');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'No part drawing');
  const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'No drawing – the target contour is empty or invalid.');
  t.setAttribute('style', 'fill:var(--v-text);font:12px sans-serif');
  svg.appendChild(t);
  return svg;
}

export function partDrawing(outer: P[], inner: P[], stockR: number): SVGSVGElement {
  // contours from imported exercises may be empty or contain garbage – never draw NaN
  const ok = (p: P) => !!p && Number.isFinite(p.z) && Number.isFinite(p.x);
  outer = (outer ?? []).filter(ok);
  inner = (inner ?? []).filter(ok);
  if (!Number.isFinite(stockR) || stockR < 0) stockR = 0;
  const all = outer.concat(inner);
  if (all.length < 2) return emptyDrawing(520, 120);
  const zmin = Math.min(...all.map((p) => p.z));
  const zmax = Math.max(...all.map((p) => p.z), 0);
  const rmax = Math.max(stockR, ...all.map((p) => p.x));
  const W = 520, H = 250, padL = 30, padR = 30, padT = 34, padB = 46;
  const s = Math.min((W - padL - padR) / Math.max(1, zmax - zmin), (H - padT - padB) / (2 * rmax));
  const X = (z: number) => padL + (z - zmin) * s;
  const cy = padT + rmax * s;
  const Y = (r: number) => cy - r * s;
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'drawing');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Part drawing');
  const style = el('style', {});
  style.textContent = `.o{fill:none;stroke:var(--v-stock-edge);stroke-width:1.6}.f{fill:var(--v-stock);opacity:.35}.c{stroke:var(--v-axis);stroke-dasharray:10 3 2 3}.d{stroke:var(--v-text);stroke-width:.8}.t{fill:var(--v-text);font:10px var(--mono)}.dd{fill:var(--v-target);font:600 11px var(--mono)}.s{fill:none;stroke:var(--v-text);stroke-dasharray:3 3;stroke-width:.8}`;
  svg.appendChild(style);
  // stock outline
  svg.appendChild(el('rect', { x: X(zmin) - 6, y: Y(stockR), width: X(zmax) - X(zmin) + 12, height: 2 * stockR * s, class: 's' }));
  // section fill (top half outline closed to the axis or to the inner contour)
  const path = (pts: P[], m: number) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.z).toFixed(1)} ${(cy - m * p.x * s).toFixed(1)}`).join(' ');
  for (const m of [1, -1]) {
    if (outer.length > 1) {
      const innerPts = inner.length > 1 ? inner.slice().reverse() : [{ z: outer[outer.length - 1].z, x: 0 }, { z: outer[0].z, x: 0 }];
      const closed = path(outer, m) + ' ' + innerPts.map((p) => `L${X(p.z).toFixed(1)} ${(cy - m * p.x * s).toFixed(1)}`).join(' ') + ' Z';
      svg.appendChild(el('path', { d: closed, class: 'f' }));
      svg.appendChild(el('path', { d: path(outer, m), class: 'o' }));
    }
    if (inner.length > 1) svg.appendChild(el('path', { d: path(inner, m), class: 'o' }));
  }
  svg.appendChild(el('line', { x1: X(zmin) - 14, y1: cy, x2: X(zmax) + 14, y2: cy, class: 'c' }));
  // Z ordinate dimensions (unique vertex z values)
  const zs = Array.from(new Set(all.map((p) => +p.z.toFixed(3)))).sort((a, b) => b - a);
  const yb = H - padB + 14;
  let lastX = Infinity;
  for (const z of zs) {
    const x = X(z);
    svg.appendChild(el('line', { x1: x, y1: Y(-rmax) + 2, x2: x, y2: yb - 2, class: 'd' }));
    if (Math.abs(lastX - x) > 22) {
      svg.appendChild(el('text', { x: x, y: yb + 9, class: 't', 'text-anchor': 'middle' }, z === 0 ? 'Z0' : `${z}`));
      lastX = x;
    }
  }
  // diameter labels on horizontal segments (outer above, inner below the axis)
  const labelDia = (pts: P[], innerSide: boolean) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.z - b.z) * s < 24) continue;
      const xm = (X(a.z) + X(b.z)) / 2;
      const y = innerSide ? cy + a.x * s - 4 : Y(a.x) - 5;
      svg.appendChild(el('text', { x: xm, y, class: 'dd', 'text-anchor': 'middle' }, `Ø${+(a.x * 2).toFixed(3)}`));
    }
  };
  labelDia(outer, false);
  labelDia(inner, true);
  svg.appendChild(el('text', { x: 6, y: 14, class: 't' }, `Stock Ø${stockR * 2} – dimensions in mm, Z from the front face`));
  return svg;
}
