import { describe, expect, it } from 'vitest';
import { interpret, type InterpConfig } from '../src/gcode/interpreter';
import * as CY from '../src/gcode/cycles';
import { evalExpr } from '../src/gcode/macro';
import { defaultTools, defaultOffsets } from '../src/sim/tools';
import { DEFAULT_MACHINE, DEFAULT_STOCK, DEFAULT_WORK_OFFSETS } from '../src/defaults';
import { Stock } from '../src/sim/stock';
import { Machine, estimateTime, spindleRpm } from '../src/sim/machine';
import { checkPart } from '../src/sim/inspect';
import { defaultSpec, generate, checkSpec } from '../src/content/wizardGen';
import type { MoveOp, Op, StockDef } from '../src/types';

const tools = defaultTools();
const cfg = (extra: Partial<InterpConfig> = {}): InterpConfig => ({
  tools,
  offsets: defaultOffsets(tools),
  machine: DEFAULT_MACHINE,
  workOffsets: DEFAULT_WORK_OFFSETS,
  blockSkip: false,
  ...extra,
});
const moves = (ops: Op[]) => ops.filter((o): o is MoveOp => o.kind === 'move');
const diags = (src: string, sev: string) => interpret(src, cfg()).diags.filter((d) => d.severity === sev);
const errors = (src: string) => diags(src, 'error');

function run(code: string, stockDef: StockDef) {
  const r = interpret(code, cfg({ stock: stockDef }));
  const stock = new Stock(stockDef);
  const m = new Machine(stock, tools, DEFAULT_MACHINE);
  m.load(r.ops);
  m.status = 'running';
  m.optionalStop = false;
  for (let n = 0; n < 200000 && (m.status === 'running' || (m.status as string) === 'stopped'); n++) {
    if ((m.status as string) === 'stopped') m.status = 'running';
    m.advance(5);
  }
  return { r, m, stock };
}

// ------------------------------------------------------------------ 1. G74/G75 tiny P/Q

describe('G74/G75 with P/Q in µm (missing decimal point)', () => {
  const head = 'T0505\nG97 S600 M03\n';

  it('G74 Z-30 Q5 drills the full depth (no silent stop) and hints at µm', () => {
    const r = interpret(head + 'G00 X0 Z2\nG74 Z-30 Q5 F0.1\nG00 Z50\nM30', cfg());
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    const pecks = moves(r.ops).filter((m) => m.cycle === 'G74' && m.type === 'linear');
    expect(Math.min(...pecks.map((m) => m.to.z))).toBeCloseTo(-30, 9);
    expect(pecks.length).toBe(6400);
    expect(r.diags.some((d) => d.severity === 'warning' && d.message.includes('Q5 = 0.005 mm'))).toBe(true);
  });

  it('G75 X40 Z-12 P2 Q30 from X52 is refused with a clear µm message instead of stopping at Ø44', () => {
    const r = interpret(head + 'G00 X52 Z0\nG75 X40 Z-12 P2 Q30 F0.05\nG00 X100\nM30', cfg());
    const err = r.diags.filter((d) => d.severity === 'error');
    expect(err.length).toBe(1);
    expect(err[0].message).toContain('µm');
    expect(err[0].message).toContain('P1500 = 1.5 mm');
    expect(moves(r.ops).some((m) => m.cycle === 'G75')).toBe(false);
  });

  it('G75 X30 Z-20 P2 Q3 is refused quickly (no memory blow-up)', () => {
    const t0 = Date.now();
    const err = errors(head + 'G00 X52 Z0\nG75 X30 Z-20 P2 Q3 F0.05\nM30');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err.length).toBe(1);
    expect(err[0].message).toMatch(/G75: P\/Q are far too small/);
  });

  it('the cycle functions themselves never generate more than the limit', () => {
    expect(() => CY.g75({ x: 26, z: 0 }, 15, -20, 0.002, 0.003, 0.5)).toThrow(/µm/);
    expect(() => CY.g74({ x: 0, z: 2 }, 0, -500, 0, 0.001, 0.5)).toThrow(/µm/);
    const ok = CY.g74({ x: 0, z: 2 }, 0, -38, 0, 6, 1);
    expect(ok.filter((m) => m.type === 'linear').length).toBe(7);
  });

  it('normal µm values still work', () => {
    const r = interpret(head + 'G00 X42 Z-35\nG75 R0.5\nG75 X30. Z-23. P2000 Q2500 F0.06\nG00 X100\nM30', cfg());
    expect(r.diags.filter((d) => d.severity !== 'info')).toEqual([]);
    const g = moves(r.ops).filter((m) => m.cycle === 'G75' && m.type === 'linear');
    expect(Math.min(...g.map((m) => m.to.x))).toBeCloseTo(15, 9);
    expect(Math.max(...g.map((m) => m.to.z))).toBeCloseTo(-23, 9);
  });
});

// ------------------------------------------------------------------ 6. missing shift amount

describe('G74/G75 end point differs but the shift amount is missing (PS0062)', () => {
  const head = 'T0303\nG97 S600 M03\n';
  it('G75 with a different Z but no Q is an error', () => {
    const r = interpret(head + 'G00 X42 Z-10\nG75 X30 Z-20 P2000 F0.05\nM30', cfg());
    const err = r.diags.filter((d) => d.severity === 'error');
    expect(err.length).toBe(1);
    expect(err[0].message).toContain('PS0062');
    expect(err[0].message).toContain('Q');
    expect(moves(r.ops).some((m) => m.cycle === 'G75')).toBe(false);
  });
  it('G75 with Q0 and a different Z is an error', () => {
    expect(errors(head + 'G00 X42 Z-10\nG75 X30 Z-20 P2000 Q0 F0.05\nM30')[0].message).toContain('PS0062');
  });
  it('G74 with a different X but no P is an error', () => {
    const err = errors(head + 'G00 X10 Z2\nG74 X30 Z-5 Q2000 F0.05\nM30');
    expect(err.length).toBe(1);
    expect(err[0].message).toContain('PS0062');
    expect(err[0].message).toContain('P');
  });
  it('a single plunge at the start Z/X still needs no Q/P', () => {
    expect(errors(head + 'G00 X42 Z-43\nG75 R0.5\nG75 X-0.5 Z-43. P3000 F0.05\nM30')).toEqual([]);
    expect(errors('T0505\nG97 S600 M03\nG00 X0 Z2\nG74 Z-20 Q5000 F0.1\nM30')).toEqual([]);
  });
});

// ------------------------------------------------------------------ 2. G71/G72 type I wrong direction

describe('G71/G72 type I with a profile monotone in the wrong direction', () => {
  const prog = (first: string, allow = 'U0 W0', end = 'N20 X20 Z-20') => `T0202
G50 S2500
G96 S200 M03
G00 X52 Z2
G71 U2 R0.5
G71 P10 Q20 ${allow} F.25
N10 G00 ${first}
G01 Z0
${end}
G00 X100 Z100
M30`;
  /** finished profile (radius) of the program above */
  const profileR = (z: number) => (z >= 0 ? 20 : 20 + z / 2);

  it('type I raises an alarm instead of roughing through the part', () => {
    const r = interpret(prog('X40'), cfg());
    const err = r.diags.filter((d) => d.severity === 'error');
    expect(err.length).toBe(1);
    expect(err[0].message).toContain('G71 type I');
    expect(err[0].message).toContain('X grows from N10 to N20 for OD roughing');
    expect(moves(r.ops).some((m) => m.cycle === 'G71')).toBe(false);
  });

  it('type II (W0) roughs the same profile without ever cutting into it', () => {
    const r = interpret(prog('X40 W0'), cfg());
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    const cuts = moves(r.ops).filter((m) => m.cycle === 'G71');
    expect(cuts.length).toBeGreaterThan(10);
    let checked = 0;
    for (const c of cuts) {
      for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        const z = c.from.z + (c.to.z - c.from.z) * t;
        const x = c.from.x + (c.to.x - c.from.x) * t;
        if (z > 2 || z < -20) continue;
        expect(x, `${c.label} at z=${z}`).toBeGreaterThanOrEqual(profileR(z) - 1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    // and roughing really went down to the small end of the taper
    expect(Math.min(...cuts.map((c) => c.to.x))).toBeLessThan(11);
  });

  it('type II on the machine leaves the finished taper intact', () => {
    const stockDef: StockDef = { diameter: 50, length: 100, bore: 0, faceAllowance: 1, gripLength: 30, material: 'steel' };
    // (the profile ends with a shoulder here, so the final retract has somewhere to go)
    const { m, stock } = run(prog('X40 W0', 'U0.8 W0.1', 'X20 Z-20\nN20 X52'), stockDef);
    expect(m.events.filter((e) => e.type === 'alarm')).toEqual([]);
    for (let z = -19; z <= -1; z += 0.5) expect(stock.radiusAt(z), `z=${z}`).toBeGreaterThanOrEqual(profileR(z) - 0.01);
  });

  it('a correctly oriented type I profile is still accepted', () => {
    expect(errors(prog('X20', 'U0 W0', 'N20 X40 Z-20'))).toEqual([]);
  });

  it('G72 type I with Z running away from the start side is refused too', () => {
    const src = `T0101
G96 S180 M03
G00 X84 Z2
G72 W1.5 R0.5
G72 P30 Q40 U0 W0 F0.25
N30 G00 Z0
G01 X40
N40 X20 Z-10
M30`;
    const err = errors(src);
    expect(err.length).toBe(1);
    expect(err[0].message).toContain('G72 type I');
    expect(err[0].message).toContain('Z grows');
  });
});

// ------------------------------------------------------------------ 3. wizard without part-off

describe('wizard part without part-off passes inspection', () => {
  const runSpec = (spec: ReturnType<typeof defaultSpec>) => {
    expect(checkSpec(spec, tools)).toEqual([]);
    const { code, target } = generate(spec, tools);
    const { r, m, stock } = run(code, spec.stock);
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    expect(m.events.filter((e) => e.type === 'alarm')).toEqual([]);
    const res = checkPart(stock, target, DEFAULT_MACHINE);
    expect(res.pass, res.summary.join('; ') + ' ' + JSON.stringify(res.samples.filter((s) => Math.abs(s.dev) > target.tol).slice(0, 4))).toBe(true);
    return { target, res };
  };
  it('partoff.enabled = false', () => {
    const spec = defaultSpec(DEFAULT_STOCK);
    spec.partoff.enabled = false;
    const { target, res } = runSpec(spec);
    expect(target.outer.trim().split('\n').pop()).toBe('G01 X40.');
    // the inspection still covers the last diameter right up to the fillet zone
    expect(res.samples.some((s) => s.z < -46 && s.z > -47.2)).toBe(true);
  });
  it('part-off exactly at the end of the profile', () => {
    const spec = defaultSpec(DEFAULT_STOCK);
    spec.partoff.length = 48;
    runSpec(spec);
  });
});

// ------------------------------------------------------------------ 4. profile capture follows macro flow

describe('G71 profile capture follows macro control flow', () => {
  const contour = (src: string) => {
    const r = interpret(src, cfg());
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    const pts = moves(r.ops)
      .filter((m) => m.cycle === 'G71' && (m.label ?? '').includes('contour pass') && !(m.label ?? '').includes('approach'))
      .map((m) => [+m.to.x.toFixed(3), +m.to.z.toFixed(3)]);
    return { r, pts };
  };
  const head = 'O1\nT0101\nG50 S2500\nG96 S200 M03\nG00 X52 Z2\nG71 U2 R0.5\nG71 P10 Q20 U0 W0 F0.25\n';

  it('IF … GOTO inside the profile, and variables are restored afterwards', () => {
    const { r, pts } = contour(head + 'N10 G00 X20\n#1 = 1\nIF [#1 EQ 1] GOTO 15\nG01 X30 Z-10\nN15 G01 Z-20\nN20 X52\nG00 X100 Z100\nM30');
    expect(pts).toEqual([[10, -20], [26, -20]]);
    expect(r.vars.has(1)).toBe(false);
  });

  it('WHILE loop inside the profile', () => {
    const { pts } = contour(head + 'N10 G00 X20\n#1 = 0\nWHILE [#1 LT 2] DO 1\nG01 W-5 F0.1\nU4\n#1 = #1 + 1\nEND 1\nN20 G01 X52\nG00 X100 Z100\nM30');
    expect(pts).toEqual([[10, -3], [12, -3], [12, -8], [14, -8], [26, -8]]);
  });

  it('M98 sub-program inside the profile (G71 and G70)', () => {
    const src = head + 'N10 G00 X20\nM98 P2\nN20 G01 X52\nG00 X100 Z100\nT0202\nG00 X52 Z2\nG70 P10 Q20\nG00 X100 Z100\nM30\nO2\nG01 W-10 F0.1\nU8\nM99';
    const { r, pts } = contour(src);
    expect(pts).toEqual([[10, -8], [14, -8], [26, -8]]);
    // G70 runs the sub-program too
    const all = moves(r.ops);
    const g70 = all.findIndex((m) => m.cycle === 'G70');
    const fin = all.slice(0, g70).filter((m) => m.tool === 2 && m.type === 'linear').map((m) => [+m.to.x.toFixed(3), +m.to.z.toFixed(3)]);
    expect(fin).toEqual([[10, -8], [14, -8], [26, -8]]);
  });

  it('an endless loop inside the profile is caught', () => {
    const err = errors(head + 'N10 G00 X20\nN12 G01 Z-5 F0.1\nGOTO 12\nN20 X52\nM30');
    expect(err.some((d) => d.message.includes('endless loop') || d.message.includes('too long'))).toBe(true);
  });
});

// ------------------------------------------------------------------ 5. inch mode

describe('inch mode (G20)', () => {
  it('P/Q without a decimal point count in 0.0001 in', () => {
    const r = interpret('G20\nT0505\nG97 S500 M03\nG00 X0 Z0.1\nG74 Z-0.5 Q1000 F0.004\nM30', cfg());
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    const pecks = moves(r.ops).filter((m) => m.cycle === 'G74' && m.type === 'linear');
    expect(pecks[0].to.z).toBeCloseTo(2.54 - 2.54, 9); // Q1000 = 0.1 in = 2.54 mm
    expect(pecks.length).toBe(6);
    expect(pecks[pecks.length - 1].to.z).toBeCloseTo(-12.7, 9);
  });

  it('G76 Q in G20 is 0.0001 in', () => {
    const r = interpret('G20\nT0404\nG97 S500 M03\nG00 X1.1 Z0.2\nG76 P010060 Q50 R0.001\nG76 X0.9 Z-1 P383 Q100 F0.0625\nM30', cfg());
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    const info = r.diags.find((d) => d.message.startsWith('G76 generates'))!;
    expect(info.message).toContain(`thread height ${(0.0383 * 25.4).toFixed(3)} mm`);
    expect(info.message).toContain(`first cut ${(0.01 * 25.4).toFixed(3)} mm`);
  });

  it('G96 S is ft/min in G20', () => {
    const r = interpret('G20\nG50 S3000\nG96 S600 M03\nG00 X2. Z0.1', cfg());
    const sp = r.ops.filter((o) => o.kind === 'spindle').pop()!;
    if (sp.kind !== 'spindle') throw new Error();
    expect(sp.spindle.s).toBeCloseTo(600 * 0.3048, 9);
    // Ø2 in: n = 12·600 / (π·2) ≈ 1146 rpm
    expect(spindleRpm(sp.spindle, 25.4, DEFAULT_MACHINE.maxRpm)).toBeCloseTo((12 * 600) / (Math.PI * 2), 6);
  });

  it('switching G97/G96 in G20 re-interprets the modal S', () => {
    const r = interpret('G20\nG50 S3000\nG97 S600 M03\nG96\nG97', cfg());
    const sp = r.ops.filter((o) => o.kind === 'spindle').map((o) => (o.kind === 'spindle' ? o.spindle : null)!);
    const last3 = sp.slice(-3);
    expect(last3.map((s) => s.mode)).toEqual(['rpm', 'css', 'rpm']);
    expect(last3[0].s).toBeCloseTo(600, 9);
    expect(last3[1].s).toBeCloseTo(600 * 0.3048, 9);
    expect(last3[2].s).toBeCloseTo(600, 9);
  });

  it('metric G96 is unchanged', () => {
    const r = interpret('G50 S3000\nG96 S200 M03', cfg());
    const sp = r.ops.filter((o) => o.kind === 'spindle').pop()!;
    expect(sp.kind === 'spindle' && sp.spindle.s).toBe(200);
  });
});

// ------------------------------------------------------------------ 7. negative dwell, G76 F0

describe('dwell and G76 lead validation', () => {
  it('rejects a negative dwell', () => {
    for (const w of ['G04 X-2', 'G04 U-1', 'G04 P-500']) {
      const r = interpret(w, cfg());
      expect(r.diags.filter((d) => d.severity === 'error').length, w).toBe(1);
      expect(r.ops.some((o) => o.kind === 'dwell')).toBe(false);
      expect(estimateTime(r.ops, DEFAULT_MACHINE).total).toBeGreaterThanOrEqual(0);
    }
    expect(errors('G04 X0.5')).toEqual([]);
  });

  it('the machine clock never runs backwards on a negative dwell op', () => {
    const ops: Op[] = [{ kind: 'dwell', seconds: -2, line: 0 }, { kind: 'end', line: 1, rewind: true }];
    expect(estimateTime(ops, DEFAULT_MACHINE).total).toBe(0);
    const m = new Machine(new Stock(DEFAULT_STOCK), tools, DEFAULT_MACHINE);
    m.load(ops);
    m.status = 'running';
    m.advance(1);
    expect(m.time).toBeGreaterThanOrEqual(0);
    expect(m.status).toBe('done');
  });

  it('G76 needs F > 0', () => {
    const err = errors('G97 S600 M03\nG00 X26 Z6\nG76 P020060 Q50 R0.05\nG76 X21.546 Z-29 P1227 Q350 F0');
    expect(err.length).toBe(1);
    expect(err[0].message).toBe('G76 needs F (lead) > 0');
  });
});

// ------------------------------------------------------------------ 8. ROUND

describe('macro ROUND', () => {
  it('rounds halves away from zero like Fanuc', () => {
    const v = new Map<number, number>();
    expect(evalExpr('ROUND[-2.5]', v)).toBe(-3);
    expect(evalExpr('ROUND[2.5]', v)).toBe(3);
    expect(evalExpr('ROUND[-2.4]', v)).toBe(-2);
    expect(evalExpr('ROUND[-2.6]', v)).toBe(-3);
    expect(Object.is(evalExpr('ROUND[-0.4]', v), 0)).toBe(true);
  });
});

import { g73 as g73Direct, g76 as g76Direct } from '../src/gcode/cycles';

describe('cycle pass limits', () => {
  it('G73 with an absurd number of passes is refused, a normal count works', () => {
    const seg = [{ type: 'linear' as const, from: { x: 20, z: 0 }, to: { x: 20, z: -20 } }];
    expect(() => g73Direct({ x: 30, z: 2 }, seg as never, 3, 0, 500000, 0.2, 0.1)).toThrow(/G73/);
    expect(g73Direct({ x: 30, z: 2 }, seg as never, 3, 0, 5, 0.2, 0.1).length).toBeGreaterThan(0);
  });
  it('G76 with a microscopic first depth is refused instead of one huge final cut', () => {
    expect(() => g76Direct({ x: 12, z: 2 }, { x1: 10.8, z1: -20, k: 1.2, d1: 0.00001, dmin: 0, fin: 0.05, m: 1, lead: 2, angle: 60, chamfer: 0 } as never)).toThrow(/G76/);
  });
});
