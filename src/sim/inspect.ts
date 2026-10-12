// Part inspection: compare the machined stock with a target contour (written as G-code).

import type { MachineSettings, P } from '../types';
import type { Target } from '../content/examples';
import { interpret } from '../gcode/interpreter';
import { discretize, deg } from './geom';
import type { Stock } from './stock';

export function contourFromGcode(src: string, machine: MachineSettings): P[] {
  const res = interpret('G18 G21 G99 F1\n' + src, {
    tools: [],
    offsets: new Map(),
    machine,
    workOffsets: {},
    blockSkip: false,
    hints: false,
  });
  const pts: P[] = [];
  let started = false;
  for (const op of res.ops) {
    if (op.kind !== 'move') continue;
    if (!started) {
      // the first move only positions the start of the contour
      pts.push({ ...op.to });
      started = true;
      continue;
    }
    const d = discretize(op, deg(1));
    d.shift();
    pts.push(...d);
  }
  return pts;
}

export interface Deviation {
  z: number;
  r: number;
  /** diameter deviation (+ = material left / oversize, − = gouge / undersize) */
  dev: number;
  inner: boolean;
  /** theoretical Ra (µm) of the surface, NaN = raw bar surface */
  ra: number;
}

export interface RaZone {
  z0: number;
  z1: number;
  ra: number;
  inner: boolean;
}

export interface CheckResult {
  pass: boolean;
  maxOver: number;
  maxUnder: number;
  faceDev: number | null;
  samples: Deviation[];
  summary: string[];
  outer: P[];
  inner: P[];
  /** surface finish zones along the inspected surfaces */
  raZones: RaZone[];
  /** worst theoretical Ra (µm) on the inspected surfaces */
  raMax: number;
  /** false when a required Ra is not met */
  raOk: boolean;
}

function radiusOnContour(poly: P[], z: number, pick: 'max' | 'min'): number | null {
  let best: number | null = null;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    if ((z < a.z && z < b.z) || (z > a.z && z > b.z)) continue;
    if (Math.abs(b.z - a.z) < 1e-9) continue;
    const t = (z - a.z) / (b.z - a.z);
    const x = a.x + (b.x - a.x) * t;
    if (best === null || (pick === 'max' ? x > best : x < best)) best = x;
  }
  return best;
}

/**
 * Z positions of concave (inside) corners. A turning tool always leaves a fillet of its
 * nose radius there, so the check ignores a small zone around them.
 * Outer contours run from the face towards the chuck with material on the left, so a right
 * turn (negative cross product) is an inside corner; for bores it is the opposite.
 */
function concaveCorners(poly: P[], inner: boolean): number[] {
  const out: number[] = [];
  for (let i = 1; i < poly.length - 1; i++) {
    const a = poly[i - 1], b = poly[i], c = poly[i + 1];
    const d1 = { z: b.z - a.z, x: b.x - a.x };
    const d2 = { z: c.z - b.z, x: c.x - b.x };
    const l1 = Math.hypot(d1.z, d1.x), l2 = Math.hypot(d2.z, d2.x);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const cr = (d1.z * d2.x - d1.x * d2.z) / (l1 * l2);
    if ((inner ? cr : -cr) > Math.sin((5 * Math.PI) / 180)) out.push(b.z);
  }
  return out;
}

function nearStep(poly: P[], z: number, tol: number): boolean {
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const steep = Math.abs(b.x - a.x) > 4 * Math.abs(b.z - a.z);
    if (!steep) continue;
    const lo = Math.min(a.z, b.z) - tol, hi = Math.max(a.z, b.z) + tol;
    if (z >= lo && z <= hi) return true;
  }
  return false;
}

/** zone (mm in Z) ignored around inside corners – covers nose radii up to 0.8 mm */
const CORNER_ZONE = 0.9;

export function checkPart(machined: Stock, target: Target, machine: MachineSettings): CheckResult {
  // after a part-off the finished part is the piece that dropped into the catcher
  const stock = machined.droppedStock() ?? machined;
  const outer = contourFromGcode(target.outer, machine);
  const inner = target.inner ? contourFromGcode(target.inner, machine) : [];
  const samples: Deviation[] = [];
  let maxOver = 0, maxUnder = 0;
  const skip = 0.12 + stock.dz;
  const ignored = (z: number) => (target.ignore ?? []).some(([a, b]) => z >= Math.min(a, b) && z <= Math.max(a, b));

  const scan = (poly: P[], isInner: boolean) => {
    if (poly.length < 2) return;
    let zmin = Infinity, zmax = -Infinity;
    for (const p of poly) {
      zmin = Math.min(zmin, p.z);
      zmax = Math.max(zmax, p.z);
    }
    const corners = concaveCorners(poly, isInner);
    for (let i = 0; i < stock.n; i++) {
      const z = stock.colZ(i);
      if (z < zmin + skip || z > zmax - skip) continue;
      if (ignored(z) || nearStep(poly, z, skip)) continue;
      if (corners.some((cz) => Math.abs(cz - z) < CORNER_ZONE)) continue;
      const tr = radiusOnContour(poly, z, isInner ? 'min' : 'max');
      if (tr === null) continue;
      const c = stock.cols[i];
      let dev: number;
      if (!isInner) {
        const mr = c.length ? c[c.length - 1] : 0;
        dev = (mr - tr) * 2;
      } else {
        // bore surface = lower bound of the interval that contains/lies above the target radius
        let lo = Infinity;
        for (let k = 0; k < c.length; k += 2) if (c[k + 1] > tr - 2) lo = Math.min(lo, c[k]);
        if (!isFinite(lo)) lo = tr;
        dev = (tr - lo) * 2;
      }
      samples.push({ z, r: tr, dev, inner: isInner, ra: isInner ? stock.raIn[i] : stock.raOut[i] });
      maxOver = Math.max(maxOver, dev);
      maxUnder = Math.min(maxUnder, dev);
    }
  };
  scan(outer, false);
  scan(inner, true);

  // front face position
  let faceDev: number | null = null;
  const all = outer.concat(inner);
  if (all.length) {
    const zFront = Math.max(...all.map((p) => p.z));
    faceDev = stock.rightEnd() - zFront;
  }
  const tol = target.tol;
  const summary: string[] = [];
  // surface finish zones
  const raZones: RaZone[] = [];
  let raMax = 0;
  for (const s of samples) {
    const ra = Number.isNaN(s.ra) ? NaN : Math.round(s.ra * 100) / 100;
    if (!Number.isNaN(ra)) raMax = Math.max(raMax, ra);
    const last = raZones[raZones.length - 1];
    const same = last && last.inner === s.inner && Math.abs(last.z1 - s.z) < 0.5 && (Number.isNaN(ra) ? Number.isNaN(last.ra) : Math.abs(last.ra - ra) < 0.02);
    if (same) last.z1 = s.z;
    else raZones.push({ z0: s.z, z1: s.z, ra, inner: s.inner });
  }
  const raw = samples.some((s) => Number.isNaN(s.ra));
  const raOk = target.ra === undefined || (!raw && raMax <= target.ra + 1e-9);
  const pass = raOk && maxOver <= tol + 1e-6 && -maxUnder <= tol + 1e-6 && (faceDev === null || Math.abs(faceDev) <= Math.max(tol, stock.dz * 1.5));
  summary.push(`Tolerance ±${tol} mm on diameter`);
  summary.push(`Max. material left (oversize): ${maxOver.toFixed(3)} mm`);
  summary.push(`Max. gouge (undersize): ${(-maxUnder).toFixed(3)} mm`);
  if (faceDev !== null) summary.push(`Front face: ${faceDev >= 0 ? '+' : ''}${faceDev.toFixed(3)} mm from target`);
  if (samples.length) summary.push(`Surface finish: worst theoretical Ra ${raMax.toFixed(2)} µm${raw ? ' (some surfaces are still raw bar)' : ''}${target.ra !== undefined ? ` – required Ra ≤ ${target.ra} µm ${raOk ? '✔' : '✘'}` : ''}`);
  if (samples.length === 0) summary.push('Nothing to compare – is the part machined?');
  return { pass: pass && samples.length > 0, maxOver, maxUnder, faceDev, samples, summary, outer, inner, raZones, raMax, raOk };
}

const g3 = (v: number) => String(Math.round(v * 1000) / 1000);

/** Inspection target (G-code contours) taken from the machined part – for building exercises. */
export function targetFromStock(machined: Stock): { outer: string; inner: string } {
  const st = machined.droppedStock() ?? machined;
  const held = machined.dropped ? -Infinity : machined.leftZ + Math.min(machined.def.gripLength, machined.def.length - 1) + 1;
  const bodies = st.bodies(0.004);
  if (!bodies.length) return { outer: '', inner: '' };
  // the body that reaches furthest towards +Z is the part
  const body = bodies.reduce((a, b) => (Math.max(...b.top.map((p) => p.z)) > Math.max(...a.top.map((p) => p.z)) ? b : a));
  const toG = (pts: P[]) => {
    const out: string[] = [];
    let last: P | null = null;
    for (const p of pts) {
      if (last && Math.abs(last.x - p.x) < 5e-4 && Math.abs(last.z - p.z) < 5e-4) continue;
      out.push(`${out.length ? 'G01' : 'G00'} X${g3(p.x * 2)} Z${g3(p.z)}`);
      last = p;
    }
    return out.length > 1 ? out.join('\n') : '';
  };
  // walk from the face towards the chuck and clip where the jaws hold the bar
  const clip = (pts: P[], stopAtAxis: boolean) => {
    const out: P[] = [];
    for (const p of pts) {
      if (stopAtAxis && p.x < 0.05) break;
      if (p.z < held) {
        const a = out[out.length - 1];
        if (a && a.z > held) out.push({ z: held, x: a.x + ((held - a.z) / (p.z - a.z)) * (p.x - a.x) });
        break;
      }
      out.push(p);
    }
    return out;
  };
  const outer = clip(body.top.slice().reverse(), false);
  const inner = clip(body.bottom.slice().reverse(), true);
  return { outer: toG(outer), inner: inner.length > 2 ? toG(inner) : '' };
}
