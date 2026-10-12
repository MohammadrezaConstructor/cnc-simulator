// Machine-data charts: spindle speed, feed and spindle power over machine time.
// Small multiples sharing one time axis (never a dual axis). One series per panel,
// so the panel title names it; a hover crosshair shows every value at that instant.

import type { Sample } from '../sim/machine';

interface Panel {
  key: 'rpm' | 'feed' | 'kw';
  title: string;
  unit: string;
  limit?: () => { value: number; label: string } | null;
}

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';

function niceStep(max: number, ticks = 3) {
  const raw = max / ticks;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
const fmtN = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(0) : v.toFixed(1));
const fmtT = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export class Charts {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private hoverX: number | null = null;
  samples: Sample[] = [];
  now = 0;
  total = 0;
  powerLimit = 15;
  onSeek: (t: number) => void = () => {};
  private panels: Panel[] = [
    { key: 'rpm', title: 'Spindle speed', unit: 'rpm' },
    { key: 'feed', title: 'Feed', unit: 'mm/min' },
    { key: 'kw', title: 'Spindle power', unit: 'kW', limit: () => ({ value: this.powerLimit, label: `machine limit ${this.powerLimit} kW` }) },
  ];
  private padL = 58;
  private padR = 14;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'charts-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Spindle speed, feed and spindle power over machine time');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip hidden';
    host.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.tip.classList.add('hidden');
      this.draw();
    });
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const t = this.timeAt(e.clientX - r.left);
      if (t !== null) this.onSeek(t);
    });
  }

  private span() {
    return Math.max(this.total, this.samples.length ? this.samples[this.samples.length - 1].t : 0, 1);
  }
  private X(t: number) {
    return this.padL + (t / this.span()) * (this.w - this.padL - this.padR);
  }
  private timeAt(px: number): number | null {
    if (px < this.padL || px > this.w - this.padR) return null;
    return ((px - this.padL) / (this.w - this.padL - this.padR)) * this.span();
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
    this.draw();
  }

  private nearest(t: number): Sample | null {
    const s = this.samples;
    if (!s.length) return null;
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t < t) lo = mid;
      else hi = mid;
    }
    return Math.abs(s[lo].t - t) < Math.abs(s[hi].t - t) ? s[lo] : s[hi];
  }

  draw() {
    if (this.w < 40 || this.h < 40 || !this.host.offsetParent) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = css('--panel'), ink = css('--text'), muted = css('--muted'), grid = css('--line');
    const series = css('--v-feed'), nowC = css('--v-sel'), warn = css('--warn');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);
    const axisH = 18;
    const gap = 8;
    const ph = (this.h - axisH - gap * (this.panels.length - 1) - 4) / this.panels.length;
    const right = this.w - this.padR;
    ctx.font = '11px system-ui, sans-serif';
    const s = this.samples;
    if (!s.length) {
      ctx.fillStyle = muted;
      ctx.textBaseline = 'middle';
      ctx.fillText('Run the program to record spindle speed, feed and power over time.', this.padL, this.h / 2);
      return;
    }

    // tool bands (shared across panels): neutral alternating tint + label
    const bands: { t0: number; t1: number; tool: number }[] = [];
    for (const smp of s) {
      const b = bands[bands.length - 1];
      if (b && b.tool === smp.tool) b.t1 = smp.t;
      else bands.push({ t0: smp.t, t1: smp.t, tool: smp.tool });
    }

    this.panels.forEach((p, pi) => {
      const top = 4 + pi * (ph + gap);
      const bottom = top + ph;
      let max = 0;
      for (const smp of s) max = Math.max(max, smp[p.key]);
      const lim = p.limit?.();
      if (lim && max > lim.value * 0.6) max = Math.max(max, lim.value);
      const step = niceStep(max || 1);
      const ymax = Math.max(step, Math.ceil((max || 1) / step) * step);
      const Y = (v: number) => bottom - (v / ymax) * (ph - 14);
      // tool bands
      bands.forEach((b, i) => {
        if (i % 2) {
          ctx.fillStyle = grid;
          ctx.globalAlpha = 0.35;
          ctx.fillRect(this.X(b.t0), top, Math.max(1, this.X(b.t1) - this.X(b.t0)), ph);
          ctx.globalAlpha = 1;
        }
        if (pi === 0 && this.X(b.t1) - this.X(b.t0) > 26) {
          ctx.fillStyle = muted;
          ctx.textBaseline = 'top';
          ctx.fillText(`T${String(b.tool).padStart(2, '0')}`, this.X(b.t0) + 3, top + 1);
        }
      });
      // grid + y ticks (hairline, solid, recessive)
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = muted;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      for (let v = 0; v <= ymax + 1e-9; v += step) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(this.padL, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillText(fmtN(v), this.padL - 6, y);
      }
      ctx.textAlign = 'left';
      // panel title names the single series
      ctx.fillStyle = ink;
      ctx.textBaseline = 'top';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(`${p.title} (${p.unit})`, this.padL + 4, top + (pi === 0 ? 14 : 1));
      ctx.font = '11px system-ui, sans-serif';
      // limit reference
      if (lim && lim.value <= ymax) {
        const y = Math.round(Y(lim.value)) + 0.5;
        ctx.strokeStyle = warn;
        ctx.beginPath();
        ctx.moveTo(this.padL, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(lim.label, right - 2, y - 2);
        ctx.textAlign = 'left';
      }
      // area wash + 2px line
      ctx.beginPath();
      s.forEach((smp, i) => (i ? ctx.lineTo(this.X(smp.t), Y(smp[p.key])) : ctx.moveTo(this.X(smp.t), Y(smp[p.key]))));
      ctx.lineTo(this.X(s[s.length - 1].t), bottom);
      ctx.lineTo(this.X(s[0].t), bottom);
      ctx.closePath();
      ctx.fillStyle = series;
      ctx.globalAlpha = 0.1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      s.forEach((smp, i) => (i ? ctx.lineTo(this.X(smp.t), Y(smp[p.key])) : ctx.moveTo(this.X(smp.t), Y(smp[p.key]))));
      ctx.strokeStyle = series;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      // baseline
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.padL, Math.round(bottom) + 0.5);
      ctx.lineTo(right, Math.round(bottom) + 0.5);
      ctx.stroke();
    });

    // time axis
    ctx.fillStyle = muted;
    ctx.textBaseline = 'top';
    const tStep = niceStep(this.span(), 6);
    for (let t = 0; t <= this.span() + 1e-9; t += tStep) {
      const x = this.X(t);
      ctx.textAlign = t === 0 ? 'left' : 'center';
      ctx.fillText(fmtT(t), x, this.h - axisH + 3);
    }
    ctx.textAlign = 'left';

    // current machine time
    if (this.now > 0) {
      const x = Math.round(this.X(this.now)) + 0.5;
      ctx.strokeStyle = nowC;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, this.h - axisH);
      ctx.stroke();
    }

    // crosshair + tooltip
    const t = this.hoverX === null ? null : this.timeAt(this.hoverX);
    const smp = t === null ? null : this.nearest(t);
    if (smp && t !== null) {
      const x = Math.round(this.X(smp.t)) + 0.5;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x, this.h - axisH);
      ctx.stroke();
      this.panels.forEach((p, pi) => {
        const top = 4 + pi * (ph + gap);
        const bottom = top + ph;
        let max = 0;
        for (const q of s) max = Math.max(max, q[p.key]);
        const lim = p.limit?.();
        if (lim && max > lim.value * 0.6) max = Math.max(max, lim.value);
        const step = niceStep(max || 1);
        const ymax = Math.max(step, Math.ceil((max || 1) / step) * step);
        const y = bottom - (smp[p.key] / ymax) * (ph - 14);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = series;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = bg;
        ctx.stroke();
      });
      this.tip.replaceChildren();
      const row = (val: string, label: string) => {
        const d = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = val;
        d.append(b, document.createTextNode(' ' + label));
        this.tip.append(d);
      };
      row(fmtT(smp.t), `· line ${smp.line + 1} · T${String(smp.tool).padStart(2, '0')}${smp.rapid ? ' · rapid' : ''}`);
      row(fmtN(smp.rpm), 'rpm');
      row(fmtN(smp.feed), 'mm/min feed');
      row(smp.kw.toFixed(2), 'kW');
      row(fmtN(smp.vc), 'm/min cutting speed');
      this.tip.classList.remove('hidden');
      const tw = this.tip.offsetWidth;
      this.tip.style.left = Math.min(this.w - tw - 4, x + 10) + 'px';
      this.tip.style.top = '6px';
    }
  }
}

/** per-line summary for the table view (accessible alternative to the charts) */
export function summarizeByLine(samples: Sample[]) {
  const rows = new Map<number, { line: number; tool: number; t0: number; t1: number; rpmMax: number; feedMax: number; kwMax: number }>();
  for (const s of samples) {
    const r = rows.get(s.line);
    if (!r) rows.set(s.line, { line: s.line, tool: s.tool, t0: s.t, t1: s.t, rpmMax: s.rpm, feedMax: s.feed, kwMax: s.kw });
    else {
      r.t1 = s.t;
      r.rpmMax = Math.max(r.rpmMax, s.rpm);
      r.feedMax = Math.max(r.feedMax, s.feed);
      r.kwMax = Math.max(r.kwMax, s.kw);
    }
  }
  return Array.from(rows.values()).sort((a, b) => a.t0 - b.t0);
}
