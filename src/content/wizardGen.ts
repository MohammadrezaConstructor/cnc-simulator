// Conversational programming: turn a list of profile points + operation choices into a
// complete, commented Fanuc program (and the matching inspection target).

import type { MaterialId, StockDef, ToolDef } from '../types';
import type { Target } from './examples';

export interface ProfilePoint {
  /** diameter */
  d: number;
  z: number;
  /** corner treatment at this point */
  corner: 'none' | 'C' | 'R';
  size: number;
}

export interface WizardSpec {
  name: string;
  stock: StockDef;
  points: ProfilePoint[];
  face: boolean;
  rough: { tool: number; vc: number; ap: number; f: number; allowX: number; allowZ: number };
  finish: { enabled: boolean; tool: number; vc: number; f: number; comp: boolean };
  groove: { enabled: boolean; zLeft: number; width: number; d: number; tool: number; toolWidth: number };
  thread: { enabled: boolean; dMajor: number; pitch: number; zStart: number; zEnd: number; tool: number };
  partoff: { enabled: boolean; length: number; tool: number; toolWidth: number };
  maxRpm: number;
}

export const DEFAULT_VC: Record<MaterialId, number> = { steel: 200, stainless: 150, aluminium: 400, brass: 250, castiron: 180, plastic: 250 };

export function defaultSpec(stock: StockDef): WizardSpec {
  return {
    name: 'WIZARD PART',
    stock: { ...stock, diameter: 40, length: 100, bore: 0 },
    points: [
      { d: 20, z: 0, corner: 'C', size: 1 },
      { d: 20, z: -18, corner: 'none', size: 0 },
      { d: 26, z: -18, corner: 'C', size: 0.5 },
      { d: 26, z: -30, corner: 'R', size: 2 },
      { d: 36, z: -30, corner: 'C', size: 1 },
      { d: 36, z: -48, corner: 'none', size: 0 },
    ],
    face: true,
    rough: { tool: 1, vc: 200, ap: 2, f: 0.25, allowX: 0.4, allowZ: 0.1 },
    finish: { enabled: true, tool: 2, vc: 250, f: 0.1, comp: true },
    groove: { enabled: true, zLeft: -18, width: 3, d: 16.5, tool: 3, toolWidth: 3 },
    thread: { enabled: true, dMajor: 20, pitch: 1.5, zStart: 0, zEnd: -16, tool: 4 },
    partoff: { enabled: true, length: 45, tool: 7, toolWidth: 3 },
    maxRpm: 2500,
  };
}

const f3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? `${r}.` : String(r);
};
const tt = (n: number) => `T${String(n).padStart(2, '0')}${String(n).padStart(2, '0')}`;

/** Validate the profile; returns problems (empty = ok). With `tools` the insert clearance is checked too. */
export function checkSpec(s: WizardSpec, tools?: ToolDef[]): string[] {
  const out: string[] = [];
  const p = s.points;
  if (tools) {
    // a turning insert can only follow a back-facing slope (Ø getting smaller towards the chuck)
    // that is flatter than its trailing (minor) cutting edge
    for (let i = 1; i < p.length; i++) {
      const dz = Math.abs(p[i].z - p[i - 1].z);
      const dr = (p[i - 1].d - p[i].d) / 2;
      if (dr <= 1e-9) continue;
      const slope = dz < 1e-9 ? 90 : (Math.atan2(dr, dz) * 180) / Math.PI;
      for (const [what, id] of [['roughing', s.rough.tool], ['finishing', s.finish.enabled ? s.finish.tool : 0]] as [string, number][]) {
        const t = tools.find((x) => x.id === id);
        if (!t || t.type !== 'turn') continue;
        const trailing = 180 - t.approach - t.insertAngle;
        if (trailing < slope + 3) {
          out.push(`Points ${i}–${i + 1}: the ${slope.toFixed(0)}° back-facing slope is too steep for the ${what} tool T${String(id).padStart(2, '0')} (${t.insertAngle}° insert, trailing edge ${trailing.toFixed(0)}°) – it would gouge. Use a 35° insert (e.g. T02).`);
        }
      }
    }
  }
  if (p.length < 2) out.push('The profile needs at least two points.');
  for (let i = 1; i < p.length; i++) {
    if (p[i].z > p[i - 1].z + 1e-9) out.push(`Point ${i + 1}: Z must not increase (the profile runs from the face towards the chuck).`);
  }
  if (p.length && Math.abs(p[0].z) > 1e-9) out.push('The first point must lie on the front face (Z0).');
  for (const [i, q] of p.entries()) {
    if (q.d <= 0) out.push(`Point ${i + 1}: diameter must be positive.`);
    if (q.d > s.stock.diameter) out.push(`Point ${i + 1}: Ø${q.d} is larger than the bar Ø${s.stock.diameter}.`);
    if (q.corner !== 'none' && q.size <= 0) out.push(`Point ${i + 1}: corner size must be > 0.`);
  }
  if (p.length && p[p.length - 1].corner !== 'none') out.push('The last point cannot have a corner (nothing follows it).');
  const free = s.stock.length - s.stock.gripLength;
  const deepest = Math.min(...p.map((q) => q.z));
  if (-deepest + 6 > free) out.push(`The part (${-deepest} mm) is too long for the ${free} mm of bar outside the jaws.`);
  if (s.partoff.enabled && s.partoff.length > -deepest + 1e-9) out.push('Part-off length must not exceed the profile length (the profile must reach the cut-off point).');
  if (s.groove.enabled && s.groove.width < s.groove.toolWidth - 1e-9) out.push('The groove is narrower than the grooving tool.');
  if (s.thread.enabled && s.thread.zEnd >= s.thread.zStart) out.push('Thread end Z must be below the thread start Z.');
  return out;
}

/**
 * Finishing allowance (diameter) needed so the uncompensated roughing passes cannot dig into
 * back-facing slopes: the R-nose of a tip-3 tool dips R·(1 + sinθ − cosθ) below a θ° slope.
 */
export function requiredAllowance(s: WizardSpec, noseR: number): number {
  let need = 0;
  const p = s.points;
  for (let i = 1; i < p.length; i++) {
    const dz = Math.abs(p[i].z - p[i - 1].z);
    const dr = (p[i - 1].d - p[i].d) / 2;
    if (dr <= 1e-9 || dz < 1e-9) continue;
    const th = Math.atan2(dr, dz);
    const dip = noseR * (1 + Math.sin(th) - Math.cos(th));
    need = Math.max(need, (2 * (dip + s.rough.allowZ * Math.sin(th) + 0.05)) / Math.cos(th));
  }
  return Math.ceil(need * 10) / 10;
}

export function generate(s: WizardSpec, tools?: ToolDef[]): { code: string; target: Target } {
  const p = s.points;
  const D = s.stock.diameter;
  const roughR = tools?.find((t) => t.id === s.rough.tool)?.noseR ?? 0.8;
  const allowX = Math.max(s.rough.allowX, requiredAllowance(s, roughR));
  const sx = D + 2; // cycle start diameter
  const L: string[] = [];
  const add = (x: string) => L.push(x);
  const mono = p.every((q, i) => i === 0 || q.d >= p[i - 1].d - 1e-9);
  add('%');
  add(`O5000 (${s.name.toUpperCase().replace(/[()]/g, '')})`);
  add(`(GENERATED BY THE LATHELAB PROGRAM WIZARD)`);
  add(`(STOCK D${D} X ${s.stock.length} - Z0 = FINISHED FRONT FACE)`);
  add('G21 G40 G99 G18');
  add('G28 U0 W0');
  // ---- profile
  const prof: string[] = [];
  const first = p[0];
  const c0 = first.corner !== 'none' ? first.size : 0;
  prof.push(`N100 G00 X${f3(first.d - 2 * c0)}${mono ? '' : ' W0'}${mono ? '' : '        (TYPE II: POCKETS ALLOWED)'}`);
  prof.push('G01 Z0 F' + f3(s.finish.f));
  if (first.corner === 'C') prof.push(`X${f3(first.d)} Z${f3(-c0)}`);
  else if (first.corner === 'R') prof.push(`G03 X${f3(first.d)} Z${f3(-c0)} R${f3(c0)}`, 'G01');
  for (let i = 1; i < p.length; i++) {
    const q = p[i];
    const corner = q.corner === 'C' ? ` ,C${f3(q.size)}` : q.corner === 'R' ? ` ,R${f3(q.size)}` : '';
    prof.push(`X${f3(q.d)} Z${f3(q.z)}${corner}`);
  }
  prof.push(`N200 X${f3(sx)}`);
  // tidy: if the line after "G03…" is only "G01", merge with the next move
  for (let i = 0; i < prof.length - 1; i++) if (prof[i] === 'G01') prof.splice(i, 2, 'G01 ' + prof[i + 1]);

  // ---- OP10 rough
  add(`(=== OP10: FACE AND ROUGH, T${String(s.rough.tool).padStart(2, '0')} ===)`);
  add(tt(s.rough.tool));
  add(`G50 S${s.maxRpm}`);
  add(`G96 S${s.rough.vc} M03`);
  if (s.face) {
    add(`G00 X${f3(D + 4)} Z0 M08`);
    add('G01 X-1.6 F0.15          (FACE)');
    add('G00 Z2.');
  } else add(`G00 X${f3(D + 4)} Z2. M08`);
  add(`G00 X${f3(sx)} Z2.            (CYCLE START POINT)`);
  add(`G71 U${f3(s.rough.ap)} R0.5`);
  add(`G71 P100 Q200 U${f3(allowX)} W${f3(s.rough.allowZ)} F${f3(s.rough.f)}${allowX > s.rough.allowX + 1e-9 ? '  (ALLOWANCE RAISED FOR THE BACK-FACING SLOPE)' : ''}`);
  L.push(...prof);
  add('G00 X100. Z100.');
  // ---- OP20 finish
  if (s.finish.enabled) {
    add(`(=== OP20: FINISH, T${String(s.finish.tool).padStart(2, '0')} ===)`);
    add(tt(s.finish.tool));
    add(`G96 S${s.finish.vc} M03`);
    add(`G00${s.finish.comp ? ' G42' : ''} X${f3(sx)} Z2.`);
    add('G70 P100 Q200');
    add(`G00${s.finish.comp ? ' G40' : ''} X100. Z100.`);
  }
  // ---- OP30 groove
  if (s.groove.enabled) {
    const g = s.groove;
    add(`(=== OP30: GROOVE ${g.width} WIDE, D${g.d}, T${String(g.tool).padStart(2, '0')} ===)`);
    add(tt(g.tool));
    add('G97 S800 M03');
    const zFirst = g.zLeft;
    const zLast = g.zLeft + g.width - g.toolWidth;
    add(`G00 X${f3(D + 2)} Z${f3(zFirst)}`);
    if (Math.abs(zLast - zFirst) < 1e-6) {
      add(`G01 X${f3(g.d)} F0.06`);
      add('G04 X0.3');
      add(`G00 X${f3(D + 2)}`);
    } else {
      add('G75 R0.3');
      add(`G75 X${f3(g.d)} Z${f3(zLast)} P1500 Q${Math.round(g.toolWidth * 0.8 * 1000)} F0.06`);
    }
    add('G00 X100. Z100.');
  }
  // ---- OP40 thread
  if (s.thread.enabled) {
    const t = s.thread;
    const h = 0.6134 * t.pitch;
    const minor = t.dMajor - 2 * h;
    add(`(=== OP40: THREAD M${t.dMajor} X ${t.pitch}, T${String(t.tool).padStart(2, '0')} ===)`);
    add(tt(t.tool));
    add('G97 S700 M03');
    add(`G00 X${f3(t.dMajor + 4)} Z${f3(t.zStart + 3 * t.pitch)}`);
    add('G76 P020060 Q50 R0.03');
    add(`G76 X${f3(minor)} Z${f3(t.zEnd)} P${Math.round(h * 1000)} Q${Math.round(Math.min(0.4, h / 3) * 1000)} F${f3(t.pitch)}`);
    add('G00 X100. Z100.');
  }
  // ---- OP50 part off
  if (s.partoff.enabled) {
    const po = s.partoff;
    const z = -po.length - po.toolWidth;
    add(`(=== OP50: PART OFF AT Z-${po.length}, T${String(po.tool).padStart(2, '0')} ===)`);
    add(tt(po.tool));
    add('G97 S700 M03');
    add(`G00 X${f3(D + 2)} Z${f3(z)}`);
    add('G75 R0.5');
    add(`G75 X-0.5 Z${f3(z)} P3000 F0.05`);
    add('G00 X100. Z100.');
  }
  add('M09');
  add('M05');
  add('M30');
  add('%');

  // ---- inspection target (same contour, corners included)
  const tg: string[] = [];
  tg.push(`G00 X${f3(first.d - 2 * c0)} Z0`);
  if (first.corner === 'C') tg.push(`G01 X${f3(first.d)} Z${f3(-c0)}`);
  else if (first.corner === 'R') tg.push(`G03 X${f3(first.d)} Z${f3(-c0)} R${f3(c0)}`);
  // the finished part ends at the part-off position: truncate the contour there
  const zEndPart = s.partoff.enabled ? -s.partoff.length : -Infinity;
  for (let i = 1; i < p.length; i++) {
    const q = p[i];
    if (q.z < zEndPart - 1e-9) {
      const a = p[i - 1];
      const t = (zEndPart - a.z) / (q.z - a.z);
      tg.push(`G01 X${f3(a.d + (q.d - a.d) * t)} Z${f3(zEndPart)}`);
      break;
    }
    const corner = q.corner === 'C' ? ` ,C${f3(q.size)}` : q.corner === 'R' ? ` ,R${f3(q.size)}` : '';
    tg.push(`G01 X${f3(q.d)} Z${f3(q.z)}${corner}`);
  }
  const ignore: [number, number][] = [];
  if (s.thread.enabled) ignore.push([s.thread.zEnd, s.thread.zStart]);
  if (s.groove.enabled) ignore.push([s.groove.zLeft - 0.3, s.groove.zLeft + s.groove.width + 0.3]);
  return { code: L.join('\n') + '\n', target: { outer: tg.join('\n'), tol: 0.05, ignore } };
}
