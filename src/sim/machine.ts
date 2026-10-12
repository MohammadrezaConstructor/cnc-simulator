// Machine runtime: executes an op list in (simulated) real time, removes material,
// detects crashes and reports live data for the DRO / control panel.

import type { MachineSettings, MaterialId, MoveOp, Op, P, SpindleState, ToolDef } from '../types';
import { Stock } from './stock';
import { buildToolShape, type ToolShape } from './tools';
import { convexHull, moveLength, pointAt, translate, dist, arcSweep } from './geom';

export interface SimEvent {
  type: 'alarm' | 'warning' | 'info' | 'stop' | 'end' | 'partoff' | 'toolchange';
  message: string;
  line: number;
  hint?: string;
}

export type MachineStatus = 'idle' | 'running' | 'hold' | 'stopped' | 'alarm' | 'done';

/** Specific cutting force kc (N/mm²) for power estimation */
export const MATERIALS: Record<MaterialId, { name: string; kc: number; vc: [number, number]; color: number; raw: number }> = {
  steel: { name: 'Steel C45 (1045)', kc: 2000, vc: [180, 280], color: 0xc9ced6, raw: 0x6b6258 },
  stainless: { name: 'Stainless 304', kc: 2500, vc: [120, 200], color: 0xd6dbe2, raw: 0x8a8c90 },
  aluminium: { name: 'Aluminium 6061', kc: 800, vc: [300, 800], color: 0xe2e6ec, raw: 0xa9adb3 },
  brass: { name: 'Brass CuZn39Pb3', kc: 780, vc: [200, 400], color: 0xe6c66e, raw: 0xa88a3c },
  castiron: { name: 'Grey cast iron', kc: 1100, vc: [150, 250], color: 0xa8acb2, raw: 0x4c4a48 },
  plastic: { name: 'POM (Delrin)', kc: 250, vc: [200, 500], color: 0xf2f0ea, raw: 0xe5e2d8 },
};

export function chuckGeometry(stock: Stock) {
  const R = stock.radius;
  const zl = stock.leftZ;
  const grip = Math.min(stock.def.gripLength, stock.def.length - 1);
  const jawH = Math.max(18, R * 0.5);
  const chuckR = Math.max(R + jawH + 15, 80);
  return {
    jaw: [
      { z: zl - 2, x: R },
      { z: zl + grip, x: R },
      { z: zl + grip, x: R + jawH },
      { z: zl - 2, x: R + jawH },
    ] as P[],
    body: [
      { z: zl - 75, x: 0 },
      { z: zl - 2, x: 0 },
      { z: zl - 2, x: chuckR },
      { z: zl - 75, x: chuckR },
    ] as P[],
    chuckR,
    jawH,
    grip,
  };
}

/** separating-axis test for convex polygons */
export function convexOverlap(a: P[], b: P[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nz = -(q.x - p.x), nx = q.z - p.z;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const v of a) {
        const d = v.z * nz + v.x * nx;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const v of b) {
        const d = v.z * nz + v.x * nx;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax < bmin - 1e-9 || bmax < amin - 1e-9) return false;
    }
  }
  return true;
}
/** mirror a polygon's x if it crosses below the axis (radial symmetry) – returns polys in x ≥ 0 space */
function radialize(poly: P[]): P[][] {
  const neg = poly.some((p) => p.x < 0);
  if (!neg) return [poly];
  return [poly, poly.map((p) => ({ z: p.z, x: -p.x }))];
}

export function spindleRpm(sp: SpindleState, x: number, machineMax: number, override = 1): number {
  if (sp.dir === 'off' || sp.s <= 0) return 0;
  const cap = Math.min(sp.maxRpm > 0 ? sp.maxRpm : machineMax, machineMax);
  let n: number;
  if (sp.mode === 'rpm') n = Math.min(sp.s, machineMax);
  else {
    const D = Math.max(0.1, Math.abs(2 * x));
    n = Math.min((1000 * sp.s) / (Math.PI * D), cap);
  }
  return n * override;
}

/** one sample of the machine state for the charts (every 0.1 s of machine time) */
export interface Sample {
  t: number;
  rpm: number;
  /** axis feed (mm/min), 0 for rapids */
  feed: number;
  kw: number;
  vc: number;
  line: number;
  tool: number;
  rapid: boolean;
}

export interface LiveData {
  pos: P;
  rpm: number;
  feedMmMin: number;
  vc: number;
  mrr: number; // cm³/min
  powerKW: number;
  cutting: boolean;
  line: number;
  label: string;
  moveType: string;
}

export class Machine {
  ops: Op[] = [];
  i = 0;
  s = 0;
  timer = 0;
  pos: P;
  tool = 1;
  offset = 0;
  spindle: SpindleState;
  coolant = false;
  status: MachineStatus = 'idle';
  time = 0;
  cutTime = 0;
  feedOverride = 1;
  rapidOverride = 1;
  spindleOverride = 1;
  singleBlock = false;
  optionalStop = true;
  events: SimEvent[] = [];
  shapes = new Map<number, ToolShape>();
  live: LiveData;
  removedTotal = 0;
  private lens = new Map<number, number>();
  private powerAvg = 0;
  private mrrAvg = 0;
  private overloadWarned = new Set<number>();
  private postThread = false;
  /** helper flag: crash checks disabled (used by "instant" stock preview) */
  noCrash = false;
  /** line → executed */
  executedLines = new Set<number>();
  /** index of last executed move (for path colouring) */
  lastMoveIdx = -1;
  /** chart samples */
  samples: Sample[] = [];
  private lastSampleT = -1;
  private accVol = 0;
  private accT = 0;

  constructor(
    public stock: Stock,
    public tools: ToolDef[],
    public settings: MachineSettings,
  ) {
    this.pos = { x: settings.homeX / 2, z: settings.homeZ };
    this.spindle = { mode: 'rpm', s: 0, maxRpm: settings.maxRpm, dir: 'off' };
    this.rebuildShapes();
    this.live = this.liveData(0, 0, false);
  }

  rebuildShapes() {
    this.shapes.clear();
    for (const t of this.tools) this.shapes.set(t.id, buildToolShape(t));
  }

  get toolDef(): ToolDef | undefined {
    return this.tools.find((t) => t.id === this.tool);
  }
  get shape(): ToolShape | undefined {
    return this.shapes.get(this.tool);
  }

  load(ops: Op[]) {
    this.ops = ops;
    this.i = 0;
    this.s = 0;
    this.timer = 0;
    this.lens.clear();
    this.executedLines.clear();
    this.lastMoveIdx = -1;
    this.status = 'idle';
    this.postThread = false;
    this.samples = [];
    this.lastSampleT = -1;
    this.accVol = 0;
    this.accT = 0;
  }

  private sample(line: number, feed: number, rapid: boolean) {
    if (this.time - this.lastSampleT < 0.1 || this.samples.length > 40000) return;
    const rpm = this.rpmAt(this.pos.x);
    const mrr = this.accT > 0 ? (this.accVol / this.accT) * 0.06 : 0;
    this.samples.push({
      t: this.time,
      rpm,
      feed,
      kw: (mrr * MATERIALS[this.stock.def.material].kc) / 60000,
      vc: (Math.PI * 2 * Math.abs(this.pos.x) * rpm) / 1000,
      line,
      tool: this.tool,
      rapid,
    });
    this.lastSampleT = this.time;
    this.accVol = 0;
    this.accT = 0;
  }

  /** Full reset: home position, spindle off, fresh stock. */
  resetAll() {
    this.stock.reset();
    this.pos = { x: this.settings.homeX / 2, z: this.settings.homeZ };
    this.spindle = { mode: 'rpm', s: 0, maxRpm: this.settings.maxRpm, dir: 'off' };
    this.coolant = false;
    this.time = 0;
    this.cutTime = 0;
    this.removedTotal = 0;
    this.overloadWarned.clear();
    this.load(this.ops);
  }

  /** RESET key: stop execution, rewind, spindle & coolant off. Stock and position are kept. */
  controlReset() {
    this.spindle = { ...this.spindle, dir: 'off' };
    this.coolant = false;
    this.i = 0;
    this.s = 0;
    this.timer = 0;
    this.status = 'idle';
    this.lastMoveIdx = -1;
    this.executedLines.clear();
  }

  private emit(e: SimEvent) {
    this.events.push(e);
  }

  private alarm(message: string, line: number, hint?: string) {
    this.status = 'alarm';
    this.spindle = { ...this.spindle, dir: 'off' };
    this.emit({ type: 'alarm', message, line, hint });
  }

  private len(idx: number, m: MoveOp) {
    let L = this.lens.get(idx);
    if (L === undefined) {
      L = moveLength(m);
      this.lens.set(idx, L);
    }
    return L;
  }

  rpmAt(x: number) {
    return spindleRpm(this.spindle, x, this.settings.maxRpm, this.spindleOverride);
  }

  /** axis velocity in mm/min */
  private velocity(m: MoveOp, p: P): number {
    if (m.type === 'rapid') return this.settings.rapidRate * this.rapidOverride;
    const rpm = this.rpmAt(p.x);
    if (m.type === 'thread') return m.feed * rpm;
    const f = m.feedPerRev ? m.feed * rpm : m.feed;
    return Math.min(f * this.feedOverride, this.settings.rapidRate);
  }

  // ------------------------------------------------------------------ material removal & checks

  private toolPolys(p: P) {
    const sh = this.shape;
    if (!sh) return null;
    return { cutter: translate(sh.cutter, p), holder: sh.holder.map((h) => translate(h, p)) };
  }

  /** sweep the cutter from a to b, returns removed volume */
  private sweep(a: P, b: P, ra = NaN): number {
    const sh = this.shape;
    if (!sh) return 0;
    const pts = translate(sh.cutter, a).concat(translate(sh.cutter, b));
    const hull = convexHull(pts);
    let v = 0;
    for (const poly of radialize(hull)) v += this.stock.removeConvex(poly, ra);
    return v;
  }

  /** theoretical roughness Ra ≈ f² / (32·rε) of a feed move (µm), NaN when not meaningful */
  private moveRa(m: MoveOp, p: P): number {
    const t = this.toolDef;
    if (!t || m.type === 'rapid' || m.type === 'thread' || t.type === 'drill') return NaN;
    const rpm = this.rpmAt(p.x);
    const f = (m.feedPerRev ? m.feed : rpm > 0 ? m.feed / rpm : 0) * this.feedOverride;
    if (f <= 0) return NaN;
    const r = Math.max(0.05, t.noseR);
    return ((f * f) / (32 * r)) * 1000;
  }

  private checkCollisions(p: P, line: number): boolean {
    if (this.noCrash) return false;
    const tp = this.toolPolys(p);
    if (!tp) return false;
    const ch = chuckGeometry(this.stock);
    for (const poly of [tp.cutter, ...tp.holder]) {
      for (const rp of radialize(poly)) {
        if (convexOverlap(rp, ch.jaw) || convexOverlap(rp, ch.body)) {
          this.alarm(
            'CRASH: tool collided with the chuck / jaws',
            line,
            'Check Z values: the jaws hold the bar from the chuck face to the grip length. Keep the tool (and its holder) clear of them.',
          );
          return true;
        }
      }
    }
    for (const h of tp.holder) {
      let v = 0;
      for (const rp of radialize(h)) v += this.stock.overlapConvex(rp);
      if (v > 0.05) {
        this.alarm(
          'CRASH: tool holder hit the workpiece',
          line,
          'The non-cutting part of the tool touched material. Depth of cut too large for the insert, groove deeper than the blade reach, or the boring bar is too thick for the bore.',
        );
        return true;
      }
    }
    return false;
  }

  /** stamp a thread tool at discrete revolutions along a thread move */
  private threadStamp(m: MoveOp, s0: number, s1: number, L: number): number {
    const sh = this.shape;
    if (!sh) return 0;
    const major = Math.max(Math.abs(m.to.z - m.from.z), Math.abs(m.to.x - m.from.x));
    if (major < 1e-9) return 0;
    const stepS = (m.feed / major) * L;
    let v = 0;
    const kStart = s0 <= 1e-9 ? 0 : Math.floor(s0 / stepS) + 1;
    for (let k = kStart; k * stepS <= s1 + 1e-9; k++) {
      const p = pointAt(m, k * stepS);
      for (const poly of radialize(translate(sh.cutter, p))) v += this.stock.removeConvex(poly);
    }
    if (s1 >= L - 1e-9) {
      for (const poly of radialize(translate(sh.cutter, m.to))) v += this.stock.removeConvex(poly);
    }
    return v;
  }

  // ------------------------------------------------------------------ main loop

  /** Advance the simulation by `simSeconds` of machine time. */
  advance(simSeconds: number) {
    let budget = simSeconds;
    let removedThisStep = 0;
    let cutTimeStep = 0;
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
          const tool = this.toolDef;
          if (op.tool !== this.tool && tool) {
            // tool table changed underneath – keep going with the active tool
          }
          let p0 = pointAt(op, this.s);
          if (this.s === 0) p0 = { ...op.from };
          const vMin = this.velocity(op, p0); // mm/min
          if (vMin <= 1e-9) {
            if (op.type !== 'rapid' && (op.feedPerRev || op.type === 'thread') && this.rpmAt(p0.x) <= 0) {
              this.alarm('Feed per revolution with the spindle stopped – axes cannot move', op.line, 'Start the spindle (M03 S..) before feed moves in G99 mode.');
            } else this.alarm('Feed rate is zero', op.line, 'Program an F value.');
            break;
          }
          const remaining = L - this.s;
          let maxStep = op.type === 'rapid' ? 3 : 0.4;
          if (op.type === 'arc' && op.center) {
            const r = dist(op.from, op.center);
            maxStep = Math.min(maxStep, Math.max(0.02, r * 0.08));
          }
          if (op.type === 'thread') maxStep = Math.max(maxStep, op.feed);
          const v = vMin / 60; // mm/s
          let ds = Math.min(remaining, v * budget, maxStep);
          if (remaining <= 1e-9) ds = 0;
          const s1 = this.s + ds;
          const p1 = s1 >= L - 1e-9 ? { ...op.to } : pointAt(op, s1);
          let removed = 0;
          if (op.type === 'thread') removed = this.threadStamp(op, this.s, s1, L);
          else removed = this.sweep(p0, p1, this.moveRa(op, p1));
          this.pos = p1;
          const dt = ds > 0 ? ds / v : 0;
          budget -= dt;
          this.time += dt;
          if (removed > 0) {
            this.removedTotal += removed;
            removedThisStep += removed;
            cutTimeStep += dt;
            if (op.type === 'rapid' && !this.postThread && removed > 0.02 && !this.noCrash) {
              this.alarm('CRASH: rapid move (G00) into the workpiece', op.line, 'G00 moves must stay in air. Approach with G00 to a safe point 1–2 mm away, then cut with G01.');
              break;
            }
            if (this.rpmAt(p1.x) <= 0 && removed > 0.02 && !this.noCrash) {
              this.alarm('CRASH: tool hit the workpiece with the spindle stopped', op.line, 'Start the spindle (M03/M04) before cutting.');
              break;
            }
            if (tool?.type === 'drill' && Math.abs(p1.x - p0.x) > 1e-4 && removed > 0.05 && !this.noCrash) {
              this.emit({ type: 'warning', message: 'Drill moved sideways (X) while in the material – drills only cut axially', line: op.line });
            }
            if (op.type !== 'rapid') this.cutTime += dt;
          }
          this.accVol += removed;
          this.accT += dt;
          this.sample(op.line, op.type === 'rapid' ? 0 : vMin, op.type === 'rapid');
          if (this.checkCollisions(p1, op.line)) break;
          this.s = s1;
          this.lastMoveIdx = this.i;
          this.executedLines.add(op.line);
          if (this.s >= L - 1e-9) {
            this.postThread = op.type === 'thread';
            this.finishOp(op.line);
          }
          break;
        }
        case 'dwell': {
          const need = op.seconds - this.timer;
          const d = Math.min(need, budget);
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
            this.offset = op.offset;
            const t = this.toolDef;
            this.emit({ type: 'toolchange', message: `Tool change → T${String(op.tool).padStart(2, '0')}${String(op.offset).padStart(2, '0')} ${t ? t.name : '(empty station!)'}`, line: op.line });
            if (!t) this.emit({ type: 'warning', message: `Turret station ${op.tool} is empty`, line: op.line });
            if (!this.noCrash && this.checkCollisions(this.pos, op.line)) break;
          }
          const need = this.settings.toolChangeTime - this.timer;
          const d = Math.min(Math.max(0, need), budget);
          this.timer += d;
          budget -= d;
          this.time += d;
          if (this.timer >= this.settings.toolChangeTime - 1e-9) this.finishOp(op.line);
          break;
        }
        case 'spindle': {
          this.spindle = { ...op.spindle };
          this.finishOp(op.line);
          break;
        }
        case 'coolant': {
          this.coolant = op.on;
          this.finishOp(op.line);
          break;
        }
        case 'stop': {
          this.finishOp(op.line, true);
          if (!op.optional || this.optionalStop) {
            this.status = 'stopped';
            this.emit({ type: 'stop', message: op.message + ' – press CYCLE START to continue', line: op.line });
          }
          break;
        }
        case 'end': {
          this.executedLines.add(op.line);
          this.status = 'done';
          this.spindle = { ...this.spindle, dir: 'off' };
          this.coolant = false;
          this.emit({ type: 'end', message: op.rewind ? 'M30 – program end, rewind' : 'Program end', line: op.line });
          this.i++;
          break;
        }
      }
    }
    const used = simSeconds - Math.max(0, budget);
    if (used > 1e-6) {
      const mrr = (removedThisStep / used) * 0.06; // mm³/s → cm³/min
      const kc = MATERIALS[this.stock.def.material].kc;
      const pw = (mrr * kc) / 60000;
      const k = Math.min(1, used * 4);
      this.mrrAvg += (mrr - this.mrrAvg) * k;
      this.powerAvg += (pw - this.powerAvg) * k;
      if (this.powerAvg > this.settings.powerKW) {
        const op = this.ops[Math.min(this.i, this.ops.length - 1)];
        const line = op ? op.line : -1;
        if (!this.overloadWarned.has(line)) {
          this.overloadWarned.add(line);
          this.emit({
            type: 'warning',
            message: `Spindle overload: ~${this.powerAvg.toFixed(1)} kW needed (machine ${this.settings.powerKW} kW)`,
            line,
            hint: 'Reduce depth of cut, feed or cutting speed.',
          });
        }
      }
    }
    this.live = this.liveData(this.mrrAvg, this.powerAvg, cutTimeStep > 0);
  }

  private finishOp(line: number, force = false) {
    this.executedLines.add(line);
    this.i++;
    this.s = 0;
    this.timer = 0;
    const next = this.ops[this.i];
    if (this.singleBlock && this.status === 'running' && (force || !next || next.line !== line)) {
      this.status = 'stopped';
    }
    if (next && next.kind === 'move' && next.type !== 'rapid') this.postThread = false;
  }

  private liveData(mrr: number, pw: number, cutting: boolean): LiveData {
    const op = this.ops[Math.min(this.i, this.ops.length - 1)];
    const m = op && op.kind === 'move' ? op : undefined;
    const rpm = this.rpmAt(this.pos.x);
    let feed = 0;
    if (m && this.status === 'running') feed = this.velocity(m, this.pos);
    return {
      pos: { ...this.pos },
      rpm,
      feedMmMin: feed,
      vc: (Math.PI * 2 * Math.abs(this.pos.x) * rpm) / 1000,
      mrr,
      powerKW: pw,
      cutting,
      line: op ? op.line : -1,
      label: m?.label ?? '',
      moveType: m ? m.type : op ? op.kind : '',
    };
  }

  /** Jog the machine (JOG / handwheel mode). Returns true if the move completed. */
  jog(target: P, rateMmMin: number, rapid: boolean): boolean {
    const m: MoveOp = {
      kind: 'move',
      type: rapid ? 'rapid' : 'linear',
      from: { ...this.pos },
      to: target,
      feed: rateMmMin,
      feedPerRev: false,
      spindle: { ...this.spindle },
      line: -1,
      tool: this.tool,
      label: rapid ? 'Manual rapid jog' : 'Manual jog',
    };
    const prev = { ops: this.ops, i: this.i, s: this.s, st: this.status, so: this.singleBlock, fo: this.feedOverride };
    this.ops = [m];
    this.i = 0;
    this.s = 0;
    this.lens.clear();
    this.status = 'running';
    this.singleBlock = false;
    this.feedOverride = 1;
    const L = moveLength(m);
    const T = L / ((rapid ? this.settings.rapidRate * this.rapidOverride : rateMmMin) / 60);
    this.advance(T + 1e-6);
    const after = this.status as MachineStatus;
    const ok = after !== 'alarm';
    this.events = this.events.filter((e) => e.type !== 'end');
    const alarmed = after === 'alarm';
    this.ops = prev.ops;
    this.i = prev.i;
    this.s = prev.s;
    this.lens.clear();
    this.singleBlock = prev.so;
    this.feedOverride = prev.fo;
    this.status = alarmed ? 'alarm' : prev.st === 'running' ? 'idle' : prev.st;
    return ok;
  }
}

/** Estimated cycle time (s) and per-line times, ignoring overrides. */
export function estimateTime(ops: Op[], settings: MachineSettings): { total: number; cutting: number; perLine: Map<number, number>; opStart: number[] } {
  let total = 0, cutting = 0;
  const perLine = new Map<number, number>();
  const opStart: number[] = [];
  let spindle: SpindleState = { mode: 'rpm', s: 0, maxRpm: settings.maxRpm, dir: 'off' };
  const add = (line: number, t: number) => perLine.set(line, (perLine.get(line) ?? 0) + t);
  for (const op of ops) {
    opStart.push(total);
    if (op.kind === 'spindle') spindle = op.spindle;
    else if (op.kind === 'dwell') {
      total += op.seconds;
      add(op.line, op.seconds);
    } else if (op.kind === 'tool') {
      total += settings.toolChangeTime;
      add(op.line, settings.toolChangeTime);
    } else if (op.kind === 'move') {
      const L = moveLength(op);
      if (L < 1e-9) continue;
      let t = 0;
      if (op.type === 'rapid') t = L / (settings.rapidRate / 60);
      else {
        const n = Math.max(1, Math.min(50, Math.ceil(L / 2)));
        for (let k = 0; k < n; k++) {
          const p = pointAt(op, ((k + 0.5) / n) * L);
          const rpm = spindleRpm(spindle, p.x, settings.maxRpm);
          const f = op.type === 'thread' || op.feedPerRev ? op.feed * rpm : op.feed;
          if (f <= 0) {
            t = 0;
            break;
          }
          t += L / n / (Math.min(f, settings.rapidRate) / 60);
        }
        cutting += t;
      }
      total += t;
      add(op.line, t);
    }
  }
  return { total, cutting, perLine, opStart };
}

export const isArcFull = (m: MoveOp) => m.center && Math.abs(arcSweep(m.from, m.to, m.center, !!m.cw)) > 6.28;
