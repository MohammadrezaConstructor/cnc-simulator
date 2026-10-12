// Reference data for every supported code (used by tooltips, autocomplete, the block
// explainer and the Reference panel).

export interface CodeRef {
  code: string;
  title: string;
  group: string;
  modal: boolean;
  syntax?: string;
  text: string;
  params?: [string, string][];
  example?: string;
  tip?: string;
}

export const GCODES: CodeRef[] = [
  {
    code: 'G00', title: 'Rapid positioning', group: 'Motion', modal: true,
    syntax: 'G00 X(U)_ Z(W)_',
    text: 'Moves at maximum traverse speed to the end point. Never cut with G00 – use it only in air. On many real machines both axes move at full speed independently, so the path may be a "dog-leg" rather than a straight line.',
    example: 'G00 X52. Z2.',
    tip: 'Approach to 1–2 mm from the material with G00, then switch to G01.',
  },
  {
    code: 'G01', title: 'Linear interpolation (feed)', group: 'Motion', modal: true,
    syntax: 'G01 X(U)_ Z(W)_ F_',
    text: 'Straight-line cutting move at the programmed feed. Moving only Z turns a diameter, moving only X faces or grooves, moving both cuts a taper or chamfer.',
    example: 'G01 Z-30. F0.25',
  },
  {
    code: 'G02', title: 'Circular interpolation clockwise', group: 'Motion', modal: true,
    syntax: 'G02 X(U)_ Z(W)_ R_   or   G02 X_ Z_ I_ K_',
    text: 'Arc in the clockwise direction as seen in the usual lathe picture (+X up, +Z to the right, tool above the centre line). On the outside diameter G02 makes a CONCAVE fillet when moving towards the chuck.',
    params: [['R', 'Arc radius (negative R = arc > 180°)'], ['I', 'Incremental X distance start → centre (RADIUS value)'], ['K', 'Incremental Z distance start → centre']],
    example: 'G02 X30. Z-20. R5.',
  },
  {
    code: 'G03', title: 'Circular interpolation counter-clockwise', group: 'Motion', modal: true,
    syntax: 'G03 X(U)_ Z(W)_ R_   or   G03 X_ Z_ I_ K_',
    text: 'Arc counter-clockwise (+X up, +Z right). On the outside diameter G03 makes a CONVEX (rounded) corner when moving towards the chuck.',
    params: [['R', 'Arc radius'], ['I', 'Incremental X start → centre (radius)'], ['K', 'Incremental Z start → centre']],
    example: 'G03 X20. Z-2. R2.',
  },
  {
    code: 'G04', title: 'Dwell', group: 'Non-modal', modal: false,
    syntax: 'G04 X_ (s)  |  G04 U_ (s)  |  G04 P_ (ms)',
    text: 'Pauses the axes for a time while the spindle keeps turning – e.g. to clean the bottom of a groove. P is in milliseconds without a decimal point.',
    example: 'G04 X0.5',
  },
  { code: 'G18', title: 'ZX plane selection', group: 'Plane', modal: true, text: 'Selects the Z-X plane for arcs and compensation. It is the default on lathes.' },
  { code: 'G20', title: 'Inch input', group: 'Units', modal: true, text: 'All dimensions in inches. Put it at the very top of the program. (The simulator converts to mm internally.)' },
  { code: 'G21', title: 'Metric input', group: 'Units', modal: true, text: 'All dimensions in millimetres.' },
  {
    code: 'G28', title: 'Return to reference (home) position', group: 'Non-modal', modal: false,
    syntax: 'G28 U0 W0',
    text: 'Rapid to the machine home position via an intermediate point. "U0 W0" means the intermediate point is the current position, so the tool goes straight home. Use "G28 U0" to retract X first.',
    tip: 'Always retract X before Z when the tool is inside a bore!',
  },
  {
    code: 'G32', title: 'Thread cutting (single move)', group: 'Motion', modal: true,
    syntax: 'G32 X(U)_ Z(W)_ F(lead)',
    text: 'Feed move synchronised with the spindle: the tool advances exactly one lead (F) per revolution. You must program every approach, cut and retract yourself.',
  },
  { code: 'G40', title: 'Cancel tool nose radius compensation', group: 'Compensation', modal: true, text: 'Switches TNRC off. Program it with a G00/G01 move away from the part.' },
  {
    code: 'G41', title: 'Tool nose radius compensation LEFT', group: 'Compensation', modal: true,
    text: 'The tool nose centre is offset by R to the LEFT of the direction of travel. On a rear-type lathe: boring (ID) towards the chuck, or facing towards the centre.',
    tip: 'R and the tip number T come from the offset page (T0101 → offset 01).',
  },
  {
    code: 'G42', title: 'Tool nose radius compensation RIGHT', group: 'Compensation', modal: true,
    text: 'Offsets the nose centre by R to the RIGHT of the direction of travel. Typical for outside turning towards the chuck. Start it on a linear move outside the part.',
  },
  {
    code: 'G50', title: 'Max. spindle speed / coordinate setting', group: 'Non-modal', modal: false,
    syntax: 'G50 S_   |   G50 X_ Z_',
    text: 'G50 S limits the spindle speed (rev/min) for constant surface speed – ALWAYS program it before G96. G50 X_ Z_ (old style) declares the current tool position to be X_ Z_.',
    example: 'G50 S2500',
  },
  { code: 'G54', title: 'Work coordinate system 1', group: 'Coordinates', modal: true, text: 'Selects work offset 1 (the default). G55–G59 select offsets 2–6.' },
  { code: 'G55', title: 'Work coordinate system 2', group: 'Coordinates', modal: true, text: 'Selects work offset 2.' },
  { code: 'G56', title: 'Work coordinate system 3', group: 'Coordinates', modal: true, text: 'Selects work offset 3.' },
  { code: 'G57', title: 'Work coordinate system 4', group: 'Coordinates', modal: true, text: 'Selects work offset 4.' },
  { code: 'G58', title: 'Work coordinate system 5', group: 'Coordinates', modal: true, text: 'Selects work offset 5.' },
  { code: 'G59', title: 'Work coordinate system 6', group: 'Coordinates', modal: true, text: 'Selects work offset 6.' },
  {
    code: 'G70', title: 'Finishing cycle', group: 'Multiple repetitive cycles', modal: false,
    syntax: 'G70 P(ns) Q(nf)',
    text: 'Runs the finishing profile (blocks N ns … N nf) once, using the F/S written inside the profile, then returns to the start point.',
    params: [['P', 'N-number of the first profile block'], ['Q', 'N-number of the last profile block']],
  },
  {
    code: 'G71', title: 'Stock removal in turning (OD/ID roughing)', group: 'Multiple repetitive cycles', modal: false,
    syntax: 'G71 U(Δd) R(e);\nG71 P(ns) Q(nf) U(Δu) W(Δw) F_ S_',
    text: 'Roughs the material above (OD) or below (ID) the finished profile in horizontal layers, then makes one pass along the profile offset by the finishing allowance. Profile must be monotonic (type I) and its first block must move in X only.',
    params: [
      ['U (1st block)', 'Depth of cut per side (radius)'],
      ['R (1st block)', 'Retract amount after each layer'],
      ['P / Q', 'First / last N-number of the profile'],
      ['U (2nd block)', 'Finishing allowance in X (diameter; negative for ID)'],
      ['W (2nd block)', 'Finishing allowance in Z'],
      ['F', 'Roughing feed (feeds inside the profile are ignored)'],
    ],
  },
  {
    code: 'G72', title: 'Stock removal in facing', group: 'Multiple repetitive cycles', modal: false,
    syntax: 'G72 W(Δd) R(e);\nG72 P(ns) Q(nf) U(Δu) W(Δw) F_',
    text: 'Like G71 but in vertical layers (cutting along X). First profile block moves in Z only. Ideal for large diameters with short length.',
    params: [['W (1st block)', 'Depth of cut per pass in Z'], ['R (1st block)', 'Retract'], ['U/W (2nd block)', 'Finishing allowances']],
  },
  {
    code: 'G73', title: 'Pattern repeating', group: 'Multiple repetitive cycles', modal: false,
    syntax: 'G73 U(Δi) W(Δk) R(d);\nG73 P(ns) Q(nf) U(Δu) W(Δw) F_',
    text: 'Repeats the complete profile several times, each time closer to the finished shape. Best for castings/forgings; also follows necks that G71 type I cannot.',
    params: [['U (1st)', 'Total relief in X (radius)'], ['W (1st)', 'Total relief in Z'], ['R (1st)', 'Number of passes'], ['U/W (2nd)', 'Finishing allowances']],
  },
  {
    code: 'G74', title: 'Face peck drilling / face grooving', group: 'Multiple repetitive cycles', modal: false,
    syntax: 'G74 R(e);\nG74 X(U)_ Z(W)_ P(Δi) Q(Δk) F_',
    text: 'Pecks along Z: feed Q, retract e, feed again… until the Z end point. With X it repeats at several X positions (face groove). P and Q are in µm when written without a decimal point.',
    params: [['R (1st)', 'Retract after each peck'], ['Z', 'Final depth'], ['Q', 'Peck depth (µm)'], ['P', 'X step (µm) for face grooving']],
    example: 'G74 R1.\nG74 Z-30. Q5000 F0.12',
  },
  {
    code: 'G75', title: 'OD/ID peck grooving', group: 'Multiple repetitive cycles', modal: false,
    syntax: 'G75 R(e);\nG75 X(U)_ Z(W)_ P(Δi) Q(Δk) F_',
    text: 'Pecks along X down to the groove diameter, then shifts by Q in Z for wide grooves. Also used for parting off. P and Q in µm without decimal point.',
    params: [['X', 'Groove bottom diameter'], ['Z', 'Last groove position (tool reference corner)'], ['P', 'Peck depth in X (µm, radius)'], ['Q', 'Z shift between plunges (µm) – less than the tool width']],
  },
  {
    code: 'G76', title: 'Multiple threading cycle', group: 'Multiple repetitive cycles', modal: false,
    syntax: 'G76 P(mm rr aa) Q(Δdmin) R(d);\nG76 X(U)_ Z(W)_ R(i) P(k) Q(Δd) F(L)',
    text: 'Cuts a complete thread in many passes. Depth per pass decreases (Δd·√n) so the chip area stays constant, and the tool feeds in along the thread flank.',
    params: [
      ['P (1st) mm', 'Number of finishing passes (2 digits)'],
      ['P (1st) rr', 'Thread run-out chamfer in 0.1 × lead'],
      ['P (1st) aa', 'Tool angle (60 for metric/UN threads)'],
      ['Q (1st)', 'Minimum depth of cut (µm)'],
      ['R (1st)', 'Finishing allowance (mm)'],
      ['X', 'Minor (root) diameter – major diameter for internal threads'],
      ['Z', 'Thread end'],
      ['R (2nd)', 'Taper (radius difference)'],
      ['P (2nd)', 'Thread height (µm, radius) – ≈ 0.6134 × pitch for external metric'],
      ['Q (2nd)', 'First depth of cut (µm, radius)'],
      ['F', 'Lead (= pitch for single-start threads)'],
    ],
    example: 'G76 P020060 Q50 R0.05\nG76 X21.546 Z-25. P1227 Q350 F2.',
  },
  {
    code: 'G90', title: 'OD/ID turning cycle (box cycle)', group: 'Single cycles', modal: true,
    syntax: 'G90 X(U)_ Z(W)_ [R_] F_',
    text: 'One block = 4 moves: rapid to X, cut to Z, feed out to the start X, rapid back. Following blocks with just X repeat the cycle. R gives a taper (radius at start of cut minus radius at end).',
  },
  {
    code: 'G92', title: 'Threading cycle (single pass)', group: 'Single cycles', modal: true,
    syntax: 'G92 X(U)_ Z(W)_ [R_] F(lead)',
    text: 'One threading pass per block; repeat with the next X for each pass. You choose the depth of every pass yourself.',
  },
  {
    code: 'G94', title: 'Facing cycle (box cycle)', group: 'Single cycles', modal: true,
    syntax: 'G94 X(U)_ Z(W)_ [R_] F_',
    text: 'One block = rapid to Z, face down to X, feed back out, rapid return. Repeat with new Z values.',
  },
  {
    code: 'G96', title: 'Constant surface speed (CSS)', group: 'Spindle', modal: true,
    syntax: 'G96 S(m/min)',
    text: 'S is the cutting speed Vc in m/min. The rpm changes automatically with the diameter: n = 1000·Vc / (π·D). Gives the same cutting conditions on every diameter – but the rpm rises sharply near X0, so limit it with G50 S.',
  },
  { code: 'G97', title: 'Constant spindle speed', group: 'Spindle', modal: true, syntax: 'G97 S(rev/min)', text: 'S is the spindle speed in rev/min. Use it for drilling on centre, threading and parting off.' },
  { code: 'G98', title: 'Feed per minute', group: 'Feed', modal: true, text: 'F in mm/min. Mostly used for driven tools, rarely for turning.' },
  { code: 'G99', title: 'Feed per revolution', group: 'Feed', modal: true, text: 'F in mm/rev – the normal mode on lathes. The table feed is f·n (mm/min).' },
];

export const MCODES: CodeRef[] = [
  { code: 'M00', title: 'Program stop', group: 'Program', modal: false, text: 'Stops the program (spindle and coolant stop on most machines). Continue with CYCLE START – e.g. to measure the part or remove chips.' },
  { code: 'M01', title: 'Optional stop', group: 'Program', modal: false, text: 'Stops only when the OPTIONAL STOP switch is ON. Placed after every operation so the operator can check the first part.' },
  { code: 'M02', title: 'End of program', group: 'Program', modal: false, text: 'Ends the program (without rewinding on older controls).' },
  { code: 'M03', title: 'Spindle on, clockwise', group: 'Spindle', modal: true, text: 'Starts the spindle forward at the programmed S.' },
  { code: 'M04', title: 'Spindle on, counter-clockwise', group: 'Spindle', modal: true, text: 'Starts the spindle in reverse (e.g. for tools mounted upside down).' },
  { code: 'M05', title: 'Spindle stop', group: 'Spindle', modal: true, text: 'Stops the spindle.' },
  { code: 'M07', title: 'Mist coolant on', group: 'Coolant', modal: true, text: 'Switches mist coolant on.' },
  { code: 'M08', title: 'Coolant on', group: 'Coolant', modal: true, text: 'Switches flood coolant on.' },
  { code: 'M09', title: 'Coolant off', group: 'Coolant', modal: true, text: 'Switches coolant off.' },
  { code: 'M30', title: 'End of program & rewind', group: 'Program', modal: false, text: 'Ends the program, resets the control and rewinds to the start.' },
  { code: 'M98', title: 'Sub-program call', group: 'Program', modal: false, syntax: 'M98 P(llll)(oooo)   or   M98 P(oooo) L(count)', text: 'Calls sub-program O oooo. Extra leading digits (or L) give the number of repetitions: M98 P31000 runs O1000 three times.' },
  { code: 'M99', title: 'Sub-program end / return', group: 'Program', modal: false, text: 'Returns from a sub-program to the block after the M98 call.' },
];

export const ADDRESSES: CodeRef[] = [
  { code: 'O', title: 'Program number', group: 'Address', modal: false, text: 'Program / sub-program number (O0001–O9999).' },
  { code: 'N', title: 'Sequence (block) number', group: 'Address', modal: false, text: 'Label of the block. Optional, but needed as P/Q targets for G70–G73.' },
  { code: 'X', title: 'X coordinate (DIAMETER, absolute)', group: 'Address', modal: false, text: 'Absolute position in X – always a DIAMETER on a lathe. X0 is the spindle centre line.' },
  { code: 'Z', title: 'Z coordinate (absolute)', group: 'Address', modal: false, text: 'Absolute axial position. Z0 is normally the finished front face; negative Z is towards the chuck.' },
  { code: 'U', title: 'Incremental X (diameter)', group: 'Address', modal: false, text: 'Incremental move in X, as a diameter change (U-2. moves the tool 1 mm closer to the centre). In G71/G73 cycles U has a special meaning.' },
  { code: 'W', title: 'Incremental Z', group: 'Address', modal: false, text: 'Incremental move in Z. In G71/G72/G73 cycles W has a special meaning.' },
  { code: 'R', title: 'Radius / cycle parameter', group: 'Address', modal: false, text: 'Arc radius with G02/G03; taper with G90/G92/G94; retract / allowance in multiple repetitive cycles.' },
  { code: 'I', title: 'Arc centre X (incremental, radius)', group: 'Address', modal: false, text: 'X distance from the arc start point to the centre, as a RADIUS value.' },
  { code: 'K', title: 'Arc centre Z (incremental)', group: 'Address', modal: false, text: 'Z distance from the arc start point to the centre.' },
  { code: 'F', title: 'Feed rate / thread lead', group: 'Address', modal: false, text: 'Feed in mm/rev (G99) or mm/min (G98). In threading blocks F is the lead.' },
  { code: 'S', title: 'Spindle speed', group: 'Address', modal: false, text: 'rev/min (G97), surface speed m/min (G96), or max rpm with G50.' },
  { code: 'T', title: 'Tool and offset', group: 'Address', modal: false, text: 'T0303 = turret station 03 with offset 03. Offset 00 cancels the offset.' },
  { code: 'P', title: 'Parameter P', group: 'Address', modal: false, text: 'Dwell time (ms), first profile block (G70–G73), sub-program number (M98), peck/thread parameter (G74–G76).' },
  { code: 'Q', title: 'Parameter Q', group: 'Address', modal: false, text: 'Last profile block (G70–G73), peck depth (G74/G75), cut depth (G76).' },
  { code: 'M', title: 'Miscellaneous function', group: 'Address', modal: false, text: 'Machine functions: spindle, coolant, program stop/end, sub-programs.' },
  { code: 'G', title: 'Preparatory function', group: 'Address', modal: false, text: 'Motion type, cycles, units, compensation…' },
];

export function findCode(code: string): CodeRef | undefined {
  const c = code.toUpperCase();
  const norm = (s: string) => {
    const m = /^([GM])(\d+)$/.exec(s);
    return m ? m[1] + String(parseInt(m[2], 10)).padStart(2, '0') : s;
  };
  const n = norm(c);
  return GCODES.find((g) => g.code === n) ?? MCODES.find((g) => g.code === n) ?? ADDRESSES.find((a) => a.code === c);
}

/** Custom Macro B and direct corner words */
export const MACROS: CodeRef[] = [
  {
    code: '#n', title: 'Macro variable', group: 'Custom Macro B', modal: false,
    syntax: '#1 = 12.5\nG01 X#1 Z[-#2 - 5]',
    text: 'Variables hold numbers. #1–#33 are local, #100–#199 and #500–#999 are common. #0 is always "vacant" (empty). A word whose variable is vacant is ignored. Any address can take a variable or a [bracket] expression.',
    params: [['#3000 = n (MSG)', 'Stop the program with an alarm and the comment as message'], ['#3006 = 1 (MSG)', 'Program stop with a message (continue with CYCLE START)']],
  },
  {
    code: '[ ]', title: 'Macro expression', group: 'Custom Macro B', modal: false,
    syntax: '#3 = [#1 + #2] * 2\n#4 = SQRT[#1 * #1 + #2 * #2]\n#5 = ATAN[#1]/[#2]',
    text: 'Brackets group operations (Fanuc uses [ ] – parentheses are comments). Operators + − * / MOD; functions SIN COS TAN ASIN ACOS ATAN SQRT ABS ROUND FIX (round down) FUP (round up) LN EXP. Angles are in degrees.',
  },
  {
    code: 'IF', title: 'Conditional jump / assignment', group: 'Custom Macro B', modal: false,
    syntax: 'IF [#1 GT 10] GOTO 100\nIF [#1 EQ #0] THEN #1 = 5',
    text: 'Compares with EQ (=) NE (≠) GT (>) GE (≥) LT (<) LE (≤), combined with AND / OR. GOTO jumps to the block with that N-number; THEN performs one assignment.',
  },
  {
    code: 'GOTO', title: 'Unconditional jump', group: 'Custom Macro B', modal: false,
    syntax: 'GOTO 200',
    text: 'Continues the program at block N200 (searching forward first, then from the top).',
  },
  {
    code: 'WHILE', title: 'Loop', group: 'Custom Macro B', modal: false,
    syntax: '#5 = 1\nWHILE [#5 LE 3] DO 1\n  …\n  #5 = #5 + 1\nEND 1',
    text: 'Repeats the blocks between DO n and END n while the condition is true. Change the loop variable inside the loop – otherwise it runs forever (the simulator stops endless loops).',
  },
  {
    code: ',C', title: 'Direct chamfer', group: 'Direct drawing input', modal: false,
    syntax: 'G01 Z-15. ,C1.\nX30.',
    text: 'Cuts off the corner at the end of a G01 move with a chamfer whose legs are C mm long. Works between any two straight moves (also on tapers). The very next block must be a G01 move.',
  },
  {
    code: ',R', title: 'Direct corner radius', group: 'Direct drawing input', modal: false,
    syntax: 'G01 Z-15. ,R2.\nX30.',
    text: 'Inserts a tangent arc of radius R between this G01 move and the next one. Program the sharp drawing corner – the control calculates the arc.',
  },
];
