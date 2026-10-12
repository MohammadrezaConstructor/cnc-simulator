// Course material. HTML is trusted (authored here).

export interface Quiz {
  q: string;
  options: string[];
  answer: number;
  why: string;
}

export interface Lesson {
  id: string;
  title: string;
  html: string;
  examples?: string[];
  quiz?: Quiz[];
}

const axesSvg = `
<svg viewBox="0 0 420 200" class="diagram" role="img" aria-label="Lathe axes">
  <rect x="10" y="40" width="60" height="120" class="d-chuck"/>
  <rect x="70" y="70" width="230" height="60" class="d-stock"/>
  <line x1="0" y1="100" x2="410" y2="100" class="d-axis"/>
  <line x1="300" y1="100" x2="390" y2="100" class="d-arrow" marker-end="url(#ah)"/>
  <text x="372" y="92" class="d-label">+Z</text>
  <line x1="300" y1="100" x2="300" y2="20" class="d-arrow" marker-end="url(#ah)"/>
  <text x="306" y="28" class="d-label">+X</text>
  <circle cx="300" cy="100" r="6" class="d-zero"/>
  <text x="250" y="122" class="d-small">W: X0 Z0</text>
  <path d="M330 60 l20 -12 l14 22 l-18 10 z" class="d-tool"/>
  <text x="352" y="62" class="d-small">tool</text>
  <text x="80" y="62" class="d-small">− Z (towards chuck)</text>
  <text x="18" y="180" class="d-small">chuck</text>
  <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="d-arrowhead"/></marker></defs>
</svg>`;

const arcSvg = `
<svg viewBox="0 0 420 200" class="diagram" role="img" aria-label="G02 and G03 on an outside profile">
  <line x1="0" y1="170" x2="410" y2="170" class="d-axis"/>
  <path d="M380 170 L380 120 A20 20 0 0 0 360 100 L240 100 A20 20 0 0 1 220 80 L220 50 L60 50" class="d-part"/>
  <path d="M380 120 A20 20 0 0 0 360 100" class="d-path"/>
  <path d="M240 100 A20 20 0 0 1 220 80" class="d-path2"/>
  <text x="330" y="88" class="d-label">G03 convex</text>
  <text x="236" y="126" class="d-label">G02 concave</text>
  <line x1="330" y1="150" x2="250" y2="150" class="d-arrow" marker-end="url(#ah2)"/>
  <text x="252" y="164" class="d-small">tool travel: face → chuck</text>
  <text x="300" y="196" class="d-small">+X up, +Z right</text>
  <defs><marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="d-arrowhead"/></marker></defs>
</svg>`;

const tipSvg = `
<svg viewBox="0 0 300 200" class="diagram" role="img" aria-label="Imaginary tool tip numbers">
  <circle cx="150" cy="100" r="40" class="d-nose"/>
  <circle cx="150" cy="100" r="3" class="d-zero"/>
  <g class="d-label">
    <text x="196" y="52">1</text><text x="96" y="52">2</text><text x="96" y="158">3</text><text x="196" y="158">4</text>
    <text x="200" y="106">5</text><text x="146" y="50">6</text><text x="92" y="106">7</text><text x="146" y="160">8</text>
    <text x="156" y="96">0/9</text>
  </g>
  <rect x="110" y="140" width="80" height="0.1" class="d-axis"/>
  <path d="M110 140 L110 60" class="d-dash"/><path d="M110 140 L190 140" class="d-dash"/>
  <text x="10" y="190" class="d-small">+X up, +Z right (rear tool post). OD turning = 3, boring = 2.</text>
</svg>`;

const tnrcSvg = `
<svg viewBox="0 0 420 200" class="diagram" role="img" aria-label="Nose radius error on a chamfer">
  <path d="M40 160 L200 160 L320 40 L400 40" class="d-part"/>
  <path d="M40 160 L200 160 L320 40" class="d-path" />
  <circle cx="190" cy="140" r="20" class="d-nose"/>
  <circle cx="275" cy="66" r="20" class="d-nose"/>
  <path d="M255 86 L262 79" class="d-err"/>
  <text x="290" y="110" class="d-label">material left</text>
  <text x="40" y="190" class="d-small">The control drives the imaginary tip (corner of the dashed square) along the line;</text>
  <text x="40" y="203" class="d-small">on the chamfer the round nose never reaches the line.</text>
</svg>`;

const g71Svg = `
<svg viewBox="0 0 420 210" class="diagram" role="img" aria-label="G71 roughing">
  <rect x="40" y="40" width="330" height="130" class="d-stock"/>
  <path d="M370 150 L330 150 L330 120 L250 120 L250 90 L170 90 L120 60 L40 60" class="d-part"/>
  <g class="d-path">
    <path d="M390 50 L60 50"/><path d="M390 70 L150 70"/><path d="M390 90 L250 90"/><path d="M390 110 L250 110"/><path d="M390 130 L330 130"/>
  </g>
  <circle cx="390" cy="30" r="4" class="d-zero"/><text x="372" y="22" class="d-small">start A</text>
  <text x="44" y="196" class="d-small">Layers of depth U (radius). Each layer stops at the profile + allowance, then a final contour pass.</text>
</svg>`;

export const LESSONS: Lesson[] = [
  {
    id: 'axes',
    title: '1. The CNC lathe and its coordinate system',
    html: `
<p>A CNC lathe rotates the workpiece in the <b>spindle</b> (held by a 3-jaw <b>chuck</b>) and moves a stationary tool in two axes:</p>
<ul>
<li><b>Z</b> – parallel to the spindle axis. <b>Z0</b> is normally the <i>finished front face</i> of the part. Moving towards the chuck is <b>negative Z</b>.</li>
<li><b>X</b> – perpendicular to the axis. <b>X0</b> is the spindle centre line. On lathes X is programmed as a <b>DIAMETER</b>: <code>X40.</code> puts the tool tip 20 mm away from the centre.</li>
</ul>
${axesSvg}
<p>The point X0 Z0 is the <b>work zero (W)</b>. The machine also has a fixed <b>machine zero / reference point</b>, reached with <code>G28 U0 W0</code>. The relationship between both is measured during setup (tool offsets &amp; work offset).</p>
<p>This simulator models a modern slant-bed lathe with the turret <b>behind the centre line (rear tool post)</b>: the tool is drawn <b>above</b> the axis, +X points up.</p>
<div class="note"><b>Try it:</b> load example 1, switch to the <b>2D</b> view and hover over the part – the status shows the diameter and Z under the mouse.</div>`,
    examples: ['basic'],
    quiz: [
      { q: 'The tool is programmed to X30. How far is the tool tip from the spindle axis?', options: ['30 mm', '15 mm', '60 mm'], answer: 1, why: 'X is a diameter on lathes – the radius is half of it.' },
      { q: 'Where is Z0 normally placed?', options: ['At the chuck face', 'At the finished front face of the part', 'At the machine home position'], answer: 1, why: 'With Z0 on the front face, all features on the part have negative Z values.' },
      { q: 'A move from Z-10 to Z-40 moves the tool…', options: ['towards the chuck', 'away from the chuck'], answer: 0, why: 'More negative Z = closer to the chuck.' },
    ],
  },
  {
    id: 'structure',
    title: '2. Structure of a CNC program',
    html: `
<p>A program is a list of <b>blocks</b> (lines). Each block contains <b>words</b>: an address letter followed by a number (<code>G01</code>, <code>X25.</code>, <code>F0.2</code>).</p>
<pre>%                        ← tape start
O0001 (SHAFT)            ← program number + comment
N10 G21 G40 G99          ← safe start line
N20 G28 U0 W0            ← go home
N30 T0101                ← tool 1, offset 1
N40 G50 S2500            ← speed limit
N50 G96 S200 M03         ← spindle on
N60 G00 X52. Z2. M08     ← approach, coolant on
...                      ← machining
N900 G28 U0 W0 M09       ← home, coolant off
N910 M30                 ← end &amp; rewind
%</pre>
<h4>Modal and non-modal codes</h4>
<p><b>Modal</b> codes stay active until replaced by another code of the same group (e.g. <code>G01</code> stays active, so the next line can contain just <code>Z-30.</code>). <b>Non-modal</b> codes act only in their own block (<code>G04</code>, <code>G28</code>, <code>G50</code>, cycles G70–G76).</p>
<h4>Comments, sequence numbers, block skip</h4>
<ul>
<li><code>( … )</code> is a comment; the control ignores it. Comments cannot be nested.</li>
<li><code>N…</code> numbers are optional labels – but G70–G73 need them as P/Q targets.</li>
<li>A block starting with <code>/</code> is skipped when the <b>BLOCK SKIP</b> switch is on.</li>
</ul>
<div class="note"><b>Safe start line:</b> always reset the modal state at the start of each tool (<code>G21 G40 G99</code>) – the previous program may have left G41 or G98 active.</div>`,
    examples: ['basic', 'mdi'],
    quiz: [
      { q: 'Line 1: G01 X20. F0.2 – Line 2: Z-15. What does line 2 do?', options: ['Rapid to Z-15', 'Feed to Z-15 (G01 is modal)', 'Nothing – no G-code'], answer: 1, why: 'G01 is modal: it stays active until another motion code is programmed.' },
      { q: 'Which of these is NOT modal?', options: ['G96', 'G04', 'G99'], answer: 1, why: 'G04 (dwell) only acts in its own block.' },
    ],
  },
  {
    id: 'motion',
    title: '3. Rapid & linear moves: G00, G01, absolute X/Z vs incremental U/W',
    html: `
<p><code>G00</code> moves at rapid traverse (10–30 m/min) – <b>only in air</b>. <code>G01</code> cuts in a straight line at feed <code>F</code>.</p>
<ul>
<li>Only Z changes → turning a diameter.</li>
<li>Only X changes → facing / grooving / parting.</li>
<li>Both change → taper or chamfer.</li>
</ul>
<h4>Absolute and incremental</h4>
<p><code>X</code>/<code>Z</code> are absolute positions. <code>U</code>/<code>W</code> are incremental distances (U is a <b>diameter</b> change). They can be mixed: <code>G01 X30. W-5.</code></p>
<pre>G00 X20. Z2.     (absolute)
G01 Z-10. F0.2   (cut 12 mm long)
U4. W-2.         (chamfer: Ø20→Ø24 over 2 mm)
W-20.            (another 20 mm)</pre>
<h4>Facing past the centre</h4>
<p>When facing, go to <code>X-1.6</code> (≈ −2 × nose radius) so the round nose cleans the centre of the face completely.</p>
<div class="note warn"><b>Crash rule:</b> never program a diagonal <code>G00</code> that passes through the part. Retract X first (away from the part), then move Z – or the other way round when inside a bore. The simulator raises an alarm if a rapid move touches material.</div>`,
    examples: ['basic', 'tnrc'],
    quiz: [
      { q: 'The tool is at X40. Z-20. What position does U-6. W-3. reach?', options: ['X34. Z-23.', 'X37. Z-23.', 'X34. Z-17.'], answer: 0, why: 'U-6 changes the diameter by −6 (40→34), W-3 moves 3 mm towards the chuck.' },
      { q: 'Which motion may NOT touch the workpiece?', options: ['G01', 'G00', 'G02'], answer: 1, why: 'G00 has no controlled feed – touching material is a crash.' },
    ],
  },
  {
    id: 'speeds',
    title: '4. Speeds & feeds: G96/G97, G50, G98/G99',
    html: `
<h4>Cutting speed and spindle speed</h4>
<p>The cutting speed <b>Vc</b> (m/min) is the speed of the material passing the cutting edge. It is chosen from the insert maker's catalogue for the material. The spindle speed follows from the diameter:</p>
<div class="formula">n = 1000 · Vc / (π · D) &nbsp;&nbsp; [rev/min]</div>
<ul>
<li><code>G96 S200</code> – constant surface speed: the control recalculates n continuously so Vc stays 200 m/min on every diameter. Use it for turning and facing.</li>
<li><code>G97 S800</code> – constant spindle speed (rev/min). Use it for drilling on centre, threading and parting off.</li>
<li><code>G50 S2500</code> – maximum spindle speed. <b>Always</b> program it before <code>G96</code>: at X0 the formula gives infinite rpm!</li>
</ul>
<h4>Feed</h4>
<ul>
<li><code>G99</code> (default): F in <b>mm/rev</b>. Table feed Vf = f · n (mm/min).</li>
<li><code>G98</code>: F in mm/min.</li>
</ul>
<h4>Useful formulas</h4>
<div class="formula">Theoretical roughness: R<sub>t</sub> ≈ f² / (8·r<sub>ε</sub>) · 1000 &nbsp;µm &nbsp;(R<sub>a</sub> ≈ R<sub>t</sub>/4)</div>
<div class="formula">Metal removal rate: Q = Vc · a<sub>p</sub> · f &nbsp;[cm³/min]</div>
<div class="formula">Power: P ≈ Q · k<sub>c</sub> / 60 000 &nbsp;[kW]</div>
<table class="data"><tr><th>Material</th><th>Vc (m/min)</th><th>f rough</th><th>f finish</th></tr>
<tr><td>Steel C45</td><td>180–280</td><td>0.25–0.4</td><td>0.08–0.15</td></tr>
<tr><td>Stainless</td><td>120–200</td><td>0.2–0.3</td><td>0.08–0.12</td></tr>
<tr><td>Aluminium</td><td>300–800</td><td>0.2–0.5</td><td>0.1–0.2</td></tr>
<tr><td>Brass</td><td>200–400</td><td>0.2–0.35</td><td>0.08–0.15</td></tr></table>
<div class="note">Open the <b>Calculator</b> (top bar) to try these formulas. During a simulation the control panel shows actual rpm, Vc, feed (mm/min), metal removal rate and spindle load. The <b>Charts</b> tab plots rpm, feed and spindle power over the whole cycle – watch the rpm climb during a G96 facing pass, and the spindle power during each roughing level.</div>
<h4>Surface finish</h4>
<p>The simulator records the feed and nose radius of the cut that produced every turned surface. Tick <b>Ra map</b> in the 2D view to colour the part by theoretical roughness, and "Check part" reports the worst Ra. Some exercises require e.g. <b>Ra ≤ 1.6 µm</b>: with a 0.4 mm nose this means f ≤ √(1.6 · 32 · 0.4 / 1000) ≈ 0.14 mm/rev.</p>`,
    examples: ['basic'],
    quiz: [
      { q: 'G96 S200 on Ø40: what is the spindle speed (approx.)?', options: ['1592 rpm', '5000 rpm', '200 rpm'], answer: 0, why: 'n = 1000·200/(π·40) ≈ 1592 rev/min.' },
      { q: 'Why is G50 S… required before G96?', options: ['It sets the feed', 'It limits rpm when the diameter gets small', 'It selects metric units'], answer: 1, why: 'As X approaches 0 the CSS formula asks for huge rpm – G50 S caps it.' },
      { q: 'Feed 0.2 mm/rev at 1500 rpm gives a table feed of…', options: ['300 mm/min', '7500 mm/min', '0.2 mm/min'], answer: 0, why: 'Vf = f·n = 0.2 × 1500 = 300 mm/min.' },
    ],
  },
  {
    id: 'arcs',
    title: '5. Arcs: G02 / G03 with R or I/K',
    html: `
<p><code>G02</code> = clockwise, <code>G03</code> = counter-clockwise, <b>looking at the usual lathe picture</b> (+X up, +Z right, tool above the centre line).</p>
<p>Rule of thumb for OD turning towards the chuck: <b>convex</b> corners (rounded edges) are <code>G03</code>, <b>concave</b> fillets are <code>G02</code>.</p>
${arcSvg}
<h4>R or I/K?</h4>
<ul>
<li><code>G03 X20. Z-2. R2.</code> – end point and radius. Simple; R negative selects the arc larger than 180°.</li>
<li><code>G03 X20. Z-2. I0 K-2.</code> – I/K is the vector from the arc <b>start</b> to the <b>centre</b>. I is a <b>radius</b> value (not diameter!).</li>
</ul>
<p>If the end point is not on the circle the control alarms ("arc end point error") – the simulator checks this too.</p>
<h4>Direct chamfers and radii: ,C and ,R</h4>
<p>Most drawings give sharp corners plus a note like "1×45°" or "R2". Modern Fanuc controls let you program the sharp corner and add the corner treatment as a word on the G01 block <i>leading into</i> the corner:</p>
<pre>G01 X20. ,C1.     (corner at X20 Z0 gets a chamfer with 1 mm legs)
Z-15. ,R2.        (corner at Z-15 gets a tangent R2 arc)
X30.</pre>
<p>The control computes the tangent points itself – also between tapers – so you never calculate chamfer end points again. The next block must be a G01 move.</p>
<div class="note"><b>Check:</b> start point Ø16 Z0, end point Ø20 Z-2, R2: the radius change is 2 mm and the Z change is 2 mm – a quarter circle.</div>`,
    examples: ['contour', 'g71'],
    quiz: [
      { q: 'Moving towards the chuck, the edge between the front face and the diameter is rounded. Which code?', options: ['G02', 'G03'], answer: 1, why: 'A convex (outside) corner on the OD towards the chuck is G03 on a rear tool post lathe.' },
      { q: 'With I/K, the I value is…', options: ['a diameter value', 'a radius value', 'an absolute X position'], answer: 1, why: 'I is the incremental distance from the start point to the centre, in radius.' },
    ],
  },
  {
    id: 'tools',
    title: '6. Tools, offsets and the imaginary tool tip',
    html: `
<p><code>T0303</code> calls <b>turret station 03</b> and activates <b>offset 03</b>. The offset contains the tool's geometry (measured at setup), its <b>wear</b> correction, the <b>nose radius R</b> and the <b>tip direction T</b>.</p>
<h4>Wear offsets</h4>
<p>Measured Ø40.06 instead of Ø40.00? Enter <b>X wear −0.06</b> on that offset and the next part is correct. Try it in the <b>Tools &amp; offsets</b> dialog.</p>
<h4>The imaginary tool tip</h4>
<p>A real insert has a round nose. The control does not program the round nose but the <b>imaginary tip</b> – the corner where the tangents touching the nose in X and Z meet. The tip number tells the control where that point lies relative to the nose centre:</p>
${tipSvg}
<h4>Tool reference points in this simulator</h4>
<ul>
<li>Turning/boring tools: imaginary tip (3 for OD, 2 for ID).</li>
<li>Grooving & parting tools: the <b>left corner</b> of the blade. A 3 mm blade at <code>Z-10.</code> cuts from Z-10 to Z-7.</li>
<li>Threading tools & drills: the tip.</li>
</ul>
<p>The turret <b>indexes where it is</b>: always move to a safe position before a tool change.</p>`,
    examples: ['groove', 'drill'],
    quiz: [
      { q: 'What does T0812 mean?', options: ['Tool 8 with offset 12', 'Tool 12 with offset 8', 'Tool 812'], answer: 0, why: 'First two digits = turret station, last two = offset number.' },
      { q: 'A part measures 0.04 mm oversize on the diameter. What do you enter?', options: ['X wear +0.04', 'X wear −0.04', 'Z wear −0.04'], answer: 1, why: 'Negative wear moves the tool closer to the centre on the next part.' },
    ],
  },
  {
    id: 'tnrc',
    title: '7. Tool nose radius compensation: G41 / G42 / G40',
    html: `
<p>Because the control drives the imaginary tip, every <b>taper and arc</b> comes out wrong by up to ~0.4·R normal to the surface if you program the drawing contour directly. Diameters and faces (pure X or Z moves) are correct.</p>
${tnrcSvg}
<p>With <b>tool nose radius compensation</b> the control drives the <b>nose centre</b> on a path offset by R, so the round nose touches the programmed contour everywhere.</p>
<ul>
<li><code>G42</code> – tool on the <b>right</b> of the path, looking in the direction of travel. OD turning towards the chuck.</li>
<li><code>G41</code> – tool on the <b>left</b>. Boring (ID) towards the chuck, facing a profile towards the centre.</li>
<li><code>G40</code> – cancel.</li>
</ul>
<p>Rules:</p>
<ol><li>Switch on/off with a <code>G00</code>/<code>G01</code> move (never on an arc), starting outside the material.</li>
<li>The offset must contain the correct <b>R</b> and <b>T</b> (tip number).</li>
<li>Arcs smaller than the nose radius on the inside are impossible (interference alarm).</li></ol>
<div class="note"><b>Experiment:</b> load example 11, run it, then press <b>Check part</b>. Then open <b>Tools &amp; offsets</b>, increase T01's nose radius to 1.6 and re-run: the uncompensated chamfer gets worse, the compensated one stays perfect.</div>`,
    examples: ['tnrc', 'contour'],
    quiz: [
      { q: 'Which features are NOT affected by the nose radius error?', options: ['Tapers', 'Arcs', 'Straight diameters and faces'], answer: 2, why: 'On pure X or Z moves the nose tangent points coincide with the imaginary tip.' },
      { q: 'OD finishing towards the chuck on a rear tool post lathe uses…', options: ['G41', 'G42', 'G40'], answer: 1, why: 'The tool is on the right of the direction of travel.' },
    ],
  },
  {
    id: 'cycles1',
    title: '8. Single canned cycles: G90 and G94',
    html: `
<p>A <b>box cycle</b> packs four moves into one block, starting and ending at the <b>start point</b> (the position before the cycle):</p>
<ol><li>rapid in to the cutting diameter (G90) / face (G94)</li><li>cut</li><li>feed out</li><li>rapid back to the start point</li></ol>
<pre>G00 X54. Z2.            (start point)
G90 X48. Z-30. F0.25    (pass 1)
X44.                    (pass 2 – only X changes)
X40.                    (pass 3)
G00 X100. Z100.</pre>
<p>The cycle stays modal until another motion code (G00/G01…) is programmed. <code>R</code> creates a taper: the radius at the start of the cut minus the radius at the end.</p>
<p><code>G94 X-1.6 Z-1. F0.2</code> faces down to Z-1; repeat with <code>Z-2.</code>, <code>Z-3.</code> …</p>`,
    examples: ['g90g94', 'contour'],
    quiz: [
      { q: 'After a G90 pass the tool stops at…', options: ['the end of the cut', 'the start point', 'machine home'], answer: 1, why: 'The fourth move is a rapid back to the start point.' },
    ],
  },
  {
    id: 'cycles2',
    title: '9. Multiple repetitive cycles: G71, G72, G73, G70',
    html: `
<p>You describe the <b>finished profile</b> once (blocks N<i>ns</i>…N<i>nf</i>); the control generates all roughing passes.</p>
${g71Svg}
<pre>G00 X52. Z2.                      (start point A – outside the stock)
G71 U2. R0.5                      (2 mm per side, 0.5 retract)
G71 P100 Q200 U0.4 W0.1 F0.25     (profile N100–N200, allowance)
N100 G00 X16.                     (X ONLY in the first block)
G01 Z0 F0.1
…
N200 X52.
G70 P100 Q200                     (finish with F from the profile)</pre>
<ul>
<li><b>G71</b> – layers along Z (long parts). Profile must rise monotonically (type I).</li>
<li><b>G72</b> – layers along X (short, large diameters). First block moves Z only.</li>
<li><b>G73</b> – repeats the shape with decreasing relief (castings, necks/undercuts).</li>
<li><b>G70</b> – runs the profile once. Usually after a tool change to the finishing tool, with G42.</li>
</ul>
<p>The finishing allowance U is on the <b>diameter</b> (U0.4 = 0.2 per side), negative for internal profiles.</p>
<div class="note warn">Roughing passes are not compensated. On back-facing slopes (necks) the nose radius digs in – give enough allowance (&gt; nose radius).</div>
<h4>G71 type I and type II</h4>
<p><b>Type I</b> needs a profile whose diameter only grows towards the chuck. A profile that dips into a pocket raises an alarm (PS0064). <b>Type II</b> – selected by naming <i>both</i> axes in the first profile block, usually with <code>W0</code> – also roughs pockets, layer by layer:</p>
<pre>N100 G00 X28. W0      (W0 → type II)</pre>
<p>Check the insert: to follow a back-facing slope, the tool's trailing edge must be steeper than the slope. An 80° CNMG (5° trailing edge) cannot; a 35° VNMG (52°) can. Example 16 shows it; the program wizard checks it for you.</p>`,
    examples: ['g71', 'g72', 'g73', 'complete'],
    quiz: [
      { q: 'In "G71 U2. R0.5", U2. means…', options: ['2 mm diameter allowance', '2 mm depth of cut per side', 'incremental X move'], answer: 1, why: 'In the first G71 block U is the depth of cut (radius).' },
      { q: 'Which cycle suits a profile with a neck (diameter goes down and up again)?', options: ['G71 type I', 'G73', 'G94'], answer: 1, why: 'G73 follows the whole shape; G71 type I needs a monotonic profile.' },
    ],
  },
  {
    id: 'grooving',
    title: '10. Grooving, parting and drilling: G75, G74',
    html: `
<h4>Grooving</h4>
<p>Use <code>G97</code> (constant rpm) and a low feed (0.04–0.1 mm/rev). A dwell (<code>G04 X0.3</code>) at the bottom cleans the groove. Wide grooves: plunge several times, shifting less than the blade width:</p>
<pre>G75 R0.5                              (retract per peck)
G75 X30. Z-23. P2000 Q2500 F0.06     (P = peck depth, Q = Z step, in µm)</pre>
<h4>Parting off</h4>
<p>Same cycle down to <b>X-0.5</b>. The finished part falls into the parts catcher – the simulator shows it next to the bar.</p>
<h4>Drilling</h4>
<p>On the lathe, holes are drilled on the centre line (<code>X0</code>) with a stationary drill. Spot / centre drill first, then pecking to break chips:</p>
<pre>G00 X0 Z3.
G74 R1.
G74 Z-38. Q6000 F0.15     (6 mm pecks)</pre>
<p>Remember the <b>drill point</b>: a 118° point is 0.3 × D long – the full diameter starts deeper than the tip.</p>`,
    examples: ['groove', 'drill', 'subprog'],
    quiz: [
      { q: 'G75 … Q2500 means a Z shift of…', options: ['2500 mm', '2.5 mm', '0.25 mm'], answer: 1, why: 'P/Q without a decimal point are in µm (0.001 mm).' },
      { q: 'Why use G97 for drilling on centre?', options: ['With G96 the rpm would go to the maximum at X0', 'Drills need feed per minute', 'It is required by G74'], answer: 0, why: 'At X0 the CSS formula asks for infinite rpm.' },
    ],
  },
  {
    id: 'threading',
    title: '11. Threading: G32, G92, G76',
    html: `
<p>Threading moves are <b>synchronised with the spindle</b>: F is the lead, the tool advances one lead per revolution. Every pass starts at the same angular position, so the passes fall into the same groove.</p>
<ul>
<li>Use <code>G97</code> – the rpm must not change between passes.</li>
<li>Start 2–3 leads in front of the part to let the axis accelerate.</li>
<li>Feed hold and the feed override do not act during a threading pass.</li>
</ul>
<h4>Metric thread depth (external)</h4>
<div class="formula">h = 0.6134 × P &nbsp;&nbsp; minor Ø = major Ø − 2h</div>
<p>M24 × 2: h = 1.227 → minor Ø 21.546.</p>
<h4>G92 – one pass per block</h4>
<pre>G92 X19.3 Z-21. F1.5
X18.9
X18.6 …</pre>
<h4>G76 – complete thread in two blocks</h4>
<pre>G76 P020060 Q50 R0.05             (2 finish passes, chamfer 0, 60°, min cut 0.05, allowance 0.05)
G76 X21.546 Z-29. P1227 Q350 F2.  (root Ø, end, height 1.227, first cut 0.35, lead 2)</pre>
<p>G76 reduces the depth of each pass (Δd·√n) to keep the chip area constant and feeds in along the flank of the thread.</p>
<div class="note">In the 2D view the thread appears as a row of V-grooves (the section). In 3D you see the helix.</div>`,
    examples: ['g76', 'g92', 'complete'],
    quiz: [
      { q: 'Thread height of M16×1.5 (external)?', options: ['0.92 mm', '1.5 mm', '0.75 mm'], answer: 0, why: 'h = 0.6134 × 1.5 ≈ 0.92 mm.' },
      { q: 'Why G97 for threading?', options: ['The rpm must stay constant so all passes stay in sync', 'G96 is not allowed with M03', 'To get mm/rev feed'], answer: 0, why: 'A changing rpm would change the start angle of the passes.' },
    ],
  },
  {
    id: 'subprograms',
    title: '12. Sub-programs: M98 / M99',
    html: `
<p>Repeated operations go into a sub-program, usually written with <b>incremental</b> moves so each call works on a new position.</p>
<pre>O0012 (MAIN)
…
G00 X44. Z-2.
M98 P40020        (call O0020 four times)
…
M30
O0020 (ONE GROOVE)
G00 W-8.
G01 X32. F0.06
G00 X44.
M99               (return)</pre>
<p>Alternative format: <code>M98 P20 L4</code>.</p>`,
    examples: ['subprog'],
  },
  {
    id: 'macro',
    title: '13. Parametric programs: Custom Macro B',
    html: `
<p>Fanuc's <b>Custom Macro B</b> adds variables, arithmetic and program flow to G-code. One program can then make a whole family of parts, or compute shapes (ellipses, parabolas) that have no G-code of their own.</p>
<h4>Variables and expressions</h4>
<pre>#1 = 30.                 (DIAMETER)
#2 = #1 / 2 + 1.5        (BRACKETS: [ ], NOT ( ) – THOSE ARE COMMENTS)
G01 X#1 Z[-#2 * 2] F0.2  (ANY ADDRESS CAN TAKE A VARIABLE)</pre>
<ul>
<li><code>#1–#33</code> local, <code>#100–#199</code> and <code>#500–#999</code> common variables, <code>#0</code> is always empty ("vacant").</li>
<li>Functions: SIN COS TAN ATAN SQRT ABS ROUND FIX FUP – angles in <b>degrees</b>.</li>
<li>An address with a vacant variable is simply left out of the block.</li>
</ul>
<h4>Decisions and loops</h4>
<pre>IF [#1 GT 40.] GOTO 900     (JUMP TO N900)
#5 = 1
WHILE [#5 LE 3] DO 1         (REPEAT WHILE TRUE)
G00 Z[-10. * #5]
G01 X24. F0.06
G00 X32.
#5 = #5 + 1                  (DON'T FORGET – OR IT NEVER ENDS)
END 1
N900 #3000 = 1 (PART TOO LARGE)   (STOPS WITH AN ALARM MESSAGE)</pre>
<p>Comparison operators: EQ NE GT GE LT LE, combined with AND / OR.</p>
<h4>Seeing what happens</h4>
<p>Put the cursor on a block with variables: the <b>block explanation</b> shows the evaluated values (e.g. "Evaluated: X24 Z-30"). The tool path in the 2D view is the real, computed path.</p>
<div class="note"><b>Try it:</b> load example 14 and change <code>#1</code>, <code>#2</code> (ellipse size) or <code>#3</code> (number of grooves), then run it again.</div>`,
    examples: ['macro'],
    quiz: [
      { q: 'What does "G01 X[#1 * 2]" do when #1 = 12?', options: ['Moves to X24', 'Moves to X12', 'Alarm – brackets are comments'], answer: 0, why: 'Square brackets are expressions; round brackets are comments.' },
      { q: 'A WHILE loop never ends. The most likely cause?', options: ['The loop variable is never changed inside the loop', 'DO and END have the same number', 'The loop contains G01 moves'], answer: 0, why: 'The condition is checked before every pass – something inside the loop must change it.' },
      { q: 'SIN[30] equals…', options: ['0.5 (degrees)', '−0.988 (radians)'], answer: 0, why: 'Fanuc macro trigonometry works in degrees.' },
    ],
  },
  {
    id: 'safety',
    title: '14. Proving out a program safely',
    html: `
<p>Real machines are expensive and dangerous. Professionals prove out a new program step by step – practise the same routine here:</p>
<ol>
<li><b>Simulate / graphic check</b> – look at the tool path (2D view, rapids in red dashed lines). Use the <b>timeline</b> (AUTO panel) to jump to any moment and ⏮ to step back block by block.</li>
<li><b>Single block</b> – the machine stops after every block; press CYCLE START for the next one.</li>
<li><b>Rapid override 25 %</b> and <b>feed override</b> low for the first part; keep a hand on <b>FEED HOLD</b>.</li>
<li><b>Optional stop (M01)</b> after each tool – check the result before continuing.</li>
<li>Measure the first part and correct <b>wear offsets</b>.</li>
</ol>
<h4>Classic crashes (all detected by the simulator)</h4>
<ul>
<li>Diagonal <code>G00</code> through the part, or a rapid ending inside the material.</li>
<li>Cutting with the spindle stopped (missing <code>M03</code>).</li>
<li>Wrong sign: <code>Z30.</code> instead of <code>Z-30.</code>, or X radius instead of diameter.</li>
<li>Tool holder or boring bar touching the part; tool hitting the <b>chuck jaws</b>.</li>
<li>Tool change too close to the part.</li>
<li>Feed per revolution (G99) while the spindle is stopped – axes do not move.</li>
<li>Assuming G00 moves in a straight line. Many machines move every axis at full speed ("dog-leg"): the tool first travels at 45° and only then straight. Switch Settings → G00 path to "Dog-leg" and watch your approach moves.</li>
<li>Forgetting a new F after threading (F is still the thread lead!).</li>
</ul>`,
    examples: ['complete'],
    quiz: [
      { q: 'What does SINGLE BLOCK do?', options: ['Runs only the first block', 'Stops after every block until CYCLE START', 'Skips blocks starting with /'], answer: 1, why: 'Single block executes one block per press of CYCLE START.' },
    ],
  },
];
