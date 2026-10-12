import type { MillOffset, MillTool, MillToolType } from './types';

/**
 * Height of the tool's lower envelope above the tip at radial distance d from the axis
 * (Infinity outside the tool). This is all the height-map needs to cut.
 */
export function envelope(t: MillTool, d: number): number {
  const R = t.diameter / 2;
  if (d > R + 1e-9) return Infinity;
  const half = ((t.tipAngle || 118) / 2) * (Math.PI / 180);
  switch (t.type) {
    case 'ball':
      return R - Math.sqrt(Math.max(0, R * R - d * d));
    case 'bull':
    case 'face': {
      const rc = Math.min(t.cornerR, R);
      const flat = R - rc;
      if (d <= flat || rc <= 0) return 0;
      const u = d - flat;
      return rc - Math.sqrt(Math.max(0, rc * rc - u * u));
    }
    case 'drill':
    case 'spot':
      return d / Math.tan(half);
    case 'chamfer': {
      const rt = t.tipDiameter / 2;
      return d <= rt ? 0 : (d - rt) / Math.tan(half);
    }
    default:
      return 0;
  }
}

/** (radius, height) outline of the cutting part, tip at h = 0 – for drawing / 3D lathe geometry */
export function toolProfile(t: MillTool): { r: number; h: number }[] {
  const R = t.diameter / 2;
  const pts: { r: number; h: number }[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const r = (R * i) / n;
    pts.push({ r, h: envelope(t, r) });
  }
  const top = Math.max(t.fluteLength, pts[pts.length - 1].h + 1);
  pts.push({ r: R, h: top });
  return pts;
}

export const MILL_TOOL_LABEL: Record<MillToolType, string> = {
  flat: 'Flat end mill',
  ball: 'Ball end mill',
  bull: 'Bull-nose (corner radius) end mill',
  face: 'Face mill',
  drill: 'Twist drill',
  spot: 'Spot / centre drill',
  chamfer: 'Chamfer mill',
  tap: 'Tap',
  ream: 'Reamer',
};

const t = (o: Partial<MillTool> & Pick<MillTool, 'id' | 'name' | 'type' | 'diameter'>): MillTool => ({
  cornerR: 0,
  flutes: 3,
  fluteLength: 20,
  length: 80,
  tipAngle: 118,
  tipDiameter: 0,
  pitch: 0,
  centerCutting: true,
  ...o,
});

export function defaultMillTools(): MillTool[] {
  return [
    t({ id: 1, name: 'Face mill Ø50 (5 inserts)', type: 'face', diameter: 50, cornerR: 0.8, flutes: 5, fluteLength: 6, length: 90, centerCutting: false }),
    t({ id: 2, name: 'End mill Ø10 3-flute', type: 'flat', diameter: 10, flutes: 3, fluteLength: 25, length: 75 }),
    t({ id: 3, name: 'End mill Ø6 3-flute', type: 'flat', diameter: 6, flutes: 3, fluteLength: 15, length: 62 }),
    t({ id: 4, name: 'Spot drill Ø10 90°', type: 'spot', diameter: 10, tipAngle: 90, flutes: 2, fluteLength: 10, length: 70 }),
    t({ id: 5, name: 'Drill Ø6.8 (tap drill M8)', type: 'drill', diameter: 6.8, flutes: 2, fluteLength: 45, length: 100 }),
    t({ id: 6, name: 'Tap M8×1.25', type: 'tap', diameter: 8, flutes: 3, fluteLength: 20, length: 95, pitch: 1.25 }),
    t({ id: 7, name: 'Drill Ø10', type: 'drill', diameter: 10, flutes: 2, fluteLength: 55, length: 110 }),
    t({ id: 8, name: 'Ball end mill Ø8 (R4)', type: 'ball', diameter: 8, flutes: 2, fluteLength: 18, length: 70 }),
    t({ id: 9, name: 'Chamfer mill Ø12 90°', type: 'chamfer', diameter: 12, tipAngle: 90, tipDiameter: 1, flutes: 4, fluteLength: 6, length: 70 }),
    t({ id: 10, name: 'Bull-nose Ø12 R1', type: 'bull', diameter: 12, cornerR: 1, flutes: 4, fluteLength: 25, length: 80 }),
    t({ id: 11, name: 'Reamer Ø8 H7', type: 'ream', diameter: 8, flutes: 6, fluteLength: 30, length: 100 }),
    t({ id: 12, name: 'End mill Ø16 4-flute', type: 'flat', diameter: 16, flutes: 4, fluteLength: 32, length: 92 }),
  ];
}

/** Offsets as measured by a tool setter: H = tool length, D = radius. */
export function defaultMillOffsets(tools: MillTool[]): Map<number, MillOffset> {
  const m = new Map<number, MillOffset>();
  for (let i = 1; i <= 20; i++) {
    const tl = tools.find((x) => x.id === i);
    m.set(i, { h: tl ? tl.length : 0, hw: 0, d: tl ? tl.diameter / 2 : 0, dw: 0 });
  }
  return m;
}
