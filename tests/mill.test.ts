import { describe, expect, it } from 'vitest';
import { interpretMill, type MillConfig } from '../src/mill/interp';
import { defaultMillTools, defaultMillOffsets, envelope } from '../src/mill/tools';
import { DEFAULT_MILL, DEFAULT_BLOCK, DEFAULT_MILL_WORK } from '../src/mill/defaults';
import { BlockModel } from '../src/mill/stock';
import { MillMachine } from '../src/mill/machine';
import type { BlockStock, MillMove, MillOp } from '../src/mill/types';

const tools = defaultMillTools();
const cfg = (extra: Partial<MillConfig> = {}): MillConfig => ({
  tools,
  offsets: defaultMillOffsets(tools),
  settings: DEFAULT_MILL,
  workOffsets: DEFAULT_MILL_WORK,
  blockSkip: false,
  stock: DEFAULT_BLOCK,
  ...extra,
});
const moves = (ops: MillOp[]) => ops.filter((o): o is MillMove => o.kind === 'move');
const errs = (src: string) => interpretMill(src, cfg()).diags.filter((d) => d.severity === 'error');

export function runMill(code: string, stock: BlockStock = DEFAULT_BLOCK) {
  const r = interpretMill(code, cfg({ stock }));
  const block = new BlockModel(stock);
  const m = new MillMachine(block, tools, DEFAULT_MILL);
  m.load(r.ops);
  m.status = 'running';
  m.optionalStop = false;
  for (let n = 0; n < 100000; n++) {
    const s = m.status as string;
    if (s === 'stopped') m.status = 'running';
    else if (s !== 'running') break;
    m.advance(5);
  }
  return { r, m, block };
}

describe('tool envelopes', () => {
  const byId = (id: number) => tools.find((t) => t.id === id)!;
  it('ball, drill, chamfer, bull', () => {
    expect(envelope(byId(8), 0)).toBe(0);
    expect(envelope(byId(8), 4)).toBeCloseTo(4);
    expect(envelope(byId(4), 2)).toBeCloseTo(2); // 90° spot drill
    expect(envelope(byId(9), 0.5)).toBe(0);
    expect(envelope(byId(9), 3)).toBeCloseTo(2.5);
    expect(envelope(byId(10), 5)).toBe(0);
    expect(envelope(byId(10), 6)).toBeCloseTo(1);
    expect(envelope(byId(2), 6)).toBe(Infinity);
  });
});

describe('mill interpreter', () => {
  it('G43 puts the tip on the programmed Z; without G43 it is one tool length lower', () => {
    const a = moves(interpretMill('T2 M06\nG43 H2 G00 X10 Y10 Z5', cfg()).ops).pop()!;
    expect(a.to).toEqual({ x: 10, y: 10, z: 5 });
    const b = moves(interpretMill('T2 M06\nG00 X10 Y10 Z5', cfg()).ops).pop()!;
    expect(b.to.z).toBeCloseTo(5 - 75);
  });
  it('M06 goes to the tool-change height and stops the spindle', () => {
    const r = interpretMill('T2 M06\nS3000 M03\nG43 H2 G00 X0 Y0 Z10\nT3 M06', cfg());
    const last = r.ops[r.ops.length - 1];
    expect(r.ops.some((o) => o.kind === 'spindle' && o.spindle.dir === 'off')).toBe(true);
    expect(last.kind === 'end' || last.kind === 'tool').toBe(true);
    const m = moves(r.ops).pop()!;
    expect(m.label).toContain('tool-change');
  });
  it('G17 arcs with I/J and R, helical Z', () => {
    const r = interpretMill('G90 G00 X10 Y0 Z0\nG03 X0 Y10 I-10 J0 Z-2 F100', cfg({ tools: tools.map((t) => ({ ...t, length: 0 })) }));
    const a = moves(r.ops).pop()!;
    expect(a.type).toBe('arc');
    expect(a.center!.x).toBeCloseTo(0);
    expect(a.center!.y).toBeCloseTo(0);
    expect(a.cw).toBe(false);
    expect(errs('G00 X10 Y0\nG02 X0 Y10 R3 F100').length).toBe(1);
  });
  it('G91 incremental, G16 polar, G68 rotation', () => {
    const t0 = tools.map((t) => ({ ...t, length: 0 }));
    const inc = moves(interpretMill('G00 X10 Y10 Z0\nG91 G01 X5 Y-2 F100', cfg({ tools: t0 })).ops).pop()!;
    expect(inc.to).toEqual({ x: 15, y: 8, z: 0 });
    const pol = moves(interpretMill('G00 X0 Y0 Z0\nG16\nG01 X20 Y90 F100', cfg({ tools: t0 })).ops).pop()!;
    expect(pol.to.x).toBeCloseTo(0);
    expect(pol.to.y).toBeCloseTo(20);
    const rot = moves(interpretMill('G00 X0 Y0 Z0\nG68 X0 Y0 R90\nG01 X10 Y0 F100', cfg({ tools: t0 })).ops).pop()!;
    expect(rot.to.x).toBeCloseTo(0);
    expect(rot.to.y).toBeCloseTo(10);
  });
  it('drilling cycles: G81 holes, G98/G99 levels, G83 pecks, K repeats', () => {
    const t0 = tools.map((t) => ({ ...t, length: 0 }));
    const r = interpretMill('G00 X10 Y10 Z20\nG99 G81 R2 Z-10 F100\nX30\nG98 X50\nG80', cfg({ tools: t0 }));
    const m = moves(r.ops);
    const drills = m.filter((x) => x.label === 'G81 drill');
    expect(drills.length).toBe(3);
    expect(m[m.length - 1].to.z).toBe(20); // G98 back to the initial level
    const p = moves(interpretMill('G00 X0 Y0 Z10\nG83 R1 Z-10 Q3. F100\nG80', cfg({ tools: t0 })).ops).filter((x) => x.label?.includes('peck'));
    expect(p.length).toBe(4);
    const k = moves(interpretMill('G00 X0 Y0 Z10\nG91 G81 X10 R-8 Z-5 K4 F100\nG80', cfg({ tools: t0 })).ops).filter((x) => x.label === 'G81 drill');
    expect(k.map((x) => x.to.x)).toEqual([10, 20, 30, 40]);
    expect(k[0].to.z).toBeCloseTo(-3);
  });
  it('cutter compensation offsets the path by the D radius', () => {
    const t0 = tools.map((t) => ({ ...t, length: 0 }));
    const src = 'T2 M06\nS3000 M03\nG00 X-20 Y-20 Z-5\nG41 D2 G01 X0 Y-10 F300\nY50\nX60\nY0\nX-10\nG40 G00 X-20 Y-20';
    const r = interpretMill(src, cfg({ tools: t0 }));
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    const m = moves(r.ops);
    // the cut along Y at X0 is done with the tool centre at X-5 (left of travel = outside)
    const alongY = m.find((x) => Math.abs(x.to.y - 50) < 1e-6 || (x.type === 'linear' && Math.abs(x.to.x + 5) < 1e-6 && x.to.y > 40));
    expect(alongY!.to.x).toBeCloseTo(-5);
    expect(m.some((x) => x.type === 'arc' && x.label === 'cutter radius corner')).toBe(true);
  });
  it(',C and ,R corners in G17', () => {
    const t0 = tools.map((t) => ({ ...t, length: 0 }));
    const m = moves(interpretMill('G00 X0 Y0 Z0\nG01 X20 ,C2 F100\nY20', cfg({ tools: t0 })).ops).slice(1);
    expect(m.map((x) => [x.to.x, x.to.y])).toEqual([[18, 0], [20, 2], [20, 20]]);
  });
  it('macro loop drives a series of moves', () => {
    const t0 = tools.map((t) => ({ ...t, length: 0 }));
    const r = interpretMill('#1 = 0\nWHILE [#1 LT 3] DO 1\nG00 X[#1 * 10] Y0 Z5\n#1 = #1 + 1\nEND 1\nM30', cfg({ tools: t0 }));
    expect(moves(r.ops).map((m) => m.to.x)).toEqual([0, 10, 20]);
  });
});

describe('mill machine', () => {
  it('faces, pockets and drills the block', () => {
    const code = `T1 M06
S2000 M03
G54 G90 G43 H1 G00 X-30 Y20 Z5
G01 Z0 F800
X130
Y60
X-30
G00 Z50
T2 M06
S6000 M03
G43 H2 G00 X30 Y30 Z5
G01 Z-5 F200
X60 F600
Y50
X30
Y30
G00 Z50
T7 M06
S2000 M03
G43 H7 G00 X80 Y40 Z20
G99 G81 R2 Z-20 F150
G80
G00 Z100
M30`;
    const { r, m, block } = runMill(code);
    expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
    expect(m.events.filter((e) => e.type === 'alarm')).toEqual([]);
    expect(m.status).toBe('done');
    expect(block.heightAt(5, 5)).toBeCloseTo(0, 3); // faced to Z0
    expect(block.heightAt(31, 31)).toBeCloseTo(-5, 3); // slot floor along the path
    expect(block.heightAt(45, 40)).toBeCloseTo(0, 3); // island left inside a single loop
    expect(block.heightAt(80, 40)!).toBeLessThan(-19); // drilled hole
    expect(m.engageTime.slot + m.engageTime.climb + m.engageTime.conventional).toBeGreaterThan(0);
  });
  it('detects a missing G43 (tool dives into the part)', () => {
    const { m } = runMill('T2 M06\nS6000 M03\nG00 X30 Y30 Z5\nG01 Z-2 F200\nM30');
    expect(m.events.some((e) => e.type === 'alarm')).toBe(true);
  });
  it('detects a face mill plunging and a vise collision', () => {
    const a = runMill('T1 M06\nS2000 M03\nG43 H1 G00 X50 Y40 Z5\nG01 Z-2 F300\nM30').m;
    expect(a.events.find((e) => e.type === 'alarm')?.message).toContain('plunge');
    const b = runMill('T2 M06\nS6000 M03\nG43 H2 G00 X50 Y-8 Z5\nG01 Z-20 F300\nM30').m;
    expect(b.events.find((e) => e.type === 'alarm')?.message).toContain('vise');
  });
});

import { defaultMillSpec, generateMill, checkMillSpec } from '../src/mill/wizardGen';

describe('milling wizard', () => {
  it('default plate: face, pocket, circular pocket, spot/drill/tap grid', () => {
    const spec = defaultMillSpec(DEFAULT_BLOCK);
    expect(checkMillSpec(spec, tools)).toEqual([]);
    const code = generateMill(spec, tools);
    const { r, m, block } = runMill(code, spec.stock);
    expect(r.diags.filter((d) => d.severity === 'error'), code).toEqual([]);
    expect(r.diags.filter((d) => d.severity === 'warning'), code).toEqual([]);
    expect(m.events.filter((e) => e.type === 'alarm'), code).toEqual([]);
    expect(m.status).toBe('done');
    expect(block.heightAt(5, 5)).toBeCloseTo(0, 3);
    expect(block.heightAt(32, 40)).toBeCloseTo(-6, 3); // pocket centre
    expect(block.heightAt(16, 27)).toBeCloseTo(-6, 3); // near the pocket corner
    expect(block.heightAt(75, 40)).toBeCloseTo(-8, 3); // circular pocket centre
    expect(block.heightAt(85, 40)).toBeCloseTo(-8, 3);
    expect(block.heightAt(15, 15)!).toBeLessThan(-14); // tapped hole
  });
  it('boss, slot and bolt circle', () => {
    const spec = defaultMillSpec(DEFAULT_BLOCK);
    spec.features = [
      { kind: 'face', z: 0, tool: 1 },
      { kind: 'boss', x: 50, y: 40, w: 40, l: 30, r: 5, depth: 5, step: 2.5, tool: 2, rings: 2 },
      { kind: 'slot', x1: 10, y1: 72, x2: 90, y2: 72, depth: 3, step: 1.5, tool: 3 },
      { kind: 'holes', pattern: 'circle', x: 50, y: 40, nx: 0, ny: 0, dx: 0, dy: 0, radius: 10, count: 6, angle: 0, depth: 10, spotTool: 4, drillTool: 5, tapTool: 6, tap: false },
    ];
    expect(checkMillSpec(spec, tools)).toEqual([]);
    const code = generateMill(spec, tools);
    const { r, m, block } = runMill(code, spec.stock);
    expect(r.diags.filter((d) => d.severity === 'error'), code).toEqual([]);
    expect(m.events.filter((e) => e.type === 'alarm'), code).toEqual([]);
    expect(block.heightAt(50, 40)).toBeCloseTo(0, 3); // boss top
    expect(block.heightAt(50 + 20 + 3, 40)).toBeCloseTo(-5, 3); // around the boss
    expect(block.heightAt(50, 72)).toBeCloseTo(-3, 3); // slot
    expect(block.heightAt(60, 40)!).toBeLessThan(-9); // bolt circle hole at angle 0
  });
});

import { MILL_EXAMPLES } from '../src/mill/content/examples';

describe('milling examples run cleanly', () => {
  for (const ex of MILL_EXAMPLES) {
    it(ex.title, () => {
      const { r, m } = runMill(ex.code, ex.stock);
      const errs = r.diags.filter((d) => d.severity === 'error');
      expect(errs, JSON.stringify(errs)).toEqual([]);
      const alarms = m.events.filter((e) => e.type === 'alarm');
      expect(alarms, JSON.stringify(alarms)).toEqual([]);
      expect(m.status).toBe('done');
    });
  }
  it('dome example produces a dome', () => {
    const ex = MILL_EXAMPLES.find((e) => e.id === 'm-dome')!;
    const { block } = runMill(ex.code, ex.stock);
    expect(block.heightAt(50, 40)!).toBeGreaterThan(-0.3);
    expect(block.heightAt(50, 40)!).toBeLessThan(0.05);
    // sphere R29 centred at Z-29: at r = 12 the surface is at Z ≈ -2.6
    expect(block.heightAt(62, 40)!).toBeCloseTo(-29 + Math.sqrt(29 * 29 - 144), 0);
    expect(block.heightAt(50 + 27, 40)!).toBeCloseTo(-8, 1);
  });
});

import { MILL_EXERCISES } from '../src/mill/content/exercises';
import { simulateBlock, checkBlock } from '../src/mill/inspect';

describe('milling exercises', () => {
  for (const ex of MILL_EXERCISES) {
    it(ex.title, () => {
      const { r, m, block } = runMill(ex.solution, ex.stock);
      expect(r.diags.filter((d) => d.severity === 'error')).toEqual([]);
      expect(m.events.filter((e) => e.type === 'alarm'), JSON.stringify(m.events.filter((e) => e.type === 'alarm'))).toEqual([]);
      const ref = simulateBlock(ex.solution, ex.stock, cfg());
      expect(checkBlock(block, ref, ex.tol).pass).toBe(true);
      const starter = runMill(ex.starter, ex.stock).block;
      expect(checkBlock(starter, ref, ex.tol).pass).toBe(false);
    });
  }
  it('a different strategy for the same part passes M1', () => {
    const ex = MILL_EXERCISES[0];
    const alt = `T01 M06
S2800 M03
G54 G43 H01 G00 X-30. Y15. Z25.
Z2.
G01 Z0 F1200
X130.
G00 Y50.
G01 X-30.
G00 Y70.
G01 X130.
G00 Z25.
T02 M06
S8000 M03
G43 H02 G00 X35. Y40. Z5.
G01 Z-5. F200
X65. F1000
Y55.
X35.
Y25.
X65.
Y40.
Y35.
X40.
Y45.
X60.
G00 Z25.
M30`;
    const { block, m } = runMill(alt, ex.stock);
    expect(m.events.filter((e) => e.type === 'alarm')).toEqual([]);
    const ref = simulateBlock(ex.solution, ex.stock, cfg());
    const res = checkBlock(block, ref, ex.tol);
    expect(res.pass, res.summary.join('; ')).toBe(true);
    // a pocket 1 mm too shallow fails
    const shallow = runMill(alt.replace('Z-5. F200', 'Z-4. F200'), ex.stock).block;
    expect(checkBlock(shallow, ref, ex.tol).pass).toBe(false);
  });
});

import { blockFrame } from '../src/mill/stock';
import type { MillSettings } from '../src/mill/types';

describe('programming conventions & automatic work zero', () => {
  const auto = (o: Partial<MillSettings>) => ({ ...DEFAULT_MILL, ...o });
  const runWith = (code: string, settings: MillSettings, stock: BlockStock = DEFAULT_BLOCK, offsets = defaultMillOffsets(tools)) => {
    const r = interpretMill(code, cfg({ settings, stock, offsets }));
    const block = new BlockModel(stock);
    const m = new MillMachine(block, tools, settings);
    m.load(r.ops);
    m.status = 'running';
    for (let n = 0; n < 100000 && (m.status as string) === 'running'; n++) m.advance(5);
    return { r, m, block };
  };

  it('automatic length compensation: Z is the tool tip after M06 without G43', () => {
    const s = auto({ autoLength: true });
    const r = interpretMill('T2 M06\nG00 X10 Y10 Z5\nT8 M06\nG00 Z3\nG49 G00 Z200', cfg({ settings: s }));
    const mv = moves(r.ops);
    expect(mv.find((m) => m.line === 1)!.to.z).toBeCloseTo(5);
    expect(mv.find((m) => m.line === 3)!.to.z).toBeCloseTo(3);
    expect(mv.find((m) => m.line === 4)!.to.z).toBeCloseTo(200); // G49 (safe-start line) keeps the automatic length
    const ex = moves(interpretMill('T2 M06\nG43 H8 G00 Z5\nG49 Z5', cfg({ settings: s })).ops);
    expect(ex[ex.length - 2].to.z).toBeCloseTo(5 + 70 - 75); // explicit (wrong) H8 overrides
    expect(ex[ex.length - 1].to.z).toBeCloseTo(5); // G49 returns to automatic
    expect(r.diags.some((d) => d.message.includes('No tool length compensation'))).toBe(false);
    expect(r.diags.some((d) => d.severity === 'info' && d.message.includes('Automatic length compensation'))).toBe(true);
    // length wear of the tool's own offset is applied too
    const offs = defaultMillOffsets(tools);
    offs.set(2, { ...offs.get(2)!, hw: -0.1 });
    const w = moves(interpretMill('T2 M06\nG00 X0 Y0 Z5', cfg({ settings: s, offsets: offs })).ops).pop()!;
    expect(w.to.z).toBeCloseTo(4.9);
    // the standard convention still warns
    expect(interpretMill('T2 M06\nG00 X0 Y0 Z5\nG01 Z-1 F100', cfg()).diags.some((d) => d.message.includes('No tool length compensation'))).toBe(true);
  });

  it('programmed point = nose-radius centre: ball centre, bull-nose corner centre, tip for flat tools', () => {
    const s = auto({ pointRef: 'center' });
    const z = (code: string) => moves(interpretMill(code, cfg({ settings: s })).ops).pop()!.to.z;
    expect(z('T8 M06\nG43 H8 G00 X50 Y40 Z-2')).toBeCloseTo(-6); // ball Ø8: tip 4 below the centre
    expect(z('T10 M06\nG43 H10 G00 X50 Y40 Z-2')).toBeCloseTo(-3); // bull-nose R1
    expect(z('T2 M06\nG43 H2 G00 X50 Y40 Z-2')).toBeCloseTo(-2); // flat end mill
    // machined: a ball plunged to Z0 (centre) leaves a hemispherical dimple 4 deep
    const { block, m } = runWith('T8 M06\nS6000 M03\nG43 H8 G00 X50 Y40 Z10\nG01 Z0 F200\nG00 Z50\nM30', s);
    expect(m.events.filter((e) => e.type === 'alarm')).toEqual([]);
    expect(block.heightAt(50, 40)!).toBeCloseTo(-4, 1);
  });

  it('automatic cutter radius: G41 without D uses the tool radius + D wear', () => {
    const prog = (d: string) => `T2 M06\nS6000 M03\nG43 H2 G00 X-20 Y-20 Z5\nG01 Z-2 F500\nG41${d} G01 X0 Y0\nY50\nX60\nG40 G01 X80 Y80\nM30`;
    const withD = moves(interpretMill(prog(' D2'), cfg()).ops);
    const r = interpretMill(prog(''), cfg({ settings: auto({ autoRadius: true }) }));
    expect(r.diags.some((d) => d.severity === 'warning' && d.message.includes('without D'))).toBe(false);
    expect(moves(r.ops).map((m) => m.to)).toEqual(withD.map((m) => m.to));
    const offs = defaultMillOffsets(tools);
    offs.set(2, { ...offs.get(2)!, dw: 0.05 });
    const worn = moves(interpretMill(prog(''), cfg({ settings: auto({ autoRadius: true }), offsets: offs })).ops);
    const leg = worn.find((m) => m.line === 5)!; // Y50 – the wall on the left of the X0 line
    expect(leg.to.x).toBeCloseTo(-5.05);
  });

  it('work zero at any top corner / centre, Z0 on the raw or finished top', () => {
    const b = { ...DEFAULT_BLOCK, sizeX: 100, sizeY: 80, sizeZ: 30, topAllowance: 1 };
    expect(blockFrame({ ...b, origin: 'corner' })).toMatchObject({ x0: 0, y0: 0, top: 1, finished: 0, bottom: -29 });
    expect(blockFrame({ ...b, origin: 'front-right' })).toMatchObject({ x0: -100, y0: 0 });
    expect(blockFrame({ ...b, origin: 'back-left' })).toMatchObject({ x0: 0, y0: -80 });
    expect(blockFrame({ ...b, origin: 'back-right' })).toMatchObject({ x0: -100, y0: -80, x1: 0, y1: 0 });
    expect(blockFrame({ ...b, origin: 'center' })).toMatchObject({ x0: -50, y0: -40 });
    expect(blockFrame({ ...b, origin: 'corner', zRef: 'raw' })).toMatchObject({ top: 0, finished: -1, bottom: -30 });
    const m = new BlockModel({ ...b, origin: 'back-right', zRef: 'raw' });
    expect([m.x0, m.y0, m.top, m.bottom]).toEqual([-100, -80, 0, -30]);
  });

  for (const origin of ['corner', 'front-right', 'back-left', 'back-right', 'center'] as const) {
    for (const zRef of ['finished', 'raw'] as const) {
      it(`wizard plate with X0 Y0 = ${origin}, Z0 = ${zRef} top, all automatic options`, () => {
        const settings = auto({ autoLength: true, autoRadius: true, pointRef: 'center' });
        const spec = defaultMillSpec({ ...DEFAULT_BLOCK, origin, zRef });
        spec.features.push({ kind: 'boss', x: 0, y: 0, w: 14, l: 10, r: 2, depth: 2, step: 1, tool: 10, rings: 1 });
        const g = blockFrame(spec.stock);
        spec.features[spec.features.length - 1] = { ...spec.features[spec.features.length - 1], x: g.x0 + 75, y: g.y0 + 40 } as typeof spec.features[0];
        // the circular pocket is moved away so the boss fits
        spec.features = spec.features.filter((f) => f.kind !== 'circle');
        expect(checkMillSpec(spec, tools)).toEqual([]);
        const code = generateMill(spec, tools, 8000, settings);
        expect(code).not.toMatch(/G43 Hd|G41 D/);
        const { r, m, block } = runWith(code, settings, spec.stock);
        expect(r.diags.filter((d) => d.severity !== 'info'), code).toEqual([]);
        expect(m.events.filter((e) => e.type === 'alarm'), code).toEqual([]);
        expect(m.status).toBe('done');
        const z0 = g.finished; // finished top in work coordinates
        expect(block.heightAt(g.x0 + 5, g.y0 + 5)).toBeCloseTo(z0, 2); // faced top
        expect(block.heightAt(g.x0 + 32, g.y0 + 40)).toBeCloseTo(z0 - 6, 2); // pocket floor
        expect(block.heightAt(g.x0 + 75, g.y0 + 40)).toBeCloseTo(z0, 2); // boss top
        expect(block.heightAt(g.x0 + 75 + 7 + 1.5, g.y0 + 40)).toBeCloseTo(z0 - 2, 2); // boss floor
        expect(block.heightAt(g.x0 + 15, g.y0 + 15)!).toBeLessThan(z0 - 14); // tapped hole
      });
    }
  }
});
