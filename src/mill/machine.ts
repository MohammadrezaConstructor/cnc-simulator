// Milling machine runtime: executes ops in machine time, removes material from the
// height map, detects crashes and reports live data (rpm, feed, fz, load, climb/conventional).

import type { MillMove, MillOp, MillSettings, MillTool, V3 } from './types';
import { BlockModel } from './stock';
import { moveLength3, pointAt3, arcInfo } from './path';
import { MATERIALS, type MachineStatus, type Sample } from '../sim/machine';
import { envelope } from './tools';

export interface MillEvent {
  type: 'alarm' | 'warning' | 'info' | 'stop' | 'end' | 'toolchange';
  message: string;
  line: number;
  hint?: string;
}

export type Engagement = 'climb' | 'conventional' | 'slot' | 'plunge' | '';

export interface MillLive {
  pos: V3;
  rpm: number;
  feedMmMin: number;
  vc: number;
  fz: number;
  mrr: number;
  powerKW: number;
  cutting: boolean;
  engagement: Engagement;
  line: number;
  label: string;
  moveType: string;
}

/** vise jaws (two boxes along the Y edges of the block) */
export function viseGeometry(b: BlockModel) {
  const jawTop = b.top - b.def.aboveJaws;
  const len = Math.max(b.x1 - b.x0, 60) + 30;
  const cx = (b.x0 + b.x1) / 2;
  return {
    jawTop,
    base: b.bottom - 45,
    jaws: [
      { x0: cx - len / 2, x1: cx + len / 2, y0: b.y0 - 22, y1: b.y0, z0: b.bottom - 45, z1: jawTop },
      { x0: cx - len / 2, x1: cx + len / 2, y0: b.y1, y1: b.y1 + 22, z0: b.bottom - 45, z1: jawTop },
    ],
  };
}

const circleRect = (x: number, y: number, r: number, b: { x0: number; x1: number; y0: number; y1: number }) => {
  const cx = Math.max(b.x0, Math.min(x, b.x1)), cy = Math.max(b.y0, Math.min(y, b.y1));
  return Math.hypot(x - cx, y - cy) < r;
};

const HOLDER_R = 22;
/** width of the parallels under the Y edges of the block, and the gap down to the vise bed */
export const PARALLEL_W = 8;
export const VISE_GAP = 12;

export class MillMachine {
  ops: MillOp[] = [];
  i = 0;
  s = 0;
  timer = 0;
  pos: V3;
  tool = 1;
  spindle: { rpm: number; dir: 'cw' | 'ccw' | 'off' } = { rpm: 0, dir: 'off' };
  coolant = false;
  status: MachineStatus = 'idle';
  time = 0;
  cutTime = 0;
  feedOverride = 1;
  rapidOverride = 1;
  spindleOverride = 1;
  singleBlock = false;
  optionalStop = true;
  events: MillEvent[] = [];
  live: MillLive;
  samples: Sample[] = [];
  /** seconds of cutting per engagement type (for the report) */
  engageTime = { climb: 0, conventional: 0, slot: 0 };
  noCrash = false;
  private lens = new Map<number, number>();
  private powerAvg = 0;
  private mrrAvg = 0;
  private lastSampleT = -1;
  private accVol = 0;
  private accT = 0;
  private overloadWarned = new Set<number>();
  private engagement: Engagement = '';
  private warnedSide = new Set<number>();

  constructor(public block: BlockModel, public tools: MillTool[], public settings: MillSettings) {
    this.pos = this.homeTip();
    this.live = this.liveData(0, 0, false);
  }

  homeTip(): V3 {
    return { x: this.settings.homeX, y: this.settings.homeY, z: this.settings.homeZ - (this.toolDef?.length ?? 0) };
  }
  get toolDef(): MillTool | undefined {
    return this.tools.find((t) => t.id === this.tool);
  }

  load(ops: MillOp[]) {
    this.ops = ops;
    this.i = 0;
    this.s = 0;
    this.timer = 0;
    this.lens.clear();
    this.status = 'idle';
    this.samples = [];
    this.lastSampleT = -1;
    this.accVol = 0;
    this.accT = 0;
    this.engageTime = { climb: 0, conventional: 0, slot: 0 };
  }

  resetAll() {
    this.block.reset();
    this.pos = this.homeTip();
    this.spindle = { rpm: 0, dir: 'off' };
    this.coolant = false;
    this.time = 0;
    this.cutTime = 0;
    this.overloadWarned.clear();
    this.warnedSide.clear();
    this.load(this.ops);
  }

  controlReset() {
    this.spindle = { ...this.spindle, dir: 'off' };
    this.coolant = false;
    this.i = 0;
    this.s = 0;
    this.timer = 0;
    this.status = 'idle';
  }

  private emit(e: MillEvent) {
    this.events.push(e);
  }
  private alarm(message: string, line: number, hint?: string) {
    this.status = 'alarm';
    this.spindle = { ...this.spindle, dir: 'off' };
    this.emit({ type: 'alarm', message, line, hint });
  }

  rpm() {
    return this.spindle.dir === 'off' ? 0 : Math.min(this.spindle.rpm, this.settings.maxRpm) * this.spindleOverride;
  }

  private velocity(m: MillMove): number {
    if (m.type === 'rapid') return this.settings.rapidRate * this.rapidOverride;
    const f = m.feedPerRev ? m.feed * this.rpm() : m.feed;
    return Math.min(f * (m.cycle === 'G84' || m.cycle === 'G74' ? 1 : this.feedOverride), this.settings.rapidRate);
  }

  private len(idx: number, m: MillMove) {
    let L = this.lens.get(idx);
    if (L === undefined) {
      L = moveLength3(m);
      this.lens.set(idx, L);
    }
    return L;
  }

  /** collision checks for the tool at tip position p */
  private collide(p: V3, line: number): boolean {
    if (this.noCrash) return false;
    const t = this.toolDef;
    const b = this.block;
    const R = t ? t.diameter / 2 : 0;
    const L = t ? t.length : 0;
    const v = viseGeometry(b);
    // vise jaws: tool body (radius R) or holder below the jaw top
    for (const j of v.jaws) {
      if ((t && p.z < j.z1 && circleRect(p.x, p.y, Math.max(R, 1), j)) || (p.z + L < j.z1 && circleRect(p.x, p.y, HOLDER_R, j))) {
        this.alarm('CRASH: tool hit the vise jaws', line, 'The block is clamped in a vise along its Y sides. Keep the tool (and holder) above the jaws there, or clamp the part higher (Stock → height above jaws).');
        return true;
      }
    }
    // parallels under the Y edges of the block, vise bed further down
    const par = PARALLEL_W;
    const strips = [
      { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y0 + par },
      { x0: b.x0, x1: b.x1, y0: b.y1 - par, y1: b.y1 },
    ];
    if (p.z < b.bottom - 0.3 && strips.some((s) => circleRect(p.x, p.y, Math.max(R, 1), s))) {
      this.alarm('CRASH: tool cut through the part into the parallels', line, `The parallels support the block along its Y edges (${par} mm wide). Through holes and cut-throughs must stay away from them – or check the Z value (and G43!).`);
      return true;
    }
    if (p.z < b.bottom - VISE_GAP && circleRect(p.x, p.y, Math.max(R, 1), { x0: b.x0 - 20, x1: b.x1 + 20, y0: b.y0, y1: b.y1 })) {
      this.alarm('CRASH: tool hit the vise bed under the part', line, `There are ${VISE_GAP} mm between the bottom of the block and the vise bed.`);
      return true;
    }
    if (!t) return false;
    // shank above the flutes, and the tool holder at the gauge line
    const shankZ = p.z + t.fluteLength;
    if (shankZ < b.top && b.overlapsBlock(p.x, p.y, R)) {
      if (b.maxInCircle(p.x, p.y, R * 0.98) > shankZ + 0.05) {
        this.alarm('CRASH: the tool shank rubs the part – flute length too short for this depth', line, `T${t.id} cuts only ${t.fluteLength} mm deep. Use a longer tool or less depth.`);
        return true;
      }
    }
    const gauge = p.z + L;
    if (gauge < b.top && b.overlapsBlock(p.x, p.y, HOLDER_R)) {
      if (b.maxInCircle(p.x, p.y, HOLDER_R, 3) > gauge) {
        this.alarm('CRASH: the tool holder hit the part', line, 'The tool sticks out too little for this depth.');
        return true;
      }
    }
    return false;
  }

  /** which side of the tool has material: climb (M03, material on the right) / conventional / slot */
  private engagementAt(p: V3, dir: { x: number; y: number }): Engagement {
    const t = this.toolDef;
    if (!t) return '';
    const R = t.diameter / 2;
    const L = Math.hypot(dir.x, dir.y);
    if (L < 1e-9) return 'plunge';
    const ux = dir.x / L, uy = dir.y / L;
    const lx = -uy, ly = ux; // left normal
    const zc = p.z + 0.05;
    const probe = (fx: number, fy: number) => {
      const h = this.block.heightAt(p.x + fx * R * 0.7 + ux * R * 0.5, p.y + fy * R * 0.7 + uy * R * 0.5);
      return h !== null && h > zc;
    };
    const left = probe(lx, ly), right = probe(-lx, -ly);
    if (left && right) return 'slot';
    if (!left && !right) return '';
    const rightIsClimb = this.spindle.dir !== 'ccw';
    return right === rightIsClimb ? 'climb' : 'conventional';
  }

  private sample(line: number, feed: number, rapid: boolean) {
    if (this.time - this.lastSampleT < 0.1 || this.samples.length > 40000) return;
    const rpm = this.rpm();
    const mrr = this.accT > 0 ? (this.accVol / this.accT) * 0.06 : 0;
    const D = this.toolDef?.diameter ?? 0;
    this.samples.push({
      t: this.time, rpm, feed, kw: (mrr * MATERIALS[this.block.def.material].kc) / 60000,
      vc: (Math.PI * D * rpm) / 1000, line, tool: this.tool, rapid,
    });
    this.lastSampleT = this.time;
    this.accVol = 0;
    this.accT = 0;
  }

  advance(simSeconds: number) {
    let budget = simSeconds;
    let removedStep = 0;
    let cutStep = 0;
    let guard = 0;
    while (budget > 1e-9 && this.status === 'running') {
      if (++guard > 200000) break;
      const op = this.ops[this.i];
      if (!op) {
        this.status = 'done';
        this.emit({ type: 'end', message: 'Program finished', line: -1 });
        break;
      }
      switch (op.kind) {
        case 'move': {
          const L = this.len(this.i, op);
          const v = this.velocity(op) / 60;
          if (v <= 1e-9) {
            if (op.type !== 'rapid' && op.feedPerRev && this.rpm() <= 0) this.alarm('Feed per revolution (G95) with the spindle stopped – axes cannot move', op.line);
            else this.alarm('Feed rate is zero', op.line, 'Program an F value.');
            break;
          }
          const p0 = this.s === 0 ? { ...op.from } : pointAt3(op, this.s, L);
          let maxStep = op.type === 'rapid' ? 4 : 1.5;
          if (op.type === 'arc' && op.center) {
            const a = arcInfo(op);
            maxStep = Math.min(maxStep, Math.max(0.05, a.r * 0.15));
          }
          const remaining = L - this.s;
          const ds = remaining <= 1e-9 ? 0 : Math.min(remaining, v * budget, maxStep);
          const s1 = this.s + ds;
          const p1 = s1 >= L - 1e-9 ? { ...op.to } : pointAt3(op, s1, L);
          const t = this.toolDef;
          let removed = 0;
          if (t) {
            const before = this.engagementAt(p1, { x: p1.x - p0.x, y: p1.y - p0.y });
            removed = this.block.sweep(t, p0, p1, this.tool);
            if (removed > 0 && op.type !== 'rapid') this.engagement = before || (Math.abs(p1.z - p0.z) > 1e-6 ? 'plunge' : '');
          }
          this.pos = p1;
          const dt = ds > 0 ? ds / v : 0;
          budget -= dt;
          this.time += dt;
          if (removed > 0) {
            removedStep += removed;
            cutStep += dt;
            if (op.type !== 'rapid') this.cutTime += dt;
            if (!this.noCrash) {
              if (op.type === 'rapid' && removed > 0.05) {
                this.alarm('CRASH: rapid move (G00) into the workpiece', op.line, 'G00 must stay in air. Approach to 1–2 mm above the material with G00, then feed with G01. Also check G43 H: without it the tool is one tool-length lower than programmed.');
                break;
              }
              if (this.rpm() <= 0 && removed > 0.05) {
                this.alarm('CRASH: tool hit the workpiece with the spindle stopped', op.line, 'After M06 the spindle is off – program M03 S… for every tool.');
                break;
              }
              if (t && !t.centerCutting && p1.z < p0.z - 1e-4 && Math.hypot(p1.x - p0.x, p1.y - p0.y) < (p0.z - p1.z) * 2 && removed > 0.5) {
                this.alarm(`CRASH: ${t.name} cannot plunge into the material`, op.line, 'Face mills have no cutting edge in the centre. Start the cut outside the part and move in sideways, or ramp in.');
                break;
              }
              if (t && (t.type === 'drill' || t.type === 'spot' || t.type === 'tap' || t.type === 'ream') && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 1e-4 && removed > 0.2 && !this.warnedSide.has(op.line)) {
                this.warnedSide.add(op.line);
                if (t.type === 'tap') {
                  this.alarm('CRASH: tap moved sideways in the hole – broken tap', op.line);
                  break;
                }
                this.emit({ type: 'warning', message: `${t.name} moved sideways while in the material – drills and reamers only cut axially`, line: op.line });
              }
            }
            if (this.engagement === 'climb' || this.engagement === 'conventional' || this.engagement === 'slot') this.engageTime[this.engagement] += dt;
          } else if (op.type !== 'rapid') this.engagement = '';
          this.accVol += removed;
          this.accT += dt;
          this.sample(op.line, op.type === 'rapid' ? 0 : v * 60, op.type === 'rapid');
          if (this.collide(p1, op.line)) break;
          this.s = s1;
          if (this.s >= L - 1e-9) this.finishOp(op.line);
          break;
        }
        case 'dwell': {
          const d = Math.min(op.seconds - this.timer, budget);
          this.timer += d;
          budget -= d;
          this.time += d;
          this.accT += d;
          this.sample(op.line, 0, false);
          if (this.timer >= op.seconds - 1e-9) this.finishOp(op.line);
          break;
        }
        case 'tool': {
          if (this.timer === 0) {
            this.tool = op.tool;
            const t = this.toolDef;
            this.emit({ type: 'toolchange', message: `Tool change M06 → T${String(op.tool).padStart(2, '0')} ${t ? t.name : '(empty pocket!)'}`, line: op.line });
          }
          const d = Math.min(Math.max(0, this.settings.toolChangeTime - this.timer), budget);
          this.timer += d;
          budget -= d;
          this.time += d;
          if (this.timer >= this.settings.toolChangeTime - 1e-9) this.finishOp(op.line);
          break;
        }
        case 'spindle':
          this.spindle = { ...op.spindle };
          this.finishOp(op.line);
          break;
        case 'coolant':
          this.coolant = op.on;
          this.finishOp(op.line);
          break;
        case 'stop':
          this.finishOp(op.line, true);
          if (!op.optional || this.optionalStop) {
            this.status = 'stopped';
            this.emit({ type: 'stop', message: op.message + ' – press CYCLE START to continue', line: op.line });
          }
          break;
        case 'end':
          this.status = 'done';
          this.spindle = { ...this.spindle, dir: 'off' };
          this.coolant = false;
          this.emit({ type: 'end', message: op.rewind ? 'M30 – program end, rewind' : 'Program end', line: op.line });
          this.i++;
          break;
      }
    }
    const used = simSeconds - Math.max(0, budget);
    if (used > 1e-6) {
      const mrr = (removedStep / used) * 0.06;
      const pw = (mrr * MATERIALS[this.block.def.material].kc) / 60000;
      const k = Math.min(1, used * 4);
      this.mrrAvg += (mrr - this.mrrAvg) * k;
      this.powerAvg += (pw - this.powerAvg) * k;
      if (this.powerAvg > this.settings.powerKW) {
        const op = this.ops[Math.min(this.i, this.ops.length - 1)];
        const line = op ? op.line : -1;
        if (!this.overloadWarned.has(line)) {
          this.overloadWarned.add(line);
          this.emit({ type: 'warning', message: `Spindle overload: ~${this.powerAvg.toFixed(1)} kW needed (machine ${this.settings.powerKW} kW)`, line, hint: 'Reduce the depth or width of cut, or the feed.' });
        }
      }
    }
    this.live = this.liveData(this.mrrAvg, this.powerAvg, cutStep > 0);
  }

  private finishOp(line: number, force = false) {
    this.i++;
    this.s = 0;
    this.timer = 0;
    const next = this.ops[this.i];
    if (this.singleBlock && this.status === 'running' && (force || !next || next.line !== line)) this.status = 'stopped';
  }

  private liveData(mrr: number, pw: number, cutting: boolean): MillLive {
    const op = this.ops[Math.min(this.i, this.ops.length - 1)];
    const m = op && op.kind === 'move' ? op : undefined;
    const rpm = this.rpm();
    const feed = m && this.status === 'running' ? this.velocity(m) : 0;
    const t = this.toolDef;
    return {
      pos: { ...this.pos },
      rpm,
      feedMmMin: feed,
      vc: t ? (Math.PI * t.diameter * rpm) / 1000 : 0,
      fz: t && rpm > 0 && m && m.type !== 'rapid' ? feed / (rpm * Math.max(1, t.flutes)) : 0,
      mrr,
      powerKW: pw,
      cutting,
      engagement: cutting ? this.engagement : '',
      line: op ? op.line : -1,
      label: m?.label ?? '',
      moveType: m ? m.type : op ? op.kind : '',
    };
  }

  /** manual jog (JOG mode) */
  jog(target: V3, rateMmMin: number, rapid: boolean): boolean {
    const m: MillMove = {
      kind: 'move', type: rapid ? 'rapid' : 'linear', from: { ...this.pos }, to: target, plane: 17, feed: rateMmMin, feedPerRev: false,
      spindle: { ...this.spindle }, line: -1, tool: this.tool, label: rapid ? 'Manual rapid jog' : 'Manual jog',
    };
    const prev = { ops: this.ops, i: this.i, s: this.s, st: this.status, sb: this.singleBlock, fo: this.feedOverride };
    this.ops = [m];
    this.i = 0;
    this.s = 0;
    this.lens.clear();
    this.status = 'running';
    this.singleBlock = false;
    this.feedOverride = 1;
    const L = moveLength3(m);
    this.advance(L / ((rapid ? this.settings.rapidRate * this.rapidOverride : rateMmMin) / 60) + 1e-6);
    const after = this.status as MachineStatus;
    this.events = this.events.filter((e) => e.type !== 'end');
    this.ops = prev.ops;
    this.i = prev.i;
    this.s = prev.s;
    this.lens.clear();
    this.singleBlock = prev.sb;
    this.feedOverride = prev.fo;
    this.status = after === 'alarm' ? 'alarm' : prev.st === 'running' ? 'idle' : prev.st;
    return after !== 'alarm';
  }
}

export function estimateMillTime(ops: MillOp[], s: MillSettings) {
  let total = 0, cutting = 0;
  const perLine = new Map<number, number>();
  const opStart: number[] = [];
  let rpm = 0;
  const add = (l: number, t: number) => perLine.set(l, (perLine.get(l) ?? 0) + t);
  for (const op of ops) {
    opStart.push(total);
    if (op.kind === 'spindle') rpm = op.spindle.dir === 'off' ? 0 : op.spindle.rpm;
    else if (op.kind === 'dwell') {
      total += op.seconds;
      add(op.line, op.seconds);
    } else if (op.kind === 'tool') {
      total += s.toolChangeTime;
      add(op.line, s.toolChangeTime);
    } else if (op.kind === 'move') {
      const L = moveLength3(op);
      if (L < 1e-9) continue;
      const f = op.type === 'rapid' ? s.rapidRate : op.feedPerRev ? op.feed * rpm : op.feed;
      if (f <= 0) continue;
      const t = L / (Math.min(f, s.rapidRate) / 60);
      total += t;
      if (op.type !== 'rapid') cutting += t;
      add(op.line, t);
    }
  }
  return { total, cutting, perLine, opStart };
}

export { envelope };
