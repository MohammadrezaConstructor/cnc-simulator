// Fanuc-style lathe G-code interpreter (Group A G-code system, diameter programming).
//
// Produces a flat list of primitive operations (moves in RADIUS coordinates of the tool
// control point, tool changes, spindle/coolant events, stops) plus diagnostics.

import type {
  Diagnostic,
  MachineSettings,
  MoveOp,
  MoveType,
  OffsetEntry,
  Op,
  P,
  SpindleState,
  StockDef,
  ToolDef,
} from '../types';
import { lexProgram, type Block, type Word } from './lexer';
import * as CY from './cycles';
import { applyTNRC, type CompInfo } from './tnrc';
import { dist, sub, add, mul, norm, leftN, rightN, dot, cross, EPS } from '../sim/geom';
import { evalExpr, type Vars } from './macro';

export interface InterpState {
  /** programmed position in the active work coordinate system (radius) */
  pos: P;
  /** actual control-point position in simulator (G54) coordinates incl. wear */
  tip: P;
  motion: number;
  feedPerRev: boolean;
  feed: number;
  spindle: SpindleState;
  coolant: boolean;
  tool: number;
  offset: number;
  comp: 40 | 41 | 42;
  inch: boolean;
  work: number;
  /** extra shift from G50 X_ Z_ (radius coords) */
  g50: P;
  cyc: { x1: number; z1: number; r: number } | null;
  g71: { d: number; e: number };
  g72: { d: number; e: number };
  g73: { i: number; k: number; d: number };
  g74e: number;
  g75e: number;
  g76: { m: number; r: number; a: number; dmin: number; fin: number };
}

export interface InterpConfig {
  tools: ToolDef[];
  offsets: Map<number, OffsetEntry>;
  machine: MachineSettings;
  /** G54..G59 → shift (radius coords) relative to the simulator origin */
  workOffsets: Record<number, P>;
  blockSkip: boolean;
  stock?: StockDef;
  /** emit "teaching" info-level hints */
  hints?: boolean;
  /** initial macro variables (#100…, #500…) */
  vars?: Vars;
}

/** modal state snapshot after a block (for the DRO / block explainer) */
export interface ModalSnap {
  motion: number;
  feedPerRev: boolean;
  css: boolean;
  comp: 40 | 41 | 42;
  tool: number;
  offset: number;
  work: number;
  inch: boolean;
  feed: number;
  s: number;
  maxRpm: number;
}

export interface InterpResult {
  /** modal state after each executed source line */
  modal: Map<number, ModalSnap>;
  ops: Op[];
  diags: Diagnostic[];
  state: InterpState;
  blocks: Block[];
  /** thread zones produced (for helical 3D rendering) */
  threads: { z0: number; z1: number; lead: number; xMin: number; xMax: number }[];
  /** macro variables at program end */
  vars: Vars;
  /** values of macro variables after each executed macro line (for the explainer) */
  varTrace: Map<number, string>;
}

export function homePos(m: MachineSettings): P {
  return { x: m.homeX / 2, z: m.homeZ };
}

export function defaultState(m: MachineSettings): InterpState {
  const h = homePos(m);
  return {
    pos: { ...h },
    tip: { ...h },
    motion: 0,
    feedPerRev: true,
    feed: 0,
    spindle: { mode: 'rpm', s: 0, maxRpm: m.maxRpm, dir: 'off' },
    coolant: false,
    tool: 1,
    offset: 0,
    comp: 40,
    inch: false,
    work: 54,
    g50: { x: 0, z: 0 },
    cyc: null,
    g71: { d: 2, e: 0.5 },
    g72: { d: 2, e: 0.5 },
    g73: { i: 0, k: 0, d: 1 },
    g74e: 0.5,
    g75e: 0.5,
    g76: { m: 1, r: 0, a: 60, dmin: 0.05, fin: 0.05 },
  };
}

const cloneState = (s: InterpState): InterpState => JSON.parse(JSON.stringify(s));

const KNOWN_G = new Set([0, 1, 2, 3, 4, 18, 20, 21, 28, 32, 33, 40, 41, 42, 50, 54, 55, 56, 57, 58, 59, 70, 71, 72, 73, 74, 75, 76, 90, 92, 94, 96, 97, 98, 99]);
const MOTION_G = new Set([0, 1, 2, 3, 32, 33, 90, 92, 94]);
const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 30, 98, 99, 40, 41, 42, 43, 44]);

interface Ctl {
  next?: number;
  end?: boolean;
}

class Interpreter {
  ops: Op[] = [];
  comp: (CompInfo | undefined)[] = [];
  diags: Diagnostic[] = [];
  private seen = new Set<string>();
  st: InterpState;
  blocks: Block[];
  private capture: CY.Seg[] | null = null;
  private labels = new Map<number, number>();
  private guard = 0;
  private hadT = false;
  private hadSpindleStart = false;
  private hintedTaper = false;
  private warnedCssNoClamp = false;
  private feedSinceThread = true;
  threads: InterpResult['threads'] = [];
  modal = new Map<number, ModalSnap>();
  private stack: { ret: number; label: number; repeat: number }[] = [];
  vars: Vars;
  varTrace = new Map<number, string>();
  /** G01 block with ,C / ,R waiting for the next move to build the corner */
  private corner: { kind: ',C' | ',R'; size: number; from: P; corner: P; line: number } | null = null;

  constructor(blocks: Block[], private cfg: InterpConfig, init: InterpState) {
    this.blocks = blocks;
    this.st = cloneState(init);
    this.vars = new Map(cfg.vars ?? []);
    blocks.forEach((b, i) => {
      if (b.o !== undefined && !this.labels.has(b.o)) this.labels.set(b.o, i);
    });
  }

  diag(line: number, severity: Diagnostic['severity'], message: string, hint?: string) {
    const k = `${line}|${message}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.diags.push({ line, severity, message, hint });
  }

  // ----------------------------------------------------------------- coordinates

  private wear(): P {
    const o = this.st.offset ? this.cfg.offsets.get(this.st.offset) : undefined;
    return o ? { x: o.wx / 2, z: o.wz } : { x: 0, z: 0 };
  }
  private shift(): P {
    const w = this.cfg.workOffsets[this.st.work] ?? { x: 0, z: 0 };
    return add(w, this.st.g50);
  }
  /** programmed → simulator control point */
  toSim(p: P): P {
    return add(add(p, this.shift()), this.wear());
  }
  /** simulator control point → programmed */
  toProg(p: P): P {
    return sub(sub(p, this.shift()), this.wear());
  }

  private tool(): ToolDef | undefined {
    return this.cfg.tools.find((t) => t.id === this.st.tool);
  }

  // ----------------------------------------------------------------- emit

  emitMove(type: MoveType, target: P, line: number, extra: Partial<MoveOp> = {}, comp = true) {
    if (this.capture) {
      if (type === 'thread') {
        this.diag(line, 'error', 'Threading moves are not allowed inside a G70–G73 finishing profile');
        return;
      }
      this.capture.push({
        type: type === 'arc' ? 'arc' : type === 'rapid' ? 'rapid' : 'linear',
        from: { ...this.st.pos },
        to: { ...target },
        center: extra.center ? { ...extra.center } : undefined,
        cw: extra.cw,
        line,
      });
      this.st.pos = { ...target };
      return;
    }
    const to = this.toSim(target);
    const center = extra.center ? this.toSim(extra.center) : undefined;
    const op: MoveOp = {
      kind: 'move',
      type,
      from: { ...this.st.tip },
      to,
      feed: type === 'thread' ? (extra.feed ?? this.st.feed) : this.st.feed,
      feedPerRev: type === 'thread' ? true : this.st.feedPerRev,
      spindle: { ...this.st.spindle },
      line,
      tool: this.st.tool,
      ...extra,
      center,
    };
    if (type !== 'rapid' && op.feed <= 0 && type !== 'thread') {
      this.diag(line, 'error', 'Feed move without a feed rate (F) – the control would alarm (no F command).');
    }
    if (type !== 'rapid' && this.st.spindle.dir === 'off') {
      this.diag(
        line,
        'warning',
        'Feed move while the spindle is stopped (M03/M04 missing).',
        'Cutting with the spindle stopped will crash the tool. Start the spindle with M03 S... before cutting.',
      );
    }
    // non-linear ("dog-leg") rapid: both axes at full speed until one arrives
    if (type === 'rapid' && this.cfg.machine.rapidMode === 'dogleg' && !(comp && this.st.comp !== 40)) {
      const dx = to.x - op.from.x, dz = to.z - op.from.z;
      const m = Math.min(Math.abs(dx), Math.abs(dz));
      if (m > 1e-6 && Math.abs(Math.abs(dx) - Math.abs(dz)) > 1e-6) {
        const mid = { x: op.from.x + Math.sign(dx) * m, z: op.from.z + Math.sign(dz) * m };
        this.ops.push({ ...op, to: mid, label: (op.label ? op.label + ' · ' : '') + 'dog-leg rapid (45°)' });
        this.comp.push(undefined);
        op.from = { ...mid };
      }
    }
    this.ops.push(op);
    const t = this.tool();
    const o = this.st.offset ? this.cfg.offsets.get(this.st.offset) : undefined;
    this.comp.push(
      comp && this.st.comp !== 40 && !op.cycle
        ? { side: this.st.comp, r: o?.r ?? t?.noseR ?? 0, t: o?.t ?? t?.tipNo ?? 0 }
        : undefined,
    );
    this.st.tip = to;
    this.st.pos = { ...target };
  }

  private push(op: Op) {
    if (this.capture) return;
    this.ops.push(op);
    this.comp.push(undefined);
  }

  // ----------------------------------------------------------------- run

  run(): void {
    let pc = 0;
    // the first O-number in the file is the main program, later ones are sub-programs
    const mainIdx = this.blocks.findIndex((b) => b.o !== undefined);
    while (pc < this.blocks.length) {
      const b = this.blocks[pc];
      if (pc > mainIdx && b.o !== undefined && this.stack.length === 0) {
        this.diag(b.line, 'warning', `Main program ran into sub-program O${b.o} – end the main program with M30.`);
        break;
      }
      const c = this.step(pc);
      if (c.end) return;
      pc = c.next ?? pc + 1;
    }
    this.flushCorner();
    const last = this.blocks.length ? this.blocks[this.blocks.length - 1].line : 0;
    if (!this.ops.some((o) => o.kind === 'end')) {
      this.diag(last, 'info', 'Program has no M30 (program end & rewind).');
      this.push({ kind: 'end', line: last, rewind: false });
    }
  }

  /** execute a block range [a,b] (used by G70) */
  private runRange(a: number, b: number) {
    let pc = a;
    while (pc <= b && pc < this.blocks.length) {
      const c = this.step(pc, true);
      if (c.end) return;
      pc = c.next ?? pc + 1;
    }
    this.flushCorner();
  }

  private step(pc: number, inRange = false): Ctl {
    if (++this.guard > 200000 || this.ops.length > 400000) {
      this.diag(this.blocks[pc].line, 'error', 'Program too long or endless loop (M99/M98) – execution aborted.');
      return { end: true };
    }
    const b = this.blocks[pc];
    for (const e of b.errors) this.diag(e.line, e.severity, e.message);
    if (b.blockDelete && this.cfg.blockSkip) return {};
    if (b.macro) {
      try {
        return this.macro(b, pc);
      } catch (err) {
        this.diag(b.line, 'error', (err as Error).message);
        return { end: true };
      }
    }
    if (b.words.length === 0) return {};
    try {
      return this.exec(b, pc, inRange);
    } catch (err) {
      this.diag(b.line, 'error', (err as Error).message);
      return {};
    } finally {
      if (!this.capture && !this.modal.has(b.line)) {
        const s = this.st;
        this.modal.set(b.line, {
          motion: s.motion, feedPerRev: s.feedPerRev, css: s.spindle.mode === 'css', comp: s.comp,
          tool: s.tool, offset: s.offset, work: s.work, inch: s.inch, feed: s.feed, s: s.spindle.s, maxRpm: s.spindle.maxRpm,
        });
      }
    }
  }

  // ----------------------------------------------------------------- block execution

  private exec(b0: Block, pc: number, inRange: boolean): Ctl {
    const b = this.resolveWords(b0);
    const L = b.line;
    const st = this.st;
    const gs: number[] = [];
    const ms: number[] = [];
    const w: Record<string, Word> = {};
    for (const wd of b.words) {
      if (wd.letter === 'G') {
        const g = Math.round(wd.value * 10) / 10;
        if (!KNOWN_G.has(g)) this.diag(L, 'error', `G${wd.raw} is not supported`);
        else gs.push(g);
      } else if (wd.letter === 'M') {
        const m = Math.round(wd.value);
        if (!KNOWN_M.has(m)) this.diag(L, 'warning', `M${wd.raw} is not supported – ignored`);
        ms.push(m);
      } else {
        if (w[wd.letter]) throw new Error(`Address ${wd.letter} appears twice in one block`);
        w[wd.letter] = wd;
      }
    }
    if (ms.filter((m) => m !== 98).length > 1) this.diag(L, 'warning', 'More than one M-code in a block – many controls allow only one.');

    // ---- modal codes that affect the interpretation of this block
    if (gs.includes(20)) st.inch = true;
    if (gs.includes(21)) st.inch = false;
    const sc = st.inch ? 25.4 : 1;
    const val = (k: string) => (w[k] ? w[k].value * sc : undefined);
    /** Fanuc "least input increment" words (P/Q in G74/G75/G76): without decimal point = 0.001 mm */
    const um = (k: string) => (w[k] ? (w[k].hasDecimal ? w[k].value * sc : (w[k].value / 1000) * sc) : undefined);

    let motionInBlock: number | null = null;
    let cycleG: number | null = null;
    let nonModal: number | null = null;
    for (const g of gs) {
      if (MOTION_G.has(g)) {
        if (motionInBlock !== null) this.diag(L, 'error', `G${motionInBlock} and G${g} are in the same modal group`);
        motionInBlock = g === 33 ? 32 : g;
      } else if (g >= 70 && g <= 76) cycleG = g;
      else if (g === 4 || g === 28 || g === 50) nonModal = g;
      else if (g === 40 || g === 41 || g === 42) {
        if (g !== 40 && st.comp === 40) {
          const t = this.tool();
          const o = st.offset ? this.cfg.offsets.get(st.offset) : undefined;
          const r = o?.r ?? t?.noseR ?? 0;
          if (r <= 0) this.diag(L, 'info', `G${g}: nose radius of offset ${st.offset} is 0 – compensation has no effect`);
          if (!st.offset) this.diag(L, 'warning', `G${g} with offset 00 – select a tool offset (e.g. T0101) so the nose radius R and tip T are known`);
        }
        st.comp = g as 40 | 41 | 42;
      } else if (g === 54 || g === 55 || g === 56 || g === 57 || g === 58 || g === 59) st.work = g;
      else if (g === 96) {
        st.spindle.mode = 'css';
      } else if (g === 97) st.spindle.mode = 'rpm';
      else if (g === 98) st.feedPerRev = false;
      else if (g === 99) st.feedPerRev = true;
    }
    // a pending ,C/,R corner needs a G01 move with an end point as the very next block
    if (this.corner) {
      const axis = ['X', 'Z', 'U', 'W'].some((k) => w[k]);
      const nextMotion = motionInBlock ?? st.motion;
      if (!(axis && nextMotion === 1 && cycleG === null && nonModal === null)) {
        this.diag(this.corner.line, 'error', 'The block after ",C"/",R" must be a G01 move – the corner was not made');
        this.flushCorner();
      }
    }
    if (motionInBlock !== null) {
      if ([90, 92, 94].includes(motionInBlock) && motionInBlock !== st.motion) st.cyc = null;
      st.motion = motionInBlock;
    }

    // ---- F
    if (w.F && cycleG !== 76) {
      const f = w.F.value * sc;
      if (st.motion === 32 || st.motion === 92) {
        st.feed = f; // thread lead
      } else {
        st.feed = f;
        this.feedSinceThread = true;
        if (st.feedPerRev && f > 1.2) {
          this.diag(L, 'warning', `Feed F${w.F.raw} mm/rev is very high for turning`, 'Typical roughing feeds are 0.15–0.4 mm/rev, finishing 0.05–0.15 mm/rev. Is G98 (mm/min) intended?');
        }
        if (!st.feedPerRev && f < 5) this.diag(L, 'warning', `Feed F${w.F.raw} mm/min (G98) is extremely slow – did you mean G99 (mm/rev)?`);
      }
    }

    // ---- S (G50 S = max spindle speed clamp)
    let spindleChanged = false;
    if (w.S) {
      if (nonModal === 50) {
        st.spindle.maxRpm = Math.min(w.S.value, this.cfg.machine.maxRpm);
        spindleChanged = true;
      } else {
        st.spindle.s = w.S.value;
        spindleChanged = true;
        if (st.spindle.mode === 'rpm' && w.S.value > this.cfg.machine.maxRpm) {
          this.diag(L, 'warning', `S${w.S.raw} exceeds the machine maximum of ${this.cfg.machine.maxRpm} rpm – clamped`);
        }
      }
    }
    if (gs.includes(96) || gs.includes(97)) spindleChanged = true;
    if (gs.includes(96) && !this.warnedCssNoClamp && st.spindle.maxRpm >= this.cfg.machine.maxRpm) {
      this.warnedCssNoClamp = true;
      this.diag(
        L,
        'warning',
        'G96 (constant surface speed) without a G50 S.. speed limit',
        'With G96 the rpm rises as X approaches 0. Always program a limit first, e.g. "G50 S2500".',
      );
    }

    // ---- T (tool change)
    if (w.T && !this.capture) {
      const v = Math.round(w.T.value);
      const raw = w.T.raw.replace(/^[+-]/, '').split('.')[0];
      let tool: number, off: number;
      if (raw.length >= 3) {
        tool = Math.floor(v / 100);
        off = v % 100;
      } else {
        tool = v;
        off = v;
      }
      if (tool > 0 && !this.cfg.tools.some((t) => t.id === tool)) {
        this.diag(L, 'error', `Tool T${String(tool).padStart(2, '0')} is not in the turret (see Tool table)`);
      }
      if (tool > 0 && tool !== st.tool) {
        this.checkToolChangePosition(L);
      }
      if (tool > 0) st.tool = tool;
      st.offset = off;
      this.hadT = true;
      this.push({ kind: 'tool', tool: st.tool, offset: off, line: L });
    }

    // ---- M codes before motion
    for (const m of ms) {
      if (m === 3 || m === 4) {
        st.spindle.dir = m === 3 ? 'cw' : 'ccw';
        spindleChanged = true;
        this.hadSpindleStart = true;
        if (st.spindle.s <= 0) this.diag(L, 'warning', `M0${m} without a spindle speed – program S.. (rpm or m/min)`);
      } else if (m === 8 || m === 7) {
        st.coolant = true;
        this.push({ kind: 'coolant', on: true, line: L });
      }
    }
    if (spindleChanged && !this.capture) this.push({ kind: 'spindle', spindle: { ...st.spindle }, line: L });

    // ---- motion / cycles
    let ctl: Ctl = {};
    const has = (k: string) => w[k] !== undefined;
    const hasAxis = has('X') || has('Z') || has('U') || has('W');
    if (has('X') && has('U')) throw new Error('X and U in the same block');
    if (has('Z') && has('W')) throw new Error('Z and W in the same block');

    const target = (): P => {
      const p = { ...st.pos };
      if (has('X')) p.x = val('X')! / 2;
      if (has('U')) p.x += val('U')! / 2;
      if (has('Z')) p.z = val('Z')!;
      if (has('W')) p.z += val('W')!;
      return p;
    };

    if (cycleG !== null) {
      if (this.capture) throw new Error(`G${cycleG} is not allowed inside a finishing profile`);
      ctl = this.cycle(cycleG, b, pc, w, val, um, inRange);
    } else if (nonModal === 50) {
      if (has('X') || has('Z')) {
        // G50 X_ Z_ : the current tool position BECOMES (X,Z)
        const want = { x: has('X') ? val('X')! / 2 : st.pos.x, z: has('Z') ? val('Z')! : st.pos.z };
        const shiftNoG50 = this.cfg.workOffsets[st.work] ?? { x: 0, z: 0 };
        st.g50 = sub(sub(sub(st.tip, this.wear()), shiftNoG50), want);
        st.pos = want;
        this.diag(L, 'info', 'G50 X/Z sets the work coordinate system from the current tool position (old-style programming).');
      }
    } else if (nonModal === 28) {
      // reference return via intermediate point
      const mid = target();
      const hasX = has('X') || has('U');
      const hasZ = has('Z') || has('W');
      if (!hasX && !hasZ) throw new Error('G28 needs U0 and/or W0 (axes to return)');
      if (st.comp !== 40) this.diag(L, 'warning', 'G28 with tool-nose radius compensation active – cancel with G40 first');
      this.emitMove('rapid', mid, L, { label: 'G28 intermediate point', cycle: 'G28' }, false);
      const home = homePos(this.cfg.machine);
      const tipHome = { x: hasX ? home.x : st.tip.x, z: hasZ ? home.z : st.tip.z };
      this.emitMove('rapid', this.toProg(tipHome), L, { label: 'G28 reference return', cycle: 'G28' }, false);
    } else if (nonModal === 4) {
      let sec = 0;
      if (has('X')) sec = w.X.value;
      else if (has('U')) sec = w.U.value;
      else if (has('P')) sec = w.P.hasDecimal ? w.P.value : w.P.value / 1000;
      this.push({ kind: 'dwell', seconds: sec, line: L });
    } else if (hasAxis) {
      ctl = this.motion(b, w, val, target());
    } else if (has('R') || has('I') || has('K')) {
      if (motionInBlock !== null) this.diag(L, 'error', 'Arc/cycle words without an end point (X/Z/U/W)');
    }

    // ---- M codes after motion
    for (const m of ms) {
      if (m === 5) {
        st.spindle.dir = 'off';
        this.push({ kind: 'spindle', spindle: { ...st.spindle }, line: L });
      } else if (m === 9) {
        st.coolant = false;
        this.push({ kind: 'coolant', on: false, line: L });
      } else if (m === 0 || m === 1) {
        this.push({ kind: 'stop', optional: m === 1, line: L, message: b.comment ?? (m === 0 ? 'Program stop (M00)' : 'Optional stop (M01)') });
      } else if (m === 2 || m === 30) {
        if (this.stack.length) this.diag(L, 'warning', `M${m} inside a sub-program`);
        if (st.comp !== 40) this.diag(L, 'warning', 'Program ends with tool-nose radius compensation still active (G40 missing)');
        if (st.spindle.dir !== 'off') this.diag(L, 'info', 'Spindle still running at program end – M05 is good practice before M30');
        this.push({ kind: 'end', line: L, rewind: m === 30 });
        return { end: true };
      } else if (m === 98) {
        if (!has('P')) throw new Error('M98 needs P (sub-program number)');
        let p = Math.round(w.P.value);
        let rep = has('L') ? Math.round(w.L.value) : 1;
        const raw = w.P.raw.replace(/^[+-]/, '');
        if (!has('L') && raw.length > 4) {
          rep = Math.floor(p / 10000);
          p = p % 10000;
        }
        const idx = this.labels.get(p);
        if (idx === undefined) throw new Error(`Sub-program O${String(p).padStart(4, '0')} not found`);
        if (this.stack.length > 8) throw new Error('Sub-program nesting too deep');
        if (rep < 1) return ctl;
        this.stack.push({ ret: pc + 1, label: idx, repeat: rep - 1 });
        return { next: idx + 1 };
      } else if (m === 99) {
        const top = this.stack[this.stack.length - 1];
        if (!top) {
          this.diag(L, 'warning', 'M99 in the main program loops forever on a real machine – treated as end');
          this.push({ kind: 'end', line: L, rewind: true });
          return { end: true };
        }
        if (top.repeat > 0) {
          top.repeat--;
          return { next: top.label + 1 };
        }
        this.stack.pop();
        return { next: top.ret };
      }
    }
    return ctl;
  }

  // ----------------------------------------------------------------- Custom Macro B

  /** evaluate macro expressions in words (X#1, Z[#2-5]); vacant values drop the word, as on Fanuc */
  private resolveWords(b: Block): Block {
    if (!b.words.some((w) => w.expr !== undefined)) return b;
    const words: Word[] = [];
    const shown: string[] = [];
    for (const w of b.words) {
      if (w.expr === undefined) {
        words.push(w);
        continue;
      }
      const v = evalExpr(w.expr, this.vars);
      if (v === null) {
        shown.push(`${w.letter}(vacant – ignored)`);
        continue;
      }
      const r = +v.toFixed(4);
      words.push({ ...w, value: r, raw: String(r), hasDecimal: true });
      shown.push(`${w.letter}${r}`);
    }
    if (!this.capture) this.varTrace.set(b.line, 'Evaluated: ' + shown.join(' '));
    return { ...b, words };
  }

  private macro(b: Block, pc: number): Ctl {
    const m = b.macro!;
    const ev = (e: string) => evalExpr(e, this.vars);
    const num = (e: string, what: string) => {
      const v = ev(e);
      if (v === null) throw new Error(`${what} is vacant`);
      return v;
    };
    const truthy = (c: string) => (ev(c) ?? 0) !== 0;
    const fmtV = (v: number | null) => (v === null ? 'vacant' : String(+v.toFixed(4)));
    const assign = (target: string, expr: string): Ctl => {
      const idx = Math.round(target.startsWith('[') ? num(target.slice(1, -1), 'Variable number') : +target);
      if (idx <= 0 || idx > 9999) throw new Error(`#${idx} cannot be assigned`);
      const v = ev(expr);
      this.varTrace.set(b.line, `#${idx} = ${fmtV(v)}`);
      if (idx === 3000) {
        this.diag(b.line, 'error', `Macro alarm ${fmtV(v)}: ${b.comment?.trim() || 'user alarm (#3000)'}`);
        this.push({ kind: 'end', line: b.line, rewind: false });
        return { end: true };
      }
      if (idx === 3006) {
        this.push({ kind: 'stop', optional: false, line: b.line, message: b.comment?.trim() || 'Macro stop (#3006)' });
        return {};
      }
      if (v === null) this.vars.delete(idx);
      else this.vars.set(idx, v);
      return {};
    };
    const gotoN = (n: number): Ctl => {
      const idx = this.findN(Math.round(n), pc + 1);
      if (idx < 0) throw new Error(`GOTO ${Math.round(n)}: block N${Math.round(n)} not found`);
      return { next: idx };
    };
    switch (m.kind) {
      case 'assign':
        return assign(m.target, m.expr);
      case 'if-then':
        if (truthy(m.cond)) return assign(m.target, m.expr);
        this.varTrace.set(b.line, 'Condition false – nothing assigned');
        return {};
      case 'goto':
        return gotoN(num(m.n, 'GOTO target'));
      case 'if-goto': {
        const t = truthy(m.cond);
        this.varTrace.set(b.line, `Condition ${t ? 'true – jump' : 'false – continue'}`);
        return t ? gotoN(num(m.n, 'GOTO target')) : {};
      }
      case 'while': {
        if (truthy(m.cond)) return {};
        for (let k = pc + 1; k < this.blocks.length; k++) {
          const mm = this.blocks[k].macro;
          if (mm?.kind === 'end' && mm.id === m.id) return { next: k + 1 };
        }
        throw new Error(`WHILE … DO ${m.id} has no END ${m.id}`);
      }
      case 'end': {
        for (let k = pc - 1; k >= 0; k--) {
          const mm = this.blocks[k].macro;
          if (mm?.kind === 'while' && mm.id === m.id) return { next: k };
        }
        throw new Error(`END ${m.id} without WHILE … DO ${m.id}`);
      }
    }
  }

  // ----------------------------------------------------------------- ,C / ,R corners

  /** emit the pending G01 move unchanged (no corner possible) */
  private flushCorner() {
    const c = this.corner;
    if (!c) return;
    this.corner = null;
    this.st.pos = { ...c.from };
    this.emitMove('linear', c.corner, c.line);
  }

  /** build the chamfer / round between the pending move and the next G01 towards `next` */
  private makeCorner(next: P) {
    const c = this.corner!;
    this.corner = null;
    const d1 = norm(sub(c.corner, c.from));
    const d2 = norm(sub(next, c.corner));
    const L1 = dist(c.from, c.corner);
    const L2 = dist(c.corner, next);
    const cosT = Math.max(-1, Math.min(1, dot(d1, d2)));
    const theta = Math.acos(cosT); // turning angle
    const label = c.kind === ',C' ? `,C${c.size} chamfer` : `,R${c.size} corner radius`;
    if (L2 < 1e-9 || theta < 1e-4 || theta > Math.PI - 1e-4) {
      this.diag(c.line, 'error', `${c.kind}: the next move is in line with this one – no corner to ${c.kind === ',C' ? 'chamfer' : 'round'}`);
      this.st.pos = { ...c.from };
      this.emitMove('linear', c.corner, c.line);
      this.st.pos = { ...c.corner };
      return;
    }
    const t = c.kind === ',C' ? c.size : c.size * Math.tan(theta / 2);
    if (t > L1 + 1e-6 || t > L2 + 1e-6) {
      this.diag(c.line, 'error', `${c.kind}${c.size} is too large for the adjacent moves`);
      this.st.pos = { ...c.from };
      this.emitMove('linear', c.corner, c.line);
      this.st.pos = { ...c.corner };
      return;
    }
    const p1 = sub(c.corner, mul(d1, t));
    const p2 = add(c.corner, mul(d2, t));
    this.st.pos = { ...c.from };
    if (t < L1 - 1e-9) this.emitMove('linear', p1, c.line);
    else this.st.pos = { ...p1 };
    if (c.kind === ',C') this.emitMove('linear', p2, c.line, { label });
    else {
      const inward = norm(sub(d2, mul(d1, cosT)));
      const center = add(p1, mul(inward, c.size));
      this.emitMove('arc', p2, c.line, { center, cw: cross(d1, d2) < 0, label });
    }
    this.st.pos = { ...p2 };
  }

  private checkToolChangePosition(L: number) {
    const s = this.cfg.stock;
    if (!s || this.capture) return;
    const tip = this.st.tip;
    const R = s.diameter / 2;
    if (tip.x < R + 10 && tip.z < s.faceAllowance + 15) {
      this.diag(
        L,
        'warning',
        'Tool change close to the workpiece',
        'The turret indexes where it is. Move to a safe position first (e.g. G28 U0 W0, or G00 X.. Z.. well clear of the part).',
      );
    }
  }

  // ----------------------------------------------------------------- plain motion

  private motion(b: Block, w: Record<string, Word>, val: (k: string) => number | undefined, tgt: P): Ctl {
    const st = this.st;
    const L = b.line;
    const has = (k: string) => w[k] !== undefined;
    switch (st.motion) {
      case 0:
        this.emitMove('rapid', tgt, L);
        break;
      case 1: {
        this.lintTaper(L, st.pos, tgt);
        if (!this.feedSinceThread && !this.capture) {
          this.diag(L, 'warning', 'Feed move after threading without a new F', 'Threading (G32/G92/G76) sets F to the thread lead. Program a new F for normal cutting.');
        }
        if (this.corner) this.makeCorner(tgt);
        const cw = w[',C'] ?? w[',R'];
        if (cw) {
          if (w[',C'] && w[',R']) throw new Error('",C" and ",R" in the same block');
          const size = cw.value * (st.inch ? 25.4 : 1);
          if (size <= 0) throw new Error(`${cw.letter} must be greater than 0`);
          if (dist(st.pos, tgt) < 1e-9) throw new Error(`${cw.letter} on a block without movement`);
          this.corner = { kind: cw.letter as ',C' | ',R', size, from: { ...st.pos }, corner: { ...tgt }, line: L };
          st.pos = { ...tgt };
          break;
        }
        this.emitMove('linear', tgt, L);
        break;
      }
      case 2:
      case 3: {
        const cw = st.motion === 2;
        const from = st.pos;
        let c: P;
        if (has('R')) {
          const R = val('R')!;
          const chord = dist(from, tgt);
          if (chord < EPS) throw new Error('Arc with R: start and end point are the same');
          const rr = Math.abs(R);
          if (rr < chord / 2 - 1e-4) throw new Error(`Arc radius R${w.R.raw} is too small for the end point (chord ${chord.toFixed(3)} mm)`);
          const h = Math.sqrt(Math.max(0, rr * rr - (chord / 2) ** 2));
          const mid = mul(add(from, tgt), 0.5);
          const d = norm(sub(tgt, from));
          const leftSide = !cw === R > 0; // minor CCW arc → centre on the left of the chord
          c = add(mid, mul(leftSide ? leftN(d) : rightN(d), h));
        } else if (has('I') || has('K')) {
          c = { x: from.x + (val('I') ?? 0), z: from.z + (val('K') ?? 0) };
          const r0 = dist(from, c);
          const r1 = dist(tgt, c);
          if (Math.abs(r0 - r1) > 0.01) {
            throw new Error(`Arc end point is not on the circle (radius at start ${r0.toFixed(3)}, at end ${r1.toFixed(3)}) – check I/K`);
          }
        } else throw new Error(`G0${st.motion} needs R or I/K`);
        if (!this.capture && !this.hintedTaper && st.comp === 40) this.hintNoComp(L);
        this.emitMove('arc', tgt, L, { center: c, cw });
        break;
      }
      case 32: {
        if (st.feed <= 0) throw new Error('G32 needs F (thread lead)');
        this.threadChecks(L);
        this.emitMove('thread', tgt, L, { feed: st.feed, label: 'G32 thread' }, false);
        this.recordThread(st.feed);
        break;
      }
      case 90:
      case 92:
      case 94: {
        const s = { ...st.pos };
        const prev = st.cyc;
        const x1 = has('X') || has('U') ? tgt.x : prev ? prev.x1 : s.x;
        const z1 = has('Z') || has('W') ? tgt.z : prev ? prev.z1 : s.z;
        const r = has('R') ? val('R')! : prev ? prev.r : 0;
        st.cyc = { x1, z1, r };
        let moves: CY.CMove[];
        if (st.motion === 90) moves = CY.g90(s, x1, z1, r);
        else if (st.motion === 94) moves = CY.g94(s, x1, z1, r);
        else {
          if (st.feed <= 0) throw new Error('G92 needs F (thread lead)');
          this.threadChecks(L);
          moves = CY.g92(s, x1, z1, r);
        }
        if (st.comp !== 40) this.diag(L, 'warning', `G${st.motion} with nose radius compensation active – compensation is ignored inside the cycle`);
        this.emitCycle(moves, L, `G${st.motion}`);
        if (st.motion === 92) this.recordThread(st.feed);
        break;
      }
    }
    return {};
  }

  private lintTaper(L: number, a: P, b: P) {
    if (this.capture || this.hintedTaper || this.st.comp !== 40) return;
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.z - b.z) > 0.01) this.hintNoComp(L);
  }
  private hintNoComp(L: number) {
    const t = this.tool();
    if (!t || t.noseR <= 0 || !['turn', 'bore'].includes(t.type)) return;
    this.hintedTaper = true;
    this.diag(
      L,
      'info',
      'Taper/arc cut without tool-nose radius compensation (G41/G42)',
      `The control drives the imaginary tool tip. On tapers and arcs the R${t.noseR} nose leaves a form error (up to ≈ ${(t.noseR * (1 - Math.SQRT1_2) * 2).toFixed(2)} mm on 45° chamfers). Use G42 (OD) / G41 (ID) for finishing.`,
    );
  }

  private threadChecks(L: number) {
    const st = this.st;
    if (st.spindle.mode === 'css') this.diag(L, 'warning', 'Threading with G96 (CSS) – use G97 constant rpm so every pass stays in sync');
    const rpm = st.spindle.mode === 'rpm' ? st.spindle.s : 0;
    if (rpm > 0 && rpm * st.feed > this.cfg.machine.rapidRate * 0.8) {
      this.diag(L, 'error', `Thread feed ${(rpm * st.feed).toFixed(0)} mm/min exceeds what the Z axis can follow – reduce S`);
    }
    const t = this.tool();
    if (t && !['thread', 'thread_id'].includes(t.type)) this.diag(L, 'warning', `Threading with T${String(t.id).padStart(2, '0')} (${t.name}) – is a threading tool selected?`);
    this.feedSinceThread = false;
  }

  private recordThread(lead: number) {
    // gather the thread move(s) just emitted
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const o = this.ops[i];
      if (o.kind !== 'move') continue;
      if (o.type === 'thread') {
        const z0 = Math.min(o.from.z, o.to.z), z1 = Math.max(o.from.z, o.to.z);
        const x0 = Math.min(o.from.x, o.to.x), x1 = Math.max(o.from.x, o.to.x);
        const ex = this.threads.find((t) => Math.abs(t.lead - lead) < 1e-6 && t.z0 < z1 && t.z1 > z0);
        if (ex) {
          ex.z0 = Math.min(ex.z0, z0);
          ex.z1 = Math.max(ex.z1, z1);
          ex.xMin = Math.min(ex.xMin, x0);
          ex.xMax = Math.max(ex.xMax, x1);
        } else this.threads.push({ z0, z1, lead, xMin: x0, xMax: x1 });
        break;
      }
    }
  }

  private emitCycle(moves: CY.CMove[], L: number, cycle: string, lead?: number) {
    for (const m of moves) {
      this.emitMove(
        m.type,
        m.to,
        L,
        {
          label: m.label,
          cycle,
          ...(m.center ? { center: m.center, cw: m.cw } : {}),
          ...(m.type === 'thread' ? { feed: lead ?? this.st.feed } : {}),
        },
        false,
      );
    }
  }

  // ----------------------------------------------------------------- multiple repetitive cycles

  private findN(n: number, from: number): number {
    for (let i = from; i < this.blocks.length; i++) if (this.blocks[i].n === n) return i;
    for (let i = 0; i < from; i++) if (this.blocks[i].n === n) return i;
    return -1;
  }

  private captureProfile(ns: number, nf: number, L: number): CY.Seg[] {
    const saved = cloneState(this.st);
    const savedGuard = this.guard;
    this.capture = [];
    try {
      for (let i = ns; i <= nf; i++) {
        const b = this.blocks[i];
        if (b.blockDelete && this.cfg.blockSkip) continue;
        if (b.macro) {
          this.macro(b, i);
          continue;
        }
        if (b.words.length === 0) continue;
        this.exec(b, i, true);
      }
      this.flushCorner();
    } catch (e) {
      this.corner = null;
      this.capture = null;
      this.st = saved;
      throw new Error(`In finishing profile (line ${L + 1}): ${(e as Error).message}`);
    }
    const segs = this.capture;
    this.capture = null;
    this.st = saved;
    this.guard = savedGuard;
    return segs.filter((s) => dist(s.from, s.to) > 1e-9 || s.type === 'arc');
  }

  private cycle(
    g: number,
    b: Block,
    pc: number,
    w: Record<string, Word>,
    val: (k: string) => number | undefined,
    um: (k: string) => number | undefined,
    inRange: boolean,
  ): Ctl {
    const st = this.st;
    const L = b.line;
    const has = (k: string) => w[k] !== undefined;
    const s = { ...st.pos };
    const tgt = (): P => {
      const p = { ...st.pos };
      if (has('X')) p.x = val('X')! / 2;
      if (has('U')) p.x += val('U')! / 2;
      if (has('Z')) p.z = val('Z')!;
      if (has('W')) p.z += val('W')!;
      return p;
    };
    const resolvePQ = () => {
      if (!has('P') || !has('Q')) throw new Error(`G${g} needs P (first block N) and Q (last block N) of the profile`);
      const ns = this.findN(Math.round(w.P.value), pc + 1);
      const nf = this.findN(Math.round(w.Q.value), ns < 0 ? pc + 1 : ns);
      if (ns < 0) throw new Error(`Profile start N${w.P.raw} not found`);
      if (nf < 0) throw new Error(`Profile end N${w.Q.raw} not found`);
      if (nf < ns) throw new Error(`Profile end N${w.Q.raw} comes before start N${w.P.raw}`);
      return { ns, nf };
    };
    // after a G71/72/73 whose profile directly follows, skip the profile blocks
    const skipAfter = (ns: number, nf: number): Ctl => {
      let k = pc + 1;
      while (k < ns && this.blocks[k].words.length === 0) k++;
      return k === ns && !inRange ? { next: nf + 1 } : {};
    };
    if (st.comp !== 40 && g !== 70) this.diag(L, 'warning', `G${g} called with G41/G42 active – roughing ignores compensation; cancel with G40 before the cycle`);

    switch (g) {
      case 70: {
        const { ns, nf } = resolvePQ();
        const start = { ...st.pos };
        this.runRange(ns, nf);
        this.emitMove('rapid', start, L, { label: 'G70 return to start point', cycle: 'G70' }, false);
        return {};
      }
      case 71:
      case 72: {
        if (!has('P')) {
          const d = has(g === 71 ? 'U' : 'W') ? val(g === 71 ? 'U' : 'W')! : undefined;
          const e = has('R') ? val('R')! : undefined;
          const slot = g === 71 ? st.g71 : st.g72;
          if (d !== undefined) slot.d = Math.abs(d);
          if (e !== undefined) slot.e = Math.abs(e);
          if (slot.d <= 0) throw new Error(`G${g}: depth of cut must be > 0`);
          return {};
        }
        const { ns, nf } = resolvePQ();
        if (has('F')) st.feed = val('F')!;
        const segs = this.captureProfile(ns, nf, L);
        if (segs.length < 2) throw new Error(`G${g}: finishing profile N${w.P.raw}–N${w.Q.raw} needs at least two moves`);
        const first = this.blocks[ns];
        // type II (pockets allowed) when the first profile block also names the other axis (e.g. "W0")
        const typeII = first.words.some((x) => x.letter === (g === 71 ? 'Z' : 'X') || x.letter === (g === 71 ? 'W' : 'U'));
        if (typeII) this.diag(first.line, 'info', `G${g} type II: the first profile block names both axes, so pockets in the profile are roughed too`);
        const slot = g === 71 ? st.g71 : st.g72;
        const du = has('U') ? val('U')! : 0;
        const dw = has('W') ? val('W')! : 0;
        if (st.feed <= 0) throw new Error(`G${g} needs a feed F`);
        const moves = CY.roughCycle(
          s,
          segs,
          { d: slot.d, e: slot.e, du, dw, axis: g === 71 ? 'x' : 'z', feedApproach: segs[0].type === 'linear', typeII },
          (m) => this.diag(L, 'warning', m),
        );
        this.emitCycle(moves, L, `G${g}`);
        return skipAfter(ns, nf);
      }
      case 73: {
        if (!has('P')) {
          if (has('U')) st.g73.i = val('U')!;
          if (has('W')) st.g73.k = val('W')!;
          if (has('R')) st.g73.d = Math.max(1, Math.round(w.R.value));
          return {};
        }
        const { ns, nf } = resolvePQ();
        if (has('F')) st.feed = val('F')!;
        if (st.feed <= 0) throw new Error('G73 needs a feed F');
        const segs = this.captureProfile(ns, nf, L);
        if (segs.length < 2) throw new Error('G73: the profile needs at least two moves');
        const moves = CY.g73(s, segs, st.g73.i, st.g73.k, st.g73.d, has('U') ? val('U')! : 0, has('W') ? val('W')! : 0);
        this.emitCycle(moves, L, 'G73');
        return skipAfter(ns, nf);
      }
      case 74:
      case 75: {
        const second = has('X') || has('Z') || has('U') || has('W');
        if (!second) {
          if (has('R')) {
            if (g === 74) st.g74e = val('R')!;
            else st.g75e = val('R')!;
          }
          return {};
        }
        if (has('F')) st.feed = val('F')!;
        if (st.feed <= 0) throw new Error(`G${g} needs a feed F`);
        const t = tgt();
        const p = um('P') ?? 0;
        const q = um('Q') ?? 0;
        const e = g === 74 ? st.g74e : st.g75e;
        const moves = g === 74 ? CY.g74(s, t.x, t.z, p, q, e) : CY.g75(s, t.x, t.z, p, q, e);
        if (g === 74 && Math.abs(s.x) > 1e-6 && !has('X') && !has('U')) {
          this.diag(L, 'info', `G74 drilling at X${(s.x * 2).toFixed(3)} – drills normally start at X0`);
        }
        this.emitCycle(moves, L, `G${g}`);
        return {};
      }
      case 76: {
        const second = has('X') || has('Z') || has('U') || has('W');
        if (!second) {
          if (has('P')) {
            const pv = Math.round(w.P.value);
            st.g76.m = Math.floor(pv / 10000) || 1;
            st.g76.r = Math.floor(pv / 100) % 100;
            st.g76.a = pv % 100;
            if (![0, 29, 30, 55, 60, 80].includes(st.g76.a)) this.diag(L, 'warning', `G76 tool angle ${st.g76.a}° is unusual (0, 29, 30, 55, 60, 80)`);
          }
          if (has('Q')) st.g76.dmin = um('Q')!;
          if (has('R')) st.g76.fin = val('R')!;
          return {};
        }
        if (!has('F')) throw new Error('G76 needs F (thread lead)');
        const lead = w.F.value * sc(st);
        st.feed = lead;
        const t = tgt();
        const k = um('P');
        const d1 = um('Q');
        if (!k || k <= 0) throw new Error('G76 second block needs P = thread height (µm, radius)');
        if (!d1 || d1 <= 0) throw new Error('G76 second block needs Q = first depth of cut (µm, radius)');
        const i = has('R') ? val('R')! : 0;
        this.threadChecks(L);
        const { moves, passes } = CY.g76(s, {
          x1: t.x,
          z1: t.z,
          i,
          k,
          d1,
          dmin: st.g76.dmin,
          fin: st.g76.fin,
          m: st.g76.m,
          angle: st.g76.a,
          chamfer: (st.g76.r / 10) * lead,
        });
        if (this.cfg.hints !== false) {
          this.diag(L, 'info', `G76 generates ${passes.length} passes (thread height ${k.toFixed(3)} mm, first cut ${d1.toFixed(3)} mm)`);
        }
        this.emitCycle(moves, L, 'G76', lead);
        this.recordThread(lead);
        return {};
      }
    }
    return {};
  }

  finish(): InterpResult {
    const ops = applyTNRC(this.ops, this.comp, (line, msg, sev) => this.diag(line, sev ?? 'warning', msg));
    if (!this.hadT && ops.some((o) => o.kind === 'move' && o.type !== 'rapid')) {
      this.diag(0, 'info', 'No T-code in the program – the tool currently in the turret is used.');
    }
    if (!this.hadSpindleStart && ops.some((o) => o.kind === 'move' && o.type !== 'rapid') && this.st.spindle.dir === 'off') {
      this.diag(0, 'warning', 'The program never starts the spindle (M03/M04).');
    }
    this.diags.sort((a, b) => a.line - b.line);
    return { ops, diags: this.diags, state: this.st, blocks: this.blocks, threads: this.threads, modal: this.modal, vars: this.vars, varTrace: this.varTrace };
  }
}

const sc = (st: InterpState) => (st.inch ? 25.4 : 1);

export function interpret(src: string, cfg: InterpConfig, init?: InterpState): InterpResult {
  const blocks = lexProgram(src);
  const it = new Interpreter(blocks, cfg, init ?? defaultState(cfg.machine));
  it.run();
  return it.finish();
}
