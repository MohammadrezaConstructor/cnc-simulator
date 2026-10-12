// Cutter radius compensation (G41/G42, G17 plane) for milling.
// The tool centre is driven on a path offset by the cutter radius: convex corners get an arc
// around the programmed corner, concave corners are trimmed to the intersection (Fanuc type C).
// Moves without XY motion (plunges) are passed through at the current offset point.

import type { P, Severity } from '../types';
import { add, sub, mul, dist, norm, dot, cross, rightN, leftN, lineLine, lineCircle, circleCircle, near, arcSweep, tangentAt, EPS } from '../sim/geom';
import type { MillMove, MillOp, V3 } from './types';

export interface MillComp {
  side: 41 | 42;
  r: number;
}
type Warn = (line: number, msg: string, sev?: Severity) => void;

const xy = (v: V3): P => ({ z: v.x, x: v.y });
const v3 = (p: P, z: number): V3 => ({ x: p.z, y: p.x, z });

interface El {
  m: MillMove;
  from: P;
  to: P;
  c?: P;
  rad?: number;
}

/** 2D view of a move for the lathe geometry helpers */
const as2d = (m: MillMove) => ({
  kind: 'move' as const,
  type: m.type === 'arc' ? ('arc' as const) : ('linear' as const),
  from: xy(m.from),
  to: xy(m.to),
  center: m.center ? xy(m.center) : undefined,
  cw: m.cw,
  feed: 0,
  feedPerRev: false,
  spindle: { mode: 'rpm' as const, s: 0, maxRpm: 0, dir: 'off' as const },
  line: m.line,
  tool: m.tool,
});

const sideN = (t: P, side: 41 | 42) => (side === 42 ? rightN(t) : leftN(t));

function offsetEl(m: MillMove, side: 41 | 42, R: number, warn: Warn): El | null {
  const a = xy(m.from), b = xy(m.to);
  if (m.type === 'arc' && m.center) {
    const c = xy(m.center);
    const r = dist(a, c);
    const t0 = tangentAt(as2d(m), false);
    const s = dot(sideN(t0, side), norm(sub(a, c))) >= 0 ? 1 : -1;
    const rr = r + s * R;
    if (rr <= 1e-6) {
      warn(m.line, `Arc radius ${r.toFixed(3)} is smaller than the cutter radius ${R} – an inside arc must be larger than the tool (alarm: interference)`, 'error');
      return null;
    }
    return { m, c, rad: rr, from: add(c, mul(norm(sub(a, c)), rr)), to: add(c, mul(norm(sub(b, c)), rr)) };
  }
  if (dist(a, b) < 1e-9) return null;
  const n = sideN(norm(sub(b, a)), side);
  return { m, from: add(a, mul(n, R)), to: add(b, mul(n, R)) };
}

function intersect(a: El, b: El, hint: P): P | null {
  const arcA = !!a.c, arcB = !!b.c;
  if (!arcA && !arcB) {
    const da = norm(sub(a.to, a.from)), db = norm(sub(b.to, b.from));
    const t = lineLine(a.from, da, b.from, db);
    return t === null ? null : add(a.from, mul(da, t));
  }
  const cands: P[] = [];
  if (arcA && arcB) cands.push(...circleCircle(a.c!, a.rad!, b.c!, b.rad!));
  else {
    const ln = arcA ? b : a, ar = arcA ? a : b;
    const d = norm(sub(ln.to, ln.from));
    for (const t of lineCircle(ln.from, d, ar.c!, ar.rad!)) cands.push(add(ln.from, mul(d, t)));
  }
  if (!cands.length) return null;
  cands.sort((p, q) => dist(p, hint) - dist(q, hint));
  return cands[0];
}

function processRun(run: MillMove[], R: number, side: 41 | 42, warn: Warn): MillMove[] {
  const startup = run[0];
  const cancel = run[run.length - 1].__cancel ? run[run.length - 1] : null;
  const body = run.slice(1, cancel ? run.length - 1 : run.length);
  if (startup.type === 'arc') warn(startup.line, 'G41/G42 must be started on a G00/G01 move, not on an arc', 'error');
  if (cancel?.type === 'arc') warn(cancel.line, 'G40 must be programmed on a G00/G01 move, not on an arc', 'error');
  if (dist(xy(startup.from), xy(startup.to)) < 1e-6) warn(startup.line, 'The G41/G42 start-up move has no X/Y motion – the control cannot build up the offset (use an approach move in X/Y)', 'warning');

  // offset elements (null = Z-only "transparent" move)
  const items = body.map((m) => ({ m, el: offsetEl(m, side, R, warn) }));
  const els = items.filter((i) => i.el).map((i) => i.el!);
  // joins between consecutive XY elements
  const join = new Map<El, { type: 'arc'; c: P } | { type: 'bridge' } | null>();
  for (let k = 0; k < els.length - 1; k++) {
    const a = els[k], b = els[k + 1];
    const tA = tangentAt(as2d(a.m), true), tB = tangentAt(as2d(b.m), false);
    const cr = cross(tA, tB), dp = dot(tA, tB);
    if (near(a.to, b.from, 1e-7)) {
      join.set(a, null);
      continue;
    }
    const convex = (side === 42 ? cr > 0 : cr < 0) || (Math.abs(cr) < 1e-9 && dp < 0);
    if (convex) join.set(a, { type: 'arc', c: xy(a.m.to) });
    else {
      const X = intersect(a, b, mul(add(a.to, b.from), 0.5));
      if (!X || dist(X, xy(a.m.to)) > 10 * R + 1) {
        warn(b.m.line, 'Cutter compensation interference at a concave corner – bridged with a straight move');
        join.set(a, { type: 'bridge' });
      } else {
        for (const [e, f, g] of [[a, a.from, X], [b, X, b.to]] as [El, P, P][]) {
          if (!e.c && dot(sub(g, f), sub(e.to, e.from)) < -EPS) warn(e.m.line, 'Element is shorter than the cutter radius – compensation would overcut (interference)');
        }
        a.to = X;
        b.from = X;
        join.set(a, null);
      }
    }
  }

  const out: MillMove[] = [];
  const clean = (m: MillMove): MillMove => {
    const { __cancel: _c, ...rest } = m;
    void _c;
    return rest;
  };
  let cur: V3 = { ...startup.from };
  const push = (src: MillMove, to: V3, extra: Partial<MillMove> = {}) => {
    out.push({ ...clean(src), from: cur, to, center: undefined, cw: undefined, ...extra });
    cur = to;
  };
  const firstXY = els[0];
  const startXY = firstXY ? firstXY.from : add(xy(startup.to), mul(sideN(norm(sub(xy(startup.to), xy(startup.from))), side), R));
  push(startup, v3(startXY, startup.to.z), { label: (startup.label ? startup.label + ' · ' : '') + `G${side} start-up` });
  for (const it of items) {
    if (!it.el) {
      push(it.m, { ...cur, z: it.m.to.z });
      continue;
    }
    const e = it.el;
    if (e.c) push(it.m, v3(e.to, it.m.to.z), { type: 'arc', center: v3(e.c, it.m.to.z), cw: it.m.cw, plane: 17 });
    else push(it.m, v3(e.to, it.m.to.z));
    const j = join.get(e);
    const idx = els.indexOf(e);
    if (j && idx < els.length - 1) {
      const nxt = els[idx + 1];
      if (j.type === 'arc') {
        const m: Partial<MillMove> = it.m.type === 'rapid' ? {} : { type: 'arc', center: v3(j.c, cur.z), cw: side === 41, plane: 17, label: 'cutter radius corner' };
        const toP = v3(nxt.from, cur.z);
        if (m.type === 'arc' && Math.abs(arcSweep(xy(cur), nxt.from, j.c, side === 41)) > Math.PI * 1.999) m.type = 'linear';
        push(it.m, toP, m);
      } else push(nxt.m, v3(nxt.from, cur.z), { label: 'compensation bridge' });
    }
  }
  if (cancel) push(cancel, { ...cancel.to }, { label: (cancel.label ? cancel.label + ' · ' : '') + 'G40 cancel' });
  return out;
}

export function applyCutterComp(ops: MillOp[], comp: (MillComp | undefined)[], warn: Warn): MillOp[] {
  if (!comp.some((c) => c && c.r > 0)) return ops;
  const out: MillOp[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    const ci = comp[i];
    if (op.kind !== 'move' || !ci || ci.r <= 0) {
      out.push(op);
      i++;
      continue;
    }
    const run: MillMove[] = [];
    const between: MillOp[] = [];
    let j = i;
    while (j < ops.length) {
      const o = ops[j];
      const c = comp[j];
      if (o.kind !== 'move') {
        between.push(o);
        j++;
        continue;
      }
      if (!c || c.r <= 0 || c.side !== ci.side || c.r !== ci.r) break;
      run.push(o);
      j++;
    }
    if (j < ops.length && ops[j].kind === 'move') {
      run.push({ ...(ops[j] as MillMove), __cancel: true });
      j++;
    }
    const processed = processRun(run, ci.r, ci.side, warn);
    for (const m of processed) {
      while (between.length && between[0].line < m.line) out.push(between.shift()!);
      out.push(m);
    }
    out.push(...between);
    i = j;
  }
  return out;
}
