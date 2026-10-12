import { describe, expect, it } from 'vitest';
import { interpret, type InterpConfig } from '../src/gcode/interpreter';
import { evalExpr } from '../src/gcode/macro';
import { defaultTools, defaultOffsets } from '../src/sim/tools';
import { DEFAULT_MACHINE, DEFAULT_WORK_OFFSETS } from '../src/defaults';
import { Stock } from '../src/sim/stock';
import { Machine } from '../src/sim/machine';
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
const errs = (src: string) => interpret(src, cfg()).diags.filter((d) => d.severity === 'error');

describe('macro expressions', () => {
  const v = new Map<number, number>([[1, 10], [2, 4]]);
  it('evaluates arithmetic, functions and precedence', () => {
    expect(evalExpr('#1+#2*2', v)).toBe(18);
    expect(evalExpr('[#1+#2]*2', v)).toBe(28);
    expect(evalExpr('SQRT[#1*10]', v)).toBe(10);
    expect(evalExpr('SIN[30]', v)).toBeCloseTo(0.5);
    expect(evalExpr('ATAN[1]/[1]', v)).toBeCloseTo(45);
    expect(evalExpr('-#2', v)).toBe(-4);
    expect(evalExpr('#[#2-3]', v)).toBe(10);
    expect(evalExpr('FIX[2.7]+FUP[2.1]+ROUND[2.5]', v)).toBe(2 + 3 + 3);
  });
  it('handles vacant variables like Fanuc', () => {
    expect(evalExpr('#5', v)).toBeNull();
    expect(evalExpr('#5+1', v)).toBe(1);
    expect(evalExpr('#5 EQ #0', v)).toBe(1);
    expect(evalExpr('#1 GT 5 AND #2 LT 5', v)).toBe(1);
  });
  it('reports bad expressions', () => {
    expect(() => evalExpr('#1+', v)).toThrow();
    expect(() => evalExpr('1/0', v)).toThrow();
  });
});

describe('macro programs', () => {
  it('runs a WHILE loop with variable addresses', () => {
    const src = `#1 = 0
#2 = -5
WHILE [#1 LT 3] DO 1
G00 X40 Z#2
#2 = #2 - 10
#1 = #1 + 1
END 1
M30`;
    const r = interpret(src, cfg());
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    expect(moves(r.ops).map((m) => m.to.z)).toEqual([-5, -15, -25]);
    expect(r.vars.get(1)).toBe(3);
  });
  it('IF GOTO jumps, vacant words are ignored, #3000 raises an alarm', () => {
    const r = interpret(`#1 = 1\nIF [#1 EQ 1] GOTO 20\nG00 X99\nN20 G00 X40 Z#7\nM30`, cfg());
    const m = moves(r.ops);
    expect(m.length).toBe(1);
    expect(m[0].to.x).toBe(20);
    expect(errs('#3000 = 1 (TOOL WORN)')[0].message).toContain('TOOL WORN');
  });
  it('detects an endless loop', () => {
    expect(errs('N1 G00 X10\nGOTO 1').length).toBe(1);
  });
});

describe('direct chamfer / corner radius', () => {
  it(',C makes a chamfer of the given leg length', () => {
    const r = interpret('G00 X20 Z2\nG01 Z-10 ,C2 F0.1\nX40', cfg());
    const m = moves(r.ops).slice(1);
    expect(m.map((x) => [x.to.x, x.to.z])).toEqual([[10, -8], [12, -10], [20, -10]]);
  });
  it(',R makes a tangent arc', () => {
    const r = interpret('G00 X20 Z2\nG01 Z-10 ,R2 F0.1\nX40', cfg());
    const m = moves(r.ops).slice(1);
    expect(m[0].to).toEqual({ x: 10, z: -8 });
    expect(m[1].type).toBe('arc');
    expect(m[1].center!.x).toBeCloseTo(12);
    expect(m[1].center!.z).toBeCloseTo(-8);
    expect(m[1].to.x).toBeCloseTo(12);
    expect(m[1].to.z).toBeCloseTo(-10);
    expect(m[1].cw).toBe(true);
  });
  it('works inside a G71 profile and reports misuse', () => {
    const src = `G00 X52 Z2\nG71 U2 R0.5\nG71 P10 Q20 U0.4 W0.1 F0.25\nN10 G00 X20\nG01 Z-20 ,R3 F0.1\nX40 ,C1\nZ-30\nN20 X52`;
    expect(errs(src)).toEqual([]);
    expect(errs('G00 X20 Z2\nG01 Z-10 ,C2 F0.1\nM30').length).toBe(1);
    expect(errs('G00 X20 Z2\nG01 Z-10 ,C30 F0.1\nX24').length).toBe(1);
  });
});

describe('dog-leg rapids', () => {
  it('splits a diagonal rapid into a 45° part and a straight part', () => {
    const r = interpret('G00 X40 Z50\nG00 X20 Z2', cfg({ machine: { ...DEFAULT_MACHINE, rapidMode: 'dogleg' } }));
    const m = moves(r.ops);
    const last = m.slice(-2);
    expect(last[0].to.x).toBeCloseTo(10);
    expect(last[0].to.z).toBeCloseTo(40);
    expect(last[1].to).toEqual({ x: 10, z: 2 });
  });
});

describe('G71 type II and G76 chamfer', () => {
  const pocket = (first: string) => `G00 X52 Z2
G71 U2 R0.5
G71 P10 Q20 U0.4 W0.1 F0.25
N10 G00 ${first}
G01 Z-10 F0.1
X30 Z-20
Z-30
X44 Z-40
Z-50
N20 X52`;
  it('type II roughs the pocket, type I leaves it', () => {
    const run = (src: string) => {
      const s: StockDef = { diameter: 50, length: 100, bore: 0, faceAllowance: 1, gripLength: 30, material: 'steel' };
      const r = interpret('T0101\nG50 S2500\nG96 S200 M03\n' + src + '\nM30', cfg());
      const st = new Stock(s);
      const m = new Machine(st, tools, DEFAULT_MACHINE);
      m.load(r.ops);
      m.status = 'running';
      for (let i = 0; i < 20000 && m.status === 'running'; i++) m.advance(5);
      expect(m.events.filter((e) => e.type === 'alarm')).toEqual([]);
      return st.radiusAt(-25);
    };
    expect(run(pocket('X44 W0'))).toBeLessThan(15.5); // pocket floor Ø30 + allowance
    expect(errs(pocket('X44 W0'))).toEqual([]);
    expect(errs(pocket('X44'))[0].message).toContain('type I');
  });
  it('G76 rr adds a 45° run-out', () => {
    const r = interpret('G97 S600 M03\nG00 X26 Z6\nG76 P021060 Q50 R0.05\nG76 X21.546 Z-29 P1227 Q350 F2', cfg());
    const th = moves(r.ops).filter((m) => m.type === 'thread');
    const runout = th.filter((m) => m.label === 'G76 run-out chamfer');
    expect(runout.length).toBeGreaterThan(5);
    expect(runout[0].to.z).toBe(-29);
    expect(runout[0].from.z).toBeCloseTo(-29 + 2); // rr = 10 → 1.0 × lead
  });
});

import { defaultSpec, generate, checkSpec } from '../src/content/wizardGen';
import { checkPart } from '../src/sim/inspect';
import { DEFAULT_STOCK } from '../src/defaults';

describe('program wizard', () => {
  const runSpec = (spec: ReturnType<typeof defaultSpec>) => {
    expect(checkSpec(spec)).toEqual([]);
    const { code, target } = generate(spec, tools);
    const r = interpret(code, cfg({ stock: spec.stock }));
    expect(r.diags.filter((d) => d.severity === 'error'), code).toEqual([]);
    const st = new Stock(spec.stock);
    const m = new Machine(st, tools, DEFAULT_MACHINE);
    m.load(r.ops);
    m.status = 'running';
    for (let i = 0; i < 40000 && m.status === 'running'; i++) m.advance(5);
    expect(m.events.filter((e) => e.type === 'alarm'), code).toEqual([]);
    const res = checkPart(st, target, DEFAULT_MACHINE);
    expect(res.pass, res.summary.join('; ') + '\n' + code + '\n' + JSON.stringify(res.samples.filter((s) => Math.abs(s.dev) > 0.05).slice(0, 4))).toBe(true);
    return { code, st };
  };
  it('default part: rough, finish, groove, thread, part-off', () => {
    const { st } = runSpec(defaultSpec(DEFAULT_STOCK));
    expect(st.dropped).not.toBeNull();
  });
  it('profile with a pocket uses G71 type II', () => {
    const spec = defaultSpec(DEFAULT_STOCK);
    spec.points = [
      { d: 30, z: 0, corner: 'C', size: 1 },
      { d: 30, z: -10, corner: 'none', size: 0 },
      { d: 22, z: -18, corner: 'none', size: 0 },
      { d: 22, z: -26, corner: 'none', size: 0 },
      { d: 34, z: -34, corner: 'none', size: 0 },
      { d: 34, z: -45, corner: 'none', size: 0 },
    ];
    spec.groove.enabled = false;
    spec.thread.enabled = false;
    spec.partoff.length = 42;
    expect(checkSpec(spec, tools).some((m) => m.includes('back-facing'))).toBe(true);
    spec.rough.tool = 2; // 35° insert follows the slope
    expect(checkSpec(spec, tools)).toEqual([]);
    const { code } = runSpec(spec);
    expect(code).toContain('W0');
  });
});

import { targetFromStock } from '../src/sim/inspect';
import { EXAMPLES } from '../src/content/examples';

describe('exercise builder', () => {
  it('a target taken from the machined part accepts that part', () => {
    for (const id of ['g71', 'drill', 'complete']) {
      const ex = EXAMPLES.find((e) => e.id === id)!;
      const r = interpret(ex.code, cfg({ stock: ex.stock }));
      const st = new Stock(ex.stock);
      const m = new Machine(st, tools, DEFAULT_MACHINE);
      m.load(r.ops);
      m.status = 'running';
      m.optionalStop = false;
      for (let i = 0; i < 40000 && (m.status as string) !== 'done'; i++) {
        m.status = 'running';
        m.advance(5);
      }
      const t = targetFromStock(st);
      expect(t.outer.split('\n').length).toBeGreaterThanOrEqual(2);
      if (id === 'drill') expect(t.inner.length).toBeGreaterThan(0);
      const res = checkPart(st, { outer: t.outer, inner: t.inner || undefined, tol: 0.02 }, DEFAULT_MACHINE);
      expect(res.pass, id + ': ' + res.summary.join('; ')).toBe(true);
    }
  });
});
