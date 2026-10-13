import type { BlockStock } from '../types';
import { defaultMillSpec, generateMill } from '../wizardGen';
import { defaultMillTools } from '../tools';

export interface MillExample {
  id: string;
  title: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  topics: string[];
  description: string;
  stock: BlockStock;
  code: string;
}

const block = (o: Partial<BlockStock> = {}): BlockStock => ({
  sizeX: 100,
  sizeY: 80,
  sizeZ: 30,
  origin: 'corner',
  topAllowance: 1,
  material: 'aluminium',
  aboveJaws: 15,
  ...o,
});

const t = (s: string) => s.replace(/^\n/, '');

const HEAD = `G21 G17 G40 G49 G80 G90 G94      (SAFE START LINE)
G91 G28 Z0                        (SPINDLE UP TO HOME)
G90`;

export const MILL_EXAMPLES: MillExample[] = [
  {
    id: 'm-face-slot',
    title: '1 · First program: face the top, mill a slot',
    level: 'Beginner',
    topics: ['Program structure', 'M06', 'G43', 'G00/G01', 'Face mill'],
    description: 'The minimum complete milling program: safe start, tool change, spindle, G43 tool length compensation, facing with a Ø50 face mill (it starts OUTSIDE the block – it cannot plunge) and a simple slot with a Ø10 end mill.',
    stock: block(),
    code: t(`
%
O1001 (FACE AND SLOT)
(BLOCK 100 X 80 X 30 ALUMINIUM - X0 Y0 = FRONT LEFT CORNER, Z0 = TOP)
${HEAD}
(--- OP10: FACE MILL D50 ---)
T01 M06                           (FACE MILL INTO THE SPINDLE)
S2800 M03                         (SPINDLE ON - M06 STOPPED IT)
G54 G43 H01 G00 X-30. Y20. Z25. M08   (WORK OFFSET, TOOL LENGTH, RAPID ABOVE)
Z2.
G01 Z0 F1200                      (DOWN TO THE FACE HEIGHT - STILL OUTSIDE THE PART)
X130.                             (FIRST PASS)
G00 Y55.
G01 X-30.                         (SECOND PASS, OVERLAPPING)
G00 Z25.
(--- OP20: SLOT WITH A D10 END MILL ---)
T02 M06
S8000 M03
G43 H02 G00 X20. Y40. Z25.
Z2.
G01 Z-3. F300                     (PLUNGE - END MILLS ARE CENTRE CUTTING)
X80. F900                         (SLOT 3 MM DEEP)
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
  {
    id: 'm-contour',
    title: '2 · Contour a boss with cutter compensation (G41)',
    level: 'Beginner',
    topics: ['G41/G42', 'D offset', 'Climb milling', ',R corners', 'Lead-in'],
    description: 'A 60 × 40 boss with R5 corners. A roughing ring (tool centre path) first, then the finished contour programmed with the DRAWING dimensions and G41 D02 – the control offsets the tool by its radius. G41 with M03 = climb milling (watch the CLIMB indicator).',
    stock: block(),
    code: t(`
%
O1002 (BOSS 60 X 40 R5 - 5 DEEP)
${HEAD}
T01 M06
S2800 M03
G54 G43 H01 G00 X-30. Y20. Z25. M08
Z2.
G01 Z0 F1200
X130.
G00 Y55.
G01 X-30.
G00 Z25.
T02 M06
S8000 M03
G43 H02 G00 X95. Y40. Z25.
Z2.
G01 Z-2.5 F400
(ROUGH RING: TOOL CENTRE 5.3 MM OUTSIDE THE BOSS)
G01 X85.3 F1200
Y14.7
X14.7
Y65.3
X85.3
Y40.
G00 Z2.
G00 X95.
G01 Z-5. F400
X85.3 F1200
Y14.7
X14.7
Y65.3
X85.3
Y40.
(FINISH THE CONTOUR WITH COMPENSATION - DRAWING DIMENSIONS)
G00 X95.
G41 D02 G01 X80. F800             (START-UP MOVE ONTO THE CONTOUR)
Y20. ,R5.
X20. ,R5.
Y60. ,R5.
X80. ,R5.
Y40.
G40 G01 X95.                      (CANCEL ON A MOVE AWAY)
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
  {
    id: 'm-pocket',
    title: '3 · Rectangular pocket with a helical entry',
    level: 'Intermediate',
    topics: ['Pocket', 'Helical entry', 'Step-over', 'Step-down', 'Corner radius'],
    description: 'A 40 × 30 × 6 pocket. The end mill enters with a helix (G03 with Z) instead of plunging, then clears the pocket in loops that get bigger by 60 % of the tool diameter – always counter-clockwise inside a pocket = climb milling. The last loop gets ,R corners.',
    stock: block(),
    code: t(`
%
O1003 (POCKET 40 X 30 X 6)
${HEAD}
T02 M06
S8000 M03
G54 G43 H02 G00 X50. Y40. Z25. M08
Z2.
(--- LEVEL 1: Z-3 ---)
G01 X54. Y40. Z0.5 F1000
G03 X54. Y40. I-4. J0 Z-1.5       (HELIX: 2 MM PER TURN)
G03 X54. Y40. I-4. J0 Z-3.
G03 X54. Y40. I-4. J0             (CLEAN THE FLOOR)
G01 X60. Y40.                     (LOOP 1)
Y50.
X40.
Y30.
X60.
Y40.
G01 X65. Y40.                     (FINAL LOOP: 40 - 10 = 30, 30 - 10 = 20)
Y55. ,R1.
X35. ,R1.
Y25. ,R1.
X65. ,R1.
Y40.
G00 Z2.
X50. Y40.
(--- LEVEL 2: Z-6 ---)
G01 X54. Y40. Z-2.5
G03 X54. Y40. I-4. J0 Z-4.25
G03 X54. Y40. I-4. J0 Z-6.
G03 X54. Y40. I-4. J0
G01 X60. Y40.
Y50.
X40.
Y30.
X60.
Y40.
G01 X65. Y40.
Y55. ,R1.
X35. ,R1.
Y25. ,R1.
X65. ,R1.
Y40.
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
  {
    id: 'm-circle',
    title: '4 · Circular pocket & helical interpolation',
    level: 'Intermediate',
    topics: ['G02/G03 full circles', 'I/J', 'Helix', 'Spiral out'],
    description: 'A Ø30 × 8 pocket: helical entry (G03 with Z), then full circles with I/J spiralling outwards. A full circle cannot be written with R – I/J (centre relative to the start point) is required.',
    stock: block(),
    code: t(`
%
O1004 (CIRCULAR POCKET D30 X 8)
${HEAD}
T02 M06
S8000 M03
G54 G43 H02 G00 X50. Y40. Z25. M08
Z2.
G01 X54. Y40. Z0.5 F1000
G03 X54. Y40. I-4. J0 Z-1.5       (HELIX DOWN, 2 MM PER TURN)
G03 X54. Y40. I-4. J0 Z-3.5
G03 X54. Y40. I-4. J0 Z-5.5
G03 X54. Y40. I-4. J0 Z-7.5
G03 X54. Y40. I-4. J0 Z-8.
G03 X54. Y40. I-4. J0             (FLAT FLOOR)
G01 X60. Y40.                     (CIRCLE R10)
G03 X60. Y40. I-10. J0
G01 X60.
G01 X64.8 Y40.                    (CIRCLE R14.8 - LEAVES 0.2 FOR FINISHING)
G03 X64.8 Y40. I-14.8 J0
G01 X65. Y40. F600                (FINISH: R15 - TOOL R5 = R10 FROM CENTRE)
G03 X65. Y40. I-15. J0
G01 X60. Y40.
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
  {
    id: 'm-holes',
    title: '5 · Hole making: spot, peck drill, tap (G82, G83, G84)',
    level: 'Intermediate',
    topics: ['G81–G84', 'R-plane', 'G98/G99', 'Q pecks', 'Tapping feed'],
    description: 'Four M8 threaded holes: spot drill (G82 with dwell), peck drill Ø6.8 (G83, Q = peck depth), tap M8×1.25 (G84, F = pitch × S). G99 keeps the tool at the R-plane between holes; G98 on the last one lifts it to the initial level.',
    stock: block(),
    code: t(`
%
O1005 (4 X M8 THREADED HOLES)
${HEAD}
(--- SPOT DRILL ---)
T04 M06
S2500 M03
G54 G43 H04 G00 X15. Y15. Z25. M08
G99 G82 Z-3.6 R2. P200 F250       (SPOT: 90 DEG, D7.2 CHAMFER)
X85.
Y65.
G98 X15.
G80
(--- DRILL D6.8 = TAP DRILL FOR M8 ---)
T05 M06
S4200 M03
G43 H05 G00 X15. Y15. Z25.
G99 G83 Z-17. R2. Q5. F420        (PECK 5 MM, RETRACT TO R EACH TIME)
X85.
Y65.
G98 X15.
G80
(--- TAP M8 X 1.25 ---)
T06 M06
S800 M03
G43 H06 G00 X15. Y15. Z25.
G99 G84 Z-13. R5. F1000           (F = 1.25 X 800)
X85.
Y65.
G98 X15.
G80
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
  {
    id: 'm-polar',
    title: '6 · Bolt-hole circle with polar coordinates (G16)',
    level: 'Intermediate',
    topics: ['G16/G15', 'G52', 'Bolt circle', 'G81'],
    description: 'Six holes on a Ø50 pitch circle. G52 moves the zero to the circle centre, G16 switches to polar coordinates: X = radius, Y = angle. Every hole is just "Y60." further.',
    stock: block(),
    code: t(`
%
O1006 (BOLT CIRCLE 6 X D10 ON PCD 50)
${HEAD}
T04 M06
S2500 M03
G54 G43 H04 G00 X75. Y40. Z25. M08
G52 X50. Y40.                     (LOCAL ZERO = CIRCLE CENTRE)
G16                               (POLAR ON: X = RADIUS, Y = ANGLE)
G99 G82 Z-4. R2. P200 F250 X25. Y0
Y60.
Y120.
Y180.
Y240.
Y300.
G15 G80                           (POLAR OFF, CYCLE OFF)
G52 X0 Y0
T07 M06
S2800 M03
G43 H07 G00 X75. Y40. Z25.
G52 X50. Y40.
G16
G99 G81 Z-18. R2. F420 X25. Y0
Y60.
Y120.
Y180.
Y240.
Y300.
G15 G80
G52 X0 Y0
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
  {
    id: 'm-subprog',
    title: '7 · Repeated features: sub-program with G52',
    level: 'Intermediate',
    topics: ['M98/M99', 'G52 local zero', 'Re-use'],
    description: 'The same 16 × 16 square pocket at three places. The sub-program O2000 is written around its own zero; the main program shifts the zero with G52 before every call.',
    stock: block(),
    code: t(`
%
O1007 (THREE POCKETS WITH A SUB-PROGRAM)
${HEAD}
T03 M06
S8000 M03
G54 G43 H03 G00 X20. Y40. Z25. M08
G52 X20. Y40.
M98 P2000
G52 X50. Y40.
M98 P2000
G52 X80. Y40.
M98 P2000
G52 X0 Y0
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
O2000 (POCKET 16 X 16 X 4 AROUND THE LOCAL ZERO)
G00 X0 Y0 Z2.
G01 Z-4. F200
G01 X2. F700
Y2.
X-2.
Y-2.
X2.
Y0
X5.
Y5.
X-5.
Y-5.
X5.
Y0
G00 Z5.
M99
%
`),
  },
  {
    id: 'm-rotate',
    title: '8 · Coordinate rotation (G68)',
    level: 'Advanced',
    topics: ['G68/G69', 'Rotated slot', 'Sub-program'],
    description: 'A slot program written along X is rotated by 30°, 90° and 150° with G68 – no trigonometry needed.',
    stock: block(),
    code: t(`
%
O1008 (ROTATED SLOTS)
${HEAD}
T03 M06
S8000 M03
G54 G43 H03 G00 X50. Y40. Z25. M08
G68 X50. Y40. R30.
M98 P3000
G69
G68 X50. Y40. R90.
M98 P3000
G69
G68 X50. Y40. R150.
M98 P3000
G69
G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
O3000 (SLOT ALONG +X FROM THE CENTRE)
G00 X58. Y40. Z2.
G01 Z-2. F200
X78. F700
G00 Z5.
M99
%
`),
  },
  {
    id: 'm-dome',
    title: '9 · 3D dome with a ball end mill (Macro B)',
    level: 'Advanced',
    topics: ['Ball end mill', '3D surface', 'Macro B', 'Roughing + finishing'],
    description: 'A spherical dome in a round pocket. The end mill roughs in circles (radius computed per level from the sphere), the ball end mill finishes with a loop over the angle φ: its centre stays (Rsphere + Rball) from the sphere centre. Change #1 (dome radius) and #2 (height).',
    stock: block(),
    code: t(`
%
O1009 (DOME IN A ROUND POCKET)
#1 = 20.                          (DOME BASE RADIUS)
#2 = 8.                           (DOME HEIGHT)
#3 = [#1 * #1 + #2 * #2] / [2 * #2]   (SPHERE RADIUS)
#4 = 33.                          (POCKET RADIUS)
${HEAD}
(--- ROUGH: CIRCLES AROUND THE DOME, 2 MM LEVELS ---)
T02 M06
S8000 M03
G54 G43 H02 G00 X88. Y40. Z25. M08
Z2.
#10 = 0                           (CURRENT LEVEL)
WHILE [#10 GT -#2] DO 1
#10 = #10 - 2.
IF [#10 LT -#2] THEN #10 = -#2
(DOME RADIUS AT THIS LEVEL + TOOL RADIUS + 0.5 ALLOWANCE - SPHERE CENTRE AT Z = -#3)
#11 = SQRT[#3 * #3 - [#10 + #3] * [#10 + #3]] + 5.5
#12 = #4 - 5.                     (OUTER CIRCLE: POCKET WALL)
G01 X[50. + #12] Y40. F300
G01 Z#10
WHILE [#12 GT #11] DO 2
G01 X[50. + #12] F1200
G03 X[50. + #12] Y40. I-#12 J0
#12 = #12 - 5.
END 2
G01 X[50. + #11]
G03 X[50. + #11] Y40. I-#11 J0
G00 Z2.
END 1
G00 Z25.
(--- FINISH THE DOME WITH THE BALL END MILL R4 ---)
T08 M06
S8000 M03
G43 H08 G00 X50. Y40. Z25.
#20 = 2.                          (ANGLE FROM THE TOP)
#21 = #3 + 4.                     (DISTANCE CENTRE - BALL CENTRE)
G00 X50. Y40. Z2.
G01 Z0 F1500                      (TOUCH THE APEX)
WHILE [#20 LE 90.] DO 3
#22 = #21 * SIN[#20]              (RADIUS OF THE BALL CENTRE)
#23 = -#3 + #21 * COS[#20] - 4.  (TIP Z = BALL CENTRE - 4)
IF [#23 LT -#2] GOTO 80
G01 X[50. + #22] Y40. Z#23 F1500
G02 X[50. + #22] Y40. I-#22 J0      (CLOCKWISE AROUND THE DOME = CLIMB)
#20 = #20 + 2.
END 3
N80 G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
  {
    id: 'm-wizard',
    title: '10 · Complete plate (generated by the wizard)',
    level: 'Intermediate',
    topics: ['Full job', 'Pocket', 'Circle', 'Spot/drill/tap'],
    description: 'Face, rectangular pocket, circular pocket and four tapped holes – exactly what the program wizard writes for its default part. Open the wizard to change it.',
    stock: block(),
    code: generateMill(defaultMillSpec(block()), defaultMillTools()),
  },
  {
    id: 'm-empty',
    title: '11 · Empty program (write your own)',
    level: 'Beginner',
    topics: ['Template'],
    description: 'Safe start, tool call and end – fill in your own machining.',
    stock: block(),
    code: t(`
%
O1000 (MY PART)
${HEAD}
T02 M06
S8000 M03
G54 G43 H02 G00 X0 Y0 Z25. M08
(... YOUR MACHINING ...)

G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%
`),
  },
];
