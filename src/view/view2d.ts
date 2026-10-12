// 2D cross-section view (Z horizontal, X vertical) drawn on a canvas.

import type { MoveOp, Op, P } from '../types';
import type { Machine } from '../sim/machine';
import { chuckGeometry } from '../sim/machine';
import { discretize, deg, translate } from '../sim/geom';
import type { Deviation } from '../sim/inspect';

export interface View2DOptions {
  mirror: boolean;
  showPath: boolean;
  showRapids: boolean;
  showTool: boolean;
  showHolder: boolean;
  showTarget: boolean;
  measure: boolean;
  showRa: boolean;
}

interface PathItem {
  idx: number;
  line: number;
  type: MoveOp['type'];
  pts: P[];
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

export class View2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  scale = 4; // px per mm
  cz = 0; // world z at canvas centre
  cx = 0; // world x (radius) at canvas centre
  opts: View2DOptions = { mirror: true, showPath: true, showRapids: true, showTool: true, showHolder: true, showTarget: true, measure: false, showRa: false };
  private paths: PathItem[] = [];
  selectedLine = -1;
  target: { outer: P[]; inner: P[] } | null = null;
  deviations: Deviation[] = [];
  tolerance = 0.05;
  private hover: { z: number; x: number } | null = null;
  private measurePts: P[] = [];
  private dirty = true;
  private colors: Record<string, string> = {};
  onPick: (line: number) => void = () => {};
  onHover: (p: P | null) => void = () => {};
  private hatch: CanvasPattern | null = null;
  /** fit() has run with a real canvas size */
  private fitted = false;

  constructor(private host: HTMLElement, private machine: Machine) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view2d-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.bind();
    this.refreshColors();
  }

  refreshColors() {
    for (const k of ['--v-bg', '--v-grid', '--v-grid2', '--v-axis', '--v-text', '--v-stock', '--v-stock-edge', '--v-chuck', '--v-jaw', '--v-rapid', '--v-feed', '--v-arc', '--v-thread', '--v-done', '--v-sel', '--v-cutter', '--v-holder', '--v-target', '--v-over', '--v-under', '--v-hatch', '--v-dropped', '--ra1', '--ra2', '--ra3', '--ra4']) {
      this.colors[k] = css(k);
    }
    this.hatch = null;
    this.invalidate();
  }

  setMachine(m: Machine) {
    this.machine = m;
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
  }

  setOps(ops: Op[]) {
    this.paths = [];
    ops.forEach((o, idx) => {
      if (o.kind !== 'move') return;
      this.paths.push({ idx, line: o.line, type: o.type, pts: discretize(o, deg(4)) });
    });
    this.invalidate();
  }

  // ------------------------------------------------------------------ transforms
  private sx(z: number) {
    return (z - this.cz) * this.scale + this.w / 2;
  }
  private sy(x: number) {
    return this.h / 2 - (x - this.cx) * this.scale;
  }
  private wz(px: number) {
    return (px - this.w / 2) / this.scale + this.cz;
  }
  private wx(py: number) {
    return (this.h / 2 - py) / this.scale + this.cx;
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(10, r.width);
    this.h = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.invalidate();
    if (!this.fitted && this.w > 60 && this.h > 60) this.fit();
    this.draw();
  }

  fit() {
    if (this.w <= 60 || this.h <= 60) {
      this.fitted = false;
      return;
    }
    this.fitted = true;
    const s = this.machine.stock;
    const R = s.radius;
    const ch = chuckGeometry(s);
    const zmin = s.leftZ - 10;
    const zmax = Math.max(s.faceZ + 25, 30);
    const xmax = Math.max(R + ch.jawH + 8, R * 1.6);
    const xmin = this.opts.mirror ? -xmax : -8;
    this.scale = Math.min(this.w / (zmax - zmin), this.h / (xmax - xmin)) * 0.92;
    this.cz = (zmin + zmax) / 2;
    this.cx = (xmin + xmax) / 2;
    this.invalidate();
  }

  private bind() {
    const c = this.canvas;
    let drag: { x: number; y: number; cz: number; cx: number; moved: boolean } | null = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const z0 = this.wz(px), x0 = this.wx(py);
      const k = Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.min(400, Math.max(0.3, this.scale * k));
      this.cz = z0 - (px - this.w / 2) / this.scale;
      this.cx = x0 - (this.h / 2 - py) / this.scale;
      this.invalidate();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, cz: this.cz, cx: this.cx, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      this.hover = { z: this.wz(px), x: this.wx(py) };
      this.onHover({ z: this.hover.z, x: this.hover.x });
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          this.cz = drag.cz - dx / this.scale;
          this.cx = drag.cx + dy / this.scale;
        }
      }
      this.invalidate();
    });
    c.addEventListener('pointerup', (e) => {
      const wasClick = drag && !drag.moved;
      drag = null;
      if (!wasClick) return;
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (this.opts.measure) {
        const p = { z: this.wz(px), x: Math.abs(this.wx(py)) * Math.sign(this.wx(py) || 1) };
        if (this.measurePts.length >= 2) this.measurePts = [];
        this.measurePts.push(this.snap(p));
        this.invalidate();
        return;
      }
      const line = this.pick(px, py);
      if (line >= 0) this.onPick(line);
    });
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.onHover(null);
      this.invalidate();
    });
    c.addEventListener('dblclick', () => this.fit());
  }

  /** snap a measuring point to nearby stock vertices (within 6 px) */
  private snap(p: P): P {
    let best = p;
    let bd = 6 / this.scale;
    for (const b of this.machine.stock.bodies(0.01)) {
      for (const q of b.outline) {
        for (const s of [1, -1]) {
          const d = Math.hypot(q.z - p.z, q.x * s - p.x);
          if (d < bd) {
            bd = d;
            best = { z: q.z, x: q.x * s };
          }
        }
      }
    }
    return best;
  }

  private pick(px: number, py: number): number {
    let best = -1;
    let bd = 8;
    for (const it of this.paths) {
      if (!this.opts.showRapids && it.type === 'rapid') continue;
      for (let i = 1; i < it.pts.length; i++) {
        const a = it.pts[i - 1], b = it.pts[i];
        const ax = this.sx(a.z), ay = this.sy(a.x), bx = this.sx(b.z), by = this.sy(b.x);
        const dx = bx - ax, dy = by - ay;
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
        const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
        if (d < bd) {
          bd = d;
          best = it.line;
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ drawing

  draw(force = false) {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const ctx = this.ctx;
    const C = this.colors;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C['--v-bg'];
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawGrid();
    this.drawChuck();
    this.drawStock();
    if (this.opts.showRa) this.drawRa();
    if (this.opts.showTarget) this.drawTarget();
    if (this.opts.showPath) this.drawPaths();
    this.drawMarkers();
    if (this.opts.showTool) this.drawTool();
    this.drawMeasure();
    this.drawHud();
  }

  private gridStep() {
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    for (const s of steps) if (s * this.scale >= 14) return s;
    return 1000;
  }

  private drawGrid() {
    const ctx = this.ctx;
    const C = this.colors;
    const step = this.gridStep();
    const major = step * 5;
    const z0 = this.wz(0), z1 = this.wz(this.w);
    const x0 = this.wx(this.h), x1 = this.wx(0);
    ctx.lineWidth = 1;
    for (const [st, col] of [[step, C['--v-grid']], [major, C['--v-grid2']]] as [number, string][]) {
      ctx.strokeStyle = col;
      ctx.beginPath();
      for (let z = Math.ceil(z0 / st) * st; z <= z1; z += st) {
        const x = Math.round(this.sx(z)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.h);
      }
      for (let x = Math.ceil(x0 / st) * st; x <= x1; x += st) {
        const y = Math.round(this.sy(x)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.w, y);
      }
      ctx.stroke();
    }
    // labels
    ctx.fillStyle = C['--v-text'];
    ctx.font = '10px var(--mono, monospace)';
    ctx.textBaseline = 'top';
    const dec = major < 1 ? 2 : 0;
    for (let z = Math.ceil(z0 / major) * major; z <= z1; z += major) {
      ctx.fillText(`Z${z.toFixed(dec)}`, this.sx(z) + 3, this.h - 14);
    }
    ctx.textBaseline = 'middle';
    for (let x = Math.ceil(x0 / major) * major; x <= x1; x += major) {
      if (Math.abs(x) < 1e-9) continue;
      ctx.fillText(`Ø${(Math.abs(x) * 2).toFixed(dec)}`, 4, this.sy(x) - 6);
    }
    // spindle centre line (dash-dot)
    ctx.strokeStyle = C['--v-axis'];
    ctx.setLineDash([14, 4, 2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, this.sy(0));
    ctx.lineTo(this.w, this.sy(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private polyPath(poly: P[], mirror = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    poly.forEach((p, i) => {
      const X = this.sx(p.z), Y = this.sy(p.x * mirror);
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.closePath();
  }

  private drawChuck() {
    const ctx = this.ctx;
    const C = this.colors;
    const ch = chuckGeometry(this.machine.stock);
    for (const m of this.opts.mirror ? [1, -1] : [1]) {
      ctx.fillStyle = C['--v-chuck'];
      this.polyPath(ch.body, m);
      ctx.fill();
      ctx.fillStyle = C['--v-jaw'];
      this.polyPath(ch.jaw, m);
      ctx.fill();
      ctx.strokeStyle = C['--v-stock-edge'];
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private getHatch(): CanvasPattern | string {
    if (this.hatch) return this.hatch;
    const c = document.createElement('canvas');
    c.width = c.height = 10;
    const g = c.getContext('2d')!;
    g.fillStyle = this.colors['--v-stock'];
    g.fillRect(0, 0, 10, 10);
    g.strokeStyle = this.colors['--v-hatch'];
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, 10);
    g.lineTo(10, 0);
    g.moveTo(-5, 5);
    g.lineTo(5, -5);
    g.moveTo(5, 15);
    g.lineTo(15, 5);
    g.stroke();
    this.hatch = this.ctx.createPattern(c, 'repeat');
    return this.hatch ?? this.colors['--v-stock'];
  }

  private drawStock() {
    const ctx = this.ctx;
    const C = this.colors;
    const tol = Math.max(0.0015, 0.4 / this.scale);
    const bodies = this.machine.stock.bodies(tol);
    const fill = this.getHatch();
    for (const m of this.opts.mirror ? [1, -1] : [1]) {
      for (const b of bodies) {
        this.polyPath(b.outline, m);
        ctx.fillStyle = fill;
        ctx.fill();
        // outline only along the real surfaces
        ctx.strokeStyle = C['--v-stock-edge'];
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (const chain of [b.top, b.bottom]) {
          chain.forEach((p, i) => {
            const X = this.sx(p.z), Y = this.sy(p.x * m);
            if (i === 0) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
          });
        }
        for (const cap of b.caps) {
          ctx.moveTo(this.sx(cap.z), this.sy(cap.r0 * m));
          ctx.lineTo(this.sx(cap.z), this.sy(cap.r1 * m));
        }
        ctx.stroke();
      }
    }
    // parted-off piece in the catcher (drawn below the axis, offset)
    const dropped = this.machine.stock.droppedBodies(tol);
    if (dropped.length) {
      ctx.globalAlpha = 0.85;
      for (const b of dropped) {
        for (const m of this.opts.mirror ? [1, -1] : [1]) {
          ctx.fillStyle = C['--v-dropped'];
          this.polyPath(b.outline.map((p) => ({ z: p.z + 6, x: p.x })), m);
          ctx.fill();
          ctx.strokeStyle = C['--v-stock-edge'];
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      const zr = Math.max(...dropped.flatMap((b) => b.outline.map((p) => p.z))) + 6;
      ctx.fillStyle = C['--v-text'];
      ctx.font = '11px var(--sans, sans-serif)';
      ctx.fillText('✂ parted off', this.sx(zr) + 6, this.sy(this.machine.stock.radius));
    }
  }

  /** roughness classes (µm): ≤0.8, ≤1.6, ≤3.2, >3.2 */
  static raClass(ra: number) {
    return ra <= 0.8 ? 0 : ra <= 1.6 ? 1 : ra <= 3.2 ? 2 : 3;
  }

  private drawRa() {
    const st = this.machine.stock;
    const C = this.colors;
    const ctx = this.ctx;
    const cols = ['--ra1', '--ra2', '--ra3', '--ra4'].map((k) => C[k]);
    const off = 3 / this.scale;
    for (const inner of [false, true]) {
      const arr = inner ? st.raIn : st.raOut;
      for (let cls = 0; cls < 4; cls++) {
        ctx.strokeStyle = cols[cls];
        ctx.lineWidth = 4;
        ctx.lineCap = 'butt';
        for (const m of this.opts.mirror ? [1, -1] : [1]) {
          ctx.beginPath();
          let open = false;
          for (let i = 0; i < st.n; i++) {
            const c = st.cols[i];
            const ra = arr[i];
            if (!c.length || Number.isNaN(ra) || View2D.raClass(ra) !== cls || (inner && c[0] < 0.05)) {
              open = false;
              continue;
            }
            const r = inner ? c[0] - off : c[c.length - 1] + off;
            const z0 = st.z0 + i * st.dz, z1 = z0 + st.dz;
            if (!open) ctx.moveTo(this.sx(z0), this.sy(r * m));
            ctx.lineTo(this.sx(z1), this.sy(r * m));
            open = true;
          }
          ctx.stroke();
        }
      }
    }
    // legend (text in text colour, swatch carries the class)
    const labels = ['Ra ≤ 0.8', '≤ 1.6', '≤ 3.2', '> 3.2 µm'];
    ctx.font = '11px var(--sans, sans-serif)';
    ctx.textBaseline = 'middle';
    let x = 12;
    const y = 40;
    labels.forEach((l, i) => {
      ctx.fillStyle = cols[i];
      ctx.fillRect(x, y - 2, 16, 4);
      ctx.fillStyle = C['--v-text'];
      ctx.fillText(l, x + 20, y);
      x += 26 + ctx.measureText(l).width;
    });
    ctx.textBaseline = 'alphabetic';
  }

  private drawTarget() {
    if (!this.target) return;
    const ctx = this.ctx;
    const C = this.colors;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = C['--v-target'];
    ctx.lineWidth = 1.5;
    for (const poly of [this.target.outer, this.target.inner]) {
      if (poly.length < 2) continue;
      for (const m of this.opts.mirror ? [1, -1] : [1]) {
        ctx.beginPath();
        poly.forEach((p, i) => (i ? ctx.lineTo(this.sx(p.z), this.sy(p.x * m)) : ctx.moveTo(this.sx(p.z), this.sy(p.x * m))));
        ctx.stroke();
      }
    }
    ctx.restore();
    // deviation map (exaggerated whiskers)
    if (this.deviations.length) {
      const k = Math.max(20, 3 / this.scale);
      for (const d of this.deviations) {
        if (Math.abs(d.dev) <= this.tolerance) continue;
        const over = d.dev > 0;
        ctx.strokeStyle = over ? C['--v-over'] : C['--v-under'];
        ctx.lineWidth = 1.5;
        const r0 = d.r;
        const sign = d.inner ? -1 : 1;
        const r1 = d.r + sign * Math.sign(d.dev) * Math.min(Math.abs(d.dev) / 2 * k, 6);
        ctx.beginPath();
        ctx.moveTo(this.sx(d.z), this.sy(r0));
        ctx.lineTo(this.sx(d.z), this.sy(r1));
        ctx.stroke();
      }
    }
  }

  private drawPaths() {
    const ctx = this.ctx;
    const C = this.colors;
    const m = this.machine;
    const doneIdx = m.status === 'done' ? Infinity : m.i;
    const typeColor = (t: string) => (t === 'rapid' ? C['--v-rapid'] : t === 'arc' ? C['--v-arc'] : t === 'thread' ? C['--v-thread'] : C['--v-feed']);
    for (const pass of [0, 1]) {
      for (const it of this.paths) {
        if (it.type === 'rapid' && !this.opts.showRapids) continue;
        const executed = it.idx < doneIdx;
        if ((pass === 0) !== !executed) continue; // future first, then executed on top
        ctx.strokeStyle = typeColor(it.type);
        ctx.globalAlpha = executed ? 1 : 0.38;
        ctx.lineWidth = executed ? 1.4 : 1;
        ctx.setLineDash(it.type === 'rapid' ? [5, 4] : []);
        ctx.beginPath();
        it.pts.forEach((p, i) => (i ? ctx.lineTo(this.sx(p.z), this.sy(p.x)) : ctx.moveTo(this.sx(p.z), this.sy(p.x))));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    if (this.selectedLine >= 0) {
      ctx.strokeStyle = C['--v-sel'];
      ctx.lineWidth = 3;
      for (const it of this.paths) {
        if (it.line !== this.selectedLine) continue;
        ctx.beginPath();
        it.pts.forEach((p, i) => (i ? ctx.lineTo(this.sx(p.z), this.sy(p.x)) : ctx.moveTo(this.sx(p.z), this.sy(p.x))));
        ctx.stroke();
        // direction arrow at the end
        const a = it.pts[it.pts.length - 2], b = it.pts[it.pts.length - 1];
        if (a && b) this.arrow(this.sx(a.z), this.sy(a.x), this.sx(b.z), this.sy(b.x));
      }
    }
  }

  private arrow(x0: number, y0: number, x1: number, y1: number) {
    const ctx = this.ctx;
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 9 * Math.cos(a - 0.4), y1 - 9 * Math.sin(a - 0.4));
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 9 * Math.cos(a + 0.4), y1 - 9 * Math.sin(a + 0.4));
    ctx.stroke();
  }

  private drawMarkers() {
    const ctx = this.ctx;
    const C = this.colors;
    // work zero symbol
    const X = this.sx(0), Y = this.sy(0);
    ctx.strokeStyle = C['--v-text'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(X, Y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = C['--v-text'];
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.arc(X, Y, 7, -Math.PI / 2, 0);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.arc(X, Y, 7, Math.PI / 2, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.font = '10px var(--sans, sans-serif)';
    ctx.fillText('W (X0 Z0)', X + 10, Y + 14);
  }

  private drawTool() {
    const m = this.machine;
    const sh = m.shape;
    if (!sh) return;
    const ctx = this.ctx;
    const C = this.colors;
    const p = m.pos;
    if (this.opts.showHolder) {
      for (const h of sh.holder) {
        this.polyPath(translate(h, p));
        ctx.fillStyle = C['--v-holder'];
        ctx.globalAlpha = 0.75;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = C['--v-stock-edge'];
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    this.polyPath(translate(sh.cutter, p));
    ctx.fillStyle = C['--v-cutter'];
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // control point (imaginary tip) cross-hair
    const X = this.sx(p.z), Y = this.sy(p.x);
    ctx.strokeStyle = C['--v-sel'];
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(X - 7, Y);
    ctx.lineTo(X + 7, Y);
    ctx.moveTo(X, Y - 7);
    ctx.lineTo(X, Y + 7);
    ctx.stroke();
    if (this.scale > 8 && m.toolDef && m.toolDef.noseR > 0) {
      const c = { z: p.z + sh.noseCenter.z, x: p.x + sh.noseCenter.x };
      ctx.beginPath();
      ctx.arc(this.sx(c.z), this.sy(c.x), m.toolDef.noseR * this.scale, 0, Math.PI * 2);
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawMeasure() {
    if (!this.opts.measure || this.measurePts.length === 0) return;
    const ctx = this.ctx;
    const C = this.colors;
    const pts = this.measurePts.slice();
    if (pts.length === 1 && this.hover) pts.push(this.hover as P);
    ctx.strokeStyle = C['--v-sel'];
    ctx.fillStyle = C['--v-sel'];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(this.sx(p.z), this.sy(p.x)) : ctx.moveTo(this.sx(p.z), this.sy(p.x))));
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(this.sx(p.z), this.sy(p.x), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pts.length === 2) {
      const [a, b] = pts;
      const dZ = b.z - a.z;
      const dD = (Math.abs(b.x) - Math.abs(a.x)) * 2;
      const L = Math.hypot(b.z - a.z, b.x - a.x);
      const txt = `ΔZ ${dZ.toFixed(3)}  ΔØ ${dD.toFixed(3)}  L ${L.toFixed(3)}  ∠ ${((Math.atan2(Math.abs(b.x - a.x), Math.abs(dZ)) * 180) / Math.PI).toFixed(2)}°`;
      const X = (this.sx(a.z) + this.sx(b.z)) / 2, Y = (this.sy(a.x) + this.sy(b.x)) / 2;
      ctx.font = '12px var(--mono, monospace)';
      const w = ctx.measureText(txt).width;
      ctx.fillStyle = C['--v-bg'];
      ctx.fillRect(X - w / 2 - 4, Y - 22, w + 8, 18);
      ctx.fillStyle = C['--v-sel'];
      ctx.fillText(txt, X - w / 2, Y - 13);
    }
  }

  private drawHud() {
    const ctx = this.ctx;
    const C = this.colors;
    // scale bar
    const step = this.gridStep() * 5;
    const L = step * this.scale;
    ctx.strokeStyle = C['--v-text'];
    ctx.fillStyle = C['--v-text'];
    ctx.lineWidth = 2;
    const x0 = this.w - L - 16, y0 = 18;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + L, y0);
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0 + 4);
    ctx.moveTo(x0 + L, y0 - 4);
    ctx.lineTo(x0 + L, y0 + 4);
    ctx.stroke();
    ctx.font = '10px var(--mono, monospace)';
    ctx.textBaseline = 'top';
    ctx.fillText(`${step} mm`, x0, y0 + 6);
    if (this.hover) {
      const t = `Ø${(Math.abs(this.hover.x) * 2).toFixed(3)}  Z${this.hover.z.toFixed(3)}`;
      ctx.font = '12px var(--mono, monospace)';
      const w = ctx.measureText(t).width;
      ctx.fillStyle = C['--v-bg'];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(8, 8, w + 12, 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C['--v-text'];
      ctx.fillText(t, 14, 12);
    }
    ctx.textBaseline = 'alphabetic';
  }
}
