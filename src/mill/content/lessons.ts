import type { Lesson } from '../../content/lessons';

const axesSvg = `
<svg viewBox="0 0 420 220" class="diagram" role="img" aria-label="Machining centre axes">
  <rect x="80" y="130" width="220" height="50" class="d-stock"/>
  <rect x="60" y="180" width="260" height="22" class="d-chuck"/>
  <rect x="170" y="20" width="40" height="60" class="d-chuck"/>
  <rect x="184" y="80" width="12" height="40" class="d-tool"/>
  <line x1="80" y1="130" x2="150" y2="130" class="d-arrow" marker-end="url(#mah)"/>
  <text x="146" y="124" class="d-label">+X</text>
  <line x1="80" y1="130" x2="110" y2="105" class="d-arrow" marker-end="url(#mah)"/>
  <text x="112" y="102" class="d-label">+Y</text>
  <line x1="80" y1="130" x2="80" y2="70" class="d-arrow" marker-end="url(#mah)"/>
  <text x="62" y="70" class="d-label">+Z</text>
  <circle cx="80" cy="130" r="6" class="d-zero"/>
  <text x="20" y="150" class="d-small">W: X0 Y0 Z0</text>
  <text x="220" y="60" class="d-small">spindle + tool</text>
  <text x="235" y="196" class="d-small">vise</text>
  <defs><marker id="mah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="d-arrowhead"/></marker></defs>
</svg>`;

const lengthSvg = `
<svg viewBox="0 0 420 210" class="diagram" role="img" aria-label="Tool length and gauge line">
  <rect x="150" y="10" width="110" height="40" class="d-chuck"/>
  <line x1="120" y1="50" x2="300" y2="50" class="d-dash"/>
  <text x="300" y="46" class="d-small">gauge line</text>
  <rect x="190" y="50" width="30" height="100" class="d-tool"/>
  <line x1="320" y1="50" x2="320" y2="150" class="d-arrow"/>
  <text x="326" y="104" class="d-label">H = tool length</text>
  <rect x="60" y="150" width="300" height="40" class="d-stock"/>
  <text x="66" y="146" class="d-small">Z0 = top of the part</text>
  <text x="10" y="205" class="d-small">G43 H.. makes Z refer to the tool tip. Without it, the gauge line goes to Z – the tip is H lower.</text>
</svg>`;

const climbSvg = `
<svg viewBox="0 0 420 200" class="diagram" role="img" aria-label="Climb and conventional milling">
  <rect x="20" y="110" width="380" height="60" class="d-stock"/>
  <circle cx="120" cy="90" r="28" class="d-nose"/>
  <path d="M120 62 A28 28 0 0 1 148 90" class="d-path2"/>
  <line x1="40" y1="40" x2="200" y2="40" class="d-arrow" marker-end="url(#mah2)"/>
  <text x="40" y="32" class="d-small">feed direction →</text>
  <text x="60" y="190" class="d-label">material on the RIGHT of the path + M03 = CLIMB (G41)</text>
  <circle cx="300" cy="140" r="0" />
  <defs><marker id="mah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="d-arrowhead"/></marker></defs>
</svg>`;

export const MILL_LESSONS: Lesson[] = [
  {
    id: 'm-axes',
    title: '1. The machining centre, axes and the work zero',
    html: `
<p>A vertical machining centre (VMC) holds the part in a <b>vise</b> on the table and moves a rotating tool in three axes:</p>
<ul><li><b>X</b> – table left/right, <b>Y</b> – table towards/away from you, <b>Z</b> – spindle up/down. Negative Z goes into the part.</li>
<li>The <b>work zero</b> (G54) is chosen on the part – here by default the front left corner of the block, Z0 on the finished top face (any top corner or the centre can be chosen in the <b>Workpiece</b> dialog – see lesson 10). During setup the operator measures where this point is and stores it in the work offset page.</li></ul>
${axesSvg}
<p>The vise clamps the block on its <b>Y sides</b> and the block rests on two <b>parallels</b> under those edges. Whatever sticks out above the jaws is free to machine; the simulator alarms if a tool touches the jaws or cuts into the parallels.</p>
<div class="note"><b>Try it:</b> load example 1, hover in the <b>Top</b> view: the status shows X, Y and the surface height under the mouse.</div>`,
    examples: ['m-face-slot'],
    quiz: [
      { q: 'The part zero is on the top face. A pocket is 5 mm deep. Its floor is at…', options: ['Z5.', 'Z-5.', 'Z0'], answer: 1, why: 'Inside the material Z is negative.' },
      { q: 'Which axis moves the spindle?', options: ['X', 'Y', 'Z'], answer: 2, why: 'On a VMC the table moves X/Y, the spindle head moves Z.' },
    ],
  },
  {
    id: 'm-tools',
    title: '2. Tools, M06 and tool length compensation (G43 H)',
    html: `
<p><code>T05 M06</code> loads tool 5. The machine first moves Z up to the tool-change position and <b>stops the spindle</b> – start it again with <code>M03 S…</code>.</p>
<p>Every tool has a different length. The tool setter measures it from the spindle <b>gauge line</b> to the tip and stores it in the length offset <b>H</b> (normally H number = tool number).</p>
${lengthSvg}
<pre>T02 M06
S8000 M03
G54 G43 H02 G00 X20. Y20. Z25.   (FIRST Z MOVE WITH G43 H02)</pre>
<div class="note warn"><b>The classic crash:</b> forgetting G43, or using the wrong H. The control then drives the gauge line to Z25 – the tool tip is 75 mm lower. Try it in the simulator: delete "G43 H02" from example 1.</div>
<h4>Tool types</h4>
<ul><li><b>Face mill</b> – large Ø, inserts, NOT centre cutting: start every pass outside the part.</li>
<li><b>End mill</b> (flat), <b>bull-nose</b> (corner radius), <b>ball end mill</b> (3D surfaces).</li>
<li><b>Spot drill</b>, <b>twist drill</b> (118° point), <b>tap</b>, <b>reamer</b>, <b>chamfer mill</b>.</li></ul>`,
    examples: ['m-face-slot'],
    quiz: [
      { q: 'After T03 M06 the spindle is…', options: ['still running at the old speed', 'stopped – program M03 S… again', 'running at maximum speed'], answer: 1, why: 'The tool change stops the spindle.' },
      { q: 'What happens without G43?', options: ['Nothing', 'The tool tip is one tool length lower than programmed', 'The tool stays at home'], answer: 1, why: 'The gauge line, not the tip, goes to the programmed Z.' },
    ],
  },
  {
    id: 'm-speeds',
    title: '3. Speeds and feeds for milling',
    html: `
<div class="formula">S = 1000 · Vc / (π · D) &nbsp;[rpm]</div>
<div class="formula">F = fz · z · S &nbsp;[mm/min]</div>
<ul><li><b>Vc</b> – cutting speed (m/min) from the tool catalogue: aluminium 200–600, steel 100–250 (carbide).</li>
<li><b>fz</b> – feed per tooth (chip thickness): 0.02–0.15 mm. <b>z</b> – number of flutes.</li>
<li>Drills: feed per rev f ≈ 0.01–0.02 × D. Taps: F = pitch × S (exactly!).</li></ul>
<div class="formula">Q = ae · ap · F / 1000 &nbsp;[cm³/min] &nbsp;&nbsp; P ≈ Q · kc / 60 000 &nbsp;[kW]</div>
<p>ae = width of cut, ap = depth of cut. The control panel shows the actual fz, Vc and spindle load; the <b>Charts</b> tab plots them over the cycle.</p>
<div class="note"><b>Example:</b> Ø10 carbide end mill in aluminium, Vc 250 → S ≈ 8000; 3 flutes, fz 0.05 → F = 0.05 × 3 × 8000 = 1200 mm/min.</div>`,
    examples: ['m-pocket'],
    quiz: [
      { q: 'Ø10 end mill, 3 flutes, S8000, F1200. Feed per tooth?', options: ['0.05 mm', '0.15 mm', '0.5 mm'], answer: 0, why: 'fz = F / (z × S) = 1200 / 24000 = 0.05.' },
      { q: 'M8×1.25 tap at S800. Tapping feed?', options: ['F800', 'F1000', 'F100'], answer: 1, why: 'F = pitch × S = 1.25 × 800 = 1000 mm/min.' },
    ],
  },
  {
    id: 'm-arcs',
    title: '4. Lines, arcs, planes and helical moves',
    html: `
<p><code>G01</code> cuts straight lines in any direction. <code>G02</code> (CW) and <code>G03</code> (CCW) cut arcs, seen from above in the <b>G17</b> XY plane (G18 = ZX, G19 = YZ).</p>
<pre>G03 X60. Y40. R10.          (ARC WITH RADIUS)
G03 X60. Y40. I-10. J0      (FULL CIRCLE: CENTRE 10 MM IN -X FROM THE START)</pre>
<ul><li><b>I, J, K</b> are the distances from the arc START to the CENTRE (incremental, always).</li>
<li>A full circle needs I/J – with R the end point equals the start point and the arc is undefined.</li>
<li>Add Z to an arc for a <b>helix</b>: <code>G03 X54. Y40. I-4. J0 Z-2.</code> – the gentle way to enter a pocket.</li></ul>
<p>Drawing corners can be written directly: <code>G01 X80. ,R5.</code> inserts a radius, <code>,C1.</code> a chamfer.</p>`,
    examples: ['m-circle', 'm-contour'],
    quiz: [
      { q: 'Start X54 Y40, centre X50 Y40. I and J are…', options: ['I4. J0', 'I-4. J0', 'I50. J40.'], answer: 1, why: 'I/J = centre − start = (50 − 54, 40 − 40).' },
    ],
  },
  {
    id: 'm-comp',
    title: '5. Climb vs conventional milling, cutter compensation G41/G42',
    html: `
${climbSvg}
<ul><li><b>Climb milling</b>: the cutter's teeth enter the material at full chip thickness – better surface, less tool wear, standard on rigid CNC machines.</li>
<li><b>Conventional</b>: chip starts at zero thickness and rubs – used on old machines with backlash or on hard skins.</li></ul>
<p>The simulator shows <b>CLIMB / CONVENTIONAL / SLOT</b> live while cutting. Rule with M03: material on the right of the path → climb. Outside contours run clockwise, pockets counter-clockwise.</p>
<h4>Cutter radius compensation</h4>
<p>Program the <b>drawing</b> contour and let the control offset the tool centre by the radius in the <b>D</b> register:</p>
<pre>G41 D02 G01 X80. F800    (START-UP: A STRAIGHT MOVE ONTO THE CONTOUR)
…                        (CONTOUR WITH DRAWING DIMENSIONS)
G40 G01 X95.             (CANCEL ON A MOVE AWAY)</pre>
<p>G41 = tool on the left of the travel direction (climb with M03), G42 = right. Bonus: measure the part, change the D wear, re-run – the size changes without editing the program.</p>
<div class="note warn">An inside corner can never be sharper than the tool radius; an inside arc smaller than the tool radius gives an interference alarm.</div>`,
    examples: ['m-contour'],
    quiz: [
      { q: 'Outside contour, M03, tool on the left (G41). The contour is travelled…', options: ['clockwise', 'counter-clockwise'], answer: 0, why: 'Clockwise around a boss keeps the material on the right → climb milling.' },
      { q: 'Smallest inside corner radius with a Ø10 end mill?', options: ['R0', 'R5', 'R10'], answer: 1, why: 'The tool radius.' },
    ],
  },
  {
    id: 'm-pockets',
    title: '6. Pockets: entry, step-over, step-down',
    html: `
<ul>
<li><b>Entry</b>: plunge (only centre-cutting tools, short), <b>ramp</b> (G01 with X and Z) or <b>helix</b> (G02/G03 with Z) – kindest to the tool.</li>
<li><b>Step-over</b> (ae): 40–70 % of the diameter for loops; <b>step-down</b> (ap): up to 0.5–1 × D in aluminium for a full-width cut, less in steel.</li>
<li>Clear the pocket from the centre outwards in loops, counter-clockwise (climb); finish the wall in one last loop with the corner radius.</li>
<li>The <b>flute length</b> limits the depth – deeper and the shank rubs (alarm).</li>
</ul>
<div class="note">The program wizard writes all of this for you – read its output to learn the structure.</div>`,
    examples: ['m-pocket', 'm-circle', 'm-dome'],
    quiz: [
      { q: 'Which entry is NOT possible with a face mill?', options: ['Starting outside and moving in', 'Plunging straight down in the middle of the part'], answer: 1, why: 'Face mills have no cutting edge in the centre.' },
    ],
  },
  {
    id: 'm-holes',
    title: '7. Hole making with canned cycles',
    html: `
<p>One line per hole: position in X/Y, the cycle does the Z moves.</p>
<pre>G99 G81 Z-15. R2. F300     (FIRST HOLE)
X40.                       (SECOND HOLE – SAME CYCLE)
G98 Y50.                   (LAST ONE: RETURN TO THE INITIAL LEVEL)
G80                        (CANCEL)</pre>
<table class="data"><tr><th>Code</th><th>Use</th></tr>
<tr><td>G81</td><td>Drill: feed down, rapid out</td></tr>
<tr><td>G82</td><td>Spot / counterbore: + dwell P (ms)</td></tr>
<tr><td>G83</td><td>Deep holes: peck Q, retract to R every time</td></tr>
<tr><td>G73</td><td>High-speed peck: short retract to break chips</td></tr>
<tr><td>G84 / G74</td><td>Tapping right / left hand: F = pitch × S</td></tr>
<tr><td>G85 / G86 / G89 / G76</td><td>Reaming / boring variants</td></tr></table>
<ul><li><b>R</b> – the plane where rapid stops (2–3 mm above the surface). <b>G99</b> returns to R between holes, <b>G98</b> to the initial Z (over clamps).</li>
<li>Q without a decimal point is in µm: <b>Q5.</b> = 5 mm, Q5 = 0.005 mm!</li>
<li>Drill depth is the <b>tip</b>: the full diameter starts 0.3 × D higher (118° point).</li>
<li>Always spot drill first so the drill does not walk.</li></ul>`,
    examples: ['m-holes', 'm-polar'],
    quiz: [
      { q: 'G99 means after each hole the tool goes to…', options: ['the R-plane', 'the initial level', 'machine home'], answer: 0, why: 'G99 = R-plane, G98 = initial level.' },
      { q: '"G83 Z-30. R2. Q5 F300" pecks…', options: ['5 mm', '0.005 mm'], answer: 1, why: 'Without the decimal point Q is in the least input increment (µm).' },
    ],
  },
  {
    id: 'm-coords',
    title: '8. Working smarter: G91, G16, G52, G68, sub-programs',
    html: `
<ul>
<li><b>G91</b> – incremental: every X/Y/Z is a distance. Great in sub-programs; switch back with G90.</li>
<li><b>G16</b> – polar coordinates: X = radius, Y = angle. A bolt circle becomes "Y60." for every next hole.</li>
<li><b>G52 X_ Y_</b> – moves the zero locally (G52 X0 Y0 cancels). Call the same sub-program at several places.</li>
<li><b>G68 X_ Y_ R_</b> – rotates the program about a point (G69 cancels).</li>
<li><b>M98 P_ / M99</b> – sub-programs; with macro variables they become parametric (see example 9).</li>
</ul>`,
    examples: ['m-polar', 'm-subprog', 'm-rotate', 'm-dome'],
    quiz: [
      { q: 'With G16 active, "X25. Y90." moves to…', options: ['X25 Y90', 'radius 25 at 90° (straight up in Y)', 'X0 Y0'], answer: 1, why: 'Polar: X = radius, Y = angle.' },
    ],
  },
  {
    id: 'm-safety',
    title: '9. Proving out a milling program',
    html: `
<ol><li>Check the toolpath in <b>Top</b> and the <b>Front/Side sections</b> – rapids in red.</li>
<li>Single block + rapid override 25 % for the first part; watch the "distance to go".</li>
<li>Check every tool change: M06 → M03 S… → G43 H (same number) → first Z move well above the part.</li></ol>
<h4>Crashes the simulator detects</h4>
<ul><li>Missing or wrong G43 H – the tool dives into the part.</li>
<li>G00 into material; cutting with the spindle stopped.</li>
<li>Face mill plunging; drill or tap moving sideways.</li>
<li>Shank or holder hitting the part (flute length too short).</li>
<li>Tool hitting the vise jaws or the parallels under the part.</li>
<li>Spindle overload (too much ae × ap × F).</li></ul>`,
    examples: ['m-face-slot'],
  },
  {
    id: 'm-conventions',
    title: '10. Work zero choice, automatic compensation and the tool’s programmed point',
    html: `
<h4>Where is X0 Y0 Z0?</h4>
<p>The programmer chooses the work zero, the operator probes it and stores it in G54. Any top corner or the centre of the block can be used (<b>Workpiece</b> dialog – the simulator sets G54 there automatically):</p>
<ul><li><b>Front left corner</b> – the whole part is in +X / +Y, like most drawings.</li>
<li><b>Front right / back left / back right</b> – the part lies in −X and/or −Y. A pocket 30 mm from the right edge is at <code>X-30.</code></li>
<li><b>Centre</b> – symmetric parts; a bore in the middle is simply <code>X0 Y0</code>.</li></ul>
<p>Z0 is either the <b>finished top</b> (the face mill cuts at Z0; the raw top is at Z+allowance) or the <b>raw top</b> (the operator touches the uncut block; the face mill cuts at Z−allowance and all depths shift by the allowance). The program wizard writes either.</p>
<h4>Automatic tool length and radius</h4>
<p>On a Fanuc-style control you program <code>G43 H02</code> after every tool change and <code>G41 D02</code> for cutter compensation. Many controls (and CAM post-processors) can do this automatically: the length and radius of the tool in the spindle are taken from the tool table. Switch it on in <b>Settings → Programming conventions</b>:</p>
<pre>T02 M06
S8000 M03
G54 G00 X20. Y20. Z25.        (NO G43 H02 – Z IS ALREADY THE TOOL TIP)
G41 G01 X0 Y10. F800          (NO D – THE TOOL RADIUS + D WEAR IS USED)</pre>
<p>Length (H) and radius (D) wear on the offset page of that tool number are still applied, so a measured part can be corrected. <code>G43 H..</code> written in the program still wins; G49 returns to the automatic length.</p>
<h4>Tip or centre of the tool nose?</h4>
<p>By default Z is the <b>tool tip</b> (the lowest point). CAM systems can also output the <b>centre of the nose radius</b>: for a ball mill Ø8 the centre is 4 mm above the tip, for a bull-nose with R1 it is 1 mm above. With that convention <code>Z-2.</code> with a Ø8 ball mill cuts to a depth of 6 mm. Choose it in Settings – the DRO then shows the centre ("ctr").</p>
<div class="note warn">Every program must be written for the convention of the machine it runs on. A program written for "centre" run on a "tip" machine cuts too high; the other way round it cuts too deep – here by the nose radius.</div>`,
    examples: ['m-face-slot', 'm-dome'],
    quiz: [
      { q: 'X0 Y0 is the back right corner of the block. The block lies in…', options: ['+X and +Y', '−X and −Y', '+X and −Y'], answer: 1, why: 'Everything is to the left (−X) and in front (−Y) of the back right corner.' },
      { q: 'Z0 is on the raw top, 1 mm stock is faced off. A pocket is 5 mm deep from the finished top. Its floor is at…', options: ['Z-5.', 'Z-6.', 'Z-4.'], answer: 1, why: 'The finished top is at Z-1, the floor 5 mm lower.' },
      { q: 'Ø10 ball mill, programmed point = ball centre, program Z-3. The tip is at…', options: ['Z-3.', 'Z-8.', 'Z2.'], answer: 1, why: 'The tip is one ball radius (5 mm) below the centre.' },
    ],
  },
];
