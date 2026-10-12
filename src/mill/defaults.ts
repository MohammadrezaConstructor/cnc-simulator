import type { BlockStock, MillSettings, V3 } from './types';

export const DEFAULT_MILL: MillSettings = {
  rapidRate: 15000,
  maxRpm: 8000,
  powerKW: 11,
  homeZ: 250,
  homeX: 150,
  homeY: 120,
  toolChangeTime: 2.5,
};

export const DEFAULT_BLOCK: BlockStock = {
  sizeX: 100,
  sizeY: 80,
  sizeZ: 30,
  origin: 'corner',
  topAllowance: 1,
  material: 'aluminium',
  aboveJaws: 15,
};

export const DEFAULT_MILL_WORK: Record<number, V3> = {
  54: { x: 0, y: 0, z: 0 },
  55: { x: 0, y: 0, z: 0 },
  56: { x: 0, y: 0, z: 0 },
  57: { x: 0, y: 0, z: 0 },
  58: { x: 0, y: 0, z: 0 },
  59: { x: 0, y: 0, z: 0 },
};
