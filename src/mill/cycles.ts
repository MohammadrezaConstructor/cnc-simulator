// Fanuc hole-making canned cycles (G73, G74, G76, G81–G89) for one hole position.
// Everything is in PROGRAM coordinates; the caller transforms and emits.

import type { V3 } from './types';

export type CycleStep =
  | { k: 'move'; type: 'rapid' | 'linear'; to: V3; label: string }
  | { k: 'dwell'; s: number; label: string }
  | { k: 'spindle'; dir: 'cw' | 'ccw' | 'off'; label: string };

export interface HoleParams {
  g: number;
  /** hole position (XY) and current Z */
  x: number;
  y: number;
  zNow: number;
  /** R-plane, final depth (absolute) */
  r: number;
  z: number;
  /** peck depth (G73/G83), bore shift (G76) */
  q: number;
  /** dwell seconds */
  p: number;
  /** level to return to: initial (G98) or R (G99) */
  ret: number;
  /** retract amount for G73 / clearance for G83 */
  d: number;
  /** spindle direction before the cycle (taps reverse it) */
  dir: 'cw' | 'ccw';
}

const pt = (x: number, y: number, z: number): V3 => ({ x, y, z });

export function holeSteps(h: HoleParams): CycleStep[] {
  const out: CycleStep[] = [];
  const name = `G${h.g}`;
  const mv = (type: 'rapid' | 'linear', z: number, label: string) => out.push({ k: 'move', type, to: pt(h.x, h.y, z), label: `${name} ${label}` });
  // 1. position in XY at the current height, 2. rapid to R
  out.push({ k: 'move', type: 'rapid', to: pt(h.x, h.y, h.zNow), label: `${name} position` });
  if (Math.abs(h.zNow - h.r) > 1e-9) mv('rapid', h.r, 'rapid to R plane');
  const down = h.z < h.r ? -1 : 1;
  switch (h.g) {
    case 73:
    case 83: {
      const q = h.q > 0 ? h.q : Math.abs(h.z - h.r);
      let depth = h.r;
      let n = 1;
      for (let guard = 0; guard < 2000; guard++) {
        const target = down < 0 ? Math.max(h.z, depth - q) : Math.min(h.z, depth + q);
        if (h.g === 83 && n > 1) {
          mv('rapid', depth - down * h.d, 'rapid back in');
          mv('linear', target, `peck ${n}`);
        } else mv('linear', target, `peck ${n}`);
        if (Math.abs(target - h.z) < 1e-9) break;
        if (h.g === 73) mv('rapid', target - down * h.d, 'chip break');
        else mv('rapid', h.r, 'retract to R (chip clearing)');
        depth = target;
        n++;
      }
      break;
    }
    case 74:
    case 84: {
      // rigid tapping: feed in, reverse, feed out
      mv('linear', h.z, 'tap in');
      if (h.p > 0) out.push({ k: 'dwell', s: h.p, label: `${name} dwell` });
      const rev = h.dir === 'cw' ? 'ccw' : 'cw';
      out.push({ k: 'spindle', dir: rev, label: `${name} spindle reverse` });
      mv('linear', h.r, 'tap out');
      out.push({ k: 'spindle', dir: h.dir, label: `${name} spindle forward` });
      break;
    }
    case 82:
    case 89:
      mv('linear', h.z, 'feed to depth');
      out.push({ k: 'dwell', s: h.p, label: `${name} dwell` });
      if (h.g === 89) mv('linear', h.r, 'feed out');
      break;
    case 85:
      mv('linear', h.z, 'bore');
      mv('linear', h.r, 'feed out');
      break;
    case 86:
      mv('linear', h.z, 'bore');
      out.push({ k: 'spindle', dir: 'off', label: `${name} spindle stop` });
      mv('rapid', h.r, 'rapid out');
      out.push({ k: 'spindle', dir: h.dir, label: `${name} spindle restart` });
      break;
    case 76:
      mv('linear', h.z, 'fine bore');
      out.push({ k: 'spindle', dir: 'off', label: `${name} oriented stop & shift` });
      mv('rapid', h.r, 'rapid out');
      out.push({ k: 'spindle', dir: h.dir, label: `${name} spindle restart` });
      break;
    default: // 81
      mv('linear', h.z, 'drill');
  }
  // return level
  const zAfter = (out.filter((s) => s.k === 'move').pop() as { to: V3 }).to.z;
  if (Math.abs(h.ret - zAfter) > 1e-9) mv('rapid', h.ret, h.ret === h.r ? 'stay at R (G99)' : 'return to initial level (G98)');
  return out;
}
