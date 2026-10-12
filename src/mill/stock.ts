// Height-map (Z-map) material model of a rectangular block for 3-axis vertical milling.
// Every grid cell stores the top height of the material above it. A tool removes material
// by lowering cells to tip.z + envelope(distance from the tool axis).

import type { BlockStock, MillTool, V3 } from './types';
import { envelope } from './tools';

export interface Rect {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

/** Where the block lies in work coordinates for a given work-zero choice:
 *  min corner (x0, y0), raw top, finished top (after facing) and bottom. */
export function blockFrame(d: BlockStock) {
  const o = d.origin;
  const x0 = o === 'center' ? -d.sizeX / 2 : o === 'front-right' || o === 'back-right' ? -d.sizeX : 0;
  const y0 = o === 'center' ? -d.sizeY / 2 : o === 'back-left' || o === 'back-right' ? -d.sizeY : 0;
  const top = d.zRef === 'raw' ? 0 : d.topAllowance;
  return { x0, y0, x1: x0 + d.sizeX, y1: y0 + d.sizeY, top, finished: top - d.topAllowance, bottom: top - d.sizeZ };
}

export const ORIGIN_NAMES: Record<BlockStock['origin'], string> = {
  corner: 'front left corner',
  'front-right': 'front right corner',
  'back-left': 'back left corner',
  'back-right': 'back right corner',
  center: 'centre of the block',
};

export class BlockModel {
  def: BlockStock;
  /** min corner of the block in work coordinates */
  x0 = 0;
  y0 = 0;
  nx = 0;
  ny = 0;
  /** cell size (mm) */
  c = 0.25;
  top = 0;
  bottom = 0;
  h = new Float32Array(0);
  /** id of the last tool that cut each cell (0 = raw surface) */
  cutBy = new Uint8Array(0);
  version = 0;
  /** changed cells since each consumer (2D view, 3D view…) last looked */
  private dirtyBy = new Map<string, Rect | null>();

  constructor(def: BlockStock, maxCells = 160000) {
    this.def = def;
    this.reset(def, maxCells);
  }

  reset(def?: BlockStock, maxCells = 160000) {
    if (def) this.def = def;
    const d = this.def;
    const g = blockFrame(d);
    this.x0 = g.x0;
    this.y0 = g.y0;
    this.top = g.top;
    this.bottom = g.bottom;
    let c = Math.max(0.1, Math.sqrt((d.sizeX * d.sizeY) / maxCells));
    c = Math.ceil(c * 100) / 100;
    this.c = c;
    this.nx = Math.max(2, Math.round(d.sizeX / c));
    this.ny = Math.max(2, Math.round(d.sizeY / c));
    this.c = d.sizeX / this.nx; // exact fit in X (Y within half a cell)
    this.h = new Float32Array(this.nx * this.ny).fill(this.top);
    this.cutBy = new Uint8Array(this.nx * this.ny);
    for (const k of this.dirtyBy.keys()) this.dirtyBy.set(k, { i0: 0, i1: this.nx - 1, j0: 0, j1: this.ny - 1 });
    this.version++;
  }

  get x1() {
    return this.x0 + this.nx * this.c;
  }
  get y1() {
    return this.y0 + this.ny * this.c;
  }
  cx(i: number) {
    return this.x0 + (i + 0.5) * this.c;
  }
  cy(j: number) {
    return this.y0 + (j + 0.5) * this.c;
  }
  heightAt(x: number, y: number): number | null {
    const i = Math.floor((x - this.x0) / this.c), j = Math.floor((y - this.y0) / this.c);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return null;
    return this.h[j * this.nx + i];
  }

  private markDirty(i0: number, i1: number, j0: number, j1: number) {
    for (const [k, d] of this.dirtyBy) {
      if (!d) this.dirtyBy.set(k, { i0, i1, j0, j1 });
      else {
        d.i0 = Math.min(d.i0, i0);
        d.i1 = Math.max(d.i1, i1);
        d.j0 = Math.min(d.j0, j0);
        d.j1 = Math.max(d.j1, j1);
      }
    }
  }

  /**
   * Sweep the tool along a straight segment with constant (or nearly constant) height.
   * Exact for any tool whose envelope grows with the radius: the lowest point the tool reaches
   * over a cell is tip.z + envelope(distance from the cell to the segment).
   * Returns the removed volume in mm³.
   */
  sweepLevel(t: MillTool, a: V3, b: V3, toolId: number): number {
    const R = t.diameter / 2;
    const z = Math.min(a.z, b.z);
    if (z >= this.top - 1e-9) return 0;
    const xmin = Math.min(a.x, b.x) - R, xmax = Math.max(a.x, b.x) + R;
    const ymin = Math.min(a.y, b.y) - R, ymax = Math.max(a.y, b.y) + R;
    if (xmax < this.x0 || xmin > this.x1 || ymax < this.y0 || ymin > this.y1) return 0;
    const c = this.c;
    const i0 = Math.max(0, Math.floor((xmin - this.x0) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((xmax - this.x0) / c));
    const j0 = Math.max(0, Math.floor((ymin - this.y0) / c));
    const j1 = Math.min(this.ny - 1, Math.floor((ymax - this.y0) / c));
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const flat = t.type === 'flat' || t.type === 'tap' || t.type === 'ream';
    let vol = 0;
    let touched = false;
    const area = c * c;
    for (let j = j0; j <= j1; j++) {
      const py = this.y0 + (j + 0.5) * c;
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const k = row + i;
        const hk = this.h[k];
        if (hk <= z) continue;
        const px = this.x0 + (i + 0.5) * c;
        let tt = L2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / L2 : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const qx = a.x + dx * tt - px, qy = a.y + dy * tt - py;
        const d2 = qx * qx + qy * qy;
        if (d2 > R * R) continue;
        const nz = flat ? z : z + envelope(t, Math.sqrt(d2));
        if (nz >= hk) continue;
        const nh = nz < this.bottom ? this.bottom : nz;
        vol += (hk - nh) * area;
        this.h[k] = nh;
        this.cutBy[k] = toolId;
        touched = true;
      }
    }
    if (touched) {
      this.markDirty(i0, i1, j0, j1);
      this.version++;
    }
    return vol;
  }

  /** Remove material along an arbitrary 3D segment (ramps, plunges) by sub-dividing it. */
  sweep(t: MillTool, a: V3, b: V3, toolId: number): number {
    const dz = Math.abs(b.z - a.z);
    const dxy = Math.hypot(b.x - a.x, b.y - a.y);
    if (Math.min(a.z, b.z) >= this.top - 1e-9) return 0;
    if (dz < 1e-4) return this.sweepLevel(t, a, b, toolId);
    if (dxy < 1e-6) {
      // pure plunge or retract: only the lowest point matters
      const low = a.z < b.z ? a : b;
      return this.sweepLevel(t, low, low, toolId);
    }
    // ramp: pieces short enough that the height change per piece is tiny
    const n = Math.max(1, Math.ceil(Math.max(dz / 0.02, dxy / (this.c * 2))));
    let v = 0;
    for (let k = 0; k < n; k++) {
      const p = lerp3(a, b, k / n), q = lerp3(a, b, (k + 1) / n);
      v += this.sweepLevel(t, { ...p, z: Math.min(p.z, q.z) }, { ...q, z: Math.min(p.z, q.z) }, toolId);
    }
    return v;
  }

  /** highest material within a circle (optionally sampling every `stride` cells) */
  maxInCircle(x: number, y: number, r: number, stride = 1): number {
    const c = this.c;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.floor((x + r - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - r - this.y0) / c)), j1 = Math.min(this.ny - 1, Math.floor((y + r - this.y0) / c));
    let m = -Infinity;
    for (let j = j0; j <= j1; j += stride) {
      const py = this.y0 + (j + 0.5) * c - y;
      for (let i = i0; i <= i1; i += stride) {
        const px = this.x0 + (i + 0.5) * c - x;
        if (px * px + py * py > r * r) continue;
        const v = this.h[j * this.nx + i];
        if (v > m) m = v;
      }
    }
    return m;
  }

  /** true when the circle (tool footprint) overlaps the block outline */
  overlapsBlock(x: number, y: number, r: number) {
    const cx = Math.max(this.x0, Math.min(x, this.x1));
    const cy = Math.max(this.y0, Math.min(y, this.y1));
    return Math.hypot(x - cx, y - cy) < r;
  }

  /** changed region since the last call by this consumer (the whole block on the first call) */
  takeDirty(consumer: string): Rect | null {
    if (!this.dirtyBy.has(consumer)) {
      this.dirtyBy.set(consumer, null);
      return { i0: 0, i1: this.nx - 1, j0: 0, j1: this.ny - 1 };
    }
    const d = this.dirtyBy.get(consumer)!;
    this.dirtyBy.set(consumer, null);
    return d;
  }

  clone(): BlockModel {
    const b = Object.create(BlockModel.prototype) as BlockModel;
    Object.assign(b, this);
    b.h = this.h.slice();
    b.cutBy = this.cutBy.slice();
    b.dirtyBy = new Map();
    return b;
  }
}

export const lerp3 = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
