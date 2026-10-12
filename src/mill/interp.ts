// Fanuc-style milling interpreter (vertical machining centre, Group A G-codes).
//
// Coordinate pipeline for an end point:
//   words (G90/G91, G16 polar) → program coords → G68 rotation → G52 local shift → G54–G59
//   → tool length: tip Z = Z + (G43 ? +H : G44 ? −H : 0) − actual tool length − point offset
// Without G43 the spindle gauge line goes to the programmed Z, i.e. the tool tip ends up one
// tool length LOWER – exactly what happens on a real machine.
// Options (MillSettings): autoLength applies the tool's length after M06 without G43, autoRadius
// takes the G41/G42 radius from the tool, pointRef 'center' programs the nose-radius centre.

import type { Diagnostic } from '../types';
import { lexProgram, type Block, type Word } from '../gcode/lexer';
import { evalExpr, type Vars } from '../gcode/macro';
import { dist, add, sub, mul, norm, leftN, rightN, dot, cross, EPS } from '../sim/geom';
import type { MillMove, MillOffset, MillOp, MillSettings, MillTool, Plane, V3, BlockStock } from './types';
import { toP, fromP, PLANE_AXES } from './path';
import { holeSteps } from './cycles';
import { applyCutterComp, type MillComp } from './comp';
import { blockFrame } from './stock';

export interface MillState {
  pos: V3;
  tip: V3;
  motion: 0 | 1 | 2 | 3;
  plane: Plane;
  abs: boolean;
  feedPerRev: boolean;
  feed: number;
  rpm: number;
  dir: 'cw' | 'ccw' | 'off';
  coolant: boolean;
  tool: number;
  nextTool: number;
  lenComp: 43 | 44 | 49;
  hReg: number;
  comp: 40 | 41 | 42;
  dReg: number;
  inch: boolean;
  work: number;
  local: V3;
  rot: { on: boolean; cx: number; cy: number; a: number };
  polar: boolean;
  cyc: { g: number; r: number; z: number; q: number; p: number; initZ: number } | null;
  ret: 98 | 99;
  /** tool changed but no G43 yet (for the "missing G43" hint) */
  needG43: boolean;
  /** automatic length compensation active (settings.autoLength, set by M06, cleared by G43/G44/G49) */
  autoLen?: boolean;
}

export interface MillConfig {
  tools: MillTool[];
  offsets: Map<number, MillOffset>;
  settings: MillSettings;
  workOffsets: Record<number, V3>;
  blockSkip: boolean;
  stock?: BlockStock;
  vars?: Vars;
}

export interface MillModalSnap {
  motion: number;
  plane: Plane;
  abs: boolean;
  feedPerRev: boolean;
  comp: 40 | 41 | 42;
  lenComp: 43 | 44 | 49;
  autoLen: boolean;
  work: number;
  tool: number;
  feed: number;
  rpm: number;
  cyc: number;
  ret: 98 | 99;
  polar: boolean;
  rot: boolean;
}

export interface MillResult {
  ops: MillOp[];
  diags: Diagnostic[];
  blocks: Block[];
  state: MillState;
  modal: Map<number, MillModalSnap>;
  vars: Vars;
  varTrace: Map<number, string>;
}

/** Z distance from the tool tip (lowest point) up to the programmed point: the ball centre of a
 *  ball mill, the corner-radius centre of a bull-nose or face mill – 0 for the tip reference */
export function pointOffset(t: MillTool | undefined, s: MillSettings): number {
  if (!t || s.pointRef !== 'center') return 0;
  if (t.type === 'ball') return t.diameter / 2;
  if (t.type === 'bull' || t.type === 'face') return Math.min(t.cornerR, t.diameter / 2);
  return 0;
}

/** active length compensation value (+ for G43, − for G44, 0 for G49) */
export function lengthTerm(st: MillState, tools: MillTool[], offsets: Map<number, MillOffset>): number {
  if (st.lenComp === 49) return 0;
  let h: number;
  if (st.autoLen) {
    // automatic: the measured length of the tool in the spindle + its length wear
    h = (tools.find((t) => t.id === st.tool)?.length ?? 0) + (offsets.get(st.tool)?.hw ?? 0);
  } else {
    const o = offsets.get(st.hReg);
    h = o ? o.h + o.hw : 0;
  }
  return st.lenComp === 43 ? h : -h;
}

/** programmed Z (work coordinates without the G54 shift) → tool-tip Z, and back:
 *  tip = Z + shift + lengthTerm − actual tool length − point offset */
export function tipFromProgZ(z: number, st: MillState, cfg: Pick<MillConfig, 'tools' | 'offsets' | 'settings'>) {
  const t = cfg.tools.find((x) => x.id === st.tool);
  const L = st.tool > 0 ? t?.length ?? 0 : 0;
  return z + lengthTerm(st, cfg.tools, cfg.offsets) - L - pointOffset(st.tool > 0 ? t : undefined, cfg.settings);
}

export function millDefaultState(s: MillSettings, tools: MillTool[]): MillState {
  const L = tools.find((t) => t.id === 1)?.length ?? 0;
  return {
    pos: { x: s.homeX, y: s.homeY, z: s.homeZ },
    tip: { x: s.homeX, y: s.homeY, z: s.homeZ - L },
    motion: 0,
    plane: 17,
    abs: true,
    feedPerRev: false,
    feed: 0,
    rpm: 0,
    dir: 'off',
    coolant: false,
    tool: 1,
    nextTool: 1,
    lenComp: 49,
    hReg: 0,
    comp: 40,
    dReg: 0,
    inch: false,
    work: 54,
    local: { x: 0, y: 0, z: 0 },
    rot: { on: false, cx: 0, cy: 0, a: 0 },
    polar: false,
    cyc: null,
    ret: 98,
    needG43: !s.autoLength,
    autoLen: !!s.autoLength,
    ...(s.autoLength ? { lenComp: 43 as const, hReg: 1 } : {}),
  };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const KNOWN_G = new Set([0, 1, 2, 3, 4, 15, 16, 17, 18, 19, 20, 21, 28, 40, 41, 42, 43, 44, 49, 52, 53, 54, 55, 56, 57, 58, 59, 68, 69, 73, 74, 76, 80, 81, 82, 83, 84, 85, 86, 89, 90, 91, 94, 95, 98, 99]);
const CYCLES = new Set([73, 74, 76, 81, 82, 83, 84, 85, 86, 89]);
const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 19, 29, 30, 98, 99]);

interface Ctl {
  next?: number;
  end?: boolean;
}

class MillInterpreter {
  ops: MillOp[] = [];
  comp: (MillComp | undefined)[] = [];
  diags: Diagnostic[] = [];
  private seen = new Set<string>();
  st: MillState;
  private labels = new Map<number, number>();
  private guard = 0;
  private stack: { ret: number; label: number; repeat: number }[] = [];
  modal = new Map<number, MillModalSnap>();
  vars: Vars;
  varTrace = new Map<number, string>();
  private hadSpindle = false;
  private corner: { kind: ',C' | ',R'; size: number; from: V3; corner: V3; line: number } | null = null;

  constructor(public blocks: Block[], private cfg: MillConfig, init: MillState) {
    this.st = clone(init);
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

  // ------------------------------------------------------------------ tools & coordinates

  toolDef(id = this.st.tool) {
    return this.cfg.tools.find((t) => t.id === id);
  }
  private actualLength() {
    return this.st.tool > 0 ? this.toolDef()?.length ?? 0 : 0;
  }
  private zTerm() {
    return tipFromProgZ(0, this.st, this.cfg);
  }
  private shift(): V3 {
    const w = this.cfg.workOffsets[this.st.work] ?? { x: 0, y: 0, z: 0 };
    return { x: w.x + this.st.local.x, y: w.y + this.st.local.y, z: w.z + this.st.local.z };
  }
  private rotate(x: number, y: number) {
    const r = this.st.rot;
    if (!r.on) return { x, y };
    const a = (r.a * Math.PI) / 180;
    const dx = x - r.cx, dy = y - r.cy;
    return { x: r.cx + dx * Math.cos(a) - dy * Math.sin(a), y: r.cy + dx * Math.sin(a) + dy * Math.cos(a) };
  }
  /** program coordinates → tool tip in simulator (G54) coordinates */
  toSim(p: V3): V3 {
    const r = this.rotate(p.x, p.y);
    const s = this.shift();
    return { x: r.x + s.x, y: r.y + s.y, z: p.z + s.z + this.zTerm() };
  }
  /** inverse (no rotation) – used after tool changes / home returns */
  private fromSimZ(tipZ: number) {
    return tipZ - this.shift().z - this.zTerm();
  }

  // ------------------------------------------------------------------ emit

  emitMove(type: MillMove['type'], target: V3, line: number, extra: Partial<MillMove> = {}, comp = true) {
    const to = this.toSim(target);
    const center = extra.center ? this.toSim(extra.center) : undefined;
    const st = this.st;
    const op: MillMove = {
      kind: 'move',
      type,
      from: { ...st.tip },
      to,
      plane: st.plane,
      feed: st.feed,
      feedPerRev: st.feedPerRev,
      spindle: { rpm: st.rpm, dir: st.dir },
      line,
      tool: st.tool,
      ...extra,
      center,
    };
    if (type !== 'rapid') {
      if (st.feed <= 0) this.diag(line, 'error', 'Feed move without a feed rate (F) – the control would alarm.');
      if (st.dir === 'off') this.diag(line, 'warning', 'Feed move while the spindle is stopped (M03 missing?)', 'After M06 the spindle is stopped – program M03 S… again for every tool.');
      if (st.needG43 && st.tool > 0 && to.z < (this.cfg.stock ? blockFrame(this.cfg.stock).top : 0) + 5) {
        this.diag(line, 'warning', `No tool length compensation (G43 H${String(st.tool).padStart(2, '0')}) for tool T${String(st.tool).padStart(2, '0')}`, 'Without G43 the gauge line – not the tool tip – goes to the programmed Z: the tip ends up one tool length lower and crashes into the part.');
      }
    }
    this.ops.push(op);
    this.comp.push(comp && st.comp !== 40 && !op.cycle ? { side: st.comp, r: this.compRadius() } : undefined);
    st.tip = to;
    st.pos = { ...target };
  }

  /** cutter radius for G41/G42: the D register, or – automatic / no D – the tool's own radius (+ radius wear) */
  compRadius() {
    const st = this.st;
    const t = this.toolDef();
    if (this.cfg.settings.autoRadius && st.dReg === 0) return (t?.diameter ?? 0) / 2 + (this.cfg.offsets.get(st.tool)?.dw ?? 0);
    const o = this.cfg.offsets.get(st.dReg);
    return o ? o.d + o.dw : (t?.diameter ?? 0) / 2;
  }

  private push(op: MillOp) {
    this.ops.push(op);
    this.comp.push(undefined);
  }

  // ------------------------------------------------------------------ run

  run() {
    let pc = 0;
    const mainIdx = this.blocks.findIndex((b) => b.o !== undefined);
    while (pc < this.blocks.length) {
      const b = this.blocks[pc];
      if (pc > mainIdx && b.o !== undefined && this.stack.length === 0) {
        this.diag(b.line, 'warning', `Main program ran into sub-program O${b.o} – end the main program with M30.`);
        break;
      }
      const c = this.step(pc);
      if (c.end) {
        this.flushCorner();
        return;
      }
      pc = c.next ?? pc + 1;
    }
    this.flushCorner();
    const last = this.blocks.length ? this.blocks[this.blocks.length - 1].line : 0;
    this.diag(last, 'info', 'Program has no M30 (program end & rewind).');
    this.push({ kind: 'end', line: last, rewind: false });
  }

  private step(pc: number): Ctl {
    if (++this.guard > 200000 || this.ops.length > 400000) {
      this.diag(this.blocks[pc].line, 'error', 'Program too long or endless loop – execution aborted.');
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
      return this.exec(b, pc);
    } catch (err) {
      this.diag(b.line, 'error', (err as Error).message);
      return {};
    } finally {
      if (!this.modal.has(b.line)) {
        const s = this.st;
        this.modal.set(b.line, {
          motion: s.motion, plane: s.plane, abs: s.abs, feedPerRev: s.feedPerRev, comp: s.comp, lenComp: s.lenComp, autoLen: !!s.autoLen, work: s.work,
          tool: s.tool, feed: s.feed, rpm: s.rpm, cyc: s.cyc?.g ?? 80, ret: s.ret, polar: s.polar, rot: s.rot.on,
        });
      }
    }
  }

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
    this.varTrace.set(b.line, 'Evaluated: ' + shown.join(' '));
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

  private findN(n: number, from: number): number {
    for (let i = from; i < this.blocks.length; i++) if (this.blocks[i].n === n) return i;
    for (let i = 0; i < from; i++) if (this.blocks[i].n === n) return i;
    return -1;
  }

  // ------------------------------------------------------------------ block execution

  private exec(b0: Block, pc: number): Ctl {
    const b = this.resolveWords(b0);
    const L = b.line;
    const st = this.st;
    const gs: number[] = [];
    const ms: number[] = [];
    const w: Record<string, Word> = {};
    for (const wd of b.words) {
      if (wd.letter === 'G') {
        const g = Math.round(wd.value * 10) / 10;
        if (g === 50.1 || g === 51.1) this.diag(L, 'warning', `G${wd.raw} (mirror image) is not simulated – ignored`);
        else if (!KNOWN_G.has(g)) this.diag(L, 'error', `G${wd.raw} is not supported`);
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
    const has = (k: string) => w[k] !== undefined;
    if (gs.includes(20)) st.inch = true;
    if (gs.includes(21)) st.inch = false;
    const sc = st.inch ? 25.4 : 1;
    const val = (k: string) => (w[k] ? w[k].value * sc : undefined);

    let motion: number | null = null;
    let cycleG: number | null = null;
    let nonModal: number | null = null;
    for (const g of gs) {
      if (g <= 3) {
        if (motion !== null) this.diag(L, 'error', 'Two motion codes in one block');
        motion = g;
      } else if (CYCLES.has(g)) cycleG = g;
      else if (g === 80) {
        st.cyc = null;
      } else if (g === 4 || g === 28 || g === 52 || g === 53) nonModal = g;
      else if (g === 17 || g === 18 || g === 19) st.plane = g as Plane;
      else if (g === 90) st.abs = true;
      else if (g === 91) st.abs = false;
      else if (g === 94) st.feedPerRev = false;
      else if (g === 95) st.feedPerRev = true;
      else if (g === 98 || g === 99) st.ret = g;
      else if (g === 15) st.polar = false;
      else if (g === 16) st.polar = true;
      else if (g >= 54 && g <= 59) st.work = g;
      else if (g === 49) {
        if (this.cfg.settings.autoLength) {
          // automatic mode: G49 only cancels an explicit G43/G44 – the tool's own length stays active
          if (st.tool > 0 && !st.autoLen) this.diag(L, 'info', `G49 with automatic length compensation: back to the length of T${String(st.tool).padStart(2, '0')}`);
          st.lenComp = 43;
          st.hReg = st.tool;
          st.autoLen = true;
        } else st.lenComp = 49;
      }
      else if (g === 40 || g === 41 || g === 42) {
        if (g !== 40 && st.plane !== 17) this.diag(L, 'error', 'Cutter compensation is only simulated in the G17 (XY) plane');
        st.comp = g as 40 | 41 | 42;
      } else if (g === 69) st.rot.on = false;
    }
    // ,C / ,R pending corner needs a G01 continuation
    if (this.corner) {
      const axis = ['X', 'Y', 'Z'].some((k) => has(k));
      const nm = motion ?? st.motion;
      if (!(axis && nm === 1 && cycleG === null && nonModal === null && !st.cyc)) {
        this.diag(this.corner.line, 'error', 'The block after ",C"/",R" must be a G01 move – the corner was not made');
        this.flushCorner();
      }
    }
    if (motion !== null) {
      st.motion = motion as 0 | 1 | 2 | 3;
      if (st.cyc && cycleG === null) st.cyc = null; // G00–G03 cancel a canned cycle
    }

    // ---- length & radius offsets (G43/G44 H, G41/G42 D)
    const g43 = gs.find((g) => g === 43 || g === 44);
    if (g43) {
      st.lenComp = g43 as 43 | 44;
      st.autoLen = false;
      st.hReg = has('H') ? Math.round(w.H.value) : st.hReg;
      if (!has('H')) this.diag(L, 'warning', `G${g43} without H – the previous H${st.hReg} is used`);
      if (st.hReg !== st.tool) this.diag(L, 'warning', `G${g43} H${String(st.hReg).padStart(2, '0')} but tool T${String(st.tool).padStart(2, '0')} is in the spindle`, 'Normally H matches the tool number. A wrong H puts the tool tip at the wrong height!');
      const o = this.cfg.offsets.get(st.hReg);
      if (!o || o.h <= 0) this.diag(L, 'warning', `Length offset H${st.hReg} is empty (0)`);
      st.needG43 = false;
      // the change of the length term moves Z: keep the programmed position, the next move picks it up
    } else if (has('H') && !gs.includes(49)) st.hReg = Math.round(w.H.value);
    if (has('D')) st.dReg = Math.round(w.D.value);
    if ((gs.includes(41) || gs.includes(42)) && !has('D') && st.dReg === 0) {
      if (this.cfg.settings.autoRadius) this.diag(L, 'info', `Automatic cutter radius: R${+this.compRadius().toFixed(3)} from tool T${String(st.tool).padStart(2, '0')} (no D needed)`);
      else this.diag(L, 'warning', 'G41/G42 without D – no cutter radius known (D00)', 'Program D with the tool number (e.g. G41 D02), or switch on "automatic cutter radius" in Settings.');
    }

    // ---- F, S, T
    if (has('F') && !cycleG && !st.cyc) {
      st.feed = val('F')!;
      if (st.feedPerRev && st.feed > 1) this.diag(L, 'warning', `F${w.F.raw} mm/rev (G95) is very large – did you mean G94 (mm/min)?`);
    } else if (has('F')) st.feed = val('F')!;
    if (has('S')) {
      st.rpm = Math.round(w.S.value);
      if (st.rpm > this.cfg.settings.maxRpm) this.diag(L, 'warning', `S${w.S.raw} exceeds the machine maximum (${this.cfg.settings.maxRpm} rpm)`);
    }
    if (has('T')) {
      const tn = Math.round(w.T.value);
      if (tn > 0 && !this.cfg.tools.some((t) => t.id === tn)) this.diag(L, 'error', `Tool T${tn} is not in the magazine (see Tool table)`);
      st.nextTool = tn;
    }

    // ---- M before motion
    let spindleChanged = has('S') && st.dir !== 'off';
    for (const m of ms) {
      if (m === 6) this.toolChange(L);
      else if (m === 3 || m === 4) {
        st.dir = m === 3 ? 'cw' : 'ccw';
        spindleChanged = true;
        this.hadSpindle = true;
        if (st.rpm <= 0) this.diag(L, 'warning', `M0${m} without S – the spindle does not turn`);
      } else if (m === 8 || m === 7) {
        st.coolant = true;
        this.push({ kind: 'coolant', on: true, line: L });
      }
    }
    if (spindleChanged) this.push({ kind: 'spindle', spindle: { rpm: st.rpm, dir: st.dir }, line: L });

    // ---- target
    const axisWords = has('X') || has('Y') || has('Z');
    const target = (): V3 => {
      const p = { ...st.pos };
      if (st.polar && st.plane === 17 && (has('X') || has('Y'))) {
        // G16: X = radius, Y = angle (about the program origin)
        const cur = Math.hypot(p.x, p.y), ang = (Math.atan2(p.y, p.x) * 180) / Math.PI;
        const r = has('X') ? (st.abs ? val('X')! : cur + val('X')!) : cur;
        const a = has('Y') ? (st.abs ? w.Y.value : ang + w.Y.value) : ang;
        p.x = r * Math.cos((a * Math.PI) / 180);
        p.y = r * Math.sin((a * Math.PI) / 180);
      } else {
        if (has('X')) p.x = st.abs ? val('X')! : p.x + val('X')!;
        if (has('Y')) p.y = st.abs ? val('Y')! : p.y + val('Y')!;
      }
      if (has('Z')) p.z = st.abs ? val('Z')! : p.z + val('Z')!;
      return p;
    };

    let ctl: Ctl = {};
    if (gs.includes(68)) {
      st.rot = { on: true, cx: has('X') ? val('X')! : 0, cy: has('Y') ? val('Y')! : 0, a: has('R') ? w.R.value : 0 };
      this.diag(L, 'info', `G68: coordinates rotated by ${st.rot.a}° about X${st.rot.cx} Y${st.rot.cy}`);
    } else if (nonModal === 4) {
      const sec = has('P') ? (w.P.hasDecimal ? w.P.value : w.P.value / 1000) : has('X') ? w.X.value : 0;
      this.push({ kind: 'dwell', seconds: sec, line: L });
    } else if (nonModal === 28) {
      if (!axisWords) throw new Error('G28 needs the axes to return, e.g. G91 G28 Z0');
      if (st.comp !== 40) this.diag(L, 'warning', 'G28 with cutter compensation active – cancel with G40 first');
      const mid = target();
      this.emitMove('rapid', mid, L, { label: 'G28 intermediate point', cycle: 'G28' }, false);
      const s = this.cfg.settings;
      const home = { ...st.tip };
      if (has('Z')) home.z = s.homeZ - this.actualLength();
      if (has('X')) home.x = s.homeX;
      if (has('Y')) home.y = s.homeY;
      this.emitSimRapid(home, L, 'G28 reference (home) return');
    } else if (nonModal === 53) {
      // machine coordinates: X0 Y0 Z0 = home position of the gauge line
      const s = this.cfg.settings;
      const tip = { ...st.tip };
      if (has('X')) tip.x = s.homeX + val('X')!;
      if (has('Y')) tip.y = s.homeY + val('Y')!;
      if (has('Z')) tip.z = s.homeZ + val('Z')! - this.actualLength();
      this.emitSimRapid(tip, L, 'G53 machine-coordinate move');
    } else if (nonModal === 52) {
      st.local = { x: has('X') ? val('X')! : 0, y: has('Y') ? val('Y')! : 0, z: has('Z') ? val('Z')! : 0 };
      this.diag(L, 'info', `G52 local coordinate system: origin shifted by X${st.local.x} Y${st.local.y} Z${st.local.z}`);
    } else if (cycleG !== null || (st.cyc && (has('X') || has('Y')))) {
      ctl = this.cycle(cycleG, w, val, L);
    } else if (st.cyc && (has('Z') || has('R') || has('Q'))) {
      // new cycle data without a hole position: stored for the next holes
      const c = st.cyc;
      if (has('R')) c.r = st.abs ? val('R')! : c.initZ + val('R')!;
      if (has('Z')) c.z = st.abs ? val('Z')! : c.r + val('Z')!;
      if (has('Q')) c.q = Math.abs(w.Q.hasDecimal ? val('Q')! : w.Q.value / 1000);
    } else if (axisWords || (st.motion >= 2 && (has('I') || has('J') || has('K')))) {
      this.motion(w, val, target(), L);
    }

    // ---- M after motion
    for (const m of ms) {
      if (m === 5) {
        st.dir = 'off';
        this.push({ kind: 'spindle', spindle: { rpm: st.rpm, dir: 'off' }, line: L });
      } else if (m === 9) {
        st.coolant = false;
        this.push({ kind: 'coolant', on: false, line: L });
      } else if (m === 0 || m === 1) {
        this.push({ kind: 'stop', optional: m === 1, line: L, message: b.comment ?? (m === 0 ? 'Program stop (M00)' : 'Optional stop (M01)') });
      } else if (m === 2 || m === 30) {
        if (st.comp !== 40) this.diag(L, 'warning', 'Program ends with cutter compensation active (G40 missing)');
        if (st.cyc) this.diag(L, 'info', 'Canned cycle still active at program end – G80 is good practice');
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

  /** rapid to a tip position given directly in simulator coordinates */
  private emitSimRapid(tip: V3, L: number, label: string) {
    const st = this.st;
    const op: MillMove = {
      kind: 'move', type: 'rapid', from: { ...st.tip }, to: tip, plane: st.plane, feed: st.feed, feedPerRev: st.feedPerRev,
      spindle: { rpm: st.rpm, dir: st.dir }, line: L, tool: st.tool, label, cycle: 'G28',
    };
    this.push(op);
    st.tip = { ...tip };
    const s = this.shift();
    st.pos = { x: tip.x - s.x, y: tip.y - s.y, z: this.fromSimZ(tip.z) };
  }

  private toolChange(L: number) {
    const st = this.st;
    const s = this.cfg.settings;
    if (st.comp !== 40) this.diag(L, 'warning', 'M06 with cutter compensation active – cancel with G40 first');
    if (st.cyc) this.diag(L, 'warning', 'M06 with a canned cycle active – cancel with G80 first');
    const tn = st.nextTool;
    if (tn === st.tool) {
      this.diag(L, 'info', `M06: T${String(tn).padStart(2, '0')} is already in the spindle`);
      return;
    }
    // the machine moves Z to the tool-change height (home) automatically and stops the spindle
    const tipHome = { ...st.tip, z: s.homeZ - this.actualLength() };
    if (Math.abs(st.tip.z - tipHome.z) > 1e-6) this.emitSimRapid(tipHome, L, 'M06: Z to tool-change position');
    if (st.dir !== 'off') {
      st.dir = 'off';
      this.push({ kind: 'spindle', spindle: { rpm: st.rpm, dir: 'off' }, line: L });
    }
    st.tool = tn;
    this.push({ kind: 'tool', tool: tn, line: L });
    if (s.autoLength) {
      // automatic length compensation: the control applies the new tool's length itself
      st.lenComp = 43;
      st.hReg = tn;
      st.autoLen = true;
      st.needG43 = false;
    } else st.needG43 = true;
    if (s.autoRadius) st.dReg = 0;
    st.tip = { ...st.tip, z: s.homeZ - this.actualLength() };
    st.pos = { ...st.pos, z: this.fromSimZ(st.tip.z) };
    const t = this.toolDef();
    const T = `T${String(tn).padStart(2, '0')}`;
    if (s.autoLength && t) this.diag(L, 'info', `Automatic length compensation: ${T} length ${+(t.length + (this.cfg.offsets.get(tn)?.hw ?? 0)).toFixed(3)} mm applied – no G43 H${String(tn).padStart(2, '0')} needed`);
    const po = pointOffset(t, s);
    if (po > 0) this.diag(L, 'info', `Programmed point of ${T}: the ${t!.type === 'ball' ? 'ball' : 'corner-radius'} centre – the tip cuts ${+po.toFixed(3)} mm below the programmed Z`);
  }

  // ------------------------------------------------------------------ motion

  private motion(w: Record<string, Word>, val: (k: string) => number | undefined, tgt: V3, L: number) {
    const st = this.st;
    const has = (k: string) => w[k] !== undefined;
    switch (st.motion) {
      case 0:
        this.emitMove('rapid', tgt, L);
        return;
      case 1: {
        if (this.corner) this.makeCorner(tgt);
        const cw = w[',C'] ?? w[',R'];
        if (cw) {
          if (st.plane !== 17) throw new Error('",C"/",R" are only simulated in the G17 plane');
          const size = cw.value * (st.inch ? 25.4 : 1);
          if (size <= 0) throw new Error(`${cw.letter} must be greater than 0`);
          this.corner = { kind: cw.letter as ',C' | ',R', size, from: { ...st.pos }, corner: { ...tgt }, line: L };
          st.pos = { ...tgt };
          return;
        }
        this.emitMove('linear', tgt, L);
        return;
      }
      case 2:
      case 3: {
        const cw = st.motion === 2;
        const plane = st.plane;
        const [a, b] = PLANE_AXES[plane];
        const from = st.pos;
        const pa = toP(from, plane), pb = toP(tgt, plane);
        const ijk: Record<string, string> = { x: 'I', y: 'J', z: 'K' };
        let c;
        if (has('R')) {
          const R = val('R')!;
          const chord = dist(pa, pb);
          if (chord < EPS) throw new Error('Arc with R: start and end point are the same (use I/J for a full circle)');
          const rr = Math.abs(R);
          if (rr < chord / 2 - 1e-4) throw new Error(`Arc radius R${w.R.raw} is too small for the end point (chord ${chord.toFixed(3)} mm)`);
          const hh = Math.sqrt(Math.max(0, rr * rr - (chord / 2) ** 2));
          const mid = mul(add(pa, pb), 0.5);
          const d = norm(sub(pb, pa));
          const leftSide = !cw === R > 0;
          c = add(mid, mul(leftSide ? leftN(d) : rightN(d), hh));
        } else if (has(ijk[a]) || has(ijk[b])) {
          c = { z: pa.z + (val(ijk[a]) ?? 0), x: pa.x + (val(ijk[b]) ?? 0) };
          const r0 = dist(pa, c), r1 = dist(pb, c);
          if (Math.abs(r0 - r1) > 0.01) throw new Error(`Arc end point is not on the circle (radius ${r0.toFixed(3)} at the start, ${r1.toFixed(3)} at the end) – check ${ijk[a]}/${ijk[b]}`);
        } else throw new Error(`G0${st.motion} needs R or ${ijk[a]}/${ijk[b]} (plane G${plane})`);
        const center = fromP(c, 0, plane);
        this.emitMove('arc', tgt, L, { center: { ...tgt, [a]: center[a], [b]: center[b] }, cw, plane });
        return;
      }
    }
  }

  // ------------------------------------------------------------------ ,C / ,R

  private flushCorner() {
    const c = this.corner;
    if (!c) return;
    this.corner = null;
    this.st.pos = { ...c.from };
    this.emitMove('linear', c.corner, c.line);
  }

  private makeCorner(next: V3) {
    const c = this.corner!;
    this.corner = null;
    const P = (v: V3) => ({ z: v.x, x: v.y });
    const a = P(c.from), k = P(c.corner), n = P(next);
    const d1 = norm(sub(k, a)), d2 = norm(sub(n, k));
    const L1 = dist(a, k), L2 = dist(k, n);
    const cosT = Math.max(-1, Math.min(1, dot(d1, d2)));
    const th = Math.acos(cosT);
    const fail = (msg: string) => {
      this.diag(c.line, 'error', msg);
      this.st.pos = { ...c.from };
      this.emitMove('linear', c.corner, c.line);
      this.st.pos = { ...c.corner };
    };
    if (L2 < 1e-9 || th < 1e-4 || th > Math.PI - 1e-4) return fail(`${c.kind}: no corner between this move and the next (in line, or no X/Y motion)`);
    const t = c.kind === ',C' ? c.size : c.size * Math.tan(th / 2);
    if (t > L1 + 1e-6 || t > L2 + 1e-6) return fail(`${c.kind}${c.size} is too large for the adjacent moves`);
    const p1 = sub(k, mul(d1, t)), p2 = add(k, mul(d2, t));
    const z = c.corner.z;
    const V = (p: { z: number; x: number }): V3 => ({ x: p.z, y: p.x, z });
    this.st.pos = { ...c.from };
    if (t < L1 - 1e-9) this.emitMove('linear', V(p1), c.line);
    else this.st.pos = V(p1);
    if (c.kind === ',C') this.emitMove('linear', V(p2), c.line, { label: `,C${c.size} chamfer` });
    else {
      const inward = norm(sub(d2, mul(d1, cosT)));
      const center = add(p1, mul(inward, c.size));
      this.emitMove('arc', V(p2), c.line, { center: V(center), cw: cross(d1, d2) < 0, plane: 17, label: `,R${c.size} corner radius` });
    }
    this.st.pos = V(p2);
  }

  // ------------------------------------------------------------------ canned cycles

  private cycle(g: number | null, w: Record<string, Word>, val: (k: string) => number | undefined, L: number): Ctl {
    const st = this.st;
    const has = (k: string) => w[k] !== undefined;
    if (g !== null) {
      if (st.comp !== 40) this.diag(L, 'warning', 'Canned cycle with cutter compensation active – cancel with G40 first');
      const prev = st.cyc;
      const initZ = prev ? prev.initZ : st.pos.z;
      const rIn = has('R') ? val('R')! : prev?.r;
      const zIn = has('Z') ? val('Z')! : prev?.z;
      if (rIn === undefined) throw new Error(`G${g} needs R (R-plane, the safe height above the part)`);
      if (zIn === undefined) throw new Error(`G${g} needs Z (hole depth)`);
      // G91: R from the initial level, Z from the R-plane
      const r = st.abs ? rIn : initZ + rIn;
      const z = st.abs ? zIn : r + zIn;
      const q = has('Q') ? Math.abs(w.Q.hasDecimal ? val('Q')! : (w.Q.value / 1000) * (st.inch ? 25.4 : 1)) : prev?.g === g ? prev.q : 0;
      const p = has('P') ? (w.P.hasDecimal ? w.P.value : w.P.value / 1000) : prev?.g === g ? prev.p : 0;
      st.cyc = { g, r, z, q, p, initZ };
      if (z >= r) this.diag(L, 'error', `G${g}: Z${z} is not below the R-plane R${r}`);
      if ((g === 83 || g === 73) && q <= 0) this.diag(L, 'warning', `G${g} without Q (peck depth) – drills in one go`);
      if (has('Q') && !w.Q.hasDecimal && q < 0.1) {
        this.diag(L, 'warning', `Q${w.Q.raw} without a decimal point means ${q} mm (Fanuc least input increment) – did you mean Q${w.Q.raw}. ?`, 'Write Q3. for 3 mm, or Q3000.');
      }
      if ((g === 83 || g === 73) && q > 0 && Math.abs(r - z) / q > 400) throw new Error(`G${g}: ${Math.ceil(Math.abs(r - z) / q)} pecks of ${q} mm – check Q`);
      if (g === 84 || g === 74) {
        const t = this.toolDef();
        if (t?.type !== 'tap') this.diag(L, 'warning', `Tapping cycle G${g} with ${t ? t.name : 'no tool'} – is a tap in the spindle?`);
        if (t && t.pitch > 0 && st.rpm > 0 && !st.feedPerRev) {
          const need = t.pitch * st.rpm;
          if (Math.abs(st.feed - need) > 0.02 * need) {
            this.diag(L, 'warning', `Tapping feed F${st.feed} does not match pitch × rpm = ${t.pitch} × ${st.rpm} = ${need.toFixed(1)} mm/min – the tap would break`);
          }
        }
        if (g === 84 && st.dir !== 'cw') this.diag(L, 'warning', 'G84 (right-hand tap) needs M03');
        if (g === 74 && st.dir !== 'ccw') this.diag(L, 'warning', 'G74 (left-hand tap) needs M04');
      }
      if (r < z) this.diag(L, 'warning', 'R-plane below the hole depth?');
    }
    const cyc = st.cyc!;
    const reps = has('K') ? Math.max(0, Math.round(w.K.value)) : has('L') ? Math.max(0, Math.round(w.L.value)) : 1;
    // hole position
    const xy0 = { ...st.pos };
    for (let k = 0; k < reps; k++) {
      let x = xy0.x, y = xy0.y;
      if (k === 0) {
        const t = this.targetXY(w, val, xy0);
        x = t.x;
        y = t.y;
      } else {
        x = st.pos.x + (has('X') ? val('X')! : 0);
        y = st.pos.y + (has('Y') ? val('Y')! : 0);
      }
      if (!st.abs && cyc.r > st.pos.z && k === 0 && g !== null) {
        /* G91 R relative to initial – already resolved */
      }
      const steps = holeSteps({
        g: cyc.g, x, y, zNow: st.pos.z, r: cyc.r, z: cyc.z, q: cyc.q, p: cyc.p,
        ret: st.ret === 98 ? cyc.initZ : cyc.r, d: cyc.g === 73 ? 0.5 : 1, dir: st.dir === 'ccw' ? 'ccw' : 'cw',
      });
      if (st.pos.z < cyc.r - 1e-9) this.diag(L, 'warning', `G${cyc.g}: the tool starts below the R-plane – it moves sideways at Z${st.pos.z.toFixed(3)}`);
      for (const s of steps) {
        if (s.k === 'move') this.emitMove(s.type, s.to, L, { label: s.label, cycle: `G${cyc.g}` }, false);
        else if (s.k === 'dwell') this.push({ kind: 'dwell', seconds: s.s, line: L });
        else this.push({ kind: 'spindle', spindle: { rpm: st.rpm, dir: s.dir }, line: L });
      }
    }
    return {};
  }

  private targetXY(w: Record<string, Word>, val: (k: string) => number | undefined, p: V3) {
    const st = this.st;
    const has = (k: string) => w[k] !== undefined;
    if (st.polar && (has('X') || has('Y'))) {
      const cur = Math.hypot(p.x, p.y), ang = (Math.atan2(p.y, p.x) * 180) / Math.PI;
      const r = has('X') ? (st.abs ? val('X')! : cur + val('X')!) : cur;
      const a = has('Y') ? (st.abs ? w.Y.value : ang + w.Y.value) : ang;
      return { x: r * Math.cos((a * Math.PI) / 180), y: r * Math.sin((a * Math.PI) / 180) };
    }
    return {
      x: has('X') ? (st.abs ? val('X')! : p.x + val('X')!) : p.x,
      y: has('Y') ? (st.abs ? val('Y')! : p.y + val('Y')!) : p.y,
    };
  }

  finish(): MillResult {
    const ops = applyCutterComp(this.ops, this.comp, (line, msg, sev) => this.diag(line, sev ?? 'warning', msg));
    if (!this.hadSpindle && ops.some((o) => o.kind === 'move' && o.type !== 'rapid')) this.diag(0, 'warning', 'The program never starts the spindle (M03/M04).');
    this.diags.sort((a, b) => a.line - b.line);
    return { ops, diags: this.diags, blocks: this.blocks, state: this.st, modal: this.modal, vars: this.vars, varTrace: this.varTrace };
  }
}

export function interpretMill(src: string, cfg: MillConfig, init?: MillState): MillResult {
  const blocks = lexProgram(src);
  const it = new MillInterpreter(blocks, cfg, init ?? millDefaultState(cfg.settings, cfg.tools));
  it.run();
  return it.finish();
}
