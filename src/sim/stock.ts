// Dexel material model for turned parts.
//
// The (axisymmetric) workpiece is stored as N thin columns along Z. Each column holds a sorted
// list of radial material intervals [lo, hi] (float precision). Removing material = intersect
// the swept convex tool shape with every column it covers and subtract that radial interval.
// This represents OD/ID profiles, face grooves and part-off exactly in X and with dz resolution in Z.

import type { P, StockDef } from '../types';
import { polyBounds, polyColumn, simplify } from './geom';

export interface Body {
  /** closed outline polygon (z, x=radius) – top chain then reversed bottom chain */
  outline: P[];
  top: P[];
  bottom: P[];
  /** exposed annular end faces */
  caps: { z: number; r0: number; r1: number; dir: -1 | 1 }[];
}

/** convert a line-intersection [a,b] (signed x) into a radial interval */
export function toRadial(a: number, b: number): [number, number] {
  if (a >= 0) return [a, b];
  if (b <= 0) return [-b, -a];
  return [0, Math.max(-a, b)];
}

export class Stock {
  z0 = 0;
  dz: number;
  n = 0;
  cols: number[][] = [];
  version = 0;
  def: StockDef;
  faceZ = 0;
  /** detached (parted-off) piece, if any */
  dropped: { z0: number; cols: number[][] } | null = null;
  /** theoretical Ra (µm) of the outer / bore surface of each column; NaN = raw bar surface */
  raOut = new Float32Array(0);
  raIn = new Float32Array(0);

  constructor(def: StockDef, dz = 0.05) {
    this.def = def;
    this.dz = dz;
    this.reset();
  }

  reset(def?: StockDef) {
    if (def) this.def = def;
    const d = this.def;
    const R = d.diameter / 2;
    const r0 = Math.max(0, d.bore / 2);
    this.faceZ = d.faceAllowance;
    this.z0 = d.faceAllowance - d.length;
    // keep the column count reasonable for very long bars
    this.dz = Math.max(0.02, Math.min(0.2, d.length / 4000));
    this.dz = Math.max(this.dz, 0.025);
    this.n = Math.max(1, Math.round(d.length / this.dz));
    this.dz = d.length / this.n;
    this.cols = new Array(this.n);
    for (let i = 0; i < this.n; i++) this.cols[i] = r0 < R ? [r0, R] : [];
    this.raOut = new Float32Array(this.n).fill(NaN);
    this.raIn = new Float32Array(this.n).fill(NaN);
    this.dropped = null;
    this.version++;
  }

  get radius() {
    return this.def.diameter / 2;
  }
  get boreR() {
    return Math.max(0, this.def.bore / 2);
  }
  get leftZ() {
    return this.z0;
  }
  colZ(i: number) {
    return this.z0 + (i + 0.5) * this.dz;
  }
  colIndex(z: number) {
    return Math.floor((z - this.z0) / this.dz);
  }

  private colRange(zmin: number, zmax: number): [number, number] {
    const i0 = Math.max(0, Math.ceil((zmin - this.z0) / this.dz - 0.5));
    const i1 = Math.min(this.n - 1, Math.floor((zmax - this.z0) / this.dz - 0.5));
    return [i0, i1];
  }

  /** Remove the material covered by a convex polygon. Returns removed volume (mm³). */
  removeConvex(poly: P[], ra = NaN): number {
    const b = polyBounds(poly);
    const [i0, i1] = this.colRange(b.zmin, b.zmax);
    if (i1 < i0) return 0;
    let vol = 0;
    let emptied = false;
    for (let i = i0; i <= i1; i++) {
      const c = this.cols[i];
      if (c.length === 0) continue;
      if (b.xmax < c[0] && b.xmin >= 0) continue; // fast reject: tool fully below material
      const hit = polyColumn(poly, this.colZ(i));
      if (!hit) continue;
      const [a, bb] = toRadial(hit[0], hit[1]);
      if (bb <= c[0] || a >= c[c.length - 1]) continue;
      const out: number[] = [];
      for (let k = 0; k < c.length; k += 2) {
        const lo = c[k], hi = c[k + 1];
        if (bb <= lo || a >= hi) {
          out.push(lo, hi);
          continue;
        }
        const cl = Math.max(lo, a), ch = Math.min(hi, bb);
        vol += Math.PI * (ch * ch - cl * cl) * this.dz;
        if (a > lo + 1e-7) out.push(lo, a);
        if (bb < hi - 1e-7) out.push(bb, hi);
      }
      this.cols[i] = out;
      if (out.length === 0) emptied = true;
      else {
        if (out[out.length - 1] < c[c.length - 1] - 1e-7) this.raOut[i] = ra;
        if (out[0] > c[0] + 1e-7) this.raIn[i] = ra;
      }
    }
    if (vol > 0) this.version++;
    if (emptied) this.checkDetach();
    return vol;
  }

  /** Volume of material that a convex polygon overlaps (no removal). */
  overlapConvex(poly: P[]): number {
    const b = polyBounds(poly);
    const [i0, i1] = this.colRange(b.zmin, b.zmax);
    let vol = 0;
    for (let i = i0; i <= i1; i++) {
      const c = this.cols[i];
      if (c.length === 0) continue;
      const hit = polyColumn(poly, this.colZ(i));
      if (!hit) continue;
      const [a, bb] = toRadial(hit[0], hit[1]);
      for (let k = 0; k < c.length; k += 2) {
        const cl = Math.max(c[k], a), ch = Math.min(c[k + 1], bb);
        if (ch > cl) vol += Math.PI * (ch * ch - cl * cl) * this.dz;
      }
    }
    return vol;
  }

  /** Detect a parted-off piece: anything to the right of an empty column falls off. */
  checkDetach(): boolean {
    let firstEmpty = -1;
    for (let i = 0; i < this.n; i++) {
      if (this.cols[i].length === 0) {
        firstEmpty = i;
        break;
      }
    }
    if (firstEmpty < 0) return false;
    let any = false;
    for (let i = firstEmpty + 1; i < this.n; i++) if (this.cols[i].length) any = true;
    if (!any) return false;
    const piece: number[][] = [];
    let vol = 0;
    for (let i = firstEmpty + 1; i < this.n; i++) {
      const c = this.cols[i];
      for (let k = 0; k < c.length; k += 2) vol += Math.PI * (c[k + 1] ** 2 - c[k] ** 2) * this.dz;
      piece.push(c);
      this.cols[i] = [];
    }
    // tiny crumbs (e.g. the centre pip left when facing just past X0) are flushed away as chips
    if (vol > 2) this.dropped = { z0: this.z0 + (firstEmpty + 1) * this.dz, cols: piece };
    this.version++;
    return true;
  }

  /** outer radius at z (max of intervals) or 0 */
  radiusAt(z: number): number {
    const i = this.colIndex(z);
    if (i < 0 || i >= this.n) return 0;
    const c = this.cols[i];
    return c.length ? c[c.length - 1] : 0;
  }

  /** z of the right-most column with material */
  rightEnd(): number {
    for (let i = this.n - 1; i >= 0; i--) if (this.cols[i].length) return this.z0 + (i + 1) * this.dz;
    return this.z0;
  }

  clone(): Stock {
    const s = Object.create(Stock.prototype) as Stock;
    Object.assign(s, this);
    s.cols = this.cols.map((c) => c.slice());
    s.raOut = this.raOut.slice();
    s.raIn = this.raIn.slice();
    s.bodyCache = null;
    s.dropped = this.dropped ? { z0: this.dropped.z0, cols: this.dropped.cols.map((c) => c.slice()) } : null;
    return s;
  }

  /** the parted-off piece as its own Stock (same column grid), or null */
  droppedStock(): Stock | null {
    if (!this.dropped) return null;
    const s = this.clone();
    const off = Math.round((this.dropped.z0 - this.z0) / this.dz);
    s.cols = this.cols.map(() => []);
    this.dropped.cols.forEach((c, k) => {
      if (off + k < s.n) s.cols[off + k] = c.slice();
    });
    s.dropped = null;
    return s;
  }

  private bodyCache: { v: number; tol: number; b: Body[] } | null = null;
  bodies(tol = 0.002): Body[] {
    const c = this.bodyCache;
    if (c && c.v === this.version && c.tol === tol) return c.b;
    const b = extractBodies(this.cols, this.z0, this.dz, tol);
    this.bodyCache = { v: this.version, tol, b };
    return b;
  }
  droppedBodies(tol = 0.002): Body[] {
    if (!this.dropped) return [];
    return extractBodies(this.dropped.cols, this.dropped.z0, this.dz, tol);
  }
}

function subtractIntervals(lo: number, hi: number, cut: number[]): [number, number][] {
  let parts: [number, number][] = [[lo, hi]];
  for (let k = 0; k < cut.length; k += 2) {
    const a = cut[k], b = cut[k + 1];
    const next: [number, number][] = [];
    for (const [p, q] of parts) {
      if (b <= p || a >= q) next.push([p, q]);
      else {
        if (a > p) next.push([p, a]);
        if (b < q) next.push([b, q]);
      }
    }
    parts = next;
  }
  return parts.filter(([p, q]) => q - p > 1e-6);
}

/** Convert columns into continuous bodies (outline polygons + exposed caps). */
export function extractBodies(cols: number[][], z0: number, dz: number, tol: number): Body[] {
  const n = cols.length;
  const bodies: Body[] = [];
  interface Open {
    top: P[];
    bot: P[];
    caps: Body['caps'];
    lastLo: number;
    lastHi: number;
  }
  let open: (Open | null)[] = [];
  const edge = (i: number) => z0 + i * dz;
  const zc = (i: number) => z0 + (i + 0.5) * dz;

  const close = (o: Open, iEnd: number) => {
    // iEnd = index of the column to the right of the body's last column
    const zE = edge(iEnd);
    o.top.push({ z: zE, x: o.lastHi });
    o.bot.push({ z: zE, x: o.lastLo });
    const right = iEnd < n ? cols[iEnd] : [];
    for (const [a, b] of subtractIntervals(o.lastLo, o.lastHi, right)) o.caps.push({ z: zE, r0: a, r1: b, dir: 1 });
    const top = simplify(o.top, tol);
    const bottom = simplify(o.bot, tol);
    bodies.push({ top, bottom, caps: o.caps, outline: top.concat(bottom.slice().reverse()) });
  };
  const start = (i: number, lo: number, hi: number): Open => {
    const zS = edge(i);
    const left = i > 0 ? cols[i - 1] : [];
    const caps: Body['caps'] = [];
    for (const [a, b] of subtractIntervals(lo, hi, left)) caps.push({ z: zS, r0: a, r1: b, dir: -1 });
    return { top: [{ z: zS, x: hi }], bot: [{ z: zS, x: lo }], caps, lastLo: lo, lastHi: hi };
  };

  for (let i = 0; i < n; i++) {
    const cur = cols[i];
    const m = cur.length / 2;
    const next: (Open | null)[] = new Array(m).fill(null);
    const prev = i > 0 ? cols[i - 1] : [];
    const pm = prev.length / 2;
    // overlap counts
    const pc = new Array(pm).fill(0);
    const cc = new Array(m).fill(0);
    const link = new Array(m).fill(-1);
    for (let a = 0; a < pm; a++) {
      for (let b = 0; b < m; b++) {
        if (prev[2 * a] < cur[2 * b + 1] && cur[2 * b] < prev[2 * a + 1]) {
          pc[a]++;
          cc[b]++;
          link[b] = a;
        }
      }
    }
    const used = new Array(pm).fill(false);
    for (let b = 0; b < m; b++) {
      const a = link[b];
      if (cc[b] === 1 && a >= 0 && pc[a] === 1 && open[a]) {
        next[b] = open[a];
        used[a] = true;
      }
    }
    for (let a = 0; a < pm; a++) if (!used[a] && open[a]) close(open[a]!, i);
    for (let b = 0; b < m; b++) {
      const lo = cur[2 * b], hi = cur[2 * b + 1];
      if (!next[b]) next[b] = start(i, lo, hi);
      const o = next[b]!;
      o.top.push({ z: zc(i), x: hi });
      o.bot.push({ z: zc(i), x: lo });
      o.lastLo = lo;
      o.lastHi = hi;
    }
    open = next;
  }
  for (const o of open) if (o) close(o, n);
  return bodies;
}
