import { describe, expect, it } from 'vitest';
import { interpret } from '../src/gcode/interpreter';
import { defaultTools, defaultOffsets } from '../src/sim/tools';
import { DEFAULT_MACHINE, DEFAULT_STOCK, DEFAULT_WORK_OFFSETS } from '../src/defaults';
import { Stock } from '../src/sim/stock';
import { Machine } from '../src/sim/machine';
import { explainBlock } from '../src/gcode/explain';

const tools = defaultTools();
const cfg = { tools, offsets: defaultOffsets(tools), machine: DEFAULT_MACHINE, workOffsets: DEFAULT_WORK_OFFSETS, blockSkip: false, stock: DEFAULT_STOCK };
const sev = (src: string, s: string) => interpret(src, cfg).diags.filter((d) => d.severity === s);

describe('error handling', () => {
  it('accepts lower case and missing % / O', () => {
    expect(sev('g0 x40 z2\ng1 z-10 f0.2', 'error')).toEqual([]);
  });
  it('reports unknown codes, duplicate words and X+U', () => {
    expect(sev('G07 X10', 'error').length).toBe(1);
    expect(sev('G01 X10 X20 F0.1', 'error').length).toBe(1);
    expect(sev('G01 X10 U2 F0.1', 'error').length).toBe(1);
  });
  it('reports a missing G71 profile', () => {
    expect(sev('G00 X52 Z2\nG71 U2 R0.5\nG71 P10 Q20 U0.4 W0.1 F0.25', 'error').length).toBeGreaterThan(0);
  });
  it('stops endless sub-program recursion', () => {
    const r = interpret('O1\nM98 P2\nM30\nO2\nM98 P2\nM99', cfg);
    expect(r.diags.some((d) => d.severity === 'error')).toBe(true);
  });
  it('warns about missing feed and stopped spindle', () => {
    const r = interpret('G00 X40 Z2\nG01 Z-10', cfg);
    expect(r.diags.some((d) => d.message.includes('feed rate'))).toBe(true);
    expect(r.diags.some((d) => d.message.includes('spindle'))).toBe(true);
  });
  it('explains every block of a program without throwing', () => {
    const r = interpret('G71 U2 R1\nG71 P1 Q2 U0.4 W0.1 F0.2\nN1 G00 X10\nN2 G01 Z-5\nG76 P020060 Q50 R0.05\nM98 P31000\n/G04 P500', cfg);
    for (const b of r.blocks) expect(explainBlock(b).summary.length).toBeGreaterThan(0);
  });
});

describe('fuzz: random programs never throw', () => {
  const words = ['G00', 'G01', 'G02', 'G03', 'G04', 'G28', 'G32', 'G40', 'G41', 'G42', 'G50', 'G70', 'G71', 'G72', 'G73', 'G74', 'G75', 'G76', 'G90', 'G92', 'G94', 'G96', 'G97', 'G98', 'G99', 'M03', 'M05', 'M08', 'M98', 'M99', 'M30', 'T0101', 'T0202', 'T0303', 'T0505', 'T0707'];
  const axes = ['X', 'Z', 'U', 'W', 'R', 'I', 'K', 'F', 'S', 'P', 'Q'];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  it('400 random programs', () => {
    for (let n = 0; n < 400; n++) {
      const lines: string[] = [];
      const L = 5 + Math.floor(rnd() * 25);
      for (let i = 0; i < L; i++) {
        const parts = [`N${i + 1}`];
        if (rnd() < 0.7) parts.push(pick(words));
        const k = Math.floor(rnd() * 4);
        for (let j = 0; j < k; j++) {
          const a = pick(axes);
          const v = a === 'F' ? (rnd() * 0.5).toFixed(2) : a === 'S' ? String(Math.floor(rnd() * 3000)) : a === 'P' || a === 'Q' ? String(Math.floor(rnd() * 30)) : (rnd() * 120 - 60).toFixed(1);
          parts.push(a + v);
        }
        lines.push(parts.join(' '));
      }
      const src = lines.join('\n');
      let r;
      expect(() => (r = interpret(src, cfg)), src).not.toThrow();
      const m = new Machine(new Stock(DEFAULT_STOCK), tools, DEFAULT_MACHINE);
      m.load(r!.ops);
      m.status = 'running';
      expect(() => {
        for (let s = 0; s < 200 && m.status === 'running'; s++) m.advance(2);
      }, src).not.toThrow();
      for (const o of r!.ops) {
        if (o.kind === 'move') {
          expect(Number.isFinite(o.to.x) && Number.isFinite(o.to.z), src).toBe(true);
        }
      }
    }
  });
});
