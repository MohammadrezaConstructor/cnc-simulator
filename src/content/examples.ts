import type { StockDef } from '../types';

export interface Target {
  /** outer finished contour written as G-code (G00 start point, then G01/G02/G03), diameter values */
  outer: string;
  /** optional inner (bore) contour */
  inner?: string;
  /** tolerance on diameter (± mm) */
  tol: number;
  /** Z ranges excluded from the check (e.g. threads) */
  ignore?: [number, number][];
  /** maximum surface roughness Ra (µm) required on the turned diameters */
  ra?: number;
}

export interface Example {
  id: string;
  title: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  topics: string[];
  description: string;
  stock: StockDef;
  code: string;
  target?: Target;
}

const steel = (diameter: number, length = 100, extra: Partial<StockDef> = {}): StockDef => ({
  diameter,
  length,
  bore: 0,
  faceAllowance: 1,
  gripLength: 30,
  material: 'steel',
  ...extra,
});

const t = (s: string) => s.replace(/^\n/, '').replace(/\n\s*$/, '\n');

export const EXAMPLES: Example[] = [
  {
    id: 'basic',
    title: '1 · Facing & straight turning (G00 / G01)',
    level: 'Beginner',
    topics: ['G00', 'G01', 'G96', 'G50', 'Program structure'],
    description:
      'The minimum complete lathe program: safe start line, tool call, spindle with constant surface speed, a facing pass and three straight turning passes. Watch how X is a DIAMETER value.',
    stock: steel(50),
    code: t(`
%
O0001 (FACING AND STRAIGHT TURNING)
(STOCK D50 X 100 - Z0 = FINISHED FRONT FACE)
N10 G21 G18 G40 G99       (SAFE LINE: MM, XZ PLANE, NO TNRC, FEED MM/REV)
N20 G28 U0 W0             (RETURN TO MACHINE HOME)
N30 T0101                 (T01 OD ROUGHING TOOL, OFFSET 01)
N40 G50 S2500             (LIMIT SPINDLE SPEED FOR G96)
N50 G96 S200 M03          (CONSTANT SURFACE SPEED 200 M/MIN, SPINDLE CW)
N60 G00 X54. Z2. M08      (RAPID TO A POINT CLEAR OF THE PART, COOLANT ON)
(--- FACE THE FRONT TO Z0 ---)
N70 G00 Z0
N80 G01 X-1.6 F0.15       (FACE PAST CENTRE BY 2 X NOSE RADIUS)
N90 G00 Z2.
N100 X54.
(--- TURN DIAMETER 46 OVER 40 MM ---)
N110 X46.
N120 G01 Z-40. F0.25
N130 X52.
N140 G00 Z2.
(--- TURN DIAMETER 42 OVER 25 MM ---)
N150 X42.
N160 G01 Z-25.
N170 X48.
N180 G00 Z2.
(--- TURN DIAMETER 38 OVER 25 MM ---)
N190 X38.
N200 G01 Z-25.
N210 X44.
N220 G00 Z2.
N230 M09                  (COOLANT OFF)
N240 G28 U0 W0 M05        (HOME, SPINDLE STOP)
N250 M30                  (END OF PROGRAM)
%
`),
  },
  {
    id: 'contour',
    title: '2 · Chamfers, tapers & arcs (G02 / G03, G42)',
    level: 'Beginner',
    topics: ['G02', 'G03', 'R-arcs', 'Chamfer', 'Taper', 'G42'],
    description:
      'A small contour finished with a 35° VNMG tool: front chamfer, convex and concave radii, a taper and a shoulder. G42 keeps the nose radius tangent to the contour.',
    stock: steel(40),
    code: t(`
%
O0002 (CONTOUR WITH ARCS)
G21 G40 G99
G28 U0 W0
(--- ROUGH WITH G90 BOX CYCLES ---)
T0101
G50 S3000
G96 S220 M03
G00 X42. Z2. M08
G01 Z0 F0.2
X-1.6 F0.15
G00 Z2.
X42.
G90 X37. Z-34.8 F0.25
X36.4
X33.4 Z-24.8
X30.4 Z-19.8
X27. Z-11.8
X24.
X22.4
X20. Z-9.8
X18.4
G00 X100. Z100.
(--- FINISH THE CONTOUR ---)
T0202
G96 S250 M03
G00 X14. Z2.
G42 G01 Z0 F0.1           (START NOSE RADIUS COMPENSATION)
X18. Z-2.                 (CHAMFER 2 X 45 DEG)
Z-10.
G02 X22. Z-12. R2.        (CONCAVE FILLET R2)
G01 X26.
G03 X30. Z-14. R2.        (CONVEX RADIUS R2)
G01 X30. Z-20.
X36. Z-30.                (TAPER)
Z-35.
X40.
G40 G00 X42.              (CANCEL COMPENSATION ON A LINEAR MOVE)
G00 X100. Z100. M09
M05
M30
%
`),
    target: {
      outer: `G00 X14 Z0
G01 X18 Z-2
Z-10
G02 X22 Z-12 R2
G01 X26
G03 X30 Z-14 R2
G01 Z-20
X36 Z-30
Z-35
X40`,
      tol: 0.05,
    },
  },
  {
    id: 'g90g94',
    title: '3 · Box cycles G90 (turning) & G94 (facing)',
    level: 'Beginner',
    topics: ['G90', 'G94', 'Modal cycles', 'Taper R'],
    description:
      'Single-pass canned cycles: one block = rapid in, cut, pull out, rapid back. Only X (or Z) is repeated on the following lines. The last G90 uses R for a taper.',
    stock: steel(60),
    code: t(`
%
O0003 (G94 FACING AND G90 TURNING)
G21 G40 G99
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X64. Z5. M08          (CYCLE START POINT)
(--- G94 FACING IN 3 PASSES: FACE DOWN TO Z-2 ---)
G94 X-1.6 Z0.  F0.2
Z-1.
Z-2.
(--- G90 TURNING TO D50 x 30 ---)
G00 X62. Z0
G90 X56. Z-30. F0.25
X52.
X50.
(--- G90 TAPER: R = RADIUS DIFFERENCE AT THE START OF THE CUT ---)
G90 X50. Z-15. R-2.
R-4.
R-5.
G00 X100. Z100.
M30
%
`),
  },
  {
    id: 'g71',
    title: '4 · Rough & finish a profile: G71 + G70',
    level: 'Intermediate',
    topics: ['G71', 'G70', 'Finishing allowance', 'G42', 'Tool change'],
    description:
      'The workhorse of CNC turning. G71 removes the bulk in horizontal layers (U = depth per side) leaving U/W finishing allowance, then the finishing tool runs the very same profile (blocks N100–N200) with G70.',
    stock: steel(50),
    code: t(`
%
O0004 (G71 ROUGHING + G70 FINISHING)
N1 G21 G40 G99
N2 G28 U0 W0
(=== T01 ROUGHING ===)
N3 T0101
N4 G50 S2500
N5 G96 S200 M03
N6 G00 X54. Z2. M08
N7 G01 Z0 F0.2
N8 X-1.6 F0.15            (FACE)
N9 G00 Z2.
N10 X52.                  (CYCLE START POINT)
N11 G71 U2. R0.5          (2 MM DEPTH PER SIDE, 0.5 MM RETRACT)
N12 G71 P100 Q200 U0.4 W0.1 F0.25
N100 G00 X16.
N110 G01 Z0 F0.1
N120 G03 X20. Z-2. R2.
N130 G01 Z-15.
N140 G02 X30. Z-20. R5.
N150 G01 X36.
N160 X40. Z-30.
N170 Z-42.
N180 G02 X48. Z-46. R4.
N190 G01 Z-55.
N200 X52.
N13 G00 X100. Z100.
(=== T02 FINISHING ===)
N14 T0202
N15 G96 S250 M03
N16 G00 G42 X52. Z2.
N17 G70 P100 Q200
N18 G00 G40 X100. Z100. M09
N19 M05
N20 M30
%
`),
    target: {
      outer: `G00 X16 Z0
G03 X20 Z-2 R2
G01 Z-15
G02 X30 Z-20 R5
G01 X36
X40 Z-30
Z-42
G02 X48 Z-46 R4
G01 Z-55
X50`,
      tol: 0.05,
    },
  },
  {
    id: 'g72',
    title: '5 · Face roughing G72 (flange)',
    level: 'Intermediate',
    topics: ['G72', 'G70', 'Face profile'],
    description:
      'G72 cuts in vertical layers (W = depth per pass) — efficient for short, large-diameter parts. The profile is described from the outside diameter towards the centre, so the finishing pass uses G41.',
    stock: steel(80, 60, { gripLength: 25 }),
    code: t(`
%
O0005 (G72 FACE ROUGHING)
G21 G40 G99
G28 U0 W0
T0101
G50 S2000
G96 S180 M03
G00 X84. Z2. M08
G72 W1.5 R0.5
G72 P30 Q40 U0.4 W0.2 F0.25
N30 G00 Z-14.
G01 X68. F0.1
X56. Z-8.
Z-4.
X48. Z0
N40 X-1.6
G00 G41 X84. Z3.          (FACE PROFILE RUNS TOWARDS THE CENTRE: TOOL IS ON THE LEFT = G41)
G70 P30 Q40
G00 G40 X100. Z100. M09
M30
%
`),
    target: {
      outer: `G00 X0 Z0
G01 X48
X56 Z-4
Z-8
X68 Z-14
X80`,
      tol: 0.05,
    },
  },
  {
    id: 'g73',
    title: '6 · Pattern repeat G73 (profile with a neck)',
    level: 'Intermediate',
    topics: ['G73', 'Non-monotonic profile', 'Insert shape'],
    description:
      'G73 repeats the whole contour offset by a shrinking relief — it can follow necks and undercuts that G71 type I cannot. Note the 35° insert (an 80° insert would gouge the neck with its back edge) and the generous finishing allowance: roughing passes follow the imaginary tip, so on back-facing slopes the nose radius digs in.',
    stock: steel(32),
    code: t(`
%
O0006 (G73 PATTERN REPEATING)
G21 G40 G99
G28 U0 W0
T0202
G50 S3000
G96 S220 M03
G00 X34. Z2. M08
G01 Z0 F0.2
X-1.6 F0.12
G00 Z2.
X40.
G73 U6. W0 R4             (RELIEF 6 MM PER SIDE, 4 PASSES)
G73 P50 Q60 U1.6 W0.1 F0.2  (BIG ALLOWANCE: ROUGH PASSES ARE NOT COMPENSATED)
N50 G00 X20.
G01 Z0 F0.1
G03 X30. Z-5. R5.
G01 Z-12.
G02 X30. Z-32. R14.
G01 Z-40.
N60 X34.
G00 G42 X40. Z2.
G70 P50 Q60
G40 G00 X100. Z100.
M30
%
`),
    target: {
      outer: `G00 X20 Z0
G03 X30 Z-5 R5
G01 Z-12
G02 X30 Z-32 R14
G01 Z-40
X32`,
      tol: 0.05,
    },
  },
  {
    id: 'groove',
    title: '7 · Grooving: G01 + dwell and G75 wide groove',
    level: 'Beginner',
    topics: ['Grooving', 'G04', 'G75', 'Tool reference point'],
    description:
      'The 3 mm grooving tool is referenced on its LEFT corner. A narrow groove is plunged with G01 and a dwell (G04) to clean the bottom; a wide groove is cut with the G75 peck cycle (P = peck depth, Q = Z step, in µm).',
    stock: steel(40),
    code: t(`
%
O0007 (GROOVING)
G21 G40 G99
G28 U0 W0
T0303                     (3 MM GROOVING TOOL, LEFT CORNER REFERENCE)
G97 S900 M03              (CONSTANT RPM FOR GROOVING)
G00 X44. Z-10. M08
(--- NARROW GROOVE 3 WIDE, D32 ---)
G01 X32. F0.06
G04 X0.4                  (DWELL 0.4 S AT THE BOTTOM)
G00 X44.
(--- WIDE GROOVE Z-35 .. Z-20, D30 WITH G75 ---)
G00 Z-35.
G75 R0.5
G75 X30. Z-23. P2000 Q2500 F0.06
G00 X100.
G28 U0 W0 M09
M30
%
`),
  },
  {
    id: 'drill',
    title: '8 · Centre drill, peck drill G74 & boring',
    level: 'Intermediate',
    topics: ['Drilling', 'G74', 'Boring', 'G41', 'G97'],
    description:
      'Holes are machined on the spindle centre line (X0) with G97 constant rpm. G74 pecks (Q = peck depth in µm) to break chips. The boring bar then opens the hole with G90 and finishes with G41 (inside tool).',
    stock: steel(50, 80, { gripLength: 25 }),
    code: t(`
%
O0008 (DRILL AND BORE)
G21 G40 G99
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X54. Z0 M08
G01 X-1.6 F0.15
G00 Z5.
G00 X100. Z100.
(--- CENTRE DRILL ---)
T1010
G97 S1500 M03
G00 X0 Z3.
G01 Z-4. F0.08
G00 Z5.
G00 X100. Z100.
(--- DRILL D16 WITH PECKING ---)
T0505
G97 S600 M03
G00 X0 Z3.
G74 R1.
G74 Z-38. Q6000 F0.15
G00 X100. Z100.
(--- BORE TO D24 x 25 DEEP ---)
T0606
G96 S180 M03
G00 X15. Z2.
G90 X18. Z-24.9 F0.2
X21.
X23.6
(--- FINISH BORE WITH CHAMFER ---)
G00 X30. Z2.
G41 G01 Z0 F0.1
X24. Z-3.
Z-25.
X16.
G40 G00 Z5.
G00 X100. Z100. M09
M30
%
`),
    target: {
      outer: `G00 X50 Z0
G01 Z-50`,
      inner: `G00 X30 Z0
G01 X24 Z-3
Z-25
X16
Z-33`,
      tol: 0.05,
    },
  },
  {
    id: 'g76',
    title: '9 · Thread M24×2 with G76',
    level: 'Advanced',
    topics: ['G76', 'Threading', 'Relief groove', 'G97'],
    description:
      'Complete thread job: turn the major diameter, cut a relief groove, then G76 cuts the thread in many passes with decreasing depth (constant chip area) and flank in-feed. Thread height = 0.6134 × pitch.',
    stock: steel(30, 90),
    code: t(`
%
O0009 (M24 X 2 THREAD)
G21 G40 G99
G28 U0 W0
(--- TURN THE THREAD MAJOR DIAMETER ---)
T0101
G50 S3000
G96 S200 M03
G00 X32. Z2. M08
G71 U1.5 R0.5
G71 P10 Q20 U0.3 W0.05 F0.25
N10 G00 X18.
G01 Z0 F0.1
X23.8 Z-2.9
Z-31.
X28.
Z-40.
N20 X32.
G70 P10 Q20
G00 X100. Z100.
(--- RELIEF GROOVE ---)
T0303
G97 S800 M03
G00 X32. Z-31.
G01 X20. F0.06
G04 X0.3
G00 X32.
G00 X100. Z100.
(--- THREAD WITH G76 ---)
T0404
G97 S600 M03              (THREADING ALWAYS WITH CONSTANT RPM)
G00 X26. Z6.              (START 3 X PITCH IN FRONT OF THE PART)
G76 P020060 Q50 R0.05     (2 FINISH PASSES, NO CHAMFER, 60 DEG; MIN CUT 0.05; FINISH 0.05)
G76 X21.546 Z-29. P1227 Q350 F2.
G00 X100. Z100. M09
M30
%
`),
  },
  {
    id: 'g92',
    title: '10 · Thread M20×1.5 with G92 (pass by pass)',
    level: 'Intermediate',
    topics: ['G92', 'Threading', 'Infeed table'],
    description:
      'G92 is the simple threading cycle: every line is one pass, you program the diameter of each pass yourself. Minor diameter = 20 − 2 × 0.92 = 18.16.',
    stock: steel(20, 70),
    code: t(`
%
O0010 (G92 THREAD M20 X 1.5)
G21 G40 G99
G28 U0 W0
T0101
G50 S3000
G96 S180 M03
G00 X24. Z0 M08
G01 X-1.6 F0.12
G00 Z2.
X17.
G01 Z0 F0.1
X19.8 Z-1.4
Z-25.
X22.
G00 X100. Z100.
T0404
G97 S700 M03
G00 X23. Z5.
G92 X19.3 Z-21. F1.5
X18.9
X18.6
X18.4
X18.25
X18.16
X18.16                    (SPRING PASS)
G00 X100. Z100. M09
M30
%
`),
  },
  {
    id: 'tnrc',
    title: '11 · Why G41/G42? Nose-radius error demo',
    level: 'Intermediate',
    topics: ['G42', 'Nose radius', 'Form error'],
    description:
      'The same 45° chamfer and R5 radius are cut twice with an R1.2 nose radius: first WITHOUT compensation (left feature) and then WITH G42 (right feature). Open "Check part" — the uncompensated feature leaves material.',
    stock: steel(40),
    code: t(`
%
O0011 (TNRC DEMONSTRATION - SET T01 NOSE R TO 1.2 TO EXAGGERATE)
G21 G40 G99
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X42. Z2. M08
G01 Z0 F0.2
X-1.6 F0.15
G00 Z2.
X42.
G90 X36. Z-60. F0.25
X31. Z-35.
X26.
(--- FEATURE A AT Z-35: NO COMPENSATION ---)
G00 X26. Z-30.
G01 Z-35. F0.1
X36. Z-40.                (45 DEG CHAMFER: MATERIAL IS LEFT BEHIND)
G00 X42.
(--- FEATURE B AT THE FRONT: WITH G42 ---)
G00 X42. Z2.              (FIRST BACK OUT IN Z - A DIAGONAL G00 WOULD CRASH!)
X16.
G42 G01 Z0 F0.1
X26. Z-5.                 (SAME 45 DEG CHAMFER, NOW CORRECT)
G40 G00 X42.
G00 X100. Z100. M09
M30
%
`),
    target: {
      outer: `G00 X16 Z0
G01 X26 Z-5
Z-35
X36 Z-40
Z-60
X40`,
      tol: 0.05,
    },
  },
  {
    id: 'subprog',
    title: '12 · Sub-programs M98 / M99 (repeated grooves)',
    level: 'Intermediate',
    topics: ['M98', 'M99', 'Incremental W'],
    description:
      'O0020 cuts one groove and moves −8 mm with incremental W. The main program calls it 4 times (M98 P40020 = 4 repetitions of O0020).',
    stock: steel(40),
    code: t(`
%
O0012 (MAIN PROGRAM)
G21 G40 G99
G28 U0 W0
T0303
G97 S800 M03
G00 X44. Z-2. M08
M98 P40020                (CALL O0020 FOUR TIMES)
G00 X100.
G28 U0 W0 M09
M30
%
O0020 (SUB: ONE GROOVE, THEN STEP -8 MM)
G00 W-8.
G01 X32. F0.06
G04 X0.3
G00 X44.
M99
%
`),
  },
  {
    id: 'complete',
    title: '13 · Complete part: shaft with thread, groove & part-off',
    level: 'Advanced',
    topics: ['Full job', 'G71', 'G70', 'G75', 'G76', 'Part-off', 'M01'],
    description:
      'A realistic production program with five tools, optional stops (M01) between operations and a part-off at the end. Turn Block Skip on and off to see "/" blocks.',
    stock: steel(40, 110, { faceAllowance: 1.5 }),
    code: t(`
%
O0013 (SHAFT - COMPLETE JOB)
(MATERIAL: C45 D40, PART LENGTH 60)
N1 G21 G40 G99 G18
N2 G28 U0 W0
(=== OP10: FACE + ROUGH, T01 ===)
N10 T0101
N11 G50 S2500
N12 G96 S200 M03
N13 G00 X44. Z0 M08
N14 G01 X-1.6 F0.15
N15 G00 Z2.
N16 X42.
N17 G71 U2. R0.5
N18 G71 P100 Q200 U0.4 W0.1 F0.25
N100 G00 X14.
N110 G01 Z0 F0.1
N120 X19.8 Z-2.
N130 Z-20.
N140 X24.
N150 X28. Z-22.
N160 Z-38.
N170 G02 X32. Z-40. R2.
N180 G01 X34.
N190 X36. Z-41.
N195 Z-64.
N200 X42.
N19 G00 X100. Z100.
N20 M01
(=== OP20: FINISH, T02 ===)
N30 T0202
N31 G96 S250 M03
N32 G00 G42 X42. Z2.
N33 G70 P100 Q200
N34 G00 G40 X100. Z100.
N35 M01
(=== OP30: RELIEF GROOVE, T03 ===)
N40 T0303
N41 G97 S800 M03
N42 G00 X26. Z-20.
N43 G75 R0.3
N44 G75 X16. Z-18. P1500 Q2000 F0.06
N45 G00 X100. Z100.
N46 M01
(=== OP40: THREAD M20 X 1.5, T04 ===)
N50 T0404
N51 G97 S700 M03
N52 G00 X24. Z5.
N53 G76 P010060 Q50 R0.03
N54 G76 X18.16 Z-18.5 P920 Q300 F1.5
/N55 G76 X18.16 Z-18.5 P920 Q920 F1.5 (OPTIONAL CHASER PASS)
N56 G00 X100. Z100.
N57 M01
(=== OP50: PART OFF, T07 ===)
N60 T0707
N61 G97 S700 M03
N62 G00 X42. Z-62.
N63 G01 X36. F0.08
N64 X34. Z-63.            (RIGHT CORNER CHAMFERS THE BACK EDGE)
N65 G00 X42.
N66 Z-63.
N67 G75 R0.5
N68 G75 X-0.5 Z-63. P3000 F0.05
N69 G00 X100. Z100. M09
N70 M05
N71 M30
%
`),
    target: {
      outer: `G00 X14 Z0
G01 X19.8 Z-2
Z-15
X16
Z-20
X24
X28 Z-22
Z-38
G02 X32 Z-40 R2
G01 X34
X36 Z-41
Z-59`,
      tol: 0.05,
      ignore: [[-15, -2]],
    },
  },
  {
    id: 'macro',
    title: '14 · Parametric part with Custom Macro B',
    level: 'Advanced',
    topics: ['Macro B', '#variables', 'WHILE', 'IF', 'Ellipse'],
    description:
      'An elliptical nose and a series of grooves, all driven by variables. A WHILE loop computes the end of every G90 roughing pass from the ellipse equation, a second loop finishes the ellipse as a parametric curve (with G42!) and a third one cuts the grooves. Change #1–#4 and run again.',
    stock: steel(32),
    code: t(`
%
O0014 (PARAMETRIC ELLIPSE NOSE + GROOVES)
#1 = 12.                  (ELLIPSE HALF-LENGTH IN Z)
#2 = 12.                  (ELLIPSE HALF-HEIGHT = MAX RADIUS)
#3 = 3                    (NUMBER OF GROOVES)
#4 = 6.                   (GROOVE PITCH)
G21 G40 G99
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X34. Z0 M08
G01 X-1.6 F0.15
G00 Z2.
X34.
G90 X30. Z-50. F0.25      (TURN THE BODY TO D30)
(--- ROUGH THE NOSE: END OF EACH PASS FROM THE ELLIPSE ---)
#10 = 14.                 (LEVEL RADIUS OF THE FIRST PASS)
WHILE [#10 GT 1.] DO 1
#11 = #10 - 0.4           (STAY 0.4 OUTSIDE THE ELLIPSE)
#12 = -#1                 (DEFAULT: CUT TO THE SHOULDER)
IF [#11 LT #2] THEN #12 = -#1 + #1 * SQRT[1 - [#11 / #2] * [#11 / #2]]
G90 X[2 * #10] Z#12
#10 = #10 - 1.5
END 1
G00 X100. Z100.
(--- FINISH THE ELLIPSE AS A PARAMETRIC CURVE ---)
T0202
G96 S250 M03
G00 X0 Z3.
G42 G01 Z0 F0.1
#20 = 0                   (PARAMETER ANGLE)
WHILE [#20 LT 90] DO 2
#20 = #20 + 3
G01 X[2 * #2 * SIN[#20]] Z[-#1 + #1 * COS[#20]]
END 2
G01 X30.                  (SHOULDER)
G40 G00 X40.
G00 X100. Z100.
(--- GROOVE SERIES ---)
T0303
G97 S800 M03
#5 = 1
WHILE [#5 LE #3] DO 3
G00 X32. Z[-20. - [#5 - 1] * #4]
G01 X24. F0.06
G04 X0.3
G00 X32.
#5 = #5 + 1
END 3
G00 X100. Z100. M09
M30
%
`),
    target: {
      outer: `#1 = 12.
#2 = 12.
G00 X0 Z0
#20 = 0
WHILE [#20 LT 90] DO 1
#20 = #20 + 1
G01 X[2 * #2 * SIN[#20]] Z[-#1 + #1 * COS[#20]]
END 1
G01 X30.
Z-50.
X32.`,
      tol: 0.05,
      ignore: [[-32.3, -16.7]],
    },
  },
  {
    id: 'corners',
    title: '15 · Direct chamfers and corner radii (,C ,R)',
    level: 'Intermediate',
    topics: [',C', ',R', 'G71', 'Drawing dimensions'],
    description:
      'Program the sharp corners straight from the drawing and let the control insert the chamfers and radii: ",C1." adds a chamfer with 1 mm legs, ",R2." a tangent radius – on any angle, including the taper.',
    stock: steel(40),
    code: t(`
%
O0015 (DIRECT CHAMFER AND CORNER RADIUS)
G21 G40 G99
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X44. Z0 M08
G01 X-1.6 F0.15
G00 Z2.
X42.
G71 U2. R0.5
G71 P100 Q200 U0.4 W0.1 F0.25
N100 G00 X14.
G01 Z0 F0.1
X20. ,C1.                 (CHAMFER THE FRONT EDGE)
Z-15. ,R2.                (FILLET IN THE CORNER)
X30. ,C1.                 (CHAMFER THE SHOULDER)
Z-30.
X36. Z-40. ,R3.           (RADIUS BETWEEN TAPER AND DIAMETER)
Z-50.
N200 X42.
G00 X100. Z100.
T0202
G96 S250 M03
G00 G42 X42. Z2.
G70 P100 Q200
G00 G40 X100. Z100. M09
M30
%
`),
    target: {
      outer: `G00 X14 Z0
G01 X20 ,C1
Z-15 ,R2
X30 ,C1
Z-30
X36 Z-40 ,R3
Z-50
X40`,
      tol: 0.05,
    },
  },
  {
    id: 'typeII',
    title: '16 · Pocket roughing with G71 type II',
    level: 'Advanced',
    topics: ['G71 type II', 'Pocket', 'Insert clearance'],
    description:
      'The profile dips into a pocket. Writing "W0" in the first profile block switches G71 to type II, which roughs the pocket as well. The 35° insert is needed: an 80° insert’s trailing edge would gouge the back-facing slope.',
    stock: steel(36),
    code: t(`
%
O0016 (G71 TYPE II - POCKET)
G21 G40 G99
G28 U0 W0
T0202                     (35 DEG INSERT FOR THE BACK-FACING SLOPE)
G50 S2500
G96 S220 M03
G00 X40. Z0 M08
G01 X-1.6 F0.15
G00 Z2.
X38.
G71 U1.5 R0.5
G71 P100 Q200 U0.8 W0.1 F0.2
N100 G00 X28. W0          (W0 = TYPE II)
G01 Z0 F0.1
X30. Z-1.
Z-10.
X22. Z-18.                (INTO THE POCKET)
Z-26.
X34. Z-34.                (OUT OF THE POCKET)
Z-45.
N200 X38.
G00 G42 X38. Z2.
G70 P100 Q200
G00 G40 X100. Z100. M09
M30
%
`),
    target: {
      outer: `G00 X28 Z0
G01 X30 Z-1
Z-10
X22 Z-18
Z-26
X34 Z-34
Z-45
X36`,
      tol: 0.05,
    },
  },
  {
    id: 'mdi',
    title: '17 · Empty program (write your own)',
    level: 'Beginner',
    topics: ['Template'],
    description: 'A program skeleton with the safe start and end blocks. Fill in your own operations.',
    stock: steel(50),
    code: t(`
%
O1000 (MY PROGRAM)
G21 G40 G99 G18          (SAFE START LINE)
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X54. Z2. M08
(... YOUR MACHINING HERE ...)

G00 X100. Z100. M09
M05
M30
%
`),
  },
];
