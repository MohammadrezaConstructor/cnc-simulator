import type { MachineSettings, P, StockDef } from './types';

export const DEFAULT_MACHINE: MachineSettings = {
  rapidRate: 12000,
  maxRpm: 4000,
  powerKW: 15,
  homeX: 200,
  homeZ: 150,
  toolChangeTime: 1.2,
  rapidMode: 'linear',
};

export const DEFAULT_STOCK: StockDef = {
  diameter: 50,
  length: 100,
  bore: 0,
  faceAllowance: 1,
  gripLength: 30,
  material: 'steel',
};

export const DEFAULT_WORK_OFFSETS: Record<number, P> = {
  54: { x: 0, z: 0 },
  55: { x: 0, z: 0 },
  56: { x: 0, z: 0 },
  57: { x: 0, z: 0 },
  58: { x: 0, z: 0 },
  59: { x: 0, z: 0 },
};
