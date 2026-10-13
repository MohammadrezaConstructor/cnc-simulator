// 2D views for milling: TOP (depth map + toolpath), FRONT (XZ section) and SIDE (YZ section).

import type { MillMachine } from './machine';
import { viseGeometry, PARALLEL_W } from './machine';
import type { MillOp, MillMove, V3 } from './types';
import { discretize3 } from './path';
import { toolProfile } from './tools';

export type View2DMode = 'top' | 'front' | 'side';

interface PathItem {
  idx: number;
  line: number;
  type: MillMove['type'];
  pts: V3[];
}

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
/** canvas fonts cannot use CSS variables – resolve the page's font stacks once */
const FONT = {
  mono: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'ui-monospace, Consolas, monospace',
  sans: getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() || 'system-ui, sans-serif',
};
const hex = (s: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

export class MillView2D {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: HTMLCanvasElement;
  private imgCtx: CanvasRenderingContext2D;
  private imgData: ImageData | null = null;
  private devCanvas: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  scale = 4;
  cx = 50;
  cy = 40;
  mode: View2DMode = 'top';
  secY = 40;
  secX = 50;
  opts = { showPath: true, showRapids: true, showTool: true };
  selectedLine = -1;
  private paths: PathItem[] = [];
  private hover: { a: number; b: number } | null = null;
  private dirty = true;
  private fitted = false;
  private colors: Record<string, string> = {};
  private ramp: { raw: number[]; s: number[]; d: number[]; hole: number[] } = { raw: [0, 0, 0], s: [0, 0, 0], d: [0, 0, 0], hole: [0, 0, 0] };
  private blockVersion = -1;
  onPick: (line: number) => void = () => {};
  private hatch: CanvasPattern | null = null;

  constructor(private host: HTMLElement, private machine: MillMachine) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view2d-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.img = document.createElement('canvas');
    this.imgCtx = this.img.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.refreshColors();
    this.resize();
    this.bind();
  }

  refreshColors() {
    for (const k of ['--v-bg', '--v-grid', '--v-grid2', '--v-axis', '--v-text', '--v-stock', '--v-stock-edge', '--v-chuck', '--v-jaw', '--v-rapid', '--v-feed', '--v-arc', '--v-sel', '--v-cutter', '--v-holder', '--v-hatch', '--v-over', '--v-under', '--mz-raw', '--mz-shallow', '--mz-deep', '--mz-hole']) {
      this.colors[k] = css(k);
    }
    this.ramp = { raw: hex(this.colors['--mz-raw']), s: hex(this.colors['--mz-shallow']), d: hex(this.colors['--mz-deep']), hole: hex(this.colors['--mz-hole']) };
    this.imgData = null;
    this.hatch = null;
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
  }

  setOps(ops: MillOp[]) {
    this.paths = [];
    ops.forEach((o, idx) => {
      if (o.kind !== 'move') return;
      this.paths.push({ idx, line: o.line, type: o.type, pts: discretize3(o, 0.02) });
    });
    this.invalidate();
  }

  /** inspection overlay: per-cell deviation (NaN = not inspected) */
  setDeviation(dev: Float32Array | null, tol: number) {
    const b = this.machine.block;
    if (!dev) {
      this.devCanvas = null;
      this.invalidate();
      return;
    }
    const c = document.createElement('canvas');
    c.width = b.nx;
    c.height = b.ny;
    const g = c.getContext('2d')!;
    const id = g.createImageData(b.nx, b.ny);
    const over = hex(this.colors['--v-over']), under = hex(this.colors['--v-under']);
    for (let j = 0; j < b.ny; j++) {
      for (let i = 0; i < b.nx; i++) {
        const d = dev[j * b.nx + i];
        if (Number.isNaN(d) || Math.abs(d) <= tol) continue;
        const p = ((b.ny - 1 - j) * b.nx + i) * 4;
        const col = d > 0 ? over : under;
        id.data[p] = col[0];
        id.data[p + 1] = col[1];
        id.data[p + 2] = col[2];
        id.data[p + 3] = 230;
      }
    }
    g.putImageData(id, 0, 0);
    this.devCanvas = c;
    this.invalidate();
  }

  // ------------------------------------------------------------------ transforms
  private sx(a: number) {
    return (a - this.cx) * this.scale + this.w / 2;
  }
  private sy(b: number) {
    return this.h / 2 - (b - this.cy) * this.scale;
  }
  private wa(px: number) {
    return (px - this.w / 2) / this.scale + this.cx;
  }
  private wb(py: number) {
    return (this.h / 2 - py) / this.scale + this.cy;
  }
  /** project a 3D point into the current 2D mode */
  private proj(p: V3): [number, number] {
    return this.mode === 'top' ? [p.x, p.y] : this.mode === 'front' ? [p.x, p.z] : [p.y, p.z];
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
    if (!this.fitted && this.w > 60 && this.h > 60) this.fit();
    this.invalidate();
    this.draw();
  }

  fit() {
    if (this.w <= 60 || this.h <= 60) return;
    this.fitted = true;
    const b = this.machine.block;
    const v = viseGeometry(b);
    let a0: number, a1: number, b0: number, b1: number;
    if (this.mode === 'top') {
      a0 = b.x0 - 25;
      a1 = b.x1 + 25;
      b0 = b.y0 - 32;
      b1 = b.y1 + 32;
    } else {
      const lo = this.mode === 'front' ? b.x0 : b.y0 - 25, hi = this.mode === 'front' ? b.x1 : b.y1 + 25;
      a0 = lo - 20;
      a1 = hi + 20;
      b0 = v.base - 5;
      b1 = b.top + 60;
    }
    this.scale = Math.min(this.w / (a1 - a0), this.h / (b1 - b0)) * 0.92;
    this.cx = (a0 + a1) / 2;
    this.cy = (b0 + b1) / 2;
    this.invalidate();
  }

  setMode(m: View2DMode) {
    this.mode = m;
    this.fitted = false;
    this.fit();
  }

  private bind() {
    const c = this.canvas;
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const a = this.wa(px), bb = this.wb(py);
      this.scale = Math.min(300, Math.max(0.3, this.scale * Math.exp(-e.deltaY * 0.0015)));
      this.cx = a - (px - this.w / 2) / this.scale;
      this.cy = bb - (this.h / 2 - py) / this.scale;
      this.invalidate();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.hover = { a: this.wa(e.clientX - r.left), b: this.wb(e.clientY - r.top) };
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          this.cx = drag.cx - dx / this.scale;
          this.cy = drag.cy + dy / this.scale;
        }
      }
      this.invalidate();
    });
    c.addEventListener('pointerup', (e) => {
      const click = drag && !drag.moved;
      drag = null;
      if (!click) return;
      const r = c.getBoundingClientRect();
      const line = this.pick(e.clientX - r.left, e.clientY - r.top);
      if (line >= 0) this.onPick(line);
    });
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.invalidate();
    });
    c.addEventListener('dblclick', () => this.fit());
  }

  private pick(px: number, py: number) {
    let best = -1, bd = 8;
    for (const it of this.paths) {
      if (!this.opts.showRapids && it.type === 'rapid') continue;
      for (let i = 1; i < it.pts.length; i++) {
        const [a0, b0] = this.proj(it.pts[i - 1]), [a1, b1] = this.proj(it.pts[i]);
        const ax = this.sx(a0), ay = this.sy(b0), bx = this.sx(a1), by = this.sy(b1);
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
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

  // ------------------------------------------------------------------ height image

  private updateImage() {
    const b = this.machine.block;
    if (this.img.width !== b.nx || this.img.height !== b.ny || !this.imgData || this.blockVersion < 0) {
      this.img.width = b.nx;
      this.img.height = b.ny;
      this.imgData = this.imgCtx.createImageData(b.nx, b.ny);
      b.takeDirty('view2d');
      this.paintRect(0, b.nx - 1, 0, b.ny - 1);
    } else {
      const d = b.takeDirty('view2d');
      if (d) this.paintRect(Math.max(0, d.i0 - 1), Math.min(b.nx - 1, d.i1 + 1), Math.max(0, d.j0 - 1), Math.min(b.ny - 1, d.j1 + 1));
    }
    this.blockVersion = b.version;
  }

  private paintRect(i0: number, i1: number, j0: number, j1: number) {
    const b = this.machine.block;
    const data = this.imgData!.data;
    // colour ramp spans the first 15 mm of depth – typical pockets get the full contrast
    const span = Math.max(1e-6, Math.min(b.top - b.bottom, 15));
    const { raw, s, d, hole } = this.ramp;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * b.nx + i;
        const hk = b.h[k];
        const p = ((b.ny - 1 - j) * b.nx + i) * 4;
        let col: number[];
        if (hk <= b.bottom + 0.005) col = hole;
        else if (b.cutBy[k] === 0) col = raw;
        else {
          const t = Math.min(1, Math.max(0, (b.top - hk) / span));
          col = [s[0] + (d[0] - s[0]) * t, s[1] + (d[1] - s[1]) * t, s[2] + (d[2] - s[2]) * t];
        }
        // hill shading from the upper left so steps read as edges
        const hl = i > 0 ? b.h[k - 1] : hk, hr = i < b.nx - 1 ? b.h[k + 1] : hk;
        const hd = j > 0 ? b.h[k - b.nx] : hk, hu = j < b.ny - 1 ? b.h[k + b.nx] : hk;
        const shade = Math.max(0.62, Math.min(1.3, 1 + ((hl - hr) + (hu - hd)) * 0.6 / Math.max(b.c, 0.05) * 0.15));
        data[p] = Math.min(255, col[0] * shade);
        data[p + 1] = Math.min(255, col[1] * shade);
        data[p + 2] = Math.min(255, col[2] * shade);
        data[p + 3] = 255;
      }
    }
    this.imgCtx.putImageData(this.imgData!, 0, 0, i0, b.ny - 1 - j1, i1 - i0 + 1, j1 - j0 + 1);
  }

  // ------------------------------------------------------------------ drawing

  draw(force = false) {
    if (!this.dirty && !force && this.blockVersion === this.machine.block.version) return;
    this.dirty = false;
    const ctx = this.ctx;
    const C = this.colors;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C['--v-bg'];
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawGrid();
    if (this.mode === 'top') this.drawTop();
    else this.drawSection();
    if (this.opts.showPath) this.drawPaths();
    this.drawZero();
    if (this.opts.showTool) this.drawTool();
    this.drawHud();
  }

  private gridStep() {
    for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200]) if (s * this.scale >= 14) return s;
    return 500;
  }

  private drawGrid() {
    const ctx = this.ctx;
    const C = this.colors;
    const st = this.gridStep(), major = st * 5;
    const a0 = this.wa(0), a1 = this.wa(this.w), b0 = this.wb(this.h), b1 = this.wb(0);
    ctx.lineWidth = 1;
    for (const [s, col] of [[st, C['--v-grid']], [major, C['--v-grid2']]] as [number, string][]) {
      ctx.strokeStyle = col;
      ctx.beginPath();
      for (let a = Math.ceil(a0 / s) * s; a <= a1; a += s) {
        const x = Math.round(this.sx(a)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.h);
      }
      for (let b = Math.ceil(b0 / s) * s; b <= b1; b += s) {
        const y = Math.round(this.sy(b)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.w, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = C['--v-text'];
    ctx.font = `10px ${FONT.mono}`;
    const [la, lb] = this.mode === 'top' ? ['X', 'Y'] : this.mode === 'front' ? ['X', 'Z'] : ['Y', 'Z'];
    const dec = major < 1 ? 1 : 0;
    ctx.textBaseline = 'top';
    for (let a = Math.ceil(a0 / major) * major; a <= a1; a += major) ctx.fillText(`${la}${a.toFixed(dec)}`, this.sx(a) + 3, this.h - 14);
    ctx.textBaseline = 'middle';
    for (let b = Math.ceil(b0 / major) * major; b <= b1; b += major) ctx.fillText(`${lb}${b.toFixed(dec)}`, 4, this.sy(b) - 6);
    ctx.textBaseline = 'alphabetic';
  }

  private rectPath(a0: number, b0: number, a1: number, b1: number) {
    this.ctx.beginPath();
    this.ctx.rect(this.sx(Math.min(a0, a1)), this.sy(Math.max(b0, b1)), Math.abs(a1 - a0) * this.scale, Math.abs(b1 - b0) * this.scale);
  }

  private drawTop() {
    const ctx = this.ctx;
    const C = this.colors;
    const b = this.machine.block;
    const v = viseGeometry(b);
    // vise jaws
    for (const j of v.jaws) {
      this.rectPath(j.x0, j.y0, j.x1, j.y1);
      ctx.fillStyle = C['--v-jaw'];
      ctx.fill();
    }
    this.updateImage();
    ctx.imageSmoothingEnabled = this.scale / (1 / b.c) < 1;
    ctx.drawImage(this.img, this.sx(b.x0), this.sy(b.y1), (b.x1 - b.x0) * this.scale, (b.y1 - b.y0) * this.scale);
    if (this.devCanvas) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.devCanvas, this.sx(b.x0), this.sy(b.y1), (b.x1 - b.x0) * this.scale, (b.y1 - b.y0) * this.scale);
    }
    ctx.strokeStyle = C['--v-stock-edge'];
    ctx.lineWidth = 1;
    this.rectPath(b.x0, b.y0, b.x1, b.y1);
    ctx.stroke();
    // section lines
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = C['--v-axis'];
    ctx.beginPath();
    ctx.moveTo(this.sx(b.x0 - 8), this.sy(this.secY));
    ctx.lineTo(this.sx(b.x1 + 8), this.sy(this.secY));
    ctx.moveTo(this.sx(this.secX), this.sy(b.y0 - 8));
    ctx.lineTo(this.sx(this.secX), this.sy(b.y1 + 8));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C['--v-text'];
    ctx.font = `10px ${FONT.sans}`;
    ctx.fillText('A–A (front section)', this.sx(b.x1 + 2), this.sy(this.secY) - 4);
    ctx.fillText('B–B (side)', this.sx(this.secX) + 4, this.sy(b.y1 + 6));
  }

  private getHatch(): CanvasPattern | string {
    if (this.hatch) return this.hatch;
    const c = document.createElement('canvas');
    c.width = c.height = 10;
    const g = c.getContext('2d')!;
    g.fillStyle = this.colors['--v-stock'];
    g.fillRect(0, 0, 10, 10);
    g.strokeStyle = this.colors['--v-hatch'];
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

  private drawSection() {
    const ctx = this.ctx;
    const C = this.colors;
    const b = this.machine.block;
    const v = viseGeometry(b);
    this.blockVersion = b.version;
    // vise bed & jaws / parallels
    ctx.fillStyle = C['--v-chuck'];
    if (this.mode === 'front') {
      this.rectPath(b.x0 - 30, v.base - 18, b.x1 + 30, v.base);
      ctx.fill();
      ctx.strokeStyle = C['--v-jaw'];
      ctx.setLineDash([4, 3]);
      this.rectPath(v.jaws[0].x0, v.jaws[0].z0, v.jaws[0].x1, v.jaws[0].z1);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      this.rectPath(b.y0 - 30, v.base - 18, b.y1 + 30, v.base);
      ctx.fill();
      ctx.fillStyle = C['--v-jaw'];
      for (const j of v.jaws) {
        this.rectPath(j.y0, j.z0, j.y1, j.z1);
        ctx.fill();
      }
      ctx.fillStyle = C['--v-chuck'];
      this.rectPath(b.y0, v.base, b.y0 + PARALLEL_W, b.bottom);
      ctx.fill();
      this.rectPath(b.y1 - PARALLEL_W, v.base, b.y1, b.bottom);
      ctx.fill();
    }
    // section profile
    const pts: [number, number][] = [];
    if (this.mode === 'front') {
      const j = Math.max(0, Math.min(b.ny - 1, Math.floor((this.secY - b.y0) / b.c)));
      for (let i = 0; i < b.nx; i++) {
        const hk = b.h[j * b.nx + i];
        pts.push([b.x0 + i * b.c, hk], [b.x0 + (i + 1) * b.c, hk]);
      }
    } else {
      const i = Math.max(0, Math.min(b.nx - 1, Math.floor((this.secX - b.x0) / b.c)));
      for (let j = 0; j < b.ny; j++) {
        const hk = b.h[j * b.nx + i];
        pts.push([b.y0 + j * b.c, hk], [b.y0 + (j + 1) * b.c, hk]);
      }
    }
    ctx.beginPath();
    ctx.moveTo(this.sx(pts[0][0]), this.sy(b.bottom));
    for (const [a, z] of pts) ctx.lineTo(this.sx(a), this.sy(z));
    ctx.lineTo(this.sx(pts[pts.length - 1][0]), this.sy(b.bottom));
    ctx.closePath();
    ctx.fillStyle = this.getHatch();
    ctx.fill();
    ctx.strokeStyle = C['--v-stock-edge'];
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = C['--v-text'];
    ctx.font = `11px ${FONT.sans}`;
    ctx.fillText(this.mode === 'front' ? `Section A–A at Y${this.secY.toFixed(1)}` : `Section B–B at X${this.secX.toFixed(1)}`, 12, 40);
  }

  private drawPaths() {
    const ctx = this.ctx;
    const C = this.colors;
    const m = this.machine;
    const doneIdx = m.status === 'done' ? Infinity : m.i;
    const col = (t: string) => (t === 'rapid' ? C['--v-rapid'] : t === 'arc' ? C['--v-arc'] : C['--v-feed']);
    for (const pass of [0, 1]) {
      for (const it of this.paths) {
        if (it.type === 'rapid' && !this.opts.showRapids) continue;
        const ex = it.idx < doneIdx;
        if ((pass === 0) !== !ex) continue;
        ctx.strokeStyle = col(it.type);
        ctx.globalAlpha = ex ? 0.95 : 0.4;
        ctx.lineWidth = ex ? 1.3 : 1;
        ctx.setLineDash(it.type === 'rapid' ? [5, 4] : []);
        ctx.beginPath();
        it.pts.forEach((p, i) => {
          const [a, b] = this.proj(p);
          if (i) ctx.lineTo(this.sx(a), this.sy(b));
          else ctx.moveTo(this.sx(a), this.sy(b));
        });
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
        it.pts.forEach((p, i) => {
          const [a, b] = this.proj(p);
          if (i) ctx.lineTo(this.sx(a), this.sy(b));
          else ctx.moveTo(this.sx(a), this.sy(b));
        });
        ctx.stroke();
      }
    }
  }

  /** work zero G54: the W symbol with the positive directions of the two axes in this view */
  private drawZero() {
    const ctx = this.ctx;
    const X = this.sx(0), Y = this.sy(0);
    const [ha, va] = this.mode === 'top' ? ['X', 'Y'] : this.mode === 'front' ? ['X', 'Z'] : ['Y', 'Z'];
    const AX: Record<string, string> = { X: '#ff5d5d', Y: '#3fcf6f', Z: '#4f9dff' };
    const L = 38;
    const arrow = (x2: number, y2: number, col: string, label: string) => {
      const a = Math.atan2(y2 - Y, x2 - X);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X, Y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2 + Math.cos(a) * 3, y2 + Math.sin(a) * 3);
      ctx.lineTo(x2 - Math.cos(a - 0.45) * 9, y2 - Math.sin(a - 0.45) * 9);
      ctx.lineTo(x2 - Math.cos(a + 0.45) * 9, y2 - Math.sin(a + 0.45) * 9);
      ctx.closePath();
      ctx.fill();
      ctx.font = `bold 11px ${FONT.mono}`;
      ctx.fillText(label, x2 + (a === 0 ? 7 : -4), y2 + (a === 0 ? 4 : -7));
    };
    arrow(X + L, Y, AX[ha], ha + '+');
    arrow(X, Y - L, AX[va], va + '+');
    ctx.strokeStyle = this.colors['--v-text'];
    ctx.fillStyle = this.colors['--v-text'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(X, Y, 7, 0, Math.PI * 2);
    ctx.stroke();
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
    ctx.font = `bold 10px ${FONT.sans}`;
    ctx.fillText(this.mode === 'top' ? 'G54  X0 Y0' : this.mode === 'front' ? 'G54  X0 Z0' : 'G54  Y0 Z0', X + 10, Y + 16);
  }

  private drawTool() {
    const m = this.machine;
    const t = m.toolDef;
    if (!t) return;
    const ctx = this.ctx;
    const C = this.colors;
    const p = m.pos;
    const R = t.diameter / 2;
    if (this.mode === 'top') {
      ctx.beginPath();
      ctx.arc(this.sx(p.x), this.sy(p.y), Math.max(2, R * this.scale), 0, Math.PI * 2);
      ctx.fillStyle = C['--v-cutter'];
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = C['--v-cutter'];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      const a = this.mode === 'front' ? p.x : p.y;
      const prof = toolProfile(t);
      ctx.beginPath();
      prof.forEach((q, i) => (i ? ctx.lineTo(this.sx(a + q.r), this.sy(p.z + q.h)) : ctx.moveTo(this.sx(a + q.r), this.sy(p.z + q.h))));
      for (let i = prof.length - 1; i >= 0; i--) ctx.lineTo(this.sx(a - prof[i].r), this.sy(p.z + prof[i].h));
      ctx.closePath();
      ctx.fillStyle = C['--v-cutter'];
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // shank and holder
      const top = p.z + Math.max(t.fluteLength, prof[prof.length - 1].h);
      ctx.fillStyle = C['--v-holder'];
      ctx.globalAlpha = 0.8;
      this.rectPath(a - Math.min(R, 8), top, a + Math.min(R, 8), p.z + t.length);
      ctx.fill();
      this.rectPath(a - 22, p.z + t.length, a + 22, p.z + t.length + 40);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const [A, B] = this.proj(p);
    ctx.strokeStyle = C['--v-sel'];
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(this.sx(A) - 7, this.sy(B));
    ctx.lineTo(this.sx(A) + 7, this.sy(B));
    ctx.moveTo(this.sx(A), this.sy(B) - 7);
    ctx.lineTo(this.sx(A), this.sy(B) + 7);
    ctx.stroke();
  }

  private drawHud() {
    const ctx = this.ctx;
    const C = this.colors;
    const step = this.gridStep() * 5;
    const L = step * this.scale;
    const x0 = this.w - L - 16;
    ctx.strokeStyle = C['--v-text'];
    ctx.fillStyle = C['--v-text'];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, 18);
    ctx.lineTo(x0 + L, 18);
    ctx.stroke();
    ctx.font = `10px ${FONT.mono}`;
    ctx.fillText(`${step} mm`, x0, 32);
    if (this.hover) {
      let t: string;
      if (this.mode === 'top') {
        const hz = this.machine.block.heightAt(this.hover.a, this.hover.b);
        t = `X${this.hover.a.toFixed(3)}  Y${this.hover.b.toFixed(3)}${hz !== null ? `  surface Z${hz.toFixed(3)}` : ''}`;
      } else t = `${this.mode === 'front' ? 'X' : 'Y'}${this.hover.a.toFixed(3)}  Z${this.hover.b.toFixed(3)}`;
      ctx.font = `12px ${FONT.mono}`;
      const w = ctx.measureText(t).width;
      ctx.fillStyle = C['--v-bg'];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(8, 8, w + 12, 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C['--v-text'];
      ctx.fillText(t, 14, 22);
    }
  }
}
