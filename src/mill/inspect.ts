// Inspection for milling: compare the machined height map with the height map that the
// reference program produces. Steep walls are excluded (a cell-sized step there is not a
// real error), everything else must be within ± tol in Z.

import { BlockModel } from './stock';
import { MillMachine } from './machine';
import { interpretMill, type MillConfig } from './interp';
import type { BlockStock, MillSettings } from './types';

export interface MillTarget {
  /** reference program whose result is the target part */
  solution: string;
  tol: number;
}

export interface MillCheck {
  pass: boolean;
  maxOver: number;
  maxUnder: number;
  /** share of inspected cells within tolerance */
  okShare: number;
  /** per-cell deviation (NaN = not inspected) */
  dev: Float32Array;
  summary: string[];
  ref: BlockModel;
}

const refCache = new Map<string, BlockModel>();

/** run a program on a fresh block (no rendering, no crash checks) */
/** Run a program on a fresh block without crash stops. Reference programs are written in the standard
 *  convention (G43 H, D registers, tip reference) unless `conventions` says otherwise
 *  (true = the user's current settings). */
export function simulateBlock(code: string, stock: BlockStock, cfg: MillConfig, conventions: boolean | Pick<MillSettings, 'autoLength' | 'autoRadius' | 'pointRef'> = false): BlockModel {
  const std = { autoLength: false, autoRadius: false, pointRef: 'tip' as const };
  const settings = conventions === true ? cfg.settings : { ...cfg.settings, ...std, ...(conventions || {}) };
  const key = JSON.stringify(stock) + '\n' + code + JSON.stringify(cfg.tools) + JSON.stringify(Array.from(cfg.offsets.entries())) + JSON.stringify(settings);
  const hit = refCache.get(key);
  if (hit) return hit.clone();
  const r = interpretMill(code, { ...cfg, settings, stock });
  const block = new BlockModel(stock);
  const m = new MillMachine(block, cfg.tools, cfg.settings);
  m.noCrash = true;
  m.optionalStop = false;
  m.load(r.ops);
  m.status = 'running';
  for (let n = 0; n < 200000; n++) {
    const s = m.status as string;
    if (s === 'stopped') m.status = 'running';
    else if (s !== 'running') break;
    m.advance(10);
  }
  if (refCache.size > 8) refCache.clear();
  refCache.set(key, block.clone());
  return block;
}

export function checkBlock(model: BlockModel, ref: BlockModel, tol: number): MillCheck {
  const n = model.nx * model.ny;
  const dev = new Float32Array(n).fill(NaN);
  const nx = model.nx, ny = model.ny;
  // exclude cells next to steep steps in the reference
  const steep = new Uint8Array(n);
  const lim = Math.max(0.3, model.c * 1.5);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // both grids are identical, so only the two cells on either side of a wall are ambiguous
      const k = j * nx + i, h = ref.h[k];
      if (i + 1 < nx && Math.abs(ref.h[k + 1] - h) > lim) steep[k] = steep[k + 1] = 1;
      if (j + 1 < ny && Math.abs(ref.h[k + nx] - h) > lim) steep[k] = steep[k + nx] = 1;
    }
  }
  // a 1 mm band along the block edges is not inspected (edges are deburred; face-mill corner radii)
  const edge = Math.ceil(1 / model.c);
  for (let j = 0; j < ny; j++) {
    const edgeRow = j < edge || j >= ny - edge;
    for (let i = 0; i < nx; i++) if (edgeRow || i < edge || i >= nx - edge) steep[j * nx + i] = 1;
  }
  let maxOver = 0, maxUnder = 0, ok = 0, count = 0;
  for (let k = 0; k < n; k++) {
    if (steep[k]) continue;
    const d = model.h[k] - ref.h[k];
    dev[k] = d;
    count++;
    if (Math.abs(d) <= tol) ok++;
    if (d > maxOver) maxOver = d;
    if (d < maxUnder) maxUnder = d;
  }
  const okShare = count ? ok / count : 0;
  const pass = maxOver <= tol && -maxUnder <= tol;
  return {
    pass,
    maxOver,
    maxUnder,
    okShare,
    dev,
    ref,
    summary: [
      `Tolerance ±${tol} mm in Z on all surfaces (walls are judged by their floors and tops)`,
      `Max. material left: ${maxOver.toFixed(3)} mm`,
      `Max. gouge: ${(-maxUnder).toFixed(3)} mm`,
      `${(okShare * 100).toFixed(1)} % of the inspected surface is within tolerance`,
    ],
  };
}
