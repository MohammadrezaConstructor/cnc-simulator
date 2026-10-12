// Types for the milling simulator (3-axis vertical machining centre).
// Coordinates are WORK coordinates (G54) in mm: X right, Y away from the operator, Z up.
// Moves describe the path of the TOOL TIP (centre of the tool's lowest point).

import type { Diagnostic, MaterialId } from '../types';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export type Plane = 17 | 18 | 19;

export interface MillSpindle {
  rpm: number;
  dir: 'cw' | 'ccw' | 'off';
}

export interface MillMove {
  kind: 'move';
  type: 'rapid' | 'linear' | 'arc';
  from: V3;
  to: V3;
  /** arc centre (only the two in-plane coordinates matter) */
  center?: V3;
  cw?: boolean;
  plane: Plane;
  /** mm/min (G94) or mm/rev (G95) */
  feed: number;
  feedPerRev: boolean;
  spindle: MillSpindle;
  line: number;
  tool: number;
  label?: string;
  cycle?: string;
  /** internal flag used by cutter compensation */
  __cancel?: boolean;
}

export type MillOp =
  | MillMove
  | { kind: 'dwell'; seconds: number; line: number }
  | { kind: 'tool'; tool: number; line: number }
  | { kind: 'spindle'; spindle: MillSpindle; line: number }
  | { kind: 'coolant'; on: boolean; line: number }
  | { kind: 'stop'; optional: boolean; line: number; message: string }
  | { kind: 'end'; line: number; rewind: boolean };

export type MillToolType = 'flat' | 'ball' | 'bull' | 'face' | 'drill' | 'spot' | 'chamfer' | 'tap' | 'ream';

export interface MillTool {
  id: number;
  name: string;
  type: MillToolType;
  diameter: number;
  /** corner radius (bull nose) */
  cornerR: number;
  flutes: number;
  /** cutting length */
  fluteLength: number;
  /** gauge line → tip (what a tool setter measures) */
  length: number;
  /** point / chamfer included angle (deg) */
  tipAngle: number;
  /** chamfer mill / spot drill tip diameter */
  tipDiameter: number;
  /** tap pitch */
  pitch: number;
  /** can the tool plunge straight down (end mills yes, most face mills no) */
  centerCutting: boolean;
}

/** offset page: H (length) and D (radius) registers share the same number */
export interface MillOffset {
  /** tool length geometry (H) */
  h: number;
  /** length wear */
  hw: number;
  /** radius (D) for G41/G42 */
  d: number;
  /** radius wear */
  dw: number;
}

/** where X0 Y0 is: a top corner of the block ('corner' = front left) or the centre of the top face */
export type WorkOrigin = 'corner' | 'front-right' | 'back-left' | 'back-right' | 'center';

export interface BlockStock {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  origin: WorkOrigin;
  /** material to be faced off the top */
  topAllowance: number;
  /** Z0 at the finished top (default – the raw top is then Z+topAllowance) or at the raw top of the block */
  zRef?: 'finished' | 'raw';
  material: MaterialId;
  /** height of the block sticking out above the vise jaws */
  aboveJaws: number;
}

export interface MillSettings {
  rapidRate: number;
  maxRpm: number;
  powerKW: number;
  /** spindle gauge line Z at machine home (work coordinates) */
  homeZ: number;
  homeX: number;
  homeY: number;
  toolChangeTime: number;
  /** automatic tool length compensation: after M06 the new tool's length (offset no. = tool no.)
   *  is applied without G43 H… – an explicit G43/G44/G49 still works */
  autoLength?: boolean;
  /** automatic cutter radius: G41/G42 without D use the active tool's radius (+ radius wear) */
  autoRadius?: boolean;
  /** programmed point of the tool: its lowest point ('tip') or the centre of the nose radius
   *  ('center' – ball centre of a ball mill, corner-radius centre of a bull-nose / face mill) */
  pointRef?: 'tip' | 'center';
}

export type { Diagnostic };
