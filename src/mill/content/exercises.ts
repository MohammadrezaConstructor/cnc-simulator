import type { BlockStock, MillSettings } from '../types';

export interface MillExercise {
  id: string;
  title: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  brief: string;
  stock: BlockStock;
  /** the finished part is whatever this program produces */
  solution: string;
  tol: number;
  hints: string[];
  starter: string;
  custom?: boolean;
  briefText?: string;
  /** programming conventions the reference solution is written for (absent = standard: G43 H, D, tip) */
  conventions?: Pick<MillSettings, 'autoLength' | 'autoRadius' | 'pointRef'>;
}

const block = (o: Partial<BlockStock> = {}): BlockStock => ({
  sizeX: 100, sizeY: 80, sizeZ: 30, origin: 'corner', topAllowance: 1, material: 'aluminium', aboveJaws: 15, ...o,
});

const HEAD = `G21 G17 G40 G49 G80 G90 G94
G91 G28 Z0
G90`;
const FACE = `T01 M06
S2800 M03
G54 G43 H01 G00 X-30. Y15. Z25. M08
Z2.
G01 Z0 F1200
X130.
G00 Y60.
G01 X-30.
G00 Z25.`;
const END = `G00 Z25. M09
M05
G91 G28 Z0
G90
M30
%`;

export const starterMill = (o: string, title: string) => `%
O${o} (${title})
${HEAD}
(FACE THE TOP TO Z0 FIRST)

(... YOUR PROGRAM ...)

${END}
`;

export const MILL_EXERCISES: MillExercise[] = [
  {
    id: 'me1',
    title: 'M1 · Face and pocket',
    level: 'Beginner',
    brief: `<p>Block 100 × 80 × 30 aluminium, X0 Y0 front left corner, 1 mm stock on top.</p>
<ul><li>Face the top to Z0</li><li>Rectangular pocket 40 × 30 centred at X50 Y40, 5 mm deep, corner radius R5 (or smaller)</li></ul>
<p>Tolerance ±0.05 mm on all floors and tops.</p>`,
    stock: block(),
    tol: 0.05,
    hints: ['Face with T01 starting outside the block (X-30).', 'With T02 (Ø10) the tool centre travels inside 40−10 = 30 by 30−10 = 20.', 'Enter with a helix: G03 X54. Y40. I-4. J0 Z-…'],
    starter: starterMill('3001', 'FACE AND POCKET'),
    solution: `%
O3001 (M1 SOLUTION)
${HEAD}
${FACE}
T02 M06
S8000 M03
G43 H02 G00 X50. Y40. Z25.
Z2.
G01 X54. Y40. Z0.5 F1000
G03 X54. Y40. I-4. J0 Z-1.5
G03 X54. Y40. I-4. J0 Z-3.5
G03 X54. Y40. I-4. J0 Z-5.
G03 X54. Y40. I-4. J0
G01 X60. Y40.
Y50.
X40.
Y30.
X60.
Y40.
X65.
Y55.
X35.
Y25.
X65.
Y40.
${END}
`,
  },
  {
    id: 'me2',
    title: 'M2 · Boss with cutter compensation',
    level: 'Intermediate',
    brief: `<p>Same block. Face to Z0, then leave a boss 70 × 50 with R8 corners, centred at X50 Y40, 4 mm high. Around the boss remove at least a 10 mm wide band down to Z-4.</p>
<p>Use G41 with D02 for the finished contour (drawing dimensions).</p>`,
    stock: block(),
    tol: 0.05,
    hints: ['Programmed contour: X15…X85, Y15…Y65 with ,R8. corners, clockwise.', 'Start-up: G41 D02 G01 from outside onto the contour.', 'A rough ring first (tool centre 5.3 outside), then the finish pass.'],
    starter: starterMill('3002', 'BOSS 70 X 50'),
    solution: `%
O3002 (M2 SOLUTION)
${HEAD}
${FACE}
T02 M06
S8000 M03
G43 H02 G00 X100. Y40. Z25.
Z2.
G01 Z-4. F400
X95.3 F1200
Y9.7
X4.7
Y70.3
X95.3
Y40.
X100.
G41 D02 G01 X85. F800
Y15. ,R8.
X15. ,R8.
Y65. ,R8.
X85. ,R8.
Y40.
G40 G01 X100.
${END}
`,
  },
  {
    id: 'me3',
    title: 'M3 · Four tapped holes',
    level: 'Intermediate',
    brief: `<p>Face to Z0. Four M8×1.25 threaded holes at X12 Y12, X88 Y12, X12 Y68, X88 Y68: spot drill, drill Ø6.8 to Z-17 (tip), tap to Z-13.</p>`,
    stock: block(),
    tol: 0.05,
    hints: ['G82 for spotting, G83 Q5. for drilling, G84 for tapping.', 'Tapping feed F = 1.25 × S.', 'G80 after every cycle.'],
    starter: starterMill('3003', 'FOUR M8 HOLES'),
    solution: `%
O3003 (M3 SOLUTION)
${HEAD}
${FACE}
T04 M06
S2500 M03
G43 H04 G00 X12. Y12. Z25.
G99 G82 Z-3.6 R2. P200 F250
X88.
Y68.
G98 X12.
G80
T05 M06
S4200 M03
G43 H05 G00 X12. Y12. Z25.
G99 G83 Z-17. R2. Q5. F420
X88.
Y68.
G98 X12.
G80
T06 M06
S800 M03
G43 H06 G00 X12. Y12. Z25.
G99 G84 Z-13. R5. F1000
X88.
Y68.
G98 X12.
G80
${END}
`,
  },
  {
    id: 'me4',
    title: 'M4 · Round pocket with a bolt circle',
    level: 'Advanced',
    brief: `<p>Face to Z0. A Ø30 round pocket 6 deep centred at X50 Y40. Around it six Ø10 holes, 20 deep (drill tip), on a Ø56 pitch circle starting at 0°.</p>`,
    stock: block(),
    tol: 0.05,
    hints: ['Helical entry and full circles with I/J for the pocket.', 'G52 X50. Y40. + G16 for the bolt circle: X28. Y0, Y60., Y120. …', 'Do not forget G15 and G52 X0 Y0 afterwards.'],
    starter: starterMill('3004', 'POCKET + BOLT CIRCLE'),
    solution: `%
O3004 (M4 SOLUTION)
${HEAD}
${FACE}
T02 M06
S8000 M03
G43 H02 G00 X50. Y40. Z25.
Z2.
G01 X54. Y40. Z0.5 F1000
G03 X54. Y40. I-4. J0 Z-1.5
G03 X54. Y40. I-4. J0 Z-3.5
G03 X54. Y40. I-4. J0 Z-5.5
G03 X54. Y40. I-4. J0 Z-6.
G03 X54. Y40. I-4. J0
G01 X60.
G03 X60. Y40. I-10. J0
G01 X65.
G03 X65. Y40. I-15. J0
G01 X60.
G00 Z25.
T04 M06
S2500 M03
G43 H04 G00 X78. Y40. Z25.
G52 X50. Y40.
G16
G99 G82 Z-4. R2. P200 F250 X28. Y0
Y60.
Y120.
Y180.
Y240.
Y300.
G15 G80
G52 X0 Y0
T07 M06
S2800 M03
G43 H07 G00 X78. Y40. Z25.
G52 X50. Y40.
G16
G99 G81 Z-20. R2. F420 X28. Y0
Y60.
Y120.
Y180.
Y240.
Y300.
G15 G80
G52 X0 Y0
${END}
`,
  },
];
