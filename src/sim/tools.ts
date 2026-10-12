import type { OffsetEntry, P, ToolDef, ToolType } from '../types';
import { convexHull, deg, dirOf, add, mul } from './geom';

/**
 * Vector from the nose-radius CENTRE to the IMAGINARY TOOL TIP for Fanuc tip numbers 0–9
 * (rear-type tool post: +X up, +Z right).
 *
 *     2   6   1
 *     7  0/9  5
 *     3   8   4
 */
export function tipVector(t: number, r: number): P {
  switch (t) {
    case 1: return { z: r, x: r };
    case 2: return { z: -r, x: r };
    case 3: return { z: -r, x: -r };
    case 4: return { z: r, x: -r };
    case 5: return { z: r, x: 0 };
    case 6: return { z: 0, x: r };
    case 7: return { z: -r, x: 0 };
    case 8: return { z: 0, x: -r };
    default: return { z: 0, x: 0 };
  }
}

export interface ToolShape {
  /** convex cutting insert, relative to the control point (imaginary tip) */
  cutter: P[];
  /** convex non-cutting holder parts (collision bodies) */
  holder: P[][];
  /** nose radius centre relative to control point */
  noseCenter: P;
  /** insert thickness for 3D extrusion */
  thickness: number;
}

const arc = (c: P, r: number, a0: number, a1: number, n: number): P[] => {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ z: c.z + r * Math.cos(a), x: c.x + r * Math.sin(a) });
  }
  return out;
};

const rect = (z0: number, z1: number, x0: number, x1: number): P[] => [
  { z: z0, x: x0 },
  { z: z1, x: x0 },
  { z: z1, x: x1 },
  { z: z0, x: x1 },
];

const mirrorX = (poly: P[]): P[] => poly.map((p) => ({ z: p.z, x: -p.x }));
const shift = (poly: P[], d: P): P[] => poly.map((p) => ({ z: p.z - d.z, x: p.x - d.x }));

/** Rhombic insert with a nose radius whose corner sits at the origin. */
function rhombic(t: ToolDef) {
  const a1 = deg(180 - t.approach);
  const a2 = a1 - deg(t.insertAngle);
  const half = (a1 - a2) / 2;
  const R = Math.max(0, t.noseR);
  const L = t.size;
  const C = mul(dirOf((a1 + a2) / 2), R / Math.sin(half));
  const pts: P[] = [];
  if (R > 0) pts.push(...arc(C, R, a1 + Math.PI / 2, a2 - Math.PI / 2 + 2 * Math.PI, 14));
  else pts.push({ x: 0, z: 0 });
  const e1 = mul(dirOf(a1), L);
  const e2 = mul(dirOf(a2), L);
  pts.push(e2, add(e1, e2), e1);
  return { poly: convexHull(pts), C, e1, e2, far: add(e1, e2) };
}

export function buildToolShape(t: ToolDef): ToolShape {
  const R = Math.max(0, t.noseR);
  switch (t.type) {
    case 'turn':
    case 'bore': {
      const r = rhombic(t);
      const insertTop = Math.max(r.e1.x, r.e2.x, r.far.x);
      const zRight = Math.max(r.e1.z, r.e2.z, r.far.z);
      // holder: clamp head over the back of the insert + vertical shank
      const headPts = r.poly.filter((p) => p.x > insertTop * 0.55).flatMap((p) => [p, { z: p.z, x: insertTop + 4 }]);
      const zl = Math.max(r.e1.z, 0) + 1.2;
      let head = convexHull(headPts.concat([{ z: zRight + 3, x: insertTop * 0.55 }, { z: zRight + 3, x: insertTop + 4 }]));
      let shank = rect(zl, zl + 20, insertTop + 4, insertTop + 70);
      let cutter = r.poly;
      let C = r.C;
      if (t.type === 'bore') {
        cutter = mirrorX(cutter);
        C = { z: C.z, x: -C.x };
        // boring bar along +Z, below the insert
        const barD = Math.max(6, t.width);
        head = mirrorX(convexHull(r.poly.filter((p) => p.x > insertTop * 0.55).concat([{ z: zRight + 2, x: insertTop * 0.55 }, { z: zRight + 2, x: insertTop + 0.5 }])));
        const z0 = Math.max(r.e1.z, 0) + 1.5;
        shank = rect(z0, z0 + Math.max(60, t.reach), -barD - 1.0, -1.0);
      }
      const tipNo = t.tipNo;
      const tip = add(C, tipVector(tipNo, R));
      return {
        cutter: shift(cutter, tip),
        holder: [shift(head, tip), shift(shank, tip)],
        noseCenter: { z: C.z - tip.z, x: C.x - tip.x },
        thickness: 4.76,
      };
    }
    case 'groove':
    case 'partoff':
    case 'groove_id': {
      const W = t.width;
      const r = Math.min(R, W / 2 - 0.01);
      const H = 6;
      const pts: P[] = [];
      if (r > 0) {
        pts.push(...arc({ z: r, x: r }, r, Math.PI, 1.5 * Math.PI, 6));
        pts.push(...arc({ z: W - r, x: r }, r, 1.5 * Math.PI, 2 * Math.PI, 6));
      } else pts.push({ z: 0, x: 0 }, { z: W, x: 0 });
      pts.push({ z: W, x: H }, { z: 0, x: H });
      const reach = Math.max(H + 1, t.reach);
      let cutter = convexHull(pts);
      let blade = rect(0.2, W - 0.2, H, reach);
      let block = rect(-4, W + 18, reach, reach + 40);
      // control point: imaginary tip of the left corner (tip 3) – or right corner (tip 4)
      let ref: P = t.tipNo === 4 ? { z: W, x: 0 } : { z: 0, x: 0 };
      let nose: P = t.tipNo === 4 ? { z: W - r, x: r } : { z: r, x: r };
      if (t.type === 'groove_id') {
        // insert points up (+X) at the end of a boring bar that runs along +Z
        const barD = 10;
        cutter = mirrorX(cutter);
        blade = rect(0.2, W - 0.2, -H - 2, -H + 0.01);
        block = rect(0.2, Math.max(120, t.reach + 40), -H - 2 - barD, -H - 2);
        nose = { z: nose.z, x: -nose.x };
      }
      return {
        cutter: shift(cutter, ref),
        holder: [shift(blade, ref), shift(block, ref)],
        noseCenter: { z: nose.z - ref.z, x: nose.x - ref.x },
        thickness: W,
      };
    }
    case 'thread':
    case 'thread_id': {
      const half = deg(t.threadAngle / 2);
      const H = 5;
      const w = H * Math.tan(half);
      const tipFlat = Math.max(0.02, R);
      let cutter: P[] = [
        { z: -tipFlat * Math.tan(half) * 0.5, x: 0 },
        { z: tipFlat * Math.tan(half) * 0.5, x: 0 },
        { z: w, x: H },
        { z: -w, x: H },
      ];
      let holder = [rect(-w - 2, w + 14, H, H + 6), rect(-1, 19, H + 6, H + 66)];
      if (t.type === 'thread_id') {
        cutter = mirrorX(cutter);
        holder = [rect(w + 0.5, w + 120, -H - 8, -H + 0.01)];
      }
      return { cutter, holder, noseCenter: { z: 0, x: 0 }, thickness: 4 };
    }
    case 'drill': {
      const D = t.width;
      const h = D / 2 / Math.tan(deg(t.threadAngle > 0 ? t.threadAngle / 2 : 59));
      const fl = Math.max(D, t.reach);
      const cutter: P[] = [
        { z: 0, x: 0 },
        { z: h, x: D / 2 },
        { z: h + fl, x: D / 2 },
        { z: h + fl, x: -D / 2 },
        { z: h, x: -D / 2 },
      ];
      const hd = Math.max(D / 2 + 6, 12);
      const holder = [rect(h + fl, h + fl + 50, -hd, hd)];
      return { cutter, holder, noseCenter: { z: 0, x: 0 }, thickness: D };
    }
  }
}

export const TOOL_TYPE_LABEL: Record<ToolType, string> = {
  turn: 'OD turning',
  bore: 'Boring bar (ID)',
  groove: 'OD grooving',
  partoff: 'Parting-off',
  groove_id: 'ID grooving',
  thread: 'OD threading',
  thread_id: 'ID threading',
  drill: 'Drill (on centre)',
};

const base = (o: Partial<ToolDef> & Pick<ToolDef, 'id' | 'name' | 'type'>): ToolDef => ({
  noseR: 0.4,
  tipNo: 3,
  insertAngle: 80,
  approach: 95,
  size: 12,
  width: 3,
  reach: 15,
  threadAngle: 60,
  ...o,
});

export function defaultTools(): ToolDef[] {
  return [
    base({ id: 1, name: 'OD rough CNMG 80° R0.8', type: 'turn', noseR: 0.8, insertAngle: 80, approach: 95, size: 12 }),
    base({ id: 2, name: 'OD finish VNMG 35° R0.4', type: 'turn', noseR: 0.4, insertAngle: 35, approach: 93, size: 16 }),
    base({ id: 3, name: 'OD groove 3 mm', type: 'groove', noseR: 0.2, width: 3, reach: 12 }),
    base({ id: 4, name: 'OD thread 60°', type: 'thread', noseR: 0.05, tipNo: 8, threadAngle: 60 }),
    base({ id: 5, name: 'Drill Ø16', type: 'drill', noseR: 0, tipNo: 0, width: 16, reach: 70, threadAngle: 118 }),
    base({ id: 6, name: 'Boring bar Ø10 DCMT07 55° R0.4', type: 'bore', noseR: 0.4, tipNo: 2, insertAngle: 55, approach: 93, size: 7, width: 10, reach: 80 }),
    base({ id: 7, name: 'Part-off 3 mm', type: 'partoff', noseR: 0.1, width: 3, reach: 30 }),
    base({ id: 8, name: 'OD finish DNMG 55° R0.4', type: 'turn', noseR: 0.4, insertAngle: 55, approach: 93, size: 15 }),
    base({ id: 9, name: 'ID thread 60°', type: 'thread_id', noseR: 0.05, tipNo: 6, threadAngle: 60, width: 12 }),
    base({ id: 10, name: 'Centre / spot drill Ø6 90°', type: 'drill', noseR: 0, tipNo: 0, width: 6, reach: 10, threadAngle: 90 }),
    base({ id: 11, name: 'ID groove 3 mm', type: 'groove_id', noseR: 0.2, tipNo: 2, width: 3, reach: 60 }),
    base({ id: 12, name: 'Boring bar Ø16 CCMT09 80° R0.8', type: 'bore', noseR: 0.8, tipNo: 2, insertAngle: 80, approach: 95, size: 9.5, width: 16, reach: 80 }),
  ];
}

export function defaultOffsets(tools: ToolDef[]): Map<number, OffsetEntry> {
  const m = new Map<number, OffsetEntry>();
  for (let i = 1; i <= 16; i++) {
    const t = tools.find((tt) => tt.id === i);
    m.set(i, { wx: 0, wz: 0, r: t ? t.noseR : 0, t: t ? t.tipNo : 0 });
  }
  return m;
}
