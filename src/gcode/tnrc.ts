// Tool-nose radius compensation (G41 / G42).
//
// Without compensation the control drives the IMAGINARY TOOL TIP along the programmed
// contour.  With compensation the NOSE-RADIUS CENTRE is driven along a path offset by R,
// and the control point is then  centre + tipVector(T, R).
//
// Implementation: runs of compensated moves are collected (start-up move, contour
// elements, cancel move).  Each element is offset by R to the left (G41) or right (G42)
// of the travel direction; convex corners get a rolling arc of radius R around the
// programmed corner, concave corners are trimmed to the intersection of the offset
// elements (Fanuc "type C" behaviour).

import type { MoveOp, Op, P, Severity } from '../types';
import {
  add, sub, mul, dist, norm, dot, cross, tangentAt, rightN, leftN, lineLine,
  lineCircle, circleCircle, near, EPS, arcSweep,
} from '../sim/geom';
import { tipVector } from '../sim/tools';

export interface CompInfo {
  side: 41 | 42;
  r: number;
  t: number;
}

type Warn = (line: number, msg: string, sev?: Severity) => void;

interface El {
  op: MoveOp;
  /** offset geometry (nose-centre) */
  from: P;
  to: P;
  center?: P;
  /** radius of the offset arc */
  rad?: number;
}

const sideNormal = (t: P, side: 41 | 42) => (side === 42 ? rightN(t) : leftN(t));

function offsetElement(op: MoveOp, side: 41 | 42, R: number, warn: Warn): El | null {
  if (op.type === 'arc' && op.center) {
    const c = op.center;
    const r = dist(op.from, c);
    const t0 = tangentAt(op, false);
    const n0 = sideNormal(t0, side);
    const radial = norm(sub(op.from, c));
    const s = dot(n0, radial) >= 0 ? 1 : -1;
    const rr = r + s * R;
    if (rr <= 1e-6) {
      warn(op.line, `Arc radius ${r.toFixed(3)} is smaller than the nose radius ${R} – compensation impossible (interference)`, 'error');
      return null;
    }
    return {
      op,
      center: c,
      rad: rr,
      from: add(c, mul(norm(sub(op.from, c)), rr)),
      to: add(c, mul(norm(sub(op.to, c)), rr)),
    };
  }
  if (dist(op.from, op.to) < 1e-9) return null;
  const n = sideNormal(norm(sub(op.to, op.from)), side);
  return { op, from: add(op.from, mul(n, R)), to: add(op.to, mul(n, R)) };
}

/** Intersection of two offset elements near point `hint`. */
function intersect(a: El, b: El, hint: P): P | null {
  const cands: P[] = [];
  const isArc = (e: El) => e.center !== undefined;
  if (!isArc(a) && !isArc(b)) {
    const da = norm(sub(a.to, a.from));
    const db = norm(sub(b.to, b.from));
    const t = lineLine(a.from, da, b.from, db);
    if (t === null) return null;
    return add(a.from, mul(da, t));
  }
  if (isArc(a) && isArc(b)) cands.push(...circleCircle(a.center!, a.rad!, b.center!, b.rad!));
  else {
    const ln = isArc(a) ? b : a;
    const ar = isArc(a) ? a : b;
    const d = norm(sub(ln.to, ln.from));
    for (const t of lineCircle(ln.from, d, ar.center!, ar.rad!)) cands.push(add(ln.from, mul(d, t)));
  }
  if (!cands.length) return null;
  cands.sort((p, q) => dist(p, hint) - dist(q, hint));
  return cands[0];
}

function processRun(run: MoveOp[], infos: CompInfo[], warn: Warn): MoveOp[] {
  const side = infos[0].side;
  const R = infos[0].r;
  const tipV = tipVector(infos[0].t, R);
  const startup = run[0];
  const cancel = run[run.length - 1].__cancel ? run[run.length - 1] : null;
  const body = run.slice(1, cancel ? run.length - 1 : run.length);

  if (startup.type === 'arc') warn(startup.line, 'G41/G42 must be started on a G00/G01 move, not on an arc', 'error');
  if (cancel && cancel.type === 'arc') warn(cancel.line, 'G40 must be programmed on a G00/G01 move, not on an arc', 'error');

  const els: El[] = [];
  for (const op of body) {
    const e = offsetElement(op, side, R, warn);
    if (e) els.push(e);
  }

  const pieces: El[] = els.map((e) => ({ ...e }));
  const joins: ({ type: 'arc'; c: P } | { type: 'bridge' } | null)[] = [];
  for (let i = 0; i < pieces.length - 1; i++) {
    const a = pieces[i];
    const b = pieces[i + 1];
    const tA = tangentAt(a.op, true);
    const tB = tangentAt(b.op, false);
    const cr = cross(tA, tB);
    const dp = dot(tA, tB);
    const corner = a.op.to;
    if (near(a.to, b.from, 1e-7)) {
      joins.push(null);
      continue;
    }
    // left turn (cr>0) with tool on the right (G42) → convex corner (gap); G41 mirrored
    const convex = (side === 42 ? cr > 0 : cr < 0) || (Math.abs(cr) < 1e-9 && dp < 0);
    if (convex) {
      joins.push({ type: 'arc', c: corner });
    } else {
      const X = intersect(a, b, mul(add(a.to, b.from), 0.5));
      if (!X || dist(X, corner) > 10 * R + 1) {
        warn(b.op.line, 'Tool-nose compensation interference at a concave corner – path bridged with a straight move');
        joins.push({ type: 'bridge' });
      } else {
        // detect overcut (element reversed by the trim)
        const checkLine = (e: El, newFrom: P, newTo: P) => {
          if (e.center) return;
          if (dot(sub(newTo, newFrom), sub(e.to, e.from)) < -EPS) {
            warn(e.op.line, `Element is shorter than the nose radius – compensation causes an overcut (interference)`);
          }
        };
        checkLine(a, a.from, X);
        checkLine(b, X, b.to);
        a.to = X;
        b.from = X;
        joins.push(null);
      }
    }
  }

  const res: MoveOp[] = [];
  const conv = (p: P) => add(p, tipV);
  const mk = (src: MoveOp, from: P, to: P, extra: Partial<MoveOp> = {}): MoveOp => {
    const { __cancel: _c, ...clean } = src;
    void _c;
    return { ...clean, from, to, center: undefined, cw: undefined, ...extra };
  };

  // start-up move: from uncompensated position to the offset start of the first element
  const firstTarget = pieces.length
    ? pieces[0].from
    : add(startup.to, mul(sideNormal(norm(sub(startup.to, startup.from)), side), R));
  res.push(mk(startup, { ...startup.from }, conv(firstTarget), { label: (startup.label ? startup.label + ' · ' : '') + `G${side} start-up` }));

  pieces.forEach((p, i) => {
    const prevEnd = res[res.length - 1].to;
    if (p.center) {
      const c = conv(p.center);
      res.push(mk(p.op, prevEnd, conv(p.to), { center: c, cw: p.op.cw, type: 'arc' }));
    } else {
      res.push(mk(p.op, prevEnd, conv(p.to)));
    }
    const j = joins[i];
    if (j && i < pieces.length - 1) {
      const nxt = pieces[i + 1];
      if (j.type === 'arc') {
        // nose rolls around the programmed corner
        const m: MoveOp = mk(p.op, conv(p.to), conv(nxt.from), {
          type: p.op.type === 'rapid' ? 'rapid' : 'arc',
          center: conv(j.c),
          cw: side === 41,
          label: 'nose-radius corner',
        });
        if (m.type === 'rapid') {
          m.center = undefined;
          m.cw = undefined;
        } else if (Math.abs(arcSweep(m.from, m.to, m.center!, !!m.cw)) > Math.PI * 1.999) {
          m.type = 'linear';
          m.center = undefined;
        }
        res.push(m);
      } else {
        res.push(mk(nxt.op, conv(p.to), conv(nxt.from), { label: 'compensation bridge' }));
      }
    }
  });

  if (cancel) {
    const prevEnd = res[res.length - 1].to;
    res.push(mk(cancel, prevEnd, { ...cancel.to }, { label: (cancel.label ? cancel.label + ' · ' : '') + 'G40 cancel' }));
  }
  return res;
}

/**
 * Apply compensation to an op list. `comp[i]` describes op i (undefined = not compensated).
 */
export function applyTNRC(ops: Op[], comp: (CompInfo | undefined)[], warn: Warn): Op[] {
  if (!comp.some((c) => c && c.r > 0)) return ops;
  const out: Op[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    const ci = comp[i];
    if (op.kind !== 'move' || !ci || ci.r <= 0) {
      out.push(op);
      i++;
      continue;
    }
    // collect run: compensated moves with the same side/r/t, interleaved non-move ops kept aside
    const run: MoveOp[] = [];
    const infos: CompInfo[] = [];
    const between: { op: Op }[] = [];
    let j = i;
    while (j < ops.length) {
      const o = ops[j];
      const c = comp[j];
      if (o.kind !== 'move') {
        between.push({ op: o });
        j++;
        continue;
      }
      if (!c || c.r <= 0) break;
      if (run.length && (c.side !== infos[0].side || c.r !== infos[0].r || c.t !== infos[0].t)) break;
      run.push(o);
      infos.push(c);
      j++;
    }
    // the next (uncompensated) move is the cancel move
    let k = j;
    if (k < ops.length && ops[k].kind === 'move') {
      const cm = { ...(ops[k] as MoveOp), __cancel: true };
      run.push(cm);
      k++;
    }
    const processed = processRun(run, infos, warn);
    // re-insert non-move ops (M08, S changes…) before the first move of a later source line
    const pending = between.map((b) => b.op);
    for (const m of processed) {
      while (pending.length && pending[0].line < m.line) out.push(pending.shift()!);
      out.push(m);
    }
    out.push(...pending);
    i = k;
  }
  // re-chain "from" points so consecutive moves stay continuous
  let last: P | null = null;
  for (const o of out) {
    if (o.kind !== 'move') continue;
    if (last && !near(o.from, last, 1e-6) && o.type !== 'arc') o.from = { ...last };
    last = o.to;
  }
  return out;
}
