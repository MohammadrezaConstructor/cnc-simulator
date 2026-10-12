// Feature-based program generator for the milling simulator ("conversational programming").
// Produces readable, commented Fanuc code: one operation per feature, climb milling,
// helical entries, cutter compensation for finished walls, canned cycles for holes.

import type { MaterialId } from '../types';
import type { BlockStock, MillSettings, MillTool } from './types';
import { blockFrame, ORIGIN_NAMES } from './stock';
import { pointOffset } from './interp';

/** programming conventions the generated code follows (see MillSettings) */
export type WizardConventions = Pick<MillSettings, 'autoLength' | 'autoRadius' | 'pointRef'>;

export type MillFeature =
  | { kind: 'face'; z: number; tool: number }
  | { kind: 'pocket'; x: number; y: number; w: number; l: number; r: number; depth: number; step: number; tool: number }
  | { kind: 'circle'; x: number; y: number; d: number; depth: number; step: number; tool: number }
  | { kind: 'boss'; x: number; y: number; w: number; l: number; r: number; depth: number; step: number; tool: number; rings: number }
  | { kind: 'slot'; x1: number; y1: number; x2: number; y2: number; depth: number; step: number; tool: number }
  | {
      kind: 'holes';
      pattern: 'grid' | 'circle';
      x: number;
      y: number;
      nx: number;
      ny: number;
      dx: number;
      dy: number;
      radius: number;
      count: number;
      angle: number;
      depth: number;
      spotTool: number;
      drillTool: number;
      tapTool: number;
      tap: boolean;
    };

export interface MillWizardSpec {
  name: string;
  stock: BlockStock;
  features: MillFeature[];
}

/** cutting data by material: Vc (m/min) and feed per tooth (mm) / feed per rev for drills */
const CUT: Record<MaterialId, { mill: number; face: number; drill: number; tap: number; fz: number; fzFace: number; frev: number }> = {
  aluminium: { mill: 250, face: 450, drill: 90, tap: 20, fz: 0.05, fzFace: 0.1, frev: 0.15 },
  steel: { mill: 120, face: 200, drill: 25, tap: 8, fz: 0.04, fzFace: 0.12, frev: 0.12 },
  stainless: { mill: 80, face: 150, drill: 15, tap: 5, fz: 0.03, fzFace: 0.1, frev: 0.08 },
  brass: { mill: 200, face: 300, drill: 60, tap: 15, fz: 0.05, fzFace: 0.1, frev: 0.15 },
  castiron: { mill: 120, face: 180, drill: 30, tap: 8, fz: 0.05, fzFace: 0.12, frev: 0.15 },
  plastic: { mill: 300, face: 500, drill: 80, tap: 20, fz: 0.08, fzFace: 0.12, frev: 0.2 },
};

const f3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? `${r}.` : String(r);
};
const T2 = (n: number) => String(n).padStart(2, '0');

export function speeds(t: MillTool, mat: MaterialId, maxRpm: number) {
  const c = CUT[mat];
  const vc = t.type === 'face' ? c.face : t.type === 'drill' || t.type === 'spot' || t.type === 'ream' ? c.drill : t.type === 'tap' ? c.tap : c.mill;
  const rpm = Math.min(maxRpm, Math.round((1000 * vc) / (Math.PI * t.diameter) / 10) * 10);
  let feed: number;
  if (t.type === 'tap') feed = t.pitch * rpm;
  else if (t.type === 'drill' || t.type === 'spot' || t.type === 'ream') feed = c.frev * (t.diameter / 10) * rpm;
  else feed = (t.type === 'face' ? c.fzFace : c.fz * Math.min(2, Math.max(0.4, t.diameter / 10))) * Math.max(1, t.flutes) * rpm;
  return { rpm, feed: Math.max(10, Math.round(feed)), vc };
}

/** move a feature by dx/dy (used when the work zero moves to another corner) */
export function shiftFeature(f: MillFeature, dx: number, dy: number) {
  if (f.kind === 'face') return;
  if (f.kind === 'slot') {
    f.x1 += dx;
    f.x2 += dx;
    f.y1 += dy;
    f.y2 += dy;
  } else {
    f.x += dx;
    f.y += dy;
  }
}

export function defaultMillSpec(stock: BlockStock): MillWizardSpec {
  const s = { ...stock, sizeX: 100, sizeY: 80, sizeZ: 30, topAllowance: 1 };
  const features: MillFeature[] = [
    { kind: 'face', z: 0, tool: 1 },
    { kind: 'pocket', x: 32, y: 40, w: 36, l: 30, r: 6, depth: 6, step: 2, tool: 2 },
    { kind: 'circle', x: 75, y: 40, d: 24, depth: 8, step: 2.5, tool: 2 },
    { kind: 'holes', pattern: 'grid', x: 15, y: 15, nx: 2, ny: 2, dx: 70, dy: 50, radius: 0, count: 0, angle: 0, depth: 15, spotTool: 4, drillTool: 5, tapTool: 6, tap: true },
  ];
  // the positions above are measured from the front left corner
  const g = blockFrame(s);
  features.forEach((f) => shiftFeature(f, g.x0, g.y0));
  return { name: 'WIZARD PLATE', stock: s, features };
}

export function checkMillSpec(s: MillWizardSpec, tools: MillTool[]): string[] {
  const out: string[] = [];
  const st = s.stock;
  const { x0, y0, x1, y1 } = blockFrame(st);
  const jawDepth = st.aboveJaws;
  const tool = (id: number, what: string) => {
    const t = tools.find((x) => x.id === id);
    if (!t) out.push(`${what}: tool T${T2(id)} is not in the magazine.`);
    return t;
  };
  s.features.forEach((f, n) => {
    const tag = `Feature ${n + 1} (${f.kind})`;
    if (f.kind === 'holes') {
      tool(f.drillTool, tag);
      if (f.tap) {
        const tt = tool(f.tapTool, tag);
        if (tt && tt.type !== 'tap') out.push(`${tag}: T${T2(f.tapTool)} is not a tap.`);
      }
      if (f.depth > st.sizeZ + st.topAllowance + 8) out.push(`${tag}: holes deeper than the block + vise gap.`);
      return;
    }
    const t = tool(f.tool, tag);
    if (!t) return;
    const R = t.diameter / 2;
    if (f.kind === 'face') {
      if (f.z > st.topAllowance) out.push(`${tag}: face Z is above the top of the block.`);
      return;
    }
    if ('depth' in f && f.depth > t.fluteLength) out.push(`${tag}: depth ${f.depth} exceeds the flute length of T${T2(t.id)} (${t.fluteLength} mm).`);
    if ('depth' in f && f.depth >= jawDepth && f.kind !== 'pocket' && f.kind !== 'circle') {
      // only a problem near the jaws – checked below
    }
    if (t.type === 'face') out.push(`${tag}: a face mill cannot plunge into pockets/slots – use an end mill.`);
    if (f.kind === 'pocket') {
      if (f.w / 2 - R <= 0.05 || f.l / 2 - R <= 0.05) out.push(`${tag}: pocket too small for a Ø${t.diameter} tool.`);
      if (f.r > 0 && f.r < R) out.push(`${tag}: corner radius R${f.r} is smaller than the tool radius ${R} – the tool leaves R${R}.`);
      if (f.x - f.w / 2 < x0 || f.x + f.w / 2 > x1 || f.y - f.l / 2 < y0 || f.y + f.l / 2 > y1) out.push(`${tag}: the pocket runs off the block.`);
    }
    if (f.kind === 'circle') {
      if (f.d / 2 - R <= 0.05) out.push(`${tag}: circle too small for a Ø${t.diameter} tool.`);
      if (f.x - f.d / 2 < x0 || f.x + f.d / 2 > x1 || f.y - f.d / 2 < y0 || f.y + f.d / 2 > y1) out.push(`${tag}: the circular pocket runs off the block.`);
    }
    if (f.kind === 'boss') {
      const outer = R + 0.3 + Math.max(0, f.rings - 1) * t.diameter * 0.6 + R;
      if ((f.y - f.l / 2 - outer < y0 || f.y + f.l / 2 + outer > y1) && f.depth > jawDepth - 1) out.push(`${tag}: the outer roughing ring runs over the vise jaws below their top – fewer rings, a smaller depth, or more stock above the jaws.`);
    }
    if ('step' in f && f.step <= 0) out.push(`${tag}: step-down must be > 0.`);
  });
  return out;
}

export function generateMill(s: MillWizardSpec, tools: MillTool[], maxRpm = 8000, conv: WizardConventions = {}): string {
  const st = s.stock;
  const mat = st.material;
  const L: string[] = [];
  const add = (x: string) => L.push(x);
  const g = blockFrame(st);
  const { x0, y0, x1, y1 } = g;
  // feature depths are measured from the finished top; with Z0 on the raw top it lies at Z−allowance
  const zf = g.finished;
  let zt = 0; // height of the programmed point above the tip (nose-centre reference)
  /** Z word for a height measured from the finished top (cut: the tip must reach it) */
  const Z = (z: number, cut = true) => f3(z + zf + (cut ? zt : 0));
  let current = 0;
  let opNo = 10;
  const safe = 25;
  add('%');
  add(`O6000 (${s.name.toUpperCase().replace(/[()]/g, '')})`);
  add('(GENERATED BY THE LATHELAB MILLING WIZARD)');
  add(`(BLOCK ${st.sizeX} X ${st.sizeY} X ${st.sizeZ} - X0 Y0 = ${ORIGIN_NAMES[st.origin].toUpperCase()})`);
  add(st.zRef === 'raw' ? `(Z0 = RAW TOP - FINISHED TOP AT Z${f3(zf)})` : '(Z0 = FINISHED TOP)');
  if (conv.autoLength) add('(AUTOMATIC TOOL LENGTH COMPENSATION - NO G43 H NEEDED)');
  if (conv.autoRadius) add('(AUTOMATIC CUTTER RADIUS - G41/G42 WITHOUT D)');
  if (conv.pointRef === 'center') add('(Z = CENTRE OF THE NOSE RADIUS FOR BALL / BULL-NOSE / FACE MILLS)');
  add('G21 G17 G40 G49 G80 G90 G94');
  add('G91 G28 Z0');
  add('G90');

  const toolOn = (id: number, comment: string) => {
    const t = tools.find((x) => x.id === id)!;
    const sp = speeds(t, mat, maxRpm);
    add(`(=== OP${opNo}: ${comment.toUpperCase()} - T${T2(id)} ${t.name.toUpperCase().replace(/[()]/g, '')} ===)`);
    opNo += 10;
    if (current !== id) {
      add(`T${T2(id)} M06`);
      current = id;
    }
    zt = pointOffset(t, conv as MillSettings);
    add(`S${sp.rpm} M03                  (VC ${sp.vc} M/MIN)`);
    return { t, ...sp };
  };
  const start = (id: number, x: number, y: number) =>
    add(`G54${conv.autoLength ? '' : ` G43 H${T2(id)}`} G00 X${f3(x)} Y${f3(y)} Z${safe}. M08`);
  const clearZ = () => add(`G00 Z${safe}.`);

  for (const f of s.features) {
    if (f.kind === 'face') {
      const { t, feed } = toolOn(f.tool, 'face the top');
      const R = t.diameter / 2;
      const step = t.diameter * 0.7;
      let y = y0 + R * 0.4;
      start(t.id, x0 - R - 5, y);
      add(`Z${Z(f.z + 2)}`);
      add(`G01 Z${Z(f.z)} F${feed}`);
      let dir = 1;
      for (let k = 0; k < 200; k++) {
        add(`X${f3(dir > 0 ? x1 + R + 5 : x0 - R - 5)}`);
        if (y + R >= y1 - 0.01) break;
        y = Math.min(y + step, y1 - R * 0.4);
        add(`G00 Y${f3(y)}`);
        add('G01');
        dir = -dir;
      }
      clearZ();
    } else if (f.kind === 'pocket' || f.kind === 'circle') {
      const { t, feed } = toolOn(f.tool, f.kind === 'pocket' ? `rectangular pocket ${f.w} x ${f.l} deep ${f.depth}` : `circular pocket D${f.d} deep ${f.depth}`);
      const R = t.diameter / 2;
      const so = t.diameter * 0.6;
      start(t.id, f.x, f.y);
      add(`Z${Z(2, false)}`);
      const levels: number[] = [];
      for (let z = -f.step; z > -f.depth + 1e-9; z -= f.step) levels.push(z);
      levels.push(-f.depth);
      const rh = f.kind === 'pocket' ? Math.min(R * 0.8, f.w / 2 - R, f.l / 2 - R) : Math.min(R * 0.8, f.d / 2 - R);
      let zPrev = 0;
      levels.forEach((z, li) => {
        add(`(LEVEL ${li + 1}/${levels.length}: Z${Z(z)})`);
        // helical entry: one or more turns, max 1 mm per turn
        add(`G01 X${f3(f.x + rh)} Y${f3(f.y)} Z${Z(zPrev + 0.5)} F${feed}`);
        const turns = Math.max(1, Math.ceil((zPrev + 0.5 - z) / 1));
        for (let k = 1; k <= turns; k++) {
          const zk = zPrev + 0.5 - ((zPrev + 0.5 - z) * k) / turns;
          add(`G03 X${f3(f.x + rh)} Y${f3(f.y)} I${f3(-rh)} J0 Z${Z(zk)}${k === 1 ? '        (HELICAL ENTRY)' : ''}`);
        }
        add(`G03 X${f3(f.x + rh)} Y${f3(f.y)} I${f3(-rh)} J0      (CLEAN THE FLOOR)`);
        if (f.kind === 'circle') {
          const rf = f.d / 2 - R;
          const radii: number[] = [];
          for (let r = rh + so; r < rf - 1e-6; r += so) radii.push(r);
          radii.push(rf);
          for (const r of radii) {
            add(`G01 X${f3(f.x + r)} Y${f3(f.y)}`);
            add(`G03 X${f3(f.x + r)} Y${f3(f.y)} I${f3(-r)} J0`);
          }
          add(`G01 X${f3(f.x + rf - 0.5)} Y${f3(f.y)}`);
        } else {
          const ax = f.w / 2 - R, ay = f.l / 2 - R;
          const rc = Math.max(0, f.r - R);
          const loops: [number, number][] = [];
          let k = 0;
          for (;;) {
            const hx = ax - k * so, hy = ay - k * so;
            if (hx <= rh || hy <= rh) break;
            loops.unshift([hx, hy]);
            k++;
          }
          if (!loops.length || loops[loops.length - 1][0] !== ax) loops.push([ax, ay]);
          loops.forEach(([hx, hy], i) => {
            const last = i === loops.length - 1;
            const cr = last && rc > 0 ? ` ,R${f3(rc)}` : '';
            add(`G01 X${f3(f.x + hx)} Y${f3(f.y)}`);
            add(`Y${f3(f.y + hy)}${cr}`);
            add(`X${f3(f.x - hx)}${cr}`);
            add(`Y${f3(f.y - hy)}${cr}`);
            add(`X${f3(f.x + hx)}${cr}`);
            add(`Y${f3(f.y)}`);
          });
          add(`G01 X${f3(f.x + ax - 0.5)}`);
        }
        add(`G00 Z${Z(2, false)}`);
        add(`X${f3(f.x)} Y${f3(f.y)}`);
        zPrev = z;
      });
      clearZ();
    } else if (f.kind === 'boss') {
      const { t, feed } = toolOn(f.tool, `boss ${f.w} x ${f.l} high ${f.depth}`);
      const R = t.diameter / 2;
      const so = t.diameter * 0.6;
      const hx = f.w / 2, hy = f.l / 2;
      const levels: number[] = [];
      for (let z = -f.step; z > -f.depth + 1e-9; z -= f.step) levels.push(z);
      levels.push(-f.depth);
      const sx = f.x + hx + R + so * Math.max(1, f.rings) + 3;
      start(t.id, sx, f.y);
      add(`Z${Z(2, false)}`);
      for (const z of levels) {
        add(`(LEVEL Z${Z(z)})`);
        add(`G01 Z${Z(z)} F${Math.round(feed / 2)}`);
        // roughing rings (tool centre path, clockwise = climb), outer first
        for (let k = f.rings - 1; k >= 0; k--) {
          const o = R + 0.3 + k * so;
          add(`G01 X${f3(f.x + hx + o)} Y${f3(f.y)} F${feed}`);
          add(`Y${f3(f.y - hy - o)}`);
          add(`X${f3(f.x - hx - o)}`);
          add(`Y${f3(f.y + hy + o)}`);
          add(`X${f3(f.x + hx + o)}`);
          add(`Y${f3(f.y)}`);
        }
        // finishing pass on the contour with cutter compensation (G41 = climb with M03)
        add(`G00 X${f3(sx)}`);
        add(`G41${conv.autoRadius ? '' : ` D${T2(t.id)}`} G01 X${f3(f.x + hx)} Y${f3(f.y)} F${feed}`);
        const cr = f.r > 0 ? ` ,R${f3(f.r)}` : '';
        add(`Y${f3(f.y - hy)}${cr}`);
        add(`X${f3(f.x - hx)}${cr}`);
        add(`Y${f3(f.y + hy)}${cr}`);
        add(`X${f3(f.x + hx)}${cr}`);
        add(`Y${f3(f.y)}`);
        add(`G40 G01 X${f3(sx)}`);
      }
      clearZ();
    } else if (f.kind === 'slot') {
      const { t, feed } = toolOn(f.tool, 'slot');
      const levels: number[] = [];
      for (let z = -f.step; z > -f.depth + 1e-9; z -= f.step) levels.push(z);
      levels.push(-f.depth);
      start(t.id, f.x1, f.y1);
      add(`Z${Z(1, false)}`);
      let atStart = true;
      for (const z of levels) {
        // ramp along the slot, then cut back at full depth
        const [ax, ay, bx, by] = atStart ? [f.x2, f.y2, f.x1, f.y1] : [f.x1, f.y1, f.x2, f.y2];
        add(`G01 X${f3(ax)} Y${f3(ay)} Z${Z(z)} F${Math.round(feed * 0.6)}    (RAMP)`);
        add(`X${f3(bx)} Y${f3(by)} F${Math.round(feed * 0.6)}`);
        atStart = !atStart;
        void ax;
        void ay;
      }
      clearZ();
    } else if (f.kind === 'holes') {
      const pts: [number, number][] = [];
      if (f.pattern === 'grid') {
        for (let j = 0; j < f.ny; j++) for (let i = 0; i < f.nx; i++) pts.push([f.x + i * f.dx, f.y + j * f.dy]);
      }
      const holeLines = (zLine: string) => {
        if (f.pattern === 'circle') {
          add(`G52 X${f3(f.x)} Y${f3(f.y)}          (LOCAL ZERO = CIRCLE CENTRE)`);
          add('G16                      (POLAR: X = RADIUS, Y = ANGLE)');
          for (let k = 0; k < f.count; k++) {
            const a = f.angle + (360 * k) / f.count;
            add(`${k === 0 ? zLine + ' ' : ''}X${f3(f.radius)} Y${f3(a)}`);
          }
          add('G15 G80');
          add('G52 X0 Y0');
        } else {
          pts.forEach(([x, y], k) => add(`${k === 0 ? zLine + ' ' : ''}X${f3(x)} Y${f3(y)}`));
          add('G80');
        }
      };
      const first = f.pattern === 'grid' ? pts[0] : [f.x + f.radius * Math.cos((f.angle * Math.PI) / 180), f.y + f.radius * Math.sin((f.angle * Math.PI) / 180)];
      const drill = tools.find((x) => x.id === f.drillTool)!;
      // spot
      const spot = tools.find((x) => x.id === f.spotTool);
      if (spot) {
        const sp = toolOn(spot.id, 'spot drill');
        const spotDepth = Math.min(drill.diameter / 2 + 0.3, spot.diameter / 2);
        start(spot.id, first[0], first[1]);
        holeLines(`G99 G82 Z${Z(-spotDepth)} R${Z(2, false)} P200 F${sp.feed}`);
        clearZ();
      }
      const dp = toolOn(drill.id, `drill D${drill.diameter} deep ${f.depth}`);
      const tipLen = drill.type === 'drill' ? drill.diameter / 2 / Math.tan(((drill.tipAngle / 2) * Math.PI) / 180) : 0;
      const zd = -(f.depth + (f.tap ? 0 : tipLen));
      start(drill.id, first[0], first[1]);
      const deep = f.depth > 3 * drill.diameter;
      holeLines(deep ? `G99 G83 Z${Z(zd)} R${Z(2, false)} Q${f3(drill.diameter)} F${dp.feed}` : `G99 G81 Z${Z(zd)} R${Z(2, false)} F${dp.feed}`);
      clearZ();
      if (f.tap) {
        const tap = tools.find((x) => x.id === f.tapTool)!;
        const tp = toolOn(tap.id, `tap M${tap.diameter} x ${tap.pitch}`);
        start(tap.id, first[0], first[1]);
        holeLines(`G99 G84 Z${Z(-(f.depth - 2 * tap.pitch))} R${Z(5, false)} F${f3(tp.feed)}      (F = PITCH X S)`);
        clearZ();
      }
    }
  }
  add('M09');
  add('M05');
  add('G91 G28 Z0');
  add('G90');
  add('M30');
  add('%');
  return L.join('\n') + '\n';
}
