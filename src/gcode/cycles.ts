// Canned-cycle expansion (Fanuc lathe, "two-block" 0i/30i style).
// All functions work in PROGRAMMED coordinates (radius x, z) and return primitive moves.

import type { MoveOp, P } from '../types';
import { discretize, deg } from '../sim/geom';

export interface CMove {
  type: 'rapid' | 'linear' | 'arc' | 'thread';
  to: P;
  center?: P;
  cw?: boolean;
  label?: string;
}

/** A segment of a captured finishing profile (G70–G73 P..Q blocks). */
export interface Seg {
  type: 'rapid' | 'linear' | 'arc';
  from: P;
  to: P;
  center?: P;
  cw?: boolean;
  line: number;
}

const P_ = (x: number, z: number): P => ({ x, z });

// ---------------------------------------------------------------- simple box cycles

/** G90 – OD/ID turning cycle. r = taper (radius at start-of-cut minus radius at end). */
export function g90(s: P, x1: number, z1: number, r: number): CMove[] {
  return [
    { type: 'rapid', to: P_(x1 + r, s.z), label: 'G90 ① rapid in' },
    { type: 'linear', to: P_(x1, z1), label: 'G90 ② cut' },
    { type: 'linear', to: P_(s.x, z1), label: 'G90 ③ face out' },
    { type: 'rapid', to: P_(s.x, s.z), label: 'G90 ④ rapid return' },
  ];
}

/** G94 – facing cycle. r = taper in Z (z at start x minus z at end x). */
export function g94(s: P, x1: number, z1: number, r: number): CMove[] {
  return [
    { type: 'rapid', to: P_(s.x, z1 + r), label: 'G94 ① rapid in' },
    { type: 'linear', to: P_(x1, z1), label: 'G94 ② face cut' },
    { type: 'linear', to: P_(x1, s.z), label: 'G94 ③ pull out' },
    { type: 'rapid', to: P_(s.x, s.z), label: 'G94 ④ rapid return' },
  ];
}

/** G92 – simple threading cycle (one pass). */
export function g92(s: P, x1: number, z1: number, r: number): CMove[] {
  return [
    { type: 'rapid', to: P_(x1 + r, s.z), label: 'G92 ① rapid to depth' },
    { type: 'thread', to: P_(x1, z1), label: 'G92 ② thread pass' },
    { type: 'rapid', to: P_(s.x, z1), label: 'G92 ③ rapid out' },
    { type: 'rapid', to: P_(s.x, s.z), label: 'G92 ④ rapid return' },
  ];
}

// ---------------------------------------------------------------- threading G76

export interface G76Params {
  /** root (minor for OD / major for ID) radius at the end point */
  x1: number;
  z1: number;
  /** taper (radius difference start − end) */
  i: number;
  /** thread height (radius, mm) */
  k: number;
  /** first depth of cut (radius, mm) */
  d1: number;
  /** minimum depth of cut (mm) */
  dmin: number;
  /** finishing allowance (mm) */
  fin: number;
  /** number of finishing passes */
  m: number;
  /** tool angle (deg) */
  angle: number;
  /** thread run-out chamfer length in Z (rr × 0.1 × lead), 0 = none */
  chamfer?: number;
}

export function g76(s: P, p: G76Params): { moves: CMove[]; passes: number[] } {
  const ext = p.x1 < s.x ? 1 : -1; // external thread: tool sits above the root
  const depths: number[] = [];
  const roughLimit = Math.max(0, p.k - p.fin);
  let n = 1;
  let prev = 0;
  while (depths.length < 200) {
    let d = p.d1 * Math.sqrt(n);
    if (d - prev < p.dmin) d = prev + p.dmin;
    if (d >= roughLimit - 1e-9) break;
    depths.push(d);
    prev = d;
    n++;
  }
  if (p.fin > 0 || depths.length === 0 || depths[depths.length - 1] < roughLimit) {
    if (roughLimit > 0 && (depths.length === 0 || depths[depths.length - 1] < roughLimit - 1e-9)) depths.push(roughLimit);
  }
  for (let i = 0; i < Math.max(1, p.m); i++) depths.push(p.k);

  const tanH = Math.tan(deg(p.angle / 2));
  const moves: CMove[] = [];
  depths.forEach((d, idx) => {
    const h = p.k - d; // remaining height above the root
    const dz = h * tanH; // flank infeed shift
    const label = `G76 pass ${idx + 1}/${depths.length} depth ${(d * 2).toFixed(3)} (dia)`;
    moves.push({ type: 'rapid', to: P_(p.x1 + p.i + ext * h, s.z + dz), label });
    const c = p.chamfer ?? 0;
    const zdir = Math.sign(p.z1 - s.z) || -1;
    if (c > 1e-6 && c < Math.abs(p.z1 - s.z)) {
      // 45° pull-out over the last c mm (thread run-out chamfer)
      const xc = p.x1 + ext * h + p.i * (c / Math.abs(p.z1 - s.z));
      moves.push({ type: 'thread', to: P_(xc, p.z1 - zdir * c), label });
      moves.push({ type: 'thread', to: P_(xc + ext * c, p.z1), label: 'G76 run-out chamfer' });
    } else moves.push({ type: 'thread', to: P_(p.x1 + ext * h, p.z1), label });
    moves.push({ type: 'rapid', to: P_(s.x, p.z1), label: 'G76 rapid out' });
    moves.push({ type: 'rapid', to: P_(s.x, s.z), label: 'G76 rapid return' });
  });
  return { moves, passes: depths };
}

// ---------------------------------------------------------------- peck cycles G74 / G75

/** G74 – face (Z-axis) peck drilling / face grooving. */
export function g74(s: P, x1: number, z1: number, dxStep: number, dzPeck: number, e: number): CMove[] {
  const out: CMove[] = [];
  const zdir = z1 < s.z ? -1 : 1;
  const xs: number[] = [];
  if (Math.abs(x1 - s.x) < 1e-6 || dxStep <= 0) xs.push(s.x);
  else {
    const xdir = x1 < s.x ? -1 : 1;
    for (let x = s.x; xdir * (x1 - x) > -1e-9; x += xdir * dxStep) xs.push(x);
    if (Math.abs(xs[xs.length - 1] - x1) > 1e-6) xs.push(x1);
  }
  xs.forEach((x, xi) => {
    if (xi > 0) out.push({ type: 'rapid', to: P_(x, s.z), label: 'G74 shift X' });
    let depth = s.z;
    let peck = 1;
    for (;;) {
      const target = dzPeck > 0 ? (zdir < 0 ? Math.max(z1, depth - dzPeck) : Math.min(z1, depth + dzPeck)) : z1;
      out.push({ type: 'linear', to: P_(x, target), label: `G74 peck ${peck}` });
      if (Math.abs(target - z1) < 1e-9) break;
      out.push({ type: 'rapid', to: P_(x, target - zdir * e), label: 'G74 chip break' });
      depth = target;
      peck++;
      if (peck > 2000) break;
    }
    out.push({ type: 'rapid', to: P_(x, s.z), label: 'G74 retract' });
  });
  if (xs.length > 1 || Math.abs(xs[0] - s.x) > 1e-9) out.push({ type: 'rapid', to: P_(s.x, s.z), label: 'G74 return' });
  return out;
}

/** G75 – OD/ID (X-axis) peck grooving. */
export function g75(s: P, x1: number, z1: number, dxPeck: number, dzStep: number, e: number): CMove[] {
  const out: CMove[] = [];
  const xdir = x1 < s.x ? -1 : 1;
  const zs: number[] = [];
  if (Math.abs(z1 - s.z) < 1e-6 || dzStep <= 0) zs.push(s.z);
  else {
    const zdir = z1 < s.z ? -1 : 1;
    for (let z = s.z; zdir * (z1 - z) > -1e-9; z += zdir * dzStep) zs.push(z);
    if (Math.abs(zs[zs.length - 1] - z1) > 1e-6) zs.push(z1);
  }
  zs.forEach((z, zi) => {
    if (zi > 0) out.push({ type: 'rapid', to: P_(s.x, z), label: 'G75 shift Z' });
    let depth = s.x;
    let peck = 1;
    for (;;) {
      const target = dxPeck > 0 ? (xdir < 0 ? Math.max(x1, depth - dxPeck) : Math.min(x1, depth + dxPeck)) : x1;
      out.push({ type: 'linear', to: P_(target, z), label: `G75 groove ${zi + 1} peck ${peck}` });
      if (Math.abs(target - x1) < 1e-9) break;
      out.push({ type: 'rapid', to: P_(target - xdir * e, z), label: 'G75 chip break' });
      depth = target;
      peck++;
      if (peck > 2000) break;
    }
    out.push({ type: 'rapid', to: P_(s.x, z), label: 'G75 retract' });
  });
  if (zs.length > 1 || Math.abs(zs[0] - s.z) > 1e-9) out.push({ type: 'rapid', to: P_(s.x, s.z), label: 'G75 return' });
  return out;
}

// ---------------------------------------------------------------- profile helpers

export function shiftSeg(sg: Seg, dx: number, dz: number): Seg {
  const sh = (p: P): P => ({ x: p.x + dx, z: p.z + dz });
  return { ...sg, from: sh(sg.from), to: sh(sg.to), center: sg.center ? sh(sg.center) : undefined };
}

function segToMove(sg: Seg): MoveOp {
  return {
    kind: 'move',
    type: sg.type === 'arc' ? 'arc' : 'linear',
    from: sg.from,
    to: sg.to,
    center: sg.center,
    cw: sg.cw,
    feed: 0,
    feedPerRev: true,
    spindle: { mode: 'rpm', s: 0, maxRpm: 0, dir: 'off' },
    line: sg.line,
    tool: 0,
  };
}

export function profilePolyline(segs: Seg[]): P[] {
  const pts: P[] = [];
  for (const sg of segs) {
    const d = discretize(segToMove(sg), deg(1));
    if (pts.length) d.shift();
    pts.push(...d);
  }
  return pts;
}

/** Is a profile monotonic along an axis (allowing flats)? */
export function isMonotonic(pts: P[], axis: 'x' | 'z'): boolean {
  let sign = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i][axis] - pts[i - 1][axis];
    if (Math.abs(d) < 1e-6) continue;
    const s = Math.sign(d);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface RoughParams {
  /** depth of cut per level (radius for G71, Z for G72) */
  d: number;
  /** retract amount */
  e: number;
  /** finishing allowance X (DIAMETER, as programmed) */
  du: number;
  /** finishing allowance Z */
  dw: number;
  /** 'x' = G71 (levels in X, cut along Z), 'z' = G72 (levels in Z, cut along X) */
  axis: 'x' | 'z';
  /** approach the profile start with feed instead of rapid (ns block was G01) */
  feedApproach: boolean;
  /** type II: the profile may contain pockets (both axes in the first profile block) */
  typeII?: boolean;
}

/** contour semi-finish pass + retract, shared by type I and II */
function contourPass(s: P, contour: Seg[], last: P, p: RoughParams, name: string, U: (q: P) => number, mk: (u: number, v: number) => P, ld: number, sv: number): CMove[] {
  const out: CMove[] = [];
  out.push({ type: 'rapid', to: { ...contour[0].from }, label: `${name} contour pass approach` });
  for (const sg of contour) {
    out.push({
      type: sg.type === 'arc' ? 'arc' : sg.type === 'rapid' ? 'rapid' : 'linear',
      to: sg.to,
      center: sg.center,
      cw: sg.cw,
      label: `${name} contour pass (allowance U${p.du} W${p.dw})`,
    });
  }
  const su = U(s);
  const startIsOutside = (su - U(last)) * -ld >= 0;
  const via = startIsOutside ? mk(su, p.axis === 'x' ? last.z : last.x) : mk(U(last), sv);
  out.push({ type: 'rapid', to: via, label: `${name} retract` });
  out.push({ type: 'rapid', to: { ...s }, label: `${name} return to start` });
  return out;
}

/**
 * Type II roughing: at every level all intervals where the profile lies below the level line are cut.
 * Pockets are entered from above through material that higher levels have already removed.
 */
function roughTypeII(
  s: P, contour: Seg[], poly: P[], p: RoughParams, name: string,
  U: (q: P) => number, V: (q: P) => number, mk: (u: number, v: number) => P,
  cd: number, ld: number, extreme: number, warn: (m: string) => void,
): CMove[] {
  const su = U(s), sv = V(s);
  const vFirst = V(poly[0]), vLast = V(poly[poly.length - 1]);
  const profileAt = (v: number): number | null => {
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const va = V(a), vb = V(b);
      if (Math.abs(vb - va) < 1e-12) continue;
      if ((v - va) * (v - vb) <= 0) return U(a) + ((v - va) / (vb - va)) * (U(b) - U(a));
    }
    return null;
  };
  const out: CMove[] = [];
  const levels: number[] = [];
  for (let k = 1; k < 5000; k++) {
    const u = su + ld * k * p.d;
    if (ld < 0 ? u <= extreme + 1e-6 : u >= extreme - 1e-6) break;
    levels.push(u);
  }
  if (!levels.length) warn(`${name}: start point is already inside the profile – no roughing levels generated`);
  levels.forEach((u, idx) => {
    // breakpoints along the cut axis
    const bps = new Set<number>([vFirst, vLast]);
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const ua = U(a), ub = U(b);
      if (Math.abs(ua - ub) < 1e-12) continue;
      if ((ua - u) * (ub - u) <= 0) bps.add(V(a) + ((u - ua) / (ub - ua)) * (V(b) - V(a)));
    }
    const sorted = Array.from(bps).sort((x, y) => (x - y) * -cd); // in cut direction
    const regions: { a: number; b: number }[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const va = sorted[i - 1], vb = sorted[i];
      if (Math.abs(vb - va) < 1e-6) continue;
      const pu = profileAt((va + vb) / 2);
      if (pu === null || (u - pu) * -ld <= 1e-9) continue;
      const lastR = regions[regions.length - 1];
      if (lastR && Math.abs(lastR.b - va) < 1e-6) lastR.b = vb;
      else regions.push({ a: va, b: vb });
    }
    const label = `${name} rough level ${idx + 1}/${levels.length}`;
    const uPrev = idx === 0 ? su : levels[idx - 1];
    regions.forEach((r, k) => {
      const fromFront = Math.abs(r.a - vFirst) < 1e-6;
      if (fromFront) {
        out.push({ type: p.feedApproach ? 'linear' : 'rapid', to: mk(u, sv), label });
      } else {
        // pocket: go up to the start X, along, down to the previous level, then feed in
        out.push({ type: 'rapid', to: mk(su, sv), label: `${name} pocket approach` });
        out.push({ type: 'rapid', to: mk(su, r.a), label: `${name} pocket approach` });
        out.push({ type: 'rapid', to: mk(uPrev, r.a), label: `${name} pocket approach` });
        out.push({ type: 'linear', to: mk(u, r.a), label: `${name} pocket plunge` });
      }
      out.push({ type: 'linear', to: mk(u, r.b), label: k ? `${label} · pocket ${k}` : label });
      out.push({ type: 'linear', to: mk(u - ld * p.e, r.b - cd * p.e), label: `${name} 45° retract` });
      out.push({ type: 'rapid', to: mk(su, r.b - cd * p.e), label: `${name} retract` });
    });
    if (regions.length) out.push({ type: 'rapid', to: mk(su, sv), label: `${name} return` });
  });
  return out.concat(contourPass(s, contour, poly[poly.length - 1], p, name, U, mk, ld, sv));
}

/**
 * G71 / G72 stock removal.
 * `segs[0]` is the ns approach move from the start point; the rest is the finished contour.
 */
export function roughCycle(s: P, segs: Seg[], p: RoughParams, warn: (m: string) => void): CMove[] {
  const name = p.axis === 'x' ? 'G71' : 'G72';
  const U = (q: P) => (p.axis === 'x' ? q.x : q.z);
  const V = (q: P) => (p.axis === 'x' ? q.z : q.x);
  const mk = (u: number, v: number): P => (p.axis === 'x' ? { x: u, z: v } : { x: v, z: u });

  const shifted = segs.map((sg) => shiftSeg(sg, p.du / 2, p.dw));
  const contour = shifted.slice(1);
  if (contour.length === 0) {
    warn(`${name}: the finishing profile has no contour moves after the first block`);
    return [];
  }
  const poly = profilePolyline(contour);
  const first = poly[0];
  const last = poly[poly.length - 1];
  const su = U(s);
  const sv = V(s);
  let cd = Math.sign(V(last) - V(first));
  if (cd === 0) cd = -1;
  let minU = Infinity, maxU = -Infinity;
  for (const q of poly) {
    minU = Math.min(minU, U(q));
    maxU = Math.max(maxU, U(q));
  }
  const ld = minU < su ? -1 : 1;
  const extreme = ld < 0 ? minU : maxU;

  const monoCut = isMonotonic(poly, p.axis === 'x' ? 'z' : 'x');
  const monoLevel = isMonotonic(poly, p.axis);
  if (p.typeII && !monoCut) {
    throw new Error(`${name} type II: the profile must still run in one direction along ${p.axis === 'x' ? 'Z' : 'X'}`);
  } else if (!p.typeII && (!monoCut || !monoLevel)) {
    throw new Error(
      `${name} type I needs a monotonic profile, but this one has a pocket/undercut (Fanuc alarm PS0064). ` +
        `Use type II by adding ${p.axis === 'x' ? 'W0 (or Z)' : 'U0 (or X)'} to the first profile block, or rough it with G73.`,
    );
  }
  if (p.typeII) return roughTypeII(s, contour, poly, p, name, U, V, mk, cd, ld, extreme, warn);

  const out: CMove[] = [];
  const levels: number[] = [];
  for (let k = 1; k < 5000; k++) {
    const u = su + ld * k * p.d;
    if (ld < 0 ? u <= extreme + 1e-6 : u >= extreme - 1e-6) break;
    levels.push(u);
  }
  if (levels.length === 0) warn(`${name}: start point is already inside the profile – no roughing levels generated`);

  levels.forEach((u, idx) => {
    // first profile crossing from the start face in the cut direction
    let best: number | null = null;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1];
      const b = poly[i];
      const ua = U(a), ub = U(b);
      let cands: number[] = [];
      if (Math.abs(ua - ub) < 1e-12) {
        if (Math.abs(ua - u) < 1e-9) cands = [V(a), V(b)];
      } else if ((ua - u) * (ub - u) <= 0) {
        const t = (u - ua) / (ub - ua);
        cands = [V(a) + t * (V(b) - V(a))];
      }
      for (const v of cands) {
        const ahead = (v - sv) * cd;
        if (ahead > 1e-9 && (best === null || ahead < (best - sv) * cd)) best = v;
      }
    }
    const vEnd = best ?? V(last);
    if ((vEnd - sv) * cd <= 1e-6) return;
    const label = `${name} rough level ${idx + 1}/${levels.length}`;
    out.push({ type: p.feedApproach ? 'linear' : 'rapid', to: mk(u, sv), label });
    out.push({ type: 'linear', to: mk(u, vEnd), label });
    out.push({ type: 'linear', to: mk(u - ld * p.e, vEnd - cd * p.e), label: `${name} 45° retract` });
    out.push({ type: 'rapid', to: mk(u - ld * p.e, sv), label: `${name} return` });
  });

  // final semi-finish pass along the offset contour
  out.push({ type: 'rapid', to: { ...contour[0].from }, label: `${name} contour pass approach` });
  for (const sg of contour) {
    out.push({
      type: sg.type === 'arc' ? 'arc' : sg.type === 'rapid' ? 'rapid' : 'linear',
      to: sg.to,
      center: sg.center,
      cw: sg.cw,
      label: `${name} contour pass (allowance U${p.du} W${p.dw})`,
    });
  }
  // Retract: if the start point lies further "outside" (away from the part) than the contour end,
  // move the level axis first, otherwise travel along the cut axis first (stays in already-cut air).
  const startIsOutside = (su - U(last)) * -ld >= 0;
  const via = startIsOutside ? mk(su, V(last)) : mk(U(last), sv);
  out.push({ type: 'rapid', to: via, label: `${name} retract` });
  out.push({ type: 'rapid', to: { ...s }, label: `${name} return to start` });
  return out;
}

/** G73 – pattern repeating (for cast/forged pre-forms). */
export function g73(
  s: P,
  segs: Seg[],
  reliefX: number,
  reliefZ: number,
  divisions: number,
  du: number,
  dw: number,
): CMove[] {
  const out: CMove[] = [];
  const n = Math.max(1, Math.round(divisions));
  for (let k = 1; k <= n; k++) {
    const f = n === 1 ? 0 : (n - k) / (n - 1);
    const ox = reliefX * f + du / 2;
    const oz = reliefZ * f + dw;
    const label = `G73 pass ${k}/${n}`;
    segs.forEach((sg, i) => {
      const sh = shiftSeg(sg, ox, oz);
      out.push({
        type: i === 0 ? 'rapid' : sh.type === 'arc' ? 'arc' : sh.type === 'rapid' ? 'rapid' : 'linear',
        to: sh.to,
        center: sh.center,
        cw: sh.cw,
        label,
      });
    });
    const last = shiftSeg(segs[segs.length - 1], ox, oz).to;
    // retract outward first, then back to start
    const outwardX = reliefX >= 0 ? Math.max(s.x, last.x) : Math.min(s.x, last.x);
    out.push({ type: 'rapid', to: { x: outwardX, z: last.z }, label: 'G73 retract' });
    out.push({ type: 'rapid', to: { ...s }, label: 'G73 return' });
  }
  return out;
}
