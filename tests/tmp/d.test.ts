import { it } from 'vitest';
import { interpretMill } from '../../src/mill/interp';
import { defaultMillTools, defaultMillOffsets } from '../../src/mill/tools';
import { DEFAULT_MILL, DEFAULT_MILL_WORK, DEFAULT_BLOCK } from '../../src/mill/defaults';
import { BlockModel } from '../../src/mill/stock';
import { MillMachine } from '../../src/mill/machine';
it('d', () => {
  const tools = defaultMillTools();
  const r = interpretMill('T02 M06\nS6000 M03\nG00 X50. Y40. Z5.\nG01 Z-2. F300', { tools, offsets: defaultMillOffsets(tools), settings: DEFAULT_MILL, workOffsets: DEFAULT_MILL_WORK, blockSkip: false });
  console.log(r.ops.map((o) => o.kind === 'move' ? `${o.type} ${JSON.stringify(o.to)}` : o.kind).join('\n'));
  const m = new MillMachine(new BlockModel(DEFAULT_BLOCK), tools, DEFAULT_MILL);
  m.load(r.ops.filter((o) => o.kind !== 'end'));
  m.status = 'running';
  const t0 = Date.now();
  for (let i = 0; i < 2000 && m.status === "running"; i++) { m.advance(0.05); }
  console.log('status', m.status, 'ms', Date.now() - t0, m.events.map((e) => e.message));
});
