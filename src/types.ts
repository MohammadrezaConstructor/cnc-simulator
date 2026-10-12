// Shared types for the lathe simulator.
//
// COORDINATE CONVENTION (internal): every point is { x, z } in millimetres where
//   x = RADIUS (distance from the spindle axis, may be negative for drills crossing the axis)
//   z = axial position, Z0 normally at the finished front face, negative towards the chuck.
// The G-code itself uses DIAMETER programming for X/U; the interpreter converts on input
// and the UI converts back (x * 2) on display.

export interface P {
  x: number;
  z: number;
}

export interface SpindleState {
  /** 'rpm' = G97 (S is rev/min), 'css' = G96 (S is surface speed m/min) */
  mode: 'rpm' | 'css';
  s: number;
  /** G50 S clamp (rev/min) */
  maxRpm: number;
  dir: 'cw' | 'ccw' | 'off';
}

export type MoveType = 'rapid' | 'linear' | 'arc' | 'thread';

export interface MoveOp {
  kind: 'move';
  type: MoveType;
  from: P;
  to: P;
  /** arc centre (radius coords) */
  center?: P;
  /** arc direction: true = G02 (clockwise when viewed with +Z right, +X up) */
  cw?: boolean;
  /** feed value: mm/rev when feedPerRev, mm/min otherwise. Thread lead for 'thread'. */
  feed: number;
  feedPerRev: boolean;
  spindle: SpindleState;
  /** source line (0-based) */
  line: number;
  tool: number;
  /** human-readable origin, e.g. "G71 rough pass 3/7" */
  label?: string;
  /** move produced by a canned cycle */
  cycle?: string;
  /** internal (TNRC): marks the G40 cancel move of a compensation run */
  __cancel?: boolean;
}

export type Op =
  | MoveOp
  | { kind: 'dwell'; seconds: number; line: number }
  | { kind: 'tool'; tool: number; offset: number; line: number }
  | { kind: 'spindle'; spindle: SpindleState; line: number }
  | { kind: 'coolant'; on: boolean; line: number }
  | { kind: 'stop'; optional: boolean; line: number; message: string }
  | { kind: 'end'; line: number; rewind: boolean };

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  line: number;
  severity: Severity;
  message: string;
  /** optional longer teaching explanation */
  hint?: string;
}

export type ToolType = 'turn' | 'bore' | 'groove' | 'partoff' | 'thread' | 'thread_id' | 'drill' | 'groove_id';

export interface ToolDef {
  /** turret station number (T01 → 1) */
  id: number;
  name: string;
  type: ToolType;
  /** nose radius (mm) */
  noseR: number;
  /** imaginary tool-tip direction (Fanuc 0-9) */
  tipNo: number;
  /** insert included angle (deg) – turning/boring */
  insertAngle: number;
  /** approach (lead) angle kappa (deg) – turning/boring */
  approach: number;
  /** insert cutting-edge length (mm) */
  size: number;
  /** groove / parting width, drill diameter, boring-bar diameter (mm) */
  width: number;
  /** maximum depth (groove/part-off reach, drill flute length) (mm) */
  reach: number;
  /** thread profile angle (deg) */
  threadAngle: number;
  color?: string;
}

export interface OffsetEntry {
  /** wear X (diameter, mm) */
  wx: number;
  /** wear Z (mm) */
  wz: number;
  /** nose radius used by G41/G42 */
  r: number;
  /** imaginary tip number used by G41/G42 */
  t: number;
}

export interface StockDef {
  /** outside diameter */
  diameter: number;
  /** total bar length */
  length: number;
  /** existing bore diameter (0 = solid) */
  bore: number;
  /** how much stock projects beyond Z0 (face allowance) */
  faceAllowance: number;
  /** length held inside the chuck jaws */
  gripLength: number;
  material: MaterialId;
}

export type MaterialId = 'steel' | 'aluminium' | 'brass' | 'stainless' | 'plastic' | 'castiron';

export interface MachineSettings {
  /** rapid traverse rate mm/min */
  rapidRate: number;
  /** machine spindle max rpm */
  maxRpm: number;
  /** spindle motor power kW */
  powerKW: number;
  /** home (reference) position in work coordinates, X as DIAMETER */
  homeX: number;
  homeZ: number;
  /** tool change time (s) */
  toolChangeTime: number;
  /** 'linear' = interpolated G00, 'dogleg' = each axis at full rapid (non-linear positioning) */
  rapidMode?: 'linear' | 'dogleg';
}
