import type { MoveOp, P } from '../types';

export const EPS = 1e-9;

export const pt = (x: number, z: number): P => ({ x, z });
export const add = (a: P, b: P): P => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: P, b: P): P => ({ x: a.x - b.x, z: a.z - b.z });
export const mul = (a: P, k: number): P => ({ x: a.x * k, z: a.z * k });
export const dot = (a: P, b: P) => a.x * b.x + a.z * b.z;
/** 2D cross product with z as the first ("horizontal") component and x as the second. */
export const cross = (a: P, b: P) => a.z * b.x - a.x * b.z;
export const len = (a: P) => Math.hypot(a.x, a.z);
export const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z);
export const norm = (a: P): P => {
  const l = len(a);
  return l < EPS ? { x: 0, z: 0 } : { x: a.x / l, z: a.z / l };
};
export const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const near = (a: P, b: P, tol = 1e-6) => Math.abs(a.x - b.x) < tol && Math.abs(a.z - b.z) < tol;

/** angle of a vector in the (z → horizontal, x → vertical) plane */
export const ang = (v: P) => Math.atan2(v.x, v.z);
export const dirOf = (a: number): P => ({ x: Math.sin(a), z: Math.cos(a) });
export const deg = (d: number) => (d * Math.PI) / 180;

/** Right-hand normal (G42 side) of a travel direction (unit). */
export const rightN = (t: P): P => ({ z: t.x, x: -t.z });
/** Left-hand normal (G41 side). */
export const leftN = (t: P): P => ({ z: -t.x, x: t.z });

/** Signed sweep (radians) of an arc, negative for clockwise. Full circle when start == end. */
export function arcSweep(from: P, to: P, c: P, cw: boolean): number {
  const a0 = ang(sub(from, c));
  const a1 = ang(sub(to, c));
  let s = a1 - a0;
  if (cw) {
    while (s >= -EPS) s -= 2 * Math.PI;
    if (s < -2 * Math.PI - EPS) s += 2 * Math.PI;
  } else {
    while (s <= EPS) s += 2 * Math.PI;
    if (s > 2 * Math.PI + EPS) s -= 2 * Math.PI;
  }
  return s;
}

export function moveLength(m: MoveOp): number {
  if (m.type === 'arc' && m.center) {
    const r = dist(m.from, m.center);
    return Math.abs(arcSweep(m.from, m.to, m.center, !!m.cw)) * r;
  }
  return dist(m.from, m.to);
}

/** Point at distance s along a move (s clamped to [0,len]). */
export function pointAt(m: MoveOp, s: number): P {
  const L = moveLength(m);
  if (L < EPS) return { ...m.to };
  const t = Math.max(0, Math.min(1, s / L));
  if (m.type === 'arc' && m.center) {
    const r = dist(m.from, m.center);
    const a0 = ang(sub(m.from, m.center));
    const sw = arcSweep(m.from, m.to, m.center, !!m.cw);
    const a = a0 + sw * t;
    return { x: m.center.x + r * Math.sin(a), z: m.center.z + r * Math.cos(a) };
  }
  return lerp(m.from, m.to, t);
}

/** Unit tangent at the start (t=0) or end (t=1) of a move. */
export function tangentAt(m: MoveOp, atEnd: boolean): P {
  if (m.type === 'arc' && m.center) {
    const p = atEnd ? m.to : m.from;
    const r = sub(p, m.center);
    // CCW tangent of radius vector r=(z,x) is (-x, z) in (z,x) order
    const t = { z: -r.x, x: r.z };
    return norm(m.cw ? mul(t, -1) : t);
  }
  return norm(sub(m.to, m.from));
}

/** Polyline approximation of a move (includes both endpoints). */
export function discretize(m: MoveOp, maxAngle = deg(3), maxSeg = Infinity): P[] {
  if (m.type === 'arc' && m.center) {
    const r = dist(m.from, m.center);
    const sw = arcSweep(m.from, m.to, m.center, !!m.cw);
    let n = Math.max(1, Math.ceil(Math.abs(sw) / maxAngle));
    if (isFinite(maxSeg)) n = Math.max(n, Math.ceil((Math.abs(sw) * r) / maxSeg));
    const a0 = ang(sub(m.from, m.center));
    const out: P[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sw * i) / n;
      out.push(i === n ? { ...m.to } : { x: m.center.x + r * Math.sin(a), z: m.center.z + r * Math.cos(a) });
    }
    return out;
  }
  if (isFinite(maxSeg)) {
    const L = dist(m.from, m.to);
    const n = Math.max(1, Math.ceil(L / maxSeg));
    const out: P[] = [];
    for (let i = 0; i <= n; i++) out.push(lerp(m.from, m.to, i / n));
    return out;
  }
  return [{ ...m.from }, { ...m.to }];
}

/** Convex hull (monotone chain), returns CCW polygon in (z,x) plane. */
export function convexHull(points: P[]): P[] {
  const pts = points.slice().sort((a, b) => a.z - b.z || a.x - b.x);
  if (pts.length <= 2) return pts;
  const c = (o: P, a: P, b: P) => (a.z - o.z) * (b.x - o.x) - (a.x - o.x) * (b.z - o.z);
  const lower: P[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && c(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && c(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Intersection of the vertical line z = zc with a convex polygon.
 * Returns [xmin, xmax] or null.
 */
export function polyColumn(poly: P[], zc: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const za = a.z, zb = b.z;
    if ((zc < za && zc < zb) || (zc > za && zc > zb)) continue;
    if (Math.abs(zb - za) < EPS) {
      lo = Math.min(lo, a.x, b.x);
      hi = Math.max(hi, a.x, b.x);
    } else {
      const t = (zc - za) / (zb - za);
      const x = a.x + (b.x - a.x) * t;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

export function polyBounds(poly: P[]) {
  let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity;
  for (const p of poly) {
    if (p.z < zmin) zmin = p.z;
    if (p.z > zmax) zmax = p.z;
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
  }
  return { zmin, zmax, xmin, xmax };
}

export const translate = (poly: P[], d: P): P[] => poly.map((p) => ({ x: p.x + d.x, z: p.z + d.z }));

/** Line (p + t·d) intersection with line (q + u·e). Returns t or null if parallel. */
export function lineLine(p: P, d: P, q: P, e: P): number | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12) return null;
  return cross(sub(q, p), e) / den;
}

/** Intersections of infinite line (p + t·d, d unit) with circle (c, r): returns t values. */
export function lineCircle(p: P, d: P, c: P, r: number): number[] {
  const f = sub(p, c);
  const b = dot(f, d);
  const cc = dot(f, f) - r * r;
  const disc = b * b - cc;
  if (disc < -1e-9) return [];
  const s = Math.sqrt(Math.max(0, disc));
  return [-b - s, -b + s];
}

/** Circle-circle intersection points. */
export function circleCircle(c1: P, r1: number, c2: P, r2: number): P[] {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = mul(sub(c2, c1), 1 / d);
  const m = add(c1, mul(u, a));
  const perp = { z: -u.x, x: u.z };
  return [add(m, mul(perp, h)), add(m, mul(perp, -h))];
}

/** Is angle of point p (about c) inside the arc from→to? */
export function onArc(p: P, from: P, to: P, c: P, cw: boolean, tol = 1e-7): boolean {
  const full = arcSweep(from, to, c, cw);
  const part = arcSweep(from, p, c, cw);
  if (near(p, from, 1e-6) || near(p, to, 1e-6)) return true;
  return Math.abs(part) <= Math.abs(full) + tol;
}

/** Douglas–Peucker simplification on an open polyline. */
export function simplify(points: P[], tol: number): P[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = points[i0];
    const b = points[i1];
    const d = sub(b, a);
    const L = len(d);
    let maxD = -1;
    let idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const v = sub(points[i], a);
      const dd = L < EPS ? len(v) : Math.abs(cross(d, v)) / L;
      if (dd > maxD) {
        maxD = dd;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export const fmt = (v: number, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
