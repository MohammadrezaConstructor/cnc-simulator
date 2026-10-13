# LatheLab & MillLab – educational CNC simulators

Two browser-based simulators for teaching CNC programming with a Fanuc-style control:

- **LatheLab** – 2-axis CNC lathe (`dist/index.html`)
- **MillLab** – 3-axis vertical machining centre (`dist/mill.html`)

Write a program, watch it remove material in 2D and 3D, get crash alarms like on a real machine, and have the part measured. Switch between the two with the **Lathe | Mill** buttons in the top bar.

**Using it:** open `dist/index.html` (lathe) or `dist/mill.html` (milling) by double-clicking. Each is a single
self-contained file that works offline; keep both in the same folder so the Lathe/Mill switch works.

## For teachers and students

| Feature | What it teaches |
|---|---|
| Live program check (errors, warnings, hints) with plain-language **block explanations** | Syntax, modal logic, what each word does in its context (e.g. `U` in `G71` vs. `G01`) |
| **2D section view**: toolpath (rapid / feed / arc / thread), tool + holder, target overlay, ruler, click a path to find its block | Reading toolpaths, diameter vs. radius, tool reference points |
| **3D view**: revolved part, raw vs. machined surfaces, threads as a helix, ¾ section for bores, chips & coolant, part catcher | What the program really produces |
| **Fanuc-style control panel**: AUTO / MDI / JOG, CYCLE START, FEED HOLD, RESET, SINGLE BLOCK, OPT. STOP, BLOCK SKIP, feed / rapid / spindle overrides, DRO, distance-to-go, modal line, spindle load | Proving out a program the way it is done on the shop floor |
| **Crash detection**: rapid into material, holder / boring-bar contact, chuck & jaw collision, cutting with the spindle stopped, G99 feed with the spindle stopped, spindle overload, drill moved sideways | Safety, tool clearance, insert/holder choice |
| **Real tool geometry**: 80°/55°/35° inserts with nose radius and approach angle, grooving / parting blades, threading inserts, drills with point angle, boring bars – all editable, with **wear offsets** and **R/T** for TNRC | Why insert shape and nose radius matter; offset correction |
| **Tool nose radius compensation** G41/G42 implemented properly (start-up, corner arcs, intersections, cancel) | Demo example 11 shows the form error without it |
| **14 lessons** with diagrams, formulas and self-check quizzes | Theory from axes to threading and safe prove-out |
| **17 example programs** (incl. Macro B ellipse, ,C/,R corners, G71 type II) (G00/G01 … complete shaft with thread and part-off) | Reference programs for every cycle |
| **5 graded exercises** with auto-generated drawings, hints, reference solutions and **automatic part inspection** (± tolerance, gouge/oversize map) | Practice with immediate, objective feedback |
| Cutting data **calculator** (n, Vc, Vf, time, Ra, MRR, power, thread depth, taper) | Speeds & feeds |
| **Surface roughness**: every turned surface remembers the feed and nose radius that cut it; **Ra map** in 2D, Ra in the inspection report, exercises can demand e.g. Ra ≤ 1.6 µm | Feed vs. finish, nose radius choice |
| **Timeline**: jump anywhere in the cycle, ⏮ step back a block, ⏭ run one block | Analysing what went wrong, block by block |
| **Charts** of spindle speed, feed and spindle power over machine time (hover, click to jump), with a table view | CSS behaviour, load per pass |
| **Program wizard**: profile points + operations → complete commented program (G71/G70, ,C/,R corners, groove, G76 thread, part-off) and its drawing; checks insert clearance on back-facing slopes and raises the finishing allowance where needed | Program structure, process planning |
| **Exercise builder** for teachers: turn any program into a graded exercise (target taken from the machined part), share it as a JSON file, import exercises | Making your own course material |
| **Custom Macro B**: variables, expressions, IF/GOTO/WHILE, #3000 alarms; the block explanation shows evaluated values | Parametric programming |
| Optional **machine sound** and **dog-leg rapids** (non-linear G00) | Realism; why diagonal rapids are dangerous |
| Cycle time estimate, per-tool operation summary | Process planning |

### Supported G-code (Fanuc lathe, Group A)

`G00 G01 G02 G03` (R or I/K) · `,C` / `,R` direct chamfer and corner radius · `G04` · `G18` · `G20/G21` · `G28` · `G32` · `G40 G41 G42` · `G50` (S clamp and old-style
X/Z setting) · `G54–G59` · `G70 G71 G72 G73 G74 G75 G76` (two-block format; G71/G72 type I and type II, G76 run-out chamfer) · `G90 G92 G94` (modal, with taper R) ·
`G96/G97` · `G98/G99` · `M00 M01 M02 M03 M04 M05 M07 M08 M09 M30 M98 M99` · `N` labels · `O` program numbers and
sub-programs · Custom Macro B (`#` variables, `[ ]` expressions, SIN COS TAN ATAN SQRT ABS ROUND FIX FUP, IF … GOTO / THEN, WHILE … DO … END, #3000 / #3006) · `/` block skip · `( )` and `;` comments · `T` as `TttOo`.
P/Q words of G74–G76 follow Fanuc: without a decimal point they are in µm.

### Simplifications (stated so students know)

- Rapid moves are straight lines by default (dog-leg optional); axis acceleration is not modelled (the cycle time is slightly optimistic).
- Surface roughness is the theoretical value from feed and nose radius (no vibration, built-up edge or tool wear).
- The workpiece is axisymmetric (no milling/C-axis). Threads are stamped once per revolution in the section view and shown as a helix in 3D.
- G71/G72/G73 roughing passes are not compensated (the finishing allowance must cover the nose radius, as noted in the examples).
- Tool geometry offsets are assumed perfectly measured; only wear offsets are simulated.
- Macro B covers the common subset (no G65/G66 macro calls, no system variables beyond #3000/#3006).


## MillLab – the milling simulator

| Feature | What it teaches |
|---|---|
| Vertical machining centre with vise, parallels, table, tool magazine and **M06** (Z to tool-change height, spindle stops) | Machine set-up, tool change routine |
| **Tool length compensation**: tools have real lengths; without G43 H the gauge line goes to Z and the tip crashes into the part; wrong H warnings | The most common VMC crash |
| Height-map material model (≈150 000 cells) with the real tool envelope: flat, bull-nose, ball, face mill, drill point, spot drill, chamfer mill, tap, reamer | Tool shape, scallops, drill point depth |
| Crash detection: G00 into material, spindle stopped, missing G43, shank / holder rubbing (flute length), vise jaws, parallels / vise bed, face mill plunging, drill or tap moving sideways, spindle overload | Safe prove-out |
| Live **CLIMB / CONVENTIONAL / SLOT** indicator and a per-cycle summary, feed per tooth fz, Vc, spindle load | Cutting technology |
| **Cutter radius compensation G41/G42 with D**, ,C / ,R corners, G02/G03 in G17/G18/G19 with helical Z | Contouring from drawing dimensions |
| Hole cycles **G73 G74 G76 G81–G89**, G98/G99, R-plane, Q pecks (with the µm trap explained), K repeats, tapping-feed check | Hole making |
| **G16 polar, G52 local zero, G68 rotation, G91**, sub-programs, Custom Macro B | Programming techniques |
| Views: **Top** (depth map), **Front/Side sections** with tool silhouette, **3D** with spinning tool, chips, coolant; charts, timeline | Reading toolpaths |
| **Feature wizard**: face, rectangular / circular pockets (helical entry, climb loops), boss (rough rings + G41 finish), slot, hole grid / bolt circle (spot, drill/peck, tap) with speeds & feeds from the material | Process planning, program structure |
| **Automatic work zero**: G54 at any top corner or the centre of the block, Z0 on the finished or raw top – one-click **WORK ZERO** picker under the DRO; the G54 axes (X+ red, Y+ green, Z+ blue) are drawn in the 2D and 3D views; the wizard writes code for each choice | Choosing and reading a work zero |
| **Programming conventions** (Settings, or the one-click **AUTO TOOL COMP** button): automatic tool length compensation after M06 (no G43 H), automatic cutter radius (G41/G42 without D), programmed point = tool tip or nose-radius centre (ball / bull-nose / face mill); wear offsets still apply | Controls and CAM posts that differ from the Fanuc default |
| 10 lessons with quizzes, 11 examples (incl. a Macro-B 3D dome), 4 graded exercises; teachers can turn any program into an exercise (JSON import/export) | Course material |

Inspection compares the machined height map with the height map produced by the hidden reference program
(±tolerance on every floor and top; wall cells next to steps and a 1 mm edge band are excluded).

Simplifications: 3-axis only (no undercuts), no machine kinematics/acceleration, no G51.1 mirror, cutter compensation only in G17,
G12/G13 and other builder-specific pocket cycles are not included – the wizard writes the pocket moves explicitly.

## Development

```bash
npm install
npm run dev        # dev server with hot reload
npm test           # 142 tests (lathe + mill): interpreter, cycles, TNRC, every example and exercise end-to-end, fuzzing
npm run build      # type-check + single-file builds → dist/index.html (lathe) and dist/mill.html (mill)
```

### Publishing on GitHub Pages

`.github/workflows/pages.yml` tests, builds and publishes both simulators on every push to `main`:

1. Push the repository to GitHub (branch `main`).
2. Repository **Settings → Pages → Source: GitHub Actions** (one time).
3. After the workflow has run: `https://<user>.github.io/<repo>/` is LatheLab, `…/<repo>/mill.html` is MillLab
   (the Lathe | Mill switch links them).

GitHub Pages sites are public. On a free account the repository must be public too; private repositories need a paid plan.

### Architecture

```
src/
  types.ts            shared types (internal coordinates: x = RADIUS, z)
  gcode/
    lexer.ts          words, comments, N/O, block delete
    interpreter.ts    modal state machine → primitive ops (moves, tool, spindle, coolant, stops) + diagnostics
    cycles.ts         G70–G76, G90/G92/G94 expansion (pure geometry, unit-tested)
    tnrc.ts           G41/G42 tool nose radius compensation
    explain.ts        plain-language explanation of a block
    macro.ts          Custom Macro B expression evaluator and statement parser
  sim/
    geom.ts           2D geometry (arcs, hulls, intersections, simplification)
    tools.ts          insert/holder shapes per tool type, Fanuc tip vectors
    stock.ts          dexel material model: Z columns of radial intervals; body extraction for rendering
    machine.ts        time-based execution, feeds/CSS rpm, overrides, collisions, power, jog
    inspect.ts        part inspection against a target contour
  view/view2d.ts      canvas section view
  view/view3d.ts      three.js view (revolved mesh, helix, section, chips, coolant)
  view/charts.ts      spindle speed / feed / power charts (small multiples, shared time axis)
  ui/                 editor (CodeMirror 6), dialogs, wizard & exercise builder, sound, DOM helpers, drawing generator
  content/            examples, exercises, lessons, G-code reference, wizard program generator
  mill/               the milling simulator: interp (G-code), cycles (holes), comp (G41/G42), stock (height map),
                      machine, inspect, wizardGen, views (2D/3D), dialogs, content/ (examples, lessons, exercises)
tests/                vitest suites
```

**Material removal.** The part is stored as ~4000 thin columns along Z, each with sorted radial material intervals.
For every motion step the convex insert shape is swept (convex hull of start and end pose); each covered column loses
the radial interval where the hull crosses it. That handles OD/ID profiles, face grooves, drilling across the axis and
part-off (an empty column detaches everything to its right). The holder shapes are checked for overlap but never cut.
Rendering extracts continuous bodies from the columns, simplifies them (Douglas–Peucker), draws them as polygons in
2D and revolves them in 3D.

**Adding content.** Examples (`content/examples.ts`) and exercises (`content/exercises.ts`) are plain data; a target
drawing is written as a short G-code contour. The test suite automatically runs every example and every exercise
reference solution on the simulated machine and checks that it passes inspection – so new content is verified by
`npm test`.
