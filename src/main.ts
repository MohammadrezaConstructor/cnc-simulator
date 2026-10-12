import './style.css';
import type { MachineSettings, MoveOp, OffsetEntry, Op, P, StockDef, ToolDef } from './types';
import { interpret, defaultState, type InterpConfig, type InterpResult, type InterpState } from './gcode/interpreter';
import { explainBlock } from './gcode/explain';
import { Stock } from './sim/stock';
import { Machine, estimateTime, type SimEvent } from './sim/machine';
import { defaultTools, defaultOffsets, TOOL_TYPE_LABEL } from './sim/tools';
import { checkPart, contourFromGcode } from './sim/inspect';
import { moveLength } from './sim/geom';
import { DEFAULT_MACHINE, DEFAULT_WORK_OFFSETS } from './defaults';
import { EXAMPLES, type Target } from './content/examples';
import { EXERCISES, type Exercise } from './content/exercises';
import { createEditor, type Editor } from './ui/editor';
import { View2D } from './view/view2d';
import { View3D } from './view/view3d';
import { h, $, $$, toast, fmtTime, download, store, dialogOpen, fill, confirmDialog, isLightTheme } from './ui/dom';
import { partDrawing } from './ui/drawing';
import * as D from './ui/dialogs';
import { wizardDialog, builderDialog, textToHtml } from './ui/dialogs2';
import { Charts, summarizeByLine } from './view/charts';
import { MachineSound } from './ui/sound';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
type Mode = 'AUTO' | 'MDI' | 'JOG';

class App implements D.AppApi {
  tools: ToolDef[];
  offsets: Map<number, OffsetEntry>;
  stockDef: StockDef;
  settings: MachineSettings;
  workOffsets: Record<number, P>;
  progress: Set<string>;
  reloadStockOnStart: boolean;

  stock: Stock;
  machine: Machine;
  editor: Editor;
  v2: View2D;
  v3: View3D;

  title = 'Program';
  result: InterpResult | null = null;
  needsReload = true;
  mode: Mode = 'AUTO';
  viewMode: '2d' | '3d' | 'split' = '3d';
  speed = 4;
  target: Target | null = null;
  exercise: Exercise | null = null;
  exampleId: string | null = null;
  turbo = false;
  holdPending = false;
  estimate = { total: 0, cutting: 0, perLine: new Map<number, number>(), opStart: [] as number[] };
  charts: Charts;
  sound = new MachineSound();
  customExercises: Exercise[];
  /** "run one block" from the timeline */
  private stepOnce = false;
  private tlDragging = false;
  private lastChart = 0;
  private tlKey = '';
  mdiState: InterpState | null = null;
  mdiHistory: string[] = [];
  running: 'program' | 'mdi' | null = null;
  /** source of the ops currently loaded in the machine (event line numbers refer to it) */
  private opsSource: 'program' | 'mdi' = 'program';
  private mdiText = '';
  private interpTimer = 0;
  private saveTimer = 0;
  private lastSig = '';
  private lastDro = 0;
  private cursorLine = 0;
  private hadDropped = false;
  private jogDir: { x: number; z: number } | null = null;
  private jogRapid = false;
  private jogInc = 1;

  constructor() {
    this.tools = store.get('tools', defaultTools());
    this.offsets = new Map(store.get<[number, OffsetEntry][]>('offsets', Array.from(defaultOffsets(this.tools).entries())));
    this.settings = { ...DEFAULT_MACHINE, ...store.get('settings', {}) };
    this.workOffsets = store.get('workOffsets', DEFAULT_WORK_OFFSETS);
    this.progress = new Set(store.get<string[]>('progress', []));
    this.reloadStockOnStart = store.get('reloadStock', true);
    const theme = store.get<string | null>('theme', null);
    if (theme) document.documentElement.dataset.theme = theme;

    const saved = store.get<{ code: string; title: string; stock: StockDef; exampleId: string | null; exerciseId: string | null } | null>('session', null);
    const first = EXAMPLES.find((e) => e.id === 'g71')!;
    this.stockDef = saved?.stock ?? { ...first.stock };
    this.stock = new Stock(this.stockDef);
    this.machine = new Machine(this.stock, this.tools, this.settings);

    this.editor = createEditor($('#editor'), saved?.code ?? first.code, () => this.onCodeChange(), (l) => this.onCursor(l));
    this.v2 = new View2D($('#view2d'), this.machine);
    this.v3 = new View3D($('#view3d'), this.machine);
    this.charts = new Charts($('#chartHost'));
    this.charts.onSeek = (t) => this.seek(t);
    this.customExercises = store.get<Exercise[]>('customExercises', []);
    this.v2.onPick = (line) => {
      this.editor.goToLine(line);
      this.v2.selectedLine = line;
    };

    this.bindUi();
    this.applyThemeTo3D();
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      this.v2.refreshColors();
      this.applyThemeTo3D();
    });
    if (saved) {
      this.title = saved.title;
      this.exampleId = saved.exampleId;
      const ex = saved.exampleId ? EXAMPLES.find((e) => e.id === saved.exampleId) : undefined;
      const exr = saved.exerciseId ? this.allExercises().find((e) => e.id === saved.exerciseId) : undefined;
      if (exr) this.showExercise(exr);
      else if (ex?.target) this.setTarget(ex.target);
    } else {
      this.title = first.title;
      this.exampleId = first.id;
      this.setTarget(first.target ?? null);
    }
    this.setTitle();
    this.reinterpret();
    this.setView(store.get('view', window.innerWidth < 820 ? '2d' : '3d'));
    requestAnimationFrame(() => {
      this.v2.fit();
      this.v3.view('iso');
    });
    if (!store.get('welcomed', false)) {
      store.set('welcomed', true);
      setTimeout(() => toast('Welcome! Press CYCLE START to run the loaded G71/G70 example, or open Lessons to learn step by step.', 'info', 8000), 600);
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ program handling

  private cfg(): InterpConfig {
    return {
      tools: this.tools,
      offsets: this.offsets,
      machine: this.settings,
      workOffsets: this.workOffsets,
      blockSkip: ($('#tSkip') as HTMLInputElement).checked,
      stock: this.stockDef,
    };
  }

  /** initial interpreter state = where the machine currently is */
  private initState(base?: InterpState | null): InterpState {
    const s = base ? JSON.parse(JSON.stringify(base)) as InterpState : defaultState(this.settings);
    const m = this.machine;
    s.tip = { ...m.pos };
    const off = m.offset ? this.offsets.get(m.offset) : undefined;
    const w = this.workOffsets[s.work] ?? { x: 0, z: 0 };
    s.pos = { x: m.pos.x - w.x - s.g50.x - (off ? off.wx / 2 : 0), z: m.pos.z - w.z - s.g50.z - (off ? off.wz : 0) };
    s.tool = m.tool;
    s.offset = m.offset;
    s.spindle = { ...m.spindle, maxRpm: base ? s.spindle.maxRpm : this.settings.maxRpm };
    s.coolant = m.coolant;
    return s;
  }

  private onCodeChange() {
    this.needsReload = true;
    clearTimeout(this.interpTimer);
    this.interpTimer = window.setTimeout(() => this.reinterpret(), 250);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveSession(), 800);
  }

  reinterpret() {
    const code = this.editor.getDoc();
    const idle = !this.running;
    this.result = interpret(code, this.cfg(), idle ? this.initState() : defaultState(this.settings));
    const r = this.result;
    if (idle) {
      this.v2.setOps(r.ops);
      this.v3.setOps(r.ops);
      this.estimate = estimateTime(r.ops, this.settings);
    }
    this.editor.setDiagnostics(r.diags);
    const n = (s: string) => r.diags.filter((d) => d.severity === s).length;
    $('#errCount').textContent = String(n('error'));
    $('#warnCount').textContent = String(n('warning'));
    $('#infoCount').textContent = String(n('info'));
    $('#checkCount').textContent = r.diags.length ? `(${r.diags.length})` : '';
    this.renderCheckList();
    this.renderOps();
    this.onCursor(this.cursorLine);
    this.setTitle();
  }

  private setTitle() {
    const m = /^\s*O(\d+)\s*(\(([^)]*)\))?/m.exec(this.editor.getDoc());
    const prog = m ? `O${m[1].padStart(4, '0')}${m[3] ? ' – ' + m[3].trim() : ''}` : 'Program';
    $('#progTitle').textContent = prog;
    document.title = `${prog} · LatheLab`;
  }

  private saveSession() {
    store.set('session', { code: this.editor.getDoc(), title: this.title, stock: this.stockDef, exampleId: this.exampleId, exerciseId: this.exercise?.id ?? null });
    if (this.exercise) store.set('ex-code:' + this.exercise.id, this.editor.getDoc());
  }

  private confirmDiscard(): boolean {
    if (this.running) {
      toast('Stop the machine first (RESET)', 'warn');
      return false;
    }
    return true;
  }

  private loadProgram(code: string, title: string, stock: StockDef | null) {
    this.editor.setDoc(code);
    this.title = title;
    if (stock) {
      this.stockDef = { ...stock };
      this.stock.reset(this.stockDef);
    }
    this.newStock(false);
    this.reinterpret();
    requestAnimationFrame(() => {
      this.v2.fit();
      this.v3.view('iso');
    });
    this.saveSession();
  }

  loadExample(id: string) {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex || !this.confirmDiscard()) return;
    this.hideExercise();
    this.exampleId = id;
    this.loadProgram(ex.code, ex.title, ex.stock);
    this.setTarget(ex.target ?? null);
    toast(`Loaded: ${ex.title}`, 'ok');
  }

  allExercises(): Exercise[] {
    return [...EXERCISES, ...this.customExercises];
  }

  loadExercise(id: string) {
    const ex = this.allExercises().find((e) => e.id === id);
    if (ex) this.loadExerciseObject(ex);
  }

  loadExerciseObject(ex: Exercise) {
    if (!this.confirmDiscard()) return;
    this.exampleId = null;
    const code = store.get<string | null>('ex-code:' + ex.id, null) ?? ex.starter;
    this.showExercise(ex);
    this.loadProgram(code, ex.title, ex.stock);
  }

  saveCustomExercises() {
    store.set('customExercises', this.customExercises);
  }

  openBuilder() {
    builderDialog({
      stock: this.stock,
      stockDef: this.stockDef,
      settings: this.settings,
      currentCode: () => this.editor.getDoc(),
      customExercises: this.customExercises,
      saveCustomExercises: () => this.saveCustomExercises(),
      loadExerciseObject: (ex) => this.loadExerciseObject(ex),
    });
  }

  /** program produced by the wizard: load it together with its drawing */
  loadGenerated(code: string, target: Target, stock: StockDef, title: string) {
    if (!this.confirmDiscard()) return;
    this.hideExercise();
    this.exampleId = null;
    this.loadProgram(code, title, stock);
    this.setTarget(target);
    toast('Program generated – read it through, then press CYCLE START', 'ok', 5000);
  }

  private setTarget(t: Target | null) {
    this.target = t;
    if (t) {
      this.v2.target = { outer: contourFromGcode(t.outer, this.settings), inner: t.inner ? contourFromGcode(t.inner, this.settings) : [] };
      this.v2.tolerance = t.tol;
    } else this.v2.target = null;
    this.v2.deviations = [];
    this.v2.invalidate();
    $('#btnCheck').toggleAttribute('disabled', !t);
  }

  private showExercise(ex: Exercise) {
    this.exercise = ex;
    this.setTarget(ex.target);
    const card = $('#exerciseCard');
    let hintIdx = 0;
    const hints = h('ul');
    const outer = contourFromGcode(ex.target.outer, this.settings);
    const inner = ex.target.inner ? contourFromGcode(ex.target.inner, this.settings) : [];
    const brief = ex.custom ? textToHtml(ex.briefText ?? '') : ex.brief;
    const details = h('div', null, partDrawing(outer, inner, ex.stock.diameter / 2), h('div', { html: brief }), hints);
    const toggle = h('button', {
      class: 'collapse',
      title: 'Show / hide the exercise',
      'aria-expanded': 'true',
      onclick: () => {
        const hidden = details.classList.toggle('hidden');
        toggle.textContent = hidden ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!hidden));
      },
    }, '▾');
    fill(card,
      h('h3', null, toggle, ' ', ex.title, this.progress.has('ex:' + ex.id) ? '  ✔ passed' : ''),
      details,
      h('div', { class: 'row' },
        h('button', { onclick: () => { if (hintIdx < ex.hints.length) hints.append(h('li', null, ex.hints[hintIdx++])); } }, '💡 Hint'),
        h('button', { onclick: () => this.check() }, '✓ Check part'),
        h('button', {
          onclick: () => {
            confirmDialog('Replace your program with the reference solution?', 'Show solution', () => {
              this.editor.setDoc(ex.solution);
              this.newStock(false);
            });
          },
        }, 'Show solution'),
        h('button', { onclick: () => { this.editor.setDoc(ex.starter); } }, 'Restart'),
        h('button', { onclick: () => this.hideExercise() }, 'Close'),
      ),
    );
    card.classList.remove('hidden');
  }

  private hideExercise() {
    this.exercise = null;
    $('#exerciseCard').classList.add('hidden');
    this.setTarget(null);
    this.saveSession();
  }

  // ------------------------------------------------------------------ AppApi (dialogs)

  applyTools(tools: ToolDef[], offsets: Map<number, OffsetEntry>) {
    this.tools.splice(0, this.tools.length, ...tools);
    this.offsets = offsets;
    this.machine.tools = this.tools;
    this.machine.rebuildShapes();
    store.set('tools', this.tools);
    store.set('offsets', Array.from(this.offsets.entries()));
    this.needsReload = true;
    this.reinterpret();
    this.updateJogTools();
  }

  applyStock(def: StockDef) {
    this.stockDef = { ...def };
    this.stock.reset(this.stockDef);
    this.newStock(false);
    this.saveSession();
    requestAnimationFrame(() => {
      this.v2.fit();
      this.v3.view('iso');
    });
    toast(`New bar Ø${def.diameter} × ${def.length} loaded`, 'ok');
  }

  applySettings(s: MachineSettings, w: Record<number, P>, reload: boolean) {
    Object.assign(this.settings, s);
    this.workOffsets = w;
    this.reloadStockOnStart = reload;
    store.set('settings', this.settings);
    store.set('workOffsets', w);
    store.set('reloadStock', reload);
    this.needsReload = true;
    this.reinterpret();
  }

  saveProgress() {
    store.set('progress', Array.from(this.progress));
  }

  // ------------------------------------------------------------------ machine control

  /** fresh bar, tool home, control reset */
  newStock(msg = true) {
    if (this.running) this.reset();
    this.machine.resetAll();
    this.hadDropped = false;
    this.v2.deviations = [];
    this.v3.refresh();
    this.v2.invalidate();
    this.needsReload = true;
    if (msg) this.msg({ type: 'info', message: 'New bar loaded, tool at home position', line: -1 });
  }

  private loadIntoMachine(): boolean {
    this.result = interpret(this.editor.getDoc(), this.cfg(), this.initState());
    const r = this.result;
    this.editor.setDiagnostics(r.diags);
    const errs = r.diags.filter((d) => d.severity === 'error');
    if (errs.length) {
      this.tab('check');
      this.renderCheckList();
      toast(`The program has ${errs.length} error(s) – fix them first (see Program check).`, 'err', 5000);
      this.editor.goToLine(errs[0].line);
      return false;
    }
    this.machine.load(r.ops);
    this.v2.setOps(r.ops);
    this.v3.setOps(r.ops);
    this.v3.threads = r.threads;
    this.estimate = estimateTime(r.ops, this.settings);
    this.machine.time = 0;
    this.machine.cutTime = 0;
    this.needsReload = false;
    return true;
  }

  cycleStart() {
    const m = this.machine;
    if (m.status === 'alarm') {
      toast('Alarm active – press RESET first', 'err');
      return;
    }
    if (this.mode === 'JOG') {
      toast('CYCLE START works in AUTO and MDI mode', 'warn');
      return;
    }
    if (m.status === 'hold' || m.status === 'stopped') {
      if (this.mode === 'AUTO' && this.running === 'program' && this.needsReload) {
        toast('The program was changed – press RESET to restart it', 'warn');
        return;
      }
      m.status = 'running';
      return;
    }
    if (m.status === 'running') return;
    if (this.mode === 'MDI') return this.runMdi();
    // AUTO: start from the top
    if (m.status === 'done' && this.reloadStockOnStart) {
      this.machine.resetAll();
      this.v3.refresh();
      this.hadDropped = false;
      this.msg({ type: 'info', message: 'Fresh bar loaded for the new cycle (Settings → "Fresh bar at CYCLE START")', line: -1 });
    }
    if (!this.loadIntoMachine()) return;
    this.v2.deviations = [];
    this.running = 'program';
    this.opsSource = 'program';
    m.status = 'running';
    this.editor.setReadOnly(true);
    this.msg({ type: 'info', message: `Cycle start – estimated cycle time ${fmtTime(this.estimate.total)}`, line: -1 });
  }

  private runMdi() {
    const txt = ($('#mdiText') as HTMLTextAreaElement).value.trim();
    if (!txt) return;
    const r = interpret(txt, this.cfg(), this.initState(this.mdiState));
    const errs = r.diags.filter((d) => d.severity === 'error');
    if (errs.length) {
      toast('MDI: ' + errs[0].message, 'err', 5000);
      return;
    }
    const ops = r.ops.filter((o) => o.kind !== 'end');
    this.mdiState = r.state;
    this.mdiState.comp = 40;
    this.machine.load(ops);
    this.v2.setOps(ops);
    this.v3.setOps(ops);
    this.v3.threads = r.threads;
    this.running = 'mdi';
    this.opsSource = 'mdi';
    this.mdiText = txt;
    this.needsReload = true;
    this.machine.status = 'running';
    this.mdiHistory = [txt, ...this.mdiHistory.filter((x) => x !== txt)].slice(0, 12);
    $('#mdiHist').replaceChildren(...this.mdiHistory.map((t) => h('div', { title: 'Click to reuse', onclick: () => (($('#mdiText') as HTMLTextAreaElement).value = t) }, t.replace(/\n/g, ' ⏎ '))));
    for (const d of r.diags) if (d.severity === 'warning') this.msg({ type: 'warning', message: 'MDI: ' + d.message, line: -1 });
  }

  feedHold() {
    const m = this.machine;
    if (m.status === 'running') {
      const op = m.ops[m.i];
      if (op && op.kind === 'move' && op.type === 'thread') {
        this.holdPending = true;
        this.msg({ type: 'info', message: 'Feed hold during threading takes effect at the end of the pass', line: op.line });
        return;
      }
      m.status = 'hold';
      this.turbo = false;
    } else if (m.status === 'hold') m.status = 'running';
  }

  reset() {
    this.machine.controlReset();
    this.turbo = false;
    this.holdPending = false;
    this.running = null;
    this.editor.setReadOnly(false);
    this.editor.setExecLine(null);
    $('#alarmBanner').classList.add('hidden');
    if (this.needsReload || this.mode !== 'AUTO') this.reinterpret();
    else if (this.result) {
      this.v2.setOps(this.result.ops);
      this.v3.setOps(this.result.ops);
    }
  }

  check() {
    if (!this.target) {
      toast('This program has no target drawing. Load an exercise or an example with a drawing.', 'warn');
      return;
    }
    const res = checkPart(this.stock, this.target, this.settings);
    this.v2.deviations = res.samples;
    this.v2.invalidate();
    if (this.viewMode === '3d') this.setView('split');
    this.v2.opts.showTarget = true;
    const body = $('#inspectBody');
    const worst = res.samples.filter((s) => Math.abs(s.dev) > this.target!.tol);
    const zones: { z0: number; z1: number; max: number; inner: boolean }[] = [];
    for (const s of worst) {
      const last = zones[zones.length - 1];
      if (last && Math.abs(last.z1 - s.z) < 0.3 && last.inner === s.inner && Math.sign(last.max) === Math.sign(s.dev)) {
        last.z1 = s.z;
        if (Math.abs(s.dev) > Math.abs(last.max)) last.max = s.dev;
      } else zones.push({ z0: s.z, z1: s.z, max: s.dev, inner: s.inner });
    }
    fill(body,
      h('p', { class: res.pass ? 'pass' : 'fail' }, res.pass ? '✔ PART OK – within tolerance' : '✘ PART REJECTED'),
      h('ul', null, res.summary.map((s) => h('li', null, s))),
      zones.length
        ? h('table', { class: 'data' },
            h('tr', null, h('th', null, 'Surface'), h('th', null, 'Z from'), h('th', null, 'Z to'), h('th', { class: 'num' }, 'Worst ΔØ'), h('th', null, 'Meaning')),
            zones.slice(0, 30).map((zn) => h('tr', null, h('td', null, zn.inner ? 'bore' : 'outside'), h('td', null, Math.max(zn.z0, zn.z1).toFixed(2)), h('td', null, Math.min(zn.z0, zn.z1).toFixed(2)),
              h('td', { class: 'num' }, (zn.max > 0 ? '+' : '') + zn.max.toFixed(3)), h('td', null, zn.max > 0 ? 'material left (oversize)' : 'gouged (undersize)'))))
        : null,
      res.raZones.length
        ? h('details', null,
            h('summary', null, `Surface finish by zone (theoretical Ra = f² / 32·rε)${this.target.ra !== undefined ? ` – required Ra ≤ ${this.target.ra} µm` : ''}`),
            h('table', { class: 'data' },
              h('tr', null, h('th', null, 'Surface'), h('th', { class: 'num' }, 'Z from'), h('th', { class: 'num' }, 'Z to'), h('th', { class: 'num' }, 'Ra µm')),
              res.raZones.filter((z) => Math.abs(z.z1 - z.z0) > 0.3).map((z) => h('tr', null,
                h('td', null, z.inner ? 'bore' : 'outside'),
                h('td', { class: 'num' }, Math.max(z.z0, z.z1).toFixed(2)),
                h('td', { class: 'num' }, Math.min(z.z0, z.z1).toFixed(2)),
                h('td', { class: 'num' }, Number.isNaN(z.ra) ? 'raw bar' : z.ra.toFixed(2) + (this.target!.ra !== undefined && z.ra > this.target!.ra ? ' ✘' : ''))))))
        : null,
      h('p', { class: 'muted small' }, 'In the 2D view: blue whiskers = material left, red = gouge (exaggerated). Inside corners are not inspected – a turning tool always leaves its nose radius there. Tick "Ra map" to see the roughness of every surface.'),
    );
    this.tab('inspect');
    if (res.pass && this.exercise) {
      if (!this.progress.has('ex:' + this.exercise.id)) {
        this.progress.add('ex:' + this.exercise.id);
        this.saveProgress();
      }
      toast(`🎉 ${this.exercise.title} passed!`, 'ok', 6000);
    } else toast(res.pass ? 'Part OK' : 'Part out of tolerance – see Inspection', res.pass ? 'ok' : 'err');
  }

  // ------------------------------------------------------------------ messages

  private msg(e: SimEvent) {
    const list = $('#msgList');
    const ic = { alarm: '⛔', warning: '⚠', info: 'ℹ', stop: '⏸', end: '✔', partoff: '✂', toolchange: '🔧' }[e.type];
    const li = h('li', { class: e.type },
      h('span', { class: 'ic' }, ic),
      h('span', { class: 't' }, fmtTime(this.machine.time)),
      e.line >= 0 && this.opsSource === 'mdi'
        ? h('span', { class: 't' }, `MDI ${e.line + 1}`)
        : e.line >= 0 ? h('span', { class: 'ln', onclick: () => this.editor.goToLine(e.line) }, `L${e.line + 1}`) : null,
      h('span', null, e.message, e.hint ? h('span', { class: 'hint' }, e.hint) : null),
    );
    list.prepend(li);
    while (list.children.length > 200) list.lastChild?.remove();
  }

  private processEvents() {
    const evs = this.machine.events.splice(0);
    for (const e of evs) {
      if (e.type === 'end' && this.opsSource === 'mdi') e.message = 'MDI blocks executed';
      this.msg(e);
      if (e.type === 'alarm') {
        this.turbo = false;
        const b = $('#alarmBanner');
        fill(b,
          h('b', null, '⛔ ALARM: ' + e.message),
          e.hint ? h('p', null, e.hint) : null,
          e.line >= 0 ? h('p', null, `${this.opsSource === 'mdi' ? 'MDI block' : 'Block'} ${e.line + 1}: ${(this.opsSource === 'mdi' ? this.mdiText : this.editor.getDoc()).split('\n')[e.line]?.trim() ?? ''}`) : null,
          h('div', null,
            e.line >= 0 && this.opsSource === 'program' ? h('button', { onclick: () => this.editor.goToLine(e.line) }, 'Show block') : null,
            h('button', { onclick: () => this.reset() }, 'RESET'),
            h('button', { onclick: () => { this.reset(); this.newStock(); } }, 'RESET + new bar')),
        );
        b.classList.remove('hidden');
        toast('ALARM: ' + e.message, 'err', 6000);
      } else if (e.type === 'stop') {
        this.turbo = false;
        toast(e.message, 'info');
      } else if (e.type === 'end') {
        this.turbo = false;
        if (this.running === 'program') {
          this.msg({ type: 'end', message: `Cycle complete in ${fmtTime(this.machine.time)} (cutting ${fmtTime(this.machine.cutTime)})`, line: -1 });
          if (this.target) toast('Program finished – press “Check part” to inspect the result', 'ok', 5000);
        }
        // an MDI run leaves the machine ready (not "done"), so the next AUTO start keeps the bar
        if (this.opsSource === 'mdi' && this.machine.status === 'done') this.machine.status = 'idle';
        this.running = null;
        this.editor.setReadOnly(false);
      }
    }
    if (this.stock.dropped && !this.hadDropped) {
      this.hadDropped = true;
      this.msg({ type: 'partoff', message: 'Part cut off – it dropped into the parts catcher', line: -1 });
    }
  }

  // ------------------------------------------------------------------ frame loop

  private frame(now: number) {
    const last = (this as unknown as { _t?: number })._t ?? now;
    (this as unknown as { _t?: number })._t = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    const m = this.machine;

    if (this.jogDir && this.mode === 'JOG') this.jogStep(dt);

    if (m.status === 'running') {
      if (this.turbo) {
        const t0 = performance.now();
        while (m.status === 'running' && performance.now() - t0 < 28) m.advance(1.5);
      } else m.advance(dt * this.speed);
      if (this.holdPending) {
        const op = m.ops[m.i];
        if (!op || op.kind !== 'move' || op.type !== 'thread') {
          this.holdPending = false;
          if (m.status === 'running') m.status = 'hold';
        }
      }
    }
    this.processEvents();
    if (this.stepOnce && m.status !== 'running') {
      this.stepOnce = false;
      m.singleBlock = ($('#tSingle') as HTMLInputElement).checked;
    }
    this.sound.update(m);
    if (now - this.lastChart > 250 && !$('#tab-charts').classList.contains('hidden')) {
      this.lastChart = now;
      this.charts.samples = m.samples;
      this.charts.now = m.time;
      this.charts.total = this.estimate.total;
      this.charts.powerLimit = this.settings.powerKW;
      this.charts.draw();
    }

    // execution line
    const execOp = m.ops[Math.min(m.i, m.ops.length - 1)];
    const showExec = this.running === 'program' && ['running', 'hold', 'stopped', 'alarm'].includes(m.status);
    this.editor.setExecLine(showExec && execOp ? execOp.line : null);

    const sig = `${m.pos.x.toFixed(4)},${m.pos.z.toFixed(4)},${this.stock.version},${m.i},${m.tool},${m.status}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.v2.invalidate();
    }
    if (this.viewMode !== '3d') this.v2.draw();
    this.v3.update(dt, now);
    if (now - this.lastDro > 50) {
      this.lastDro = now;
      this.updateDro();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  private updateDro() {
    const m = this.machine;
    const L = m.live;
    const off = m.offset ? this.offsets.get(m.offset) : undefined;
    const w = this.workOffsets[54] ?? { x: 0, z: 0 };
    const absX = (m.pos.x - w.x - (off ? off.wx / 2 : 0)) * 2;
    const absZ = m.pos.z - w.z - (off ? off.wz : 0);
    $('#droX').textContent = absX.toFixed(3);
    $('#droZ').textContent = absZ.toFixed(3);
    const op = m.ops[m.i];
    if (op && op.kind === 'move' && (m.status === 'running' || m.status === 'hold' || m.status === 'stopped')) {
      $('#droDtg').textContent = `X ${((op.to.x - m.pos.x) * 2).toFixed(3)} Z ${(op.to.z - m.pos.z).toFixed(3)}`;
    } else $('#droDtg').textContent = 'X 0.000 Z 0.000';
    $('#droT').textContent = `T${String(m.tool).padStart(2, '0')}${String(m.offset).padStart(2, '0')}`;
    $('#droS').textContent = m.spindle.s ? `${m.spindle.s}${m.spindle.mode === 'css' ? ' m/min' : ''}` : '0';
    $('#droRpm').textContent = L.rpm.toFixed(0);
    $('#droVc').textContent = L.vc.toFixed(0);
    const mv = op && op.kind === 'move' ? op : null;
    $('#droF').textContent = mv ? (mv.type === 'rapid' ? 'rapid' : `${mv.feed}${mv.type === 'thread' ? ' lead' : mv.feedPerRev ? '/rev' : '/min'}`) : '–';
    $('#droFeed').textContent = m.status === 'running' ? L.feedMmMin.toFixed(0) : '0';
    // modal line
    const snap = this.result?.modal.get(L.line);
    if (snap && this.running) {
      const motion = mv ? (mv.type === 'rapid' ? 'G00' : mv.type === 'linear' ? 'G01' : mv.type === 'arc' ? (mv.cw ? 'G02' : 'G03') : 'G32') : `G${String(snap.motion).padStart(2, '0')}`;
      $('#droModal').textContent = `${motion} G18 ${snap.inch ? 'G20' : 'G21'} G${snap.comp} ${snap.css ? 'G96' : 'G97'} ${snap.feedPerRev ? 'G99' : 'G98'} G${snap.work}${mv?.cycle ? ' · ' + mv.cycle : ''}`;
    }
    const led = (id: string, on: boolean, cls = 'on') => {
      const e = $(id);
      e.classList.remove('on', 'warn', 'alarm');
      if (on) e.classList.add(cls);
    };
    led('#ledSpindle', m.spindle.dir !== 'off');
    $('#ledSpindle').textContent = m.spindle.dir === 'ccw' ? 'SPINDLE CCW' : m.spindle.dir === 'cw' ? 'SPINDLE CW' : 'SPINDLE';
    led('#ledCoolant', m.coolant);
    led('#ledCut', L.cutting && m.status === 'running');
    const st = $('#ledStatus');
    st.textContent = m.status === 'stopped' ? 'STOP' : m.status.toUpperCase();
    led('#ledStatus', m.status !== 'idle', m.status === 'alarm' ? 'alarm' : m.status === 'hold' || m.status === 'stopped' ? 'warn' : 'on');
    const pct = Math.min(100, (L.powerKW / this.settings.powerKW) * 100);
    ($('#loadBar') as HTMLElement).style.width = pct + '%';
    $('#loadV').textContent = `${L.powerKW.toFixed(1)} kW`;
    $('#mrrV').textContent = `${L.mrr.toFixed(1)} cm³/min`;
    $('#timeV').textContent = `${fmtTime(m.time)} / ${fmtTime(this.estimate.total)}`;
    this.updateTimeline();
    // status strip
    const lineTxt = L.line >= 0 ? this.editor.getDoc().split('\n')[L.line] ?? '' : '';
    $('#stripBlock').textContent = this.running && L.line >= 0 ? `N:${L.line + 1}  ${lineTxt.trim()}` : m.status === 'alarm' ? 'ALARM – press RESET' : this.mode === 'JOG' ? 'JOG mode – use the jog buttons or arrow keys' : 'Ready – press CYCLE START';
    $('#stripLabel').textContent = this.running ? L.label : '';
  }

  // ------------------------------------------------------------------ cursor / explain / lists

  private onCursor(line: number) {
    this.cursorLine = line;
    this.v2.selectedLine = line;
    this.v2.invalidate();
    const body = $('#explainBody');
    const r = this.result;
    if (!r || !r.blocks[line]) {
      body.replaceChildren();
      return;
    }
    let before;
    for (let l = line - 1; l >= 0; l--) {
      const s = r.modal.get(l);
      if (s) {
        before = s;
        break;
      }
    }
    const ex = explainBlock(r.blocks[line], before);
    const diags = r.diags.filter((d) => d.line === line);
    const trace = r.varTrace.get(line);
    const t = this.estimate.perLine.get(line);
    fill(body,
      h('p', { class: 'sum' }, h('b', null, `Line ${line + 1}: `), ex.summary || '(empty line)', t ? h('span', { class: 'muted' }, `  ⏱ ${t.toFixed(1)} s`) : null),
      ex.words.length
        ? h('table', null, ex.words.map((w) => h('tr', null, h('td', { class: 'k-' + w.kind }, w.word), h('td', null, w.text))))
        : null,
      trace ? h('div', { class: 'diag info' }, '▶ ' + trace + ' (last time this block ran)') : null,
      diags.map((d) => h('div', { class: 'diag ' + d.severity }, (d.severity === 'error' ? '⛔ ' : d.severity === 'warning' ? '⚠ ' : 'ℹ ') + d.message, d.hint ? h('div', { class: 'muted' }, d.hint) : null)),
    );
  }

  private renderCheckList() {
    const r = this.result;
    const list = $('#checkList');
    if (!r) return;
    if (!r.diags.length) {
      list.replaceChildren(h('li', { class: 'end' }, h('span', { class: 'ic' }, '✔'), h('span', null, 'No problems found. (The simulation still checks for crashes while running.)')));
      return;
    }
    list.replaceChildren(
      ...r.diags.map((d) =>
        h('li', { class: d.severity },
          h('span', { class: 'ic' }, d.severity === 'error' ? '⛔' : d.severity === 'warning' ? '⚠' : 'ℹ'),
          h('span', { class: 'ln', onclick: () => this.editor.goToLine(d.line) }, `L${d.line + 1}`),
          h('span', null, d.message, d.hint ? h('span', { class: 'hint' }, d.hint) : null)),
      ),
    );
  }

  private renderOps() {
    const r = this.result;
    if (!r) return;
    interface Grp { tool: number; line: number; first: number; last: number; time: number; cutLen: number; rapidLen: number; moves: number }
    const groups: Grp[] = [];
    let g: Grp | null = null;
    const perLine = this.estimate.perLine;
    const lineSeen = new Set<number>();
    for (const o of r.ops as Op[]) {
      if (o.kind === 'tool' || !g) {
        g = { tool: o.kind === 'tool' ? o.tool : this.machine.tool, line: o.line, first: o.line, last: o.line, time: 0, cutLen: 0, rapidLen: 0, moves: 0 };
        groups.push(g);
      }
      g.last = Math.max(g.last, o.line);
      if (!lineSeen.has(o.line)) {
        lineSeen.add(o.line);
        g.time += perLine.get(o.line) ?? 0;
      }
      if (o.kind === 'move') {
        const L = moveLength(o as MoveOp);
        if (o.type === 'rapid') g.rapidLen += L;
        else g.cutLen += L;
        g.moves++;
      }
    }
    const rows = groups.filter((x) => x.moves > 0);
    $('#opsTable').replaceChildren(
      h('table', { class: 'data' },
        h('tr', null, ['Tool', 'Description', 'From line', 'Moves', 'Feed path mm', 'Rapid mm', 'Time'].map((c, i) => h('th', { class: i >= 3 ? 'num' : '' }, c))),
        rows.map((x) => {
          const t = this.tools.find((tt) => tt.id === x.tool);
          return h('tr', null,
            h('td', null, `T${String(x.tool).padStart(2, '0')}`),
            h('td', null, t ? `${t.name} (${TOOL_TYPE_LABEL[t.type]})` : '(empty station)'),
            h('td', null, h('span', { class: 'ln', style: { cursor: 'pointer', color: 'var(--info)' }, onclick: () => this.editor.goToLine(x.line) }, `L${x.line + 1}`)),
            h('td', { class: 'num' }, x.moves),
            h('td', { class: 'num' }, x.cutLen.toFixed(0)),
            h('td', { class: 'num' }, x.rapidLen.toFixed(0)),
            h('td', { class: 'num' }, fmtTime(x.time)));
        }),
        h('tr', null, h('td', { colspan: 6 }, h('b', null, `Total (cutting ${fmtTime(this.estimate.cutting)})`)), h('td', { class: 'num' }, h('b', null, fmtTime(this.estimate.total)))),
      ),
    );
  }

  // ------------------------------------------------------------------ views / modes

  setView(v: '2d' | '3d' | 'split') {
    this.viewMode = v;
    $('#views').dataset.mode = v;
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    $('#opts2d').classList.toggle('hidden', v === '3d');
    $('#opts3d').classList.toggle('hidden', v === '2d');
    this.v3.setVisible(v !== '2d');
    store.set('view', v);
    requestAnimationFrame(() => {
      this.v2.resize();
      this.v3.resize();
    });
  }

  private setMode(m: Mode) {
    if (this.running && this.machine.status !== 'idle' && this.machine.status !== 'done') {
      toast('Stop the machine first (RESET)', 'warn');
      return;
    }
    if (this.mode === 'MDI' && m !== 'MDI') this.reinterpret();
    this.mode = m;
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    for (const p of ['AUTO', 'MDI', 'JOG']) $('#panel' + p).classList.toggle('hidden', p !== m);
    if (m === 'JOG') this.updateJogTools();
  }

  private applyThemeTo3D() {
    const light = isLightTheme();
    (this.v3.scene.background as import('three').Color).set(light ? 0xdde3ea : 0x1b2128);
    this.v3.forceRender = true;
  }

  private tab(name: string) {
    $$('#bottomTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    for (const t of ['messages', 'check', 'ops', 'inspect', 'charts']) $('#tab-' + t).classList.toggle('hidden', t !== name);
    $('.bottom').classList.toggle('tall', name === 'charts');
    if (name === 'charts') {
      requestAnimationFrame(() => {
        this.v2.resize();
        this.v3.resize();
        this.charts.samples = this.machine.samples;
        this.charts.now = this.machine.time;
        this.charts.total = this.estimate.total;
        this.charts.resize();
        this.renderChartTable();
      });
    }
  }

  private renderChartTable() {
    const host = $('#chartTable');
    if (host.classList.contains('hidden')) return;
    const rows = summarizeByLine(this.machine.samples);
    fill(host, rows.length
      ? h('table', { class: 'data' },
          h('tr', null, ['Line', 'Tool', 'From', 'To', 'Max rpm', 'Max feed mm/min', 'Max kW'].map((c, i) => h('th', { class: i >= 2 ? 'num' : '' }, c))),
          rows.map((r) => h('tr', null,
            h('td', null, h('span', { class: 'ln', style: { cursor: 'pointer', color: 'var(--info)' }, onclick: () => this.editor.goToLine(r.line) }, `L${r.line + 1}`)),
            h('td', null, `T${String(r.tool).padStart(2, '0')}`),
            h('td', { class: 'num' }, fmtTime(r.t0)),
            h('td', { class: 'num' }, fmtTime(r.t1)),
            h('td', { class: 'num' }, r.rpmMax.toFixed(0)),
            h('td', { class: 'num' }, r.feedMax.toFixed(0)),
            h('td', { class: 'num' }, r.kwMax.toFixed(2)))))
      : h('p', { class: 'muted' }, 'No data yet – run the program.'));
  }

  // ------------------------------------------------------------------ timeline

  private updateTimeline() {
    const m = this.machine;
    const total = Math.max(this.estimate.total, m.time, 0.1);
    const sl = $('#tlSlider') as HTMLInputElement;
    sl.max = String(Math.round(total * 10));
    if (!this.tlDragging) sl.value = String(Math.round(m.time * 10));
    $('#tlTime').textContent = `${fmtTime(this.tlDragging ? +sl.value / 10 : m.time)} / ${fmtTime(total)}`;
    const op = m.ops[Math.min(m.i, m.ops.length - 1)];
    $('#tlBlock').textContent = this.running && op ? `L${op.line + 1} ${(this.editor.getDoc().split('\n')[op.line] ?? '').trim()}` : '';
    // tool bands on the track
    const ops = this.result?.ops ?? [];
    const key = `${ops.length}|${this.estimate.total}`;
    if (key !== this.tlKey && this.estimate.opStart.length === ops.length) {
      this.tlKey = key;
      const stops: string[] = [];
      let tool = -1, t0 = 0, k = 0;
      const tot = this.estimate.total || 1;
      const push = (t1: number) => {
        if (tool < 0) return;
        const c = k++ % 2 ? 'var(--muted)' : 'var(--accent)';
        stops.push(`${c} ${((t0 / tot) * 100).toFixed(2)}% ${((t1 / tot) * 100).toFixed(2)}%`);
      };
      ops.forEach((o, i) => {
        if (o.kind === 'tool') {
          push(this.estimate.opStart[i]);
          tool = o.tool;
          t0 = this.estimate.opStart[i];
        }
      });
      push(tot);
      $('#tlTrack').style.background = stops.length ? `linear-gradient(90deg, ${stops.join(', ')})` : '';
    }
  }

  /** jump the simulation to machine time t (re-simulates from the start at full speed) */
  seek(t: number) {
    if (this.mode !== 'AUTO') {
      toast('The timeline works in AUTO mode', 'warn');
      return;
    }
    const m = this.machine;
    if (this.running !== 'program' || this.needsReload) {
      if (this.running) this.reset();
      if (!this.loadIntoMachine()) return;
      this.running = 'program';
      this.opsSource = 'program';
      this.editor.setReadOnly(true);
    }
    const saved = { fo: m.feedOverride, ro: m.rapidOverride, so: m.spindleOverride, sb: m.singleBlock, os: m.optionalStop };
    m.feedOverride = 1;
    m.rapidOverride = 1;
    m.spindleOverride = 1;
    m.singleBlock = false;
    m.optionalStop = false;
    m.resetAll();
    this.hadDropped = false;
    $('#alarmBanner').classList.add('hidden');
    m.status = 'running';
    for (let guard = 0; m.time < t - 1e-6 && guard < 200000; guard++) {
      if ((m.status as string) === 'stopped') m.status = 'running';
      if (m.status !== 'running') break;
      m.advance(Math.min(2, t - m.time + 1e-6));
    }
    m.feedOverride = saved.fo;
    m.rapidOverride = saved.ro;
    m.spindleOverride = saved.so;
    m.singleBlock = saved.sb;
    m.optionalStop = saved.os;
    m.events = m.events.filter((e) => e.type === 'alarm' || e.type === 'end');
    if (m.status === 'running') m.status = 'hold';
    this.turbo = false;
    this.v3.refresh();
    this.v2.invalidate();
  }

  private stepBack() {
    const m = this.machine;
    const ops = m.ops;
    if (this.running !== 'program' || !ops.length) return;
    const i = Math.min(m.i, ops.length - 1);
    const line = (k: number) => ops[k].line;
    let k = i;
    while (k > 0 && line(k - 1) === line(i)) k--;
    if (m.time - (this.estimate.opStart[k] ?? 0) < 0.05 && k > 0) {
      const L = line(k - 1);
      k--;
      while (k > 0 && line(k - 1) === L) k--;
    }
    this.seek(this.estimate.opStart[k] ?? 0);
  }

  private stepForward() {
    const m = this.machine;
    if (this.mode !== 'AUTO') return;
    if (m.status === 'alarm') {
      toast('Alarm active – press RESET first', 'err');
      return;
    }
    this.stepOnce = true;
    m.singleBlock = true;
    if (m.status === 'hold' || m.status === 'stopped') m.status = 'running';
    else this.cycleStart();
  }

  // ------------------------------------------------------------------ jog

  private updateJogTools() {
    const sel = $('#jogTool') as HTMLSelectElement;
    sel.replaceChildren(...this.tools.map((t) => h('option', { value: String(t.id), selected: t.id === this.machine.tool }, `T${String(t.id).padStart(2, '0')} ${t.name}`)));
  }

  private jogStep(dt: number) {
    const m = this.machine;
    if (!this.jogDir || m.status === 'alarm' || m.status === 'running') return;
    const rate = this.jogRapid ? this.settings.rapidRate * m.rapidOverride : parseFloat(($('#jogFeed') as HTMLInputElement).value);
    const d = (rate / 60) * dt;
    const tgt = { x: m.pos.x + this.jogDir.x * d / 2, z: m.pos.z + this.jogDir.z * d };
    m.jog(tgt, rate, this.jogRapid);
  }

  private jogIncrement(dir: { x: number; z: number }) {
    const m = this.machine;
    if (m.status === 'alarm') {
      toast('Alarm active – press RESET', 'err');
      return;
    }
    const inc = this.jogInc;
    const tgt = { x: m.pos.x + (dir.x * inc) / 2, z: m.pos.z + dir.z * inc };
    const rate = this.jogRapid ? this.settings.rapidRate : parseFloat(($('#jogFeed') as HTMLInputElement).value);
    m.jog(tgt, rate, this.jogRapid);
  }

  // ------------------------------------------------------------------ UI bindings

  private bindUi() {
    const acts: Record<string, () => void> = {
      examples: () => D.examplesDialog(this),
      exercises: () => D.exercisesDialog(this),
      lessons: () => D.lessonsDialog(this),
      reference: () => D.referenceDialog(),
      tools: () => D.toolsDialog(this),
      stock: () => D.stockDialog(this),
      calc: () => D.calcDialog(this.stockDef.material),
      settings: () => D.settingsDialog(this),
      help: () => D.helpDialog(),
      wizard: () => wizardDialog(this),
      sound: () => {
        const b = $('#soundBtn');
        if (this.sound.enabled) this.sound.disable();
        else if (!this.sound.enable()) toast('This browser has no audio support', 'warn');
        b.textContent = this.sound.enabled ? 'Sound on' : 'Sound off';
        b.setAttribute('aria-pressed', String(this.sound.enabled));
      },
      new: () => {
        if (!this.confirmDiscard()) return;
        confirmDialog('Start a new, empty program? The current program is replaced.', 'New program', () => {
          this.hideExercise();
          this.exampleId = null;
          this.loadProgram(EXAMPLES.find((e) => e.id === 'mdi')!.code, 'New program', null);
        });
      },
      open: () => ($('#fileInput') as HTMLInputElement).click(),
      save: () => this.saveFile(),
      theme: () => {
        const cur = isLightTheme() ? 'dark' : 'light';
        document.documentElement.dataset.theme = cur;
        store.set('theme', cur);
        this.v2.refreshColors();
        this.applyThemeTo3D();
      },
    };
    $$('.menu button').forEach((b) => b.addEventListener('click', () => acts[b.dataset.act!]?.()));
    ($('#fileInput') as HTMLInputElement).addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      f.text().then((txt) => {
        this.hideExercise();
        this.exampleId = null;
        this.loadProgram(txt, f.name, null);
        toast(`Opened ${f.name}`, 'ok');
      });
      (e.target as HTMLInputElement).value = '';
    });

    $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view as '2d')));
    $$('#opts2d input[data-opt]').forEach((inp) =>
      inp.addEventListener('change', () => {
        (this.v2.opts as unknown as Record<string, boolean>)[inp.dataset.opt!] = (inp as HTMLInputElement).checked;
        if (inp.dataset.opt === 'mirror') this.v2.fit();
        this.v2.invalidate();
      }),
    );
    $('#opt3dPath').addEventListener('change', (e) => (this.v3.showPath = (e.target as HTMLInputElement).checked));
    $('#opt3dSection').addEventListener('change', (e) => {
      this.v3.section = (e.target as HTMLInputElement).checked;
      this.v3.refresh();
    });
    $$('[data-cam]').forEach((b) => b.addEventListener('click', () => this.v3.view(b.dataset.cam as 'iso')));
    $('#fitBtn').addEventListener('click', () => {
      this.v2.fit();
      this.v3.view('iso');
    });
    $('#shotBtn').addEventListener('click', () => {
      const url = this.viewMode === '2d' ? this.v2.canvas.toDataURL('image/png') : this.v3.snapshot();
      fetch(url).then((r) => r.blob()).then((b) => download('lathelab-view.png', b));
    });
    $$('#bottomTabs button').forEach((b) => b.addEventListener('click', () => this.tab(b.dataset.tab!)));
    $('#chartTableBtn').addEventListener('click', (e) => {
      const tbl = $('#chartTable');
      const on = tbl.classList.toggle('hidden') === false;
      $('#chartHost').classList.toggle('hidden', on);
      (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
      (e.currentTarget as HTMLElement).textContent = on ? 'Chart' : 'Table';
      if (on) this.renderChartTable();
      else requestAnimationFrame(() => this.charts.resize());
    });
    const sl = $('#tlSlider') as HTMLInputElement;
    sl.addEventListener('input', () => (this.tlDragging = true));
    sl.addEventListener('change', () => {
      this.tlDragging = false;
      this.seek(+sl.value / 10);
    });
    $('#tlBack').addEventListener('click', () => this.stepBack());
    $('#tlFwd').addEventListener('click', () => this.stepForward());

    $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode as Mode)));
    $('#btnStart').addEventListener('click', () => this.cycleStart());
    $('#btnHold').addEventListener('click', () => this.feedHold());
    $('#btnReset').addEventListener('click', () => this.reset());
    $('#btnInstant').addEventListener('click', () => {
      if (this.machine.status !== 'running') this.cycleStart();
      if (this.machine.status === 'running') this.turbo = true;
    });
    $('#btnNewStock').addEventListener('click', () => this.newStock());
    $('#btnCheck').addEventListener('click', () => this.check());

    const tSingle = $('#tSingle') as HTMLInputElement;
    tSingle.addEventListener('change', () => (this.machine.singleBlock = tSingle.checked));
    const tOpt = $('#tOpt') as HTMLInputElement;
    tOpt.addEventListener('change', () => (this.machine.optionalStop = tOpt.checked));
    $('#tSkip').addEventListener('change', () => {
      this.needsReload = true;
      this.reinterpret();
    });

    const ovFeed = $('#ovFeed') as HTMLInputElement;
    ovFeed.addEventListener('input', () => {
      this.machine.feedOverride = +ovFeed.value / 100;
      $('#ovFeedV').textContent = ovFeed.value + '%';
    });
    const ovSp = $('#ovSpindle') as HTMLInputElement;
    ovSp.addEventListener('input', () => {
      this.machine.spindleOverride = +ovSp.value / 100;
      $('#ovSpindleV').textContent = ovSp.value + '%';
    });
    $$('#ovRapid button').forEach((b) =>
      b.addEventListener('click', () => {
        this.machine.rapidOverride = +b.dataset.v!;
        $$('#ovRapid button').forEach((x) => x.classList.toggle('on', x === b));
      }),
    );
    const sp = $('#simSpeed') as HTMLInputElement;
    sp.value = String(SPEEDS.indexOf(this.speed));
    const spUpd = () => {
      this.speed = SPEEDS[+sp.value];
      $('#simSpeedV').textContent = '×' + this.speed;
    };
    sp.addEventListener('input', spUpd);
    spUpd();

    // jog
    $$('[data-jog]').forEach((b) => {
      const d = b.dataset.jog!;
      if (d === 'rapid') {
        b.addEventListener('click', () => {
          this.jogRapid = !this.jogRapid;
          b.classList.toggle('on', this.jogRapid);
        });
        return;
      }
      const dir = { 'x+': { x: 1, z: 0 }, 'x-': { x: -1, z: 0 }, 'z+': { x: 0, z: 1 }, 'z-': { x: 0, z: -1 } }[d]!;
      b.addEventListener('pointerdown', () => {
        if (this.jogInc === 0) this.jogDir = dir;
        else this.jogIncrement(dir);
      });
      const stop = () => (this.jogDir = null);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
    });
    $$('#jogInc button').forEach((b) =>
      b.addEventListener('click', () => {
        this.jogInc = +b.dataset.v!;
        $$('#jogInc button').forEach((x) => x.classList.toggle('on', x === b));
      }),
    );
    const jf = $('#jogFeed') as HTMLInputElement;
    jf.addEventListener('input', () => ($('#jogFeedV').textContent = jf.value + ' mm/min'));
    const spindle = (dir: 'cw' | 'ccw' | 'off') => {
      const rpm = Math.min(this.settings.maxRpm, Math.max(0, +($('#spRpm') as HTMLInputElement).value || 0));
      this.machine.spindle = { mode: 'rpm', s: rpm, maxRpm: this.settings.maxRpm, dir };
    };
    $('#spCW').addEventListener('click', () => spindle('cw'));
    $('#spCCW').addEventListener('click', () => spindle('ccw'));
    $('#spStop').addEventListener('click', () => spindle('off'));
    $('#jogTool').addEventListener('change', (e) => {
      const id = +(e.target as HTMLSelectElement).value;
      this.machine.tool = id;
      this.machine.offset = id;
      this.msg({ type: 'toolchange', message: `Manual turret index → T${String(id).padStart(2, '0')}`, line: -1 });
    });
    $('#jogCool').addEventListener('click', (e) => {
      this.machine.coolant = !this.machine.coolant;
      (e.currentTarget as HTMLElement).classList.toggle('on', this.machine.coolant);
    });

    // keyboard
    const inField = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t.closest('.cm-editor') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
    };
    document.addEventListener('keydown', (e) => {
      if (dialogOpen()) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.cycleStart();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveFile();
      } else if (e.key === 'Escape') this.reset();
      else if (e.key === ' ' && !inField(e)) {
        e.preventDefault();
        this.feedHold();
      } else if (this.mode === 'JOG' && !inField(e) && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const dir = { ArrowUp: { x: 1, z: 0 }, ArrowDown: { x: -1, z: 0 }, ArrowLeft: { x: 0, z: -1 }, ArrowRight: { x: 0, z: 1 } }[e.key]!;
        this.jogRapid = e.shiftKey;
        if (this.jogInc === 0) this.jogDir = dir;
        else if (!e.repeat) this.jogIncrement(dir);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key.startsWith('Arrow')) {
        this.jogDir = null;
        if (this.jogRapid && !($('#jogRapid').classList.contains('on'))) this.jogRapid = false;
      }
    });
    window.addEventListener('beforeunload', () => this.saveSession());
  }

  private saveFile() {
    const m = /^\s*O(\d+)/m.exec(this.editor.getDoc());
    download(`O${m ? m[1].padStart(4, '0') : '0001'}.nc`, this.editor.getDoc());
  }
}

declare global {
  interface Window {
    lathelab: App;
  }
}
window.lathelab = new App();
