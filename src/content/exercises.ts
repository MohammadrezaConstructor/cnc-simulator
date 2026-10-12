import type { StockDef } from '../types';
import type { Target } from './examples';

export interface Exercise {
  id: string;
  title: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  brief: string;
  stock: StockDef;
  target: Target;
  hints: string[];
  starter: string;
  solution: string;
  /** created by a teacher in this browser / imported from a file */
  custom?: boolean;
  /** plain-text task (custom exercises) */
  briefText?: string;
}

const stock = (diameter: number, length: number, extra: Partial<StockDef> = {}): StockDef => ({
  diameter,
  length,
  bore: 0,
  faceAllowance: 1,
  gripLength: 30,
  material: 'steel',
  ...extra,
});

const starter = (o: string, title: string) => `%
O${o} (${title})
G21 G40 G99 G18
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X54. Z2. M08
(... YOUR PROGRAM ...)

G28 U0 W0 M09
M05
M30
%
`;

export const EXERCISES: Exercise[] = [
  {
    id: 'e1',
    title: 'E1 · Stepped pin',
    level: 'Beginner',
    brief: `<p>Machine the stepped pin from a Ø50 bar. Face the front to <b>Z0</b> (1 mm stock on the face).</p>
<ul><li>Ø30 from Z0 to Z-15, chamfer 1×45° at the front</li><li>Ø40 from Z-15 to Z-35</li><li>Ø48 from Z-35 to Z-50</li></ul>
<p>Tolerance ±0.05 on all diameters. The chamfer is not inspected.</p>`,
    stock: stock(50, 100),
    target: {
      outer: 'G00 X28 Z0\nG01 X30 Z-1\nZ-15\nX40\nZ-35\nX48\nZ-50\nX50',
      tol: 0.05,
      ignore: [[-1.3, 0.3]],
    },
    hints: [
      'Face with G01 to X-1.6 first.',
      'G90 is the quickest way: G90 X48. Z-50. F0.25, then X44. Z-35. / X40. …',
      'Max. depth of cut for T01: about 2–3 mm per side.',
    ],
    starter: starter('2001', 'STEPPED PIN'),
    solution: `%
O2001 (E1 SOLUTION - STEPPED PIN)
G21 G40 G99 G18
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X54. Z2. M08
G01 Z0 F0.2
X-1.6 F0.15
G00 Z2.
X52.
G90 X48. Z-50. F0.25
X44. Z-35.
X40.
X36. Z-15.
X33.
X30.
G00 X26. Z1.
G01 X30. Z-1. F0.1
G00 X54.
G28 U0 W0 M09
M05
M30
%
`,
  },
  {
    id: 'e2',
    title: 'E2 · Taper and fillet with G71 / G70',
    level: 'Intermediate',
    brief: `<p>Rough with <b>T01</b> using G71 and finish with <b>T02</b> using G70 and tool nose radius compensation.</p>
<ul><li>Front chamfer: Ø16 at Z0 → Ø20 at Z-2</li><li>Ø20 to Z-12</li><li>Taper to Ø28 at Z-22</li><li>Ø28 to Z-30, concave fillet R3 up to Ø34 at Z-33</li><li>Ø38 from Z-33 to Z-45</li></ul>
<p>Tolerance ±0.05 everywhere – including the taper and the fillet. Surface finish <b>Ra ≤ 1.6 µm</b> on all diameters (theoretical Ra ≈ f² / (32·r), so choose the finishing feed carefully).</p>`,
    stock: stock(40, 100),
    target: {
      outer: 'G00 X16 Z0\nG01 X20 Z-2\nZ-12\nX28 Z-22\nZ-30\nG02 X34 Z-33 R3\nG01 X38\nZ-45\nX40',
      tol: 0.05,
      ra: 1.6,
    },
    hints: [
      'Start point A for G71 must be outside the bar: e.g. X42. Z2.',
      'The fillet goes from Ø28 Z-30 to Ø34 Z-33: is it G02 or G03?',
      'Without G42 the taper will fail the tolerance.',
      'Ra 1.6 with a 0.4 mm nose radius: f ≤ √(1.6 × 32 × 0.4 / 1000) ≈ 0.14 mm/rev.',
    ],
    starter: starter('2002', 'TAPER AND FILLET'),
    solution: `%
O2002 (E2 SOLUTION)
G21 G40 G99 G18
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X44. Z2. M08
G01 Z0 F0.2
X-1.6 F0.15
G00 Z2.
X42.
G71 U2. R0.5
G71 P10 Q20 U0.4 W0.1 F0.25
N10 G00 X16.
G01 Z0 F0.1
X20. Z-2.
Z-12.
X28. Z-22.
Z-30.
G02 X34. Z-33. R3.
G01 X38.
Z-45.
N20 X42.
G00 X100. Z100.
T0202
G96 S250 M03
G00 G42 X42. Z2.
G70 P10 Q20
G00 G40 X100. Z100. M09
M05
M30
%
`,
  },
  {
    id: 'e3',
    title: 'E3 · Grooves and part-off',
    level: 'Beginner',
    brief: `<p>From a Ø30 bar make a 40 mm long part with three grooves and part it off.</p>
<ul><li>Face to Z0</li><li>3 grooves, 3 mm wide, Ø24, from Z-7 to Z-10, Z-17 to Z-20 and Z-27 to Z-30</li><li>Part off at Z-40 (part length 40 mm)</li></ul>
<p>The grooving tool T03 and the parting tool T07 (3 mm) are referenced on their <b>left</b> corner.</p>`,
    stock: stock(30, 100),
    target: {
      outer: 'G00 X30 Z0\nG01 Z-7\nX24\nZ-10\nX30\nZ-17\nX24\nZ-20\nX30\nZ-27\nX24\nZ-30\nX30\nZ-40',
      tol: 0.05,
    },
    hints: [
      'Left-corner reference: a groove from Z-10 to Z-7 is cut with the tool at Z-10.',
      'Use G97 S… for grooving and parting.',
      'Part-off: G75 X-0.5 Z-43. P3000 F0.05 with the tool at Z-43.',
    ],
    starter: starter('2003', 'GROOVES AND PART-OFF'),
    solution: `%
O2003 (E3 SOLUTION)
G21 G40 G99 G18
G28 U0 W0
T0101
G50 S3000
G96 S200 M03
G00 X34. Z0 M08
G01 X-1.6 F0.15
G00 Z2.
G00 X100. Z100.
T0303
G97 S900 M03
G00 X34. Z-10.
G01 X24. F0.06
G04 X0.3
G00 X34.
Z-20.
G01 X24.
G04 X0.3
G00 X34.
Z-30.
G01 X24.
G04 X0.3
G00 X34.
G00 X100. Z100.
T0707
G97 S800 M03
G00 X34. Z-43.
G75 R0.5
G75 X-0.5 Z-43. P3000 F0.05
G00 X100. Z100. M09
M05
M30
%
`,
  },
  {
    id: 'e4',
    title: 'E4 · Bushing: drill and bore',
    level: 'Intermediate',
    brief: `<p>Ø40 bar, 80 mm long. Machine the inside:</p>
<ul><li>Face to Z0, turn the outside to Ø38 down to Z-40</li><li>Bore Ø22 to a depth of 25 mm (flat bottom)</li><li>Below that a Ø16 drilled hole to Z-35 (drill point not inspected)</li></ul>
<p>Use the centre drill T10, the Ø16 drill T05 and the boring bar T06.</p>`,
    stock: stock(40, 80, { gripLength: 25 }),
    target: {
      outer: 'G00 X38 Z0\nG01 Z-40\nX40',
      inner: 'G00 X22 Z0\nG01 Z-25\nX16\nZ-30',
      tol: 0.05,
    },
    hints: ['Drill with G97 and G74 pecking at X0.', 'The boring bar needs a start position inside the Ø16 hole, e.g. X15. Z2.', 'Inside finishing: G41.'],
    starter: starter('2004', 'BUSHING'),
    solution: `%
O2004 (E4 SOLUTION)
G21 G40 G99 G18
G28 U0 W0
T0101
G50 S2500
G96 S200 M03
G00 X44. Z0 M08
G01 X-1.6 F0.15
G00 Z2.
X42.
G90 X38. Z-40. F0.25
G00 X100. Z100.
T1010
G97 S1500 M03
G00 X0 Z3.
G01 Z-4. F0.08
G00 Z5.
G00 X100. Z100.
T0505
G97 S600 M03
G00 X0 Z3.
G74 R1.
G74 Z-35. Q6000 F0.15
G00 X100. Z100.
T0606
G96 S180 M03
G00 X15. Z2.
G90 X18. Z-24.9 F0.2
X20.
X21.6
G00 X20. Z2.
G41 G01 X22. Z1. F0.1
Z-25.
X16.
G40 G00 Z5.
G00 X100. Z100. M09
M05
M30
%
`,
  },
  {
    id: 'e5',
    title: 'E5 · Threaded spigot M20×1.5',
    level: 'Advanced',
    brief: `<p>Ø25 bar. Make a threaded spigot:</p>
<ul><li>Chamfer Ø17 at Z0 → Ø19.8 at Z-1.4</li><li>Thread M20×1.5 (major Ø19.8) to Z-20</li><li>Relief groove Ø17, Z-20 to Z-23</li><li>Ø24 from Z-23 to Z-35</li></ul>
<p>Thread data: height h = 0.6134 × 1.5 = 0.92 mm, minor Ø 18.16. The thread itself is not inspected; everything else ±0.05.</p>`,
    stock: stock(25, 90),
    target: {
      outer: 'G00 X17 Z0\nG01 X19.8 Z-1.4\nZ-20\nX17\nZ-23\nX24\nZ-35\nX25',
      tol: 0.05,
      ignore: [[-20, 0.5]],
    },
    hints: ['Groove: T03 at Z-23 cuts Z-23…Z-20.', 'Thread with T04: G76 P010060 Q50 R0.03 / G76 X18.16 Z-21.5 P920 Q300 F1.5', 'Start the thread 3 leads in front: Z5.'],
    starter: starter('2005', 'THREADED SPIGOT'),
    solution: `%
O2005 (E5 SOLUTION)
G21 G40 G99 G18
G28 U0 W0
T0101
G50 S3000
G96 S200 M03
G00 X29. Z0 M08
G01 X-1.6 F0.15
G00 Z2.
X27.
G71 U1.5 R0.5
G71 P10 Q20 U0.4 W0.1 F0.25
N10 G00 X17.
G01 Z0 F0.1
X19.8 Z-1.4
Z-23.
X24.
Z-35.
N20 X27.
G00 X100. Z100.
T0202
G96 S250 M03
G00 G42 X27. Z2.
G70 P10 Q20
G00 G40 X100. Z100.
T0303
G97 S900 M03
G00 X27. Z-23.
G01 X17. F0.06
G04 X0.3
G00 X27.
G00 X100. Z100.
T0404
G97 S700 M03
G00 X23. Z5.
G76 P010060 Q50 R0.03
G76 X18.16 Z-21.5 P920 Q300 F1.5
G00 X100. Z100. M09
M05
M30
%
`,
  },
];
