// Reference data for the milling control (Fanuc 0i-M / 30i style).

import type { CodeRef } from '../content/gcodeRef';

export const MILL_G: CodeRef[] = [
  { code: 'G00', title: 'Rapid positioning', group: 'Motion', modal: true, syntax: 'G00 X_ Y_ Z_', text: 'Moves at rapid traverse – never into material. Approach in X/Y high above the part, then go down in Z to 1–2 mm above the surface.' },
  { code: 'G01', title: 'Linear interpolation (feed)', group: 'Motion', modal: true, syntax: 'G01 X_ Y_ Z_ F_', text: 'Straight cutting move at feed F (mm/min with G94). Moving X and Z together ramps into the material.' },
  { code: 'G02', title: 'Circular interpolation CW', group: 'Motion', modal: true, syntax: 'G02 X_ Y_ R_  |  G02 X_ Y_ I_ J_ (Z_ = helix)', text: 'Clockwise arc seen from the positive axis of the plane normal (from above for G17). I/J/K are the incremental distances from the start point to the centre. Add Z for a helical move (helical entry into a pocket).' },
  { code: 'G03', title: 'Circular interpolation CCW', group: 'Motion', modal: true, syntax: 'G03 X_ Y_ R_  |  G03 X_ Y_ I_ J_', text: 'Counter-clockwise arc. A full circle needs I/J (R cannot describe it): G03 X10 Y0 I-10 J0 from X10 Y0.' },
  { code: 'G04', title: 'Dwell', group: 'Non-modal', modal: false, syntax: 'G04 P500 (ms) | G04 X0.5 (s)', text: 'Waits while the spindle keeps turning.' },
  { code: 'G15', title: 'Polar coordinates OFF', group: 'Coordinates', modal: true, text: 'Back to normal X/Y coordinates.' },
  { code: 'G16', title: 'Polar coordinates ON', group: 'Coordinates', modal: true, syntax: 'G16  …  X(radius) Y(angle)', text: 'In G17, X is the radius and Y the angle (degrees, counter-clockwise from +X) about the work zero. Perfect for bolt-hole circles.' },
  { code: 'G17', title: 'XY plane', group: 'Plane', modal: true, text: 'Arcs and cutter compensation in the XY plane (default on a vertical mill).' },
  { code: 'G18', title: 'ZX plane', group: 'Plane', modal: true, text: 'Arcs in the ZX plane (I and K).' },
  { code: 'G19', title: 'YZ plane', group: 'Plane', modal: true, text: 'Arcs in the YZ plane (J and K).' },
  { code: 'G20', title: 'Inch input', group: 'Units', modal: true, text: 'Dimensions in inches.' },
  { code: 'G21', title: 'Metric input', group: 'Units', modal: true, text: 'Dimensions in millimetres.' },
  { code: 'G28', title: 'Reference (home) return', group: 'Non-modal', modal: false, syntax: 'G91 G28 Z0', text: 'Rapid to the machine home via an intermediate point. "G91 G28 Z0" = go home in Z from where you are – the safe way to retract the spindle.', tip: 'Always retract Z before moving X/Y home.' },
  { code: 'G40', title: 'Cutter compensation cancel', group: 'Compensation', modal: true, text: 'Switch off cutter radius compensation on a G00/G01 move away from the part.' },
  { code: 'G41', title: 'Cutter compensation LEFT', group: 'Compensation', modal: true, syntax: 'G41 D_ G01 X_ Y_', text: 'The tool centre is offset by the radius in D to the LEFT of the direction of travel. With M03 this gives CLIMB milling – the normal choice on CNC machines.' },
  { code: 'G42', title: 'Cutter compensation RIGHT', group: 'Compensation', modal: true, syntax: 'G42 D_ G01 X_ Y_', text: 'Offset to the right of the travel direction (conventional milling with M03).' },
  { code: 'G43', title: 'Tool length compensation +', group: 'Length compensation', modal: true, syntax: 'G43 H_ Z_', text: 'Adds the tool length stored in register H so that Z refers to the TOOL TIP. Program it with the first Z move after every tool change: G43 H05 Z50.', tip: 'Missing G43 = the gauge line goes to Z – the tip is one tool length lower: crash!' },
  { code: 'G44', title: 'Tool length compensation −', group: 'Length compensation', modal: true, text: 'Subtracts the H value (rarely used).' },
  { code: 'G49', title: 'Tool length compensation cancel', group: 'Length compensation', modal: true, text: 'Z refers to the spindle gauge line again.' },
  { code: 'G52', title: 'Local coordinate system', group: 'Coordinates', modal: false, syntax: 'G52 X_ Y_ Z_', text: 'Shifts the zero point by X/Y/Z inside the current work offset (G52 X0 Y0 cancels). Handy to repeat a feature at several places.' },
  { code: 'G53', title: 'Machine coordinates (one block)', group: 'Coordinates', modal: false, syntax: 'G53 Z0', text: 'Moves in machine coordinates for this block only. G53 Z0 = spindle to the top (home).' },
  { code: 'G54', title: 'Work offset 1', group: 'Coordinates', modal: true, text: 'Selects work coordinate system 1 – the position of the part zero found during setup. G55–G59 select 2–6.' },
  { code: 'G55', title: 'Work offset 2', group: 'Coordinates', modal: true, text: 'Work coordinate system 2.' },
  { code: 'G56', title: 'Work offset 3', group: 'Coordinates', modal: true, text: 'Work coordinate system 3.' },
  { code: 'G57', title: 'Work offset 4', group: 'Coordinates', modal: true, text: 'Work coordinate system 4.' },
  { code: 'G58', title: 'Work offset 5', group: 'Coordinates', modal: true, text: 'Work coordinate system 5.' },
  { code: 'G59', title: 'Work offset 6', group: 'Coordinates', modal: true, text: 'Work coordinate system 6.' },
  { code: 'G68', title: 'Coordinate rotation', group: 'Coordinates', modal: true, syntax: 'G68 X_ Y_ R(angle)', text: 'Rotates the program about X/Y by R degrees (CCW positive). Cancel with G69.' },
  { code: 'G69', title: 'Rotation cancel', group: 'Coordinates', modal: true, text: 'Cancels G68.' },
  { code: 'G73', title: 'High-speed peck drilling', group: 'Hole cycles', modal: true, syntax: 'G73 X_ Y_ Z_ R_ Q_ F_', text: 'Pecks Q deep, retracts a small amount to break the chip, continues. Fast – for short chips.' },
  { code: 'G74', title: 'Left-hand tapping', group: 'Hole cycles', modal: true, syntax: 'G74 X_ Y_ Z_ R_ F_', text: 'Like G84 but with the spindle in reverse (M04).' },
  { code: 'G76', title: 'Fine boring', group: 'Hole cycles', modal: true, syntax: 'G76 X_ Y_ Z_ R_ Q_ F_', text: 'Bores to depth, orients the spindle, shifts away by Q and retracts without marking the bore.' },
  { code: 'G80', title: 'Cancel canned cycle', group: 'Hole cycles', modal: true, text: 'Ends any hole cycle. Always program it before moving on.' },
  { code: 'G81', title: 'Drilling', group: 'Hole cycles', modal: true, syntax: 'G81 X_ Y_ Z_ R_ F_', text: 'Rapid to R, feed to Z, rapid out. Every following X/Y position drills another hole until G80.', params: [['R', 'R-plane: rapid stops here (2–3 mm above the surface)'], ['Z', 'Hole bottom (tip of the drill)'], ['F', 'Feed mm/min'], ['K', 'Number of repeats (with G91 increments)']] },
  { code: 'G82', title: 'Spot drilling / counterboring', group: 'Hole cycles', modal: true, syntax: 'G82 X_ Y_ Z_ R_ P_ F_', text: 'Like G81 with a dwell P (ms) at the bottom for a clean spot or counterbore.' },
  { code: 'G83', title: 'Deep-hole peck drilling', group: 'Hole cycles', modal: true, syntax: 'G83 X_ Y_ Z_ R_ Q_ F_', text: 'Pecks Q deep and retracts to R after every peck to clear the chips – for holes deeper than ~3 × D.', params: [['Q', 'Peck depth (write a decimal point: Q3. = 3 mm)']] },
  { code: 'G84', title: 'Tapping', group: 'Hole cycles', modal: true, syntax: 'G84 X_ Y_ Z_ R_ F(pitch × rpm)', text: 'Feeds in synchronised with the spindle, reverses, feeds out. With G94: F = pitch × S, e.g. M8×1.25 at S800 → F1000.' },
  { code: 'G85', title: 'Boring (feed out)', group: 'Hole cycles', modal: true, text: 'Feed in, feed out – for reaming.' },
  { code: 'G86', title: 'Boring (spindle stop, rapid out)', group: 'Hole cycles', modal: true, text: 'Feed in, stop the spindle, rapid out.' },
  { code: 'G89', title: 'Boring with dwell', group: 'Hole cycles', modal: true, text: 'Feed in, dwell, feed out.' },
  { code: 'G90', title: 'Absolute programming', group: 'Distance', modal: true, text: 'X/Y/Z are positions in the work coordinate system.' },
  { code: 'G91', title: 'Incremental programming', group: 'Distance', modal: true, text: 'X/Y/Z are distances from the current position. Remember to switch back to G90!' },
  { code: 'G94', title: 'Feed per minute', group: 'Feed', modal: true, text: 'F in mm/min – the normal mode on milling machines.' },
  { code: 'G95', title: 'Feed per revolution', group: 'Feed', modal: true, text: 'F in mm/rev.' },
  { code: 'G98', title: 'Return to initial level', group: 'Hole cycles', modal: true, text: 'After each hole the drill rapids back to the Z where the cycle started – use it to jump over clamps or features.' },
  { code: 'G99', title: 'Return to R-plane', group: 'Hole cycles', modal: true, text: 'After each hole the drill stays at R – faster when the path to the next hole is clear.' },
];

export const MILL_M: CodeRef[] = [
  { code: 'M00', title: 'Program stop', group: 'Program', modal: false, text: 'Stops; continue with CYCLE START.' },
  { code: 'M01', title: 'Optional stop', group: 'Program', modal: false, text: 'Stops only with OPTIONAL STOP on.' },
  { code: 'M02', title: 'End of program', group: 'Program', modal: false, text: 'Ends the program.' },
  { code: 'M03', title: 'Spindle on CW', group: 'Spindle', modal: true, text: 'Spindle clockwise (seen from above) at S rpm – normal for right-hand tools.' },
  { code: 'M04', title: 'Spindle on CCW', group: 'Spindle', modal: true, text: 'Spindle counter-clockwise.' },
  { code: 'M05', title: 'Spindle stop', group: 'Spindle', modal: true, text: 'Stops the spindle.' },
  { code: 'M06', title: 'Tool change', group: 'Tool', modal: false, syntax: 'T05 M06', text: 'Puts the tool selected with T into the spindle. The machine first moves Z up to the tool-change position and STOPS the spindle – program M03 S… again afterwards, plus G43 H for the new length.' },
  { code: 'M08', title: 'Coolant on', group: 'Coolant', modal: true, text: 'Flood coolant on.' },
  { code: 'M09', title: 'Coolant off', group: 'Coolant', modal: true, text: 'Coolant off.' },
  { code: 'M19', title: 'Spindle orientation', group: 'Spindle', modal: false, text: 'Orients the spindle (ignored by the simulator).' },
  { code: 'M29', title: 'Rigid tapping mode', group: 'Spindle', modal: false, text: 'Selects rigid tapping before G84 on some controls (simulated as normal G84).' },
  { code: 'M30', title: 'End of program & rewind', group: 'Program', modal: false, text: 'Ends and rewinds.' },
  { code: 'M98', title: 'Sub-program call', group: 'Program', modal: false, syntax: 'M98 P1000 L3', text: 'Calls O1000 (three times with L3). Often combined with G91 moves or G52 shifts.' },
  { code: 'M99', title: 'Sub-program end', group: 'Program', modal: false, text: 'Returns to the calling program.' },
];

export const MILL_ADDR: CodeRef[] = [
  { code: 'X', title: 'X axis', group: 'Address', modal: false, text: 'Table left/right. Radius when G16 polar is active.' },
  { code: 'Y', title: 'Y axis', group: 'Address', modal: false, text: 'Table towards/away from the operator. Angle when G16 is active.' },
  { code: 'Z', title: 'Z axis', group: 'Address', modal: false, text: 'Spindle up/down. Z0 is usually the top of the finished part – negative Z is inside the material.' },
  { code: 'I', title: 'Arc centre X', group: 'Address', modal: false, text: 'Distance from the arc start to the centre in X.' },
  { code: 'J', title: 'Arc centre Y', group: 'Address', modal: false, text: 'Distance from the arc start to the centre in Y.' },
  { code: 'K', title: 'Arc centre Z / repeats', group: 'Address', modal: false, text: 'Arc centre in Z (G18/G19) or the number of repeats in hole cycles.' },
  { code: 'R', title: 'Radius / R-plane', group: 'Address', modal: false, text: 'Arc radius, R-plane of hole cycles or rotation angle with G68.' },
  { code: 'Q', title: 'Peck depth', group: 'Address', modal: false, text: 'Peck depth in G73/G83 (use a decimal point).' },
  { code: 'P', title: 'Dwell / sub-program', group: 'Address', modal: false, text: 'Dwell in ms (G04, G82, G89) or sub-program number (M98).' },
  { code: 'F', title: 'Feed', group: 'Address', modal: false, text: 'mm/min (G94). Feed per tooth fz = F / (S × number of flutes).' },
  { code: 'S', title: 'Spindle speed', group: 'Address', modal: false, text: 'rev/min: S = 1000 × Vc / (π × D).' },
  { code: 'T', title: 'Tool select', group: 'Address', modal: false, text: 'Prepares the tool; M06 puts it into the spindle.' },
  { code: 'H', title: 'Length offset register', group: 'Address', modal: false, text: 'Used with G43. Normally the same number as the tool.' },
  { code: 'D', title: 'Radius offset register', group: 'Address', modal: false, text: 'Used with G41/G42 – contains the tool radius (plus wear).' },
  { code: 'N', title: 'Sequence number', group: 'Address', modal: false, text: 'Block label (GOTO targets).' },
  { code: 'O', title: 'Program number', group: 'Address', modal: false, text: 'Program / sub-program number.' },
];

export function findMillCode(code: string): CodeRef | undefined {
  const c = code.toUpperCase();
  const m = /^([GM])(\d+)$/.exec(c);
  const n = m ? m[1] + String(parseInt(m[2], 10)).padStart(2, '0') : c;
  return MILL_G.find((g) => g.code === n) ?? MILL_M.find((g) => g.code === n) ?? MILL_ADDR.find((a) => a.code === c);
}
