// 3D move geometry for milling. Arcs live in a plane (G17/G18/G19) and may be helical
// (linear motion along the plane normal). The in-plane maths reuses the lathe geometry by
// mapping the plane's right-handed axes (a, b) onto P {z: a, x: b}.

import type { P } from '../types';
import { arcSweep, dist } from '../sim/geom';
import type { MillMove, Plane, V3 } from './types';

/** in-plane axes (a, b) and normal n, right-handed: a × b = n */
export const PLANE_AXES: Record<Plane, ['x' | 'y' | 'z', 'x' | 'y' | 'z', 'x' | 'y' | 'z']> = {
  17: ['x', 'y', 'z'],
  18: ['z', 'x', 'y'],
  19: ['y', 'z', 'x'],
};

export const toP = (v: V3, plane: Plane): P => {
  const [a, b] = PLANE_AXES[plane];
  return { z: v[a], x: v[b] };
};

export function fromP(p: P, n: number, plane: Plane): V3 {
  const [a, b, nn] = PLANE_AXES[plane];
  const v = { x: 0, y: 0, z: 0 };
  v[a] = p.z;
  v[b] = p.x;
  v[nn] = n;
  return v;
}

export const dist3 = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function arcInfo(m: MillMove) {
  const pa = toP(m.from, m.plane), pb = toP(m.to, m.plane), pc = toP(m.center!, m.plane);
  const r = dist(pa, pc);
  const sweep = arcSweep(pa, pb, pc, !!m.cw);
  const a0 = Math.atan2(pa.x - pc.x, pa.z - pc.z);
  const nn = PLANE_AXES[m.plane][2];
  return { pc, r, sweep, a0, n0: m.from[nn], n1: m.to[nn] };
}

export function moveLength3(m: MillMove): number {
  if (m.type === 'arc' && m.center) {
    const a = arcInfo(m);
    return Math.hypot(Math.abs(a.sweep) * a.r, a.n1 - a.n0);
  }
  return dist3(m.from, m.to);
}

export function pointAt3(m: MillMove, s: number, L = moveLength3(m)): V3 {
  if (L < 1e-12) return { ...m.to };
  const t = Math.max(0, Math.min(1, s / L));
  if (m.type === 'arc' && m.center) {
    const a = arcInfo(m);
    const ang = a.a0 + a.sweep * t;
    return fromP({ z: a.pc.z + a.r * Math.cos(ang), x: a.pc.x + a.r * Math.sin(ang) }, a.n0 + (a.n1 - a.n0) * t, m.plane);
  }
  return { x: m.from.x + (m.to.x - m.from.x) * t, y: m.from.y + (m.to.y - m.from.y) * t, z: m.from.z + (m.to.z - m.from.z) * t };
}

/** polyline approximation (chord error ≈ tol) */
export function discretize3(m: MillMove, tol = 0.01, maxSeg = Infinity): V3[] {
  if (m.type === 'arc' && m.center) {
    const a = arcInfo(m);
    const step = a.r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / a.r)) : Math.PI / 8;
    let n = Math.max(2, Math.ceil(Math.abs(a.sweep) / Math.max(step, 1e-3)));
    if (isFinite(maxSeg)) n = Math.max(n, Math.ceil((Math.abs(a.sweep) * a.r) / maxSeg));
    n = Math.min(n, 2000);
    const L = moveLength3(m);
    const out: V3[] = [];
    for (let i = 0; i <= n; i++) out.push(i === n ? { ...m.to } : pointAt3(m, (L * i) / n, L));
    return out;
  }
  if (isFinite(maxSeg)) {
    const L = dist3(m.from, m.to);
    const n = Math.max(1, Math.ceil(L / maxSeg));
    const out: V3[] = [];
    for (let i = 0; i <= n; i++) out.push(pointAt3(m, (L * i) / n, L));
    return out;
  }
  return [{ ...m.from }, { ...m.to }];
}
