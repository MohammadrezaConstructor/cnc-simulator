import { describe, expect, it } from 'vitest';
import { interpret, type InterpConfig } from '../src/gcode/interpreter';
import { defaultTools, defaultOffsets } from '../src/sim/tools';
import { DEFAULT_MACHINE, DEFAULT_WORK_OFFSETS } from '../src/defaults';
import { EXAMPLES } from '../src/content/examples';
import { Stock } from '../src/sim/stock';
import { Machine } from '../src/sim/machine';
import { checkPart } from '../src/sim/inspect';
import type { MoveOp, Op, StockDef } from '../src/types';
import { lexLine } from '../src/gcode/lexer';

const tools = defaultTools();
const cfg = (stock?: StockDef): InterpConfig => ({
  tools,
  offsets: defaultOffsets(tools),
  machine: DEFAULT_MACHINE,
  workOffsets: DEFAULT_WORK_OFFSETS,
  blockSkip: false,
  stock,
});
const moves = (ops: Op[]) => ops.filter((o): o is MoveOp => o.kind === 'move');
const errors = (src: string) => interpret(src, cfg()).diags.filter((d) => d.severity === 'error');

describe('lexer', () => {
  it('parses words, comments, block delete and N numbers', () => {
    const b = lexLine('/N120 G01X20.5Z-3 F.2 (CUT) ; note', 0);
    expect(b.blockDelete).toBe(true);
    expect(b.n).toBe(120);
    expect(b.words.map((w) => w.letter + w.value)).toEqual(['G1', 'X20.5', 'Z-3', 'F0.2']);
    expect(b.comment).toContain('CUT');
    expect(b.words[1].hasDecimal).toBe(true);
  });
  it('flags garbage', () => {
    expect(lexLine('G01 X10 $', 0).errors.length).toBe(1);
  });
});

describe('interpreter basics', () => {
  it('uses diameter programming and U/W increments', () => {
    const r = interpret('G00 X40 Z2\nG01 U-10 W-5 F0.2\nG00 X60', cfg());
    const m = moves(r.ops);
    expect(m[0].to).toEqual({ x: 20, z: 2 });
    expect(m[1].to.x).toBeCloseTo(15);
    expect(m[1].to.z).toBeCloseTo(-3);
    expect(m[1].type).toBe('linear');
    expect(m[1].feedPerRev).toBe(true);
  });

  it('computes arc centres from R (convex corner = G03)', () => {
    const r = interpret('G00 X20 Z0\nG03 X30 Z-5 R5 F0.1', cfg());
    const a = moves(r.ops)[1];
    expect(a.type).toBe('arc');
    expect(a.center!.x).toBeCloseTo(10);
    expect(a.center!.z).toBeCloseTo(-5);
    expect(a.cw).toBe(false);
  });

  it('computes arc centres from I/K and rejects inconsistent ones', () => {
    const r = interpret('G00 X20 Z0\nG02 X30 Z-5 I5 K0 F0.1', cfg());
    const a = moves(r.ops)[1];
    expect(a.center).toEqual({ x: 15, z: 0 });
    expect(errors('G00 X20 Z0\nG02 X30 Z-5 I1 K1 F0.1').length).toBe(1);
  });

  it('rejects an arc radius that is too small', () => {
    expect(errors('G00 X0 Z0\nG03 X40 Z-20 R5 F0.1').length).toBe(1);
  });

  it('G90 expands to four moves and is modal', () => {
    const r = interpret('G00 X52 Z2\nG90 X46 Z-30 F0.2\nX42', cfg());
    const m = moves(r.ops).slice(1);
    expect(m.length).toBe(8);
    expect(m[1].to).toEqual({ x: 23, z: -30 });
    expect(m[5].to).toEqual({ x: 21, z: -30 });
    expect(m[7].to).toEqual({ x: 26, z: 2 });
  });

  it('G71 roughs in levels and never cuts below the offset profile', () => {
    const src = `G00 X52 Z2
G71 U2 R0.5
G71 P10 Q20 U0.4 W0.1 F0.25
N10 G00 X20
G01 Z-20 F0.1
X40 Z-30
N20 X52
G00 X100`;
    const r = interpret(src, cfg());
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    const m = moves(r.ops);
    const cuts = m.filter((x) => x.cycle === 'G71' && x.type === 'linear');
    expect(cuts.length).toBeGreaterThan(10);
    // offset profile: x >= 10.2 for z > -20.1, the taper below that
    for (const c of cuts) {
      for (const p of [c.from, c.to]) {
        if (p.z > -19.9) expect(p.x).toBeGreaterThanOrEqual(10.2 - 1e-6);
      }
    }
    // the profile blocks are skipped after G71: next real move is G00 X100
    expect(m[m.length - 1].to.x).toBe(50);
  });

  it('G76 produces decreasing depth increments and the full thread depth', () => {
    const src = `G97 S600 M03\nG00 X26 Z6\nG76 P020060 Q50 R0.05\nG76 X21.546 Z-29 P1227 Q350 F2`;
    const r = interpret(src, cfg());
    const th = moves(r.ops).filter((m) => m.type === 'thread');
    expect(th.length).toBeGreaterThan(8);
    const depths = th.map((t) => 13 - t.to.x);
    expect(Math.max(...depths)).toBeCloseTo(13 - 10.773, 3);
    expect(th[0].feed).toBe(2);
  });

  it('M98/M99 repeats sub-programs', () => {
    const src = `O1\nG00 X44 Z0\nM98 P30020\nM30\nO0020\nG00 W-5\nM99`;
    const r = interpret(src, cfg());
    const m = moves(r.ops);
    expect(m.map((x) => x.to.z)).toEqual([0, -5, -10, -15]);
  });

  it('warns about G96 without G50', () => {
    const r = interpret('G96 S200 M03\nG00 X20 Z2', cfg());
    expect(r.diags.some((d) => d.message.includes('G50'))).toBe(true);
  });
});

describe('tool nose radius compensation', () => {
  it('keeps straight Z turning unchanged and corrects a 45° chamfer', () => {
    // T01: R0.8, tip 3
    const base = 'T0101\nG00 X16 Z2\n';
    const comp = interpret(base + 'G42 G01 Z0 F0.1\nX26 Z-5\nZ-20\nG40 G00 X40', cfg());
    const plain = interpret(base + 'G01 Z0 F0.1\nX26 Z-5\nZ-20\nG00 X40', cfg());
    const mc = moves(comp.ops);
    const mp = moves(plain.ops);
    // straight Z move at Ø26: the control point stays on X26 (the nose centre is R above it);
    // at the free end the imaginary tip lies R beyond Z-20 because the nose centre stops at Z-20
    const zc = mc[mc.length - 2];
    expect(zc.to.x).toBeCloseTo(13, 6);
    expect(zc.to.z).toBeCloseTo(-20.8, 6);
    // chamfer end point is shifted along Z by R*tan(22.5°)… i.e. differs from the uncompensated one
    const chamferEndPlain = mp.find((m) => Math.abs(m.to.z - -5) < 1e-6)!;
    expect(chamferEndPlain.to.x).toBeCloseTo(13);
    const anyShift = mc.some((m) => Math.abs(m.to.z - -5) > 1e-3 && Math.abs(m.to.z + 5) < 1);
    expect(anyShift).toBe(true);
    expect(comp.diags.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

function runProgram(code: string, stockDef: StockDef) {
  const r = interpret(code, cfg(stockDef));
  const stock = new Stock(stockDef);
  const m = new Machine(stock, tools, DEFAULT_MACHINE);
  m.load(r.ops);
  m.status = 'running';
  m.optionalStop = false;
  let n = 0;
  const st = () => m.status as string;
  while ((st() === 'running' || st() === 'stopped') && n++ < 200000) {
    if (st() === 'stopped') m.status = 'running';
    m.advance(5);
  }
  return { r, m, stock };
}

describe('examples run cleanly on the simulated machine', () => {
  for (const ex of EXAMPLES) {
    it(ex.title, () => {
      const { r, m, stock } = runProgram(ex.code, ex.stock);
      const errs = r.diags.filter((d) => d.severity === 'error');
      expect(errs, JSON.stringify(errs)).toEqual([]);
      const alarms = m.events.filter((e) => e.type === 'alarm');
      expect(alarms, JSON.stringify(alarms)).toEqual([]);
      expect(m.status).toBe('done');
      if (ex.target) {
        const res = checkPart(stock, ex.target, DEFAULT_MACHINE);
        if (ex.id === 'tnrc') {
          // the uncompensated chamfer must leave material, the compensated one must not
          expect(res.pass).toBe(false);
          const front = res.samples.filter((s) => s.z > -5 && s.z < 0);
          expect(Math.max(...front.map((s) => Math.abs(s.dev)))).toBeLessThan(0.05);
          const featA = res.samples.filter((s) => s.z < -35.2 && s.z > -39.8);
          expect(Math.max(...featA.map((s) => s.dev))).toBeGreaterThan(0.3);
        } else {
          expect(res.pass, res.summary.join('; ') + ' worst: ' + JSON.stringify(res.samples.filter((s) => Math.abs(s.dev) > ex.target!.tol).slice(0, 5))).toBe(true);
        }
      }
      if (ex.id === 'complete') expect(stock.dropped).not.toBeNull();
    });
  }
});

import { EXERCISES } from '../src/content/exercises';

describe('exercise reference solutions pass inspection', () => {
  for (const ex of EXERCISES) {
    it(ex.title, () => {
      const { r, m, stock } = runProgram(ex.solution, ex.stock);
      expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
      const alarms = m.events.filter((e) => e.type === 'alarm');
      expect(alarms, JSON.stringify(alarms)).toEqual([]);
      const res = checkPart(stock, ex.target, DEFAULT_MACHINE);
      expect(res.pass, res.summary.join('; ') + ' worst: ' + JSON.stringify(res.samples.filter((s) => Math.abs(s.dev) > ex.target.tol).slice(0, 4))).toBe(true);
    });
    it(`${ex.title} – starter program fails inspection`, () => {
      const { stock } = runProgram(ex.starter, ex.stock);
      expect(checkPart(stock, ex.target, DEFAULT_MACHINE).pass).toBe(false);
    });
  }
});
