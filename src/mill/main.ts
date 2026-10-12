import '../style.css';
import './mill.css';
import type { BlockStock, MillMove, MillOffset, MillOp, MillSettings, MillTool, V3 } from './types';
import { interpretMill, millDefaultState, pointOffset, tipFromProgZ, type MillConfig, type MillResult, type MillState } from './interp';
import { explainMillBlock } from './explain';
import { BlockModel, ORIGIN_NAMES } from './stock';
import { MillMachine, estimateMillTime, type MillEvent } from './machine';
import { defaultMillTools, defaultMillOffsets, MILL_TOOL_LABEL } from './tools';
import { moveLength3 } from './path';
import { DEFAULT_MILL, DEFAULT_MILL_WORK } from './defaults';
import { MILL_EXAMPLES, type MillExample } from './content/examples';
import { MILL_EXERCISES, type MillExercise } from './content/exercises';
import { MILL_G, MILL_M, findMillCode } from './ref';
import { simulateBlock, checkBlock } from './inspect';
import { MillView2D, type View2DMode } from './view2d';
import { MillView3D } from './view3d';
import { createEditor, type Editor } from '../ui/editor';
import { h, $, $$, toast, fmtTime, download, store, dialogOpen, fill, confirmDialog, isLightTheme } from '../ui/dom';
import { Charts, summarizeByLine } from '../view/charts';
import { MachineSound } from '../ui/sound';
import * as D from './dialogs';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
type Mode = 'AUTO' | 'MDI' | 'JOG';
type ViewKey = View2DMode | '3d' | 'split';
const S = (k: string) => 'mill:' + k;

class MillApp implements D.MillAppApi {
  tools: MillTool[];
  offsets: Map<number, MillOffset>;
  stockDef: BlockStock;
  settings: MillSettings;
  workOffsets: Record<number, V3>;
  progress: Set<string>;
  customExercises: MillExercise[];
  reloadStockOnStart: boolean;

  block: BlockModel;
  machine: MillMachine;
  editor: Editor;
  v2: MillView2D;
  v3: MillView3D;
  charts: Charts;
  sound = new MachineSound();

  result: MillResult | null = null;
  needsReload = true;
  mode: Mode = 'AUTO';
  view: ViewKey = '3d';
  speed = 4;
  exercise: MillExercise | null = null;
  turbo = false;
  running: 'program' | 'mdi' | null = null;
  opsSource: 'program' | 'mdi' = 'program';
  mdiText = '';
  mdiState: MillState | null = null;
  mdiHistory: string[] = [];
  estimate = { total: 0, cutting: 0, perLine: new Map<number, number>(), opStart: [] as number[] };
  private interpTimer = 0;
  private saveTimer = 0;
  private lastSig = '';
  private lastDro = 0;
  private lastChart = 0;
  private cursorLine = 0;
  private jogDir: V3 | null = null;
  private jogRapid = false;
  private jogInc = 1;
  private stepOnce = false;
  private tlDragging = false;
  private tlKey = '';
  private t0 = 0;

  constructor() {
    this.tools = store.get(S('tools'), defaultMillTools());
    this.offsets = new Map(store.get<[number, MillOffset][]>(S('offsets'), Array.from(defaultMillOffsets(this.tools).entries())));
    this.settings = { ...DEFAULT_MILL, ...store.get(S('settings'), {}) };
    this.workOffsets = store.get(S('work'), DEFAULT_MILL_WORK);
    this.progress = new Set(store.get<string[]>('progress', []));
    this.customExercises = store.get<MillExercise[]>(S('customExercises'), []);
    this.reloadStockOnStart = store.get(S('reloadStock'), true);
    const theme = store.get<string | null>('theme', null);
    if (theme) document.documentElement.dataset.theme = theme;

    const saved = store.get<{ code: string; stock: BlockStock; exerciseId: string | null } | null>(S('session'), null);
    const first = MILL_EXAMPLES.find((e) => e.id === 'm-contour')!;
    this.stockDef = saved?.stock ?? { ...first.stock };
    this.block = new BlockModel(this.stockDef);
    this.machine = new MillMachine(this.block, this.tools, this.settings);
    this.editor = createEditor($('#editor'), saved?.code ?? first.code, () => this.onCodeChange(), (l) => this.onCursor(l), { find: findMillCode, gcodes: MILL_G, mcodes: MILL_M, axes: 'XYZ' });
    this.v2 = new MillView2D($('#view2d'), this.machine);
    this.v3 = new MillView3D($('#view3d'), this.machine);
    this.charts = new Charts($('#chartHost'));
    this.charts.onSeek = (t) => this.seek(t);
    this.v2.onPick = (line) => {
      this.editor.goToLine(line);
      this.v2.selectedLine = line;
    };
    this.bindUi();
    this.updateConv();
    this.applyTheme();
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => this.applyTheme());
    if (saved?.exerciseId) {
      const ex = this.allExercises().find((e) => e.id === saved.exerciseId);
      if (ex) this.showExercise(ex);
    }
    this.updateSectionSlider();
    this.reinterpret();
    this.setView(store.get<ViewKey>(S('view'), window.innerWidth < 820 ? 'top' : '3d'));
    if (!store.get(S('welcomed'), false)) {
      store.set(S('welcomed'), true);
      setTimeout(() => toast('Welcome to the milling simulator! Press CYCLE START to run the loaded contour example, or open Lessons.', 'info', 8000), 600);
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ program

  cfg(): MillConfig {
    return { tools: this.tools, offsets: this.offsets, settings: this.settings, workOffsets: this.workOffsets, blockSkip: ($('#tSkip') as HTMLInputElement).checked, stock: this.stockDef };
  }

  private initState(base?: MillState | null): MillState {
    const s = base ? (JSON.parse(JSON.stringify(base)) as MillState) : millDefaultState(this.settings, this.tools);
    const m = this.machine;
    const w = this.workOffsets[s.work] ?? { x: 0, y: 0, z: 0 };
    s.tip = { ...m.pos };
    if (s.autoLen && s.hReg === s.tool) s.hReg = m.tool;
    s.tool = m.tool;
    s.nextTool = m.tool;
    s.rpm = m.spindle.rpm;
    s.dir = m.spindle.dir;
    s.coolant = m.coolant;
    s.pos = { x: m.pos.x - w.x - s.local.x, y: m.pos.y - w.y - s.local.y, z: m.pos.z - w.z - s.local.z - tipFromProgZ(0, s, this.cfg()) };
    return s;
  }

  currentCode() {
    return this.editor.getDoc();
  }

  private onCodeChange() {
    this.needsReload = true;
    clearTimeout(this.interpTimer);
    this.interpTimer = window.setTimeout(() => this.reinterpret(), 250);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveSession(), 800);
  }

  reinterpret() {
    const idle = !this.running;
    this.result = interpretMill(this.editor.getDoc(), this.cfg(), idle ? this.initState() : undefined);
    const r = this.result;
    if (idle) {
      this.v2.setOps(r.ops);
      this.v3.setOps(r.ops);
      this.estimate = estimateMillTime(r.ops, this.settings);
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
    const m = /^\s*O(\d+)\s*(\(([^)]*)\))?/m.exec(this.editor.getDoc());
    const prog = m ? `O${m[1].padStart(4, '0')}${m[3] ? ' – ' + m[3].trim() : ''}` : 'Program';
    $('#progTitle').textContent = prog;
    document.title = `${prog} · MillLab`;
  }

  private saveSession() {
    store.set(S('session'), { code: this.editor.getDoc(), stock: this.stockDef, exerciseId: this.exercise?.id ?? null });
    if (this.exercise) store.set(S('ex-code:') + this.exercise.id, this.editor.getDoc());
  }

  private confirmIdle() {
    if (this.running) {
      toast('Stop the machine first (RESET)', 'warn');
      return false;
    }
    return true;
  }

  private loadProgram(code: string, stock: BlockStock | null) {
    this.editor.setDoc(code);
    if (stock) {
      this.stockDef = { ...stock };
      this.block.reset(this.stockDef);
    }
    this.updateConv();
    this.newStock(false);
    this.updateSectionSlider();
    this.reinterpret();
    requestAnimationFrame(() => {
      this.v2.fit();
      this.v3.view('iso');
    });
    this.saveSession();
  }

  loadExample(ex: MillExample) {
    if (!this.confirmIdle()) return;
    this.hideExercise();
    this.loadProgram(ex.code, ex.stock);
    toast(`Loaded: ${ex.title}`, 'ok');
  }

  allExercises() {
    return [...MILL_EXERCISES, ...this.customExercises];
  }

  loadExercise(ex: MillExercise) {
    if (!this.confirmIdle()) return;
    const code = store.get<string | null>(S('ex-code:') + ex.id, null) ?? ex.starter;
    this.showExercise(ex);
    this.loadProgram(code, ex.stock);
  }

  loadGenerated(code: string, stock: BlockStock, title: string) {
    if (!this.confirmIdle()) return;
    this.hideExercise();
    this.loadProgram(code, stock);
    toast(`“${title}” generated – read it through, then press CYCLE START`, 'ok', 5000);
  }

  private showExercise(ex: MillExercise) {
    this.exercise = ex;
    const card = $('#exerciseCard');
    let hintIdx = 0;
    const hints = h('ul');
    const details = h('div', null, h('div', { html: ex.brief }), hints);
    const toggle = h('button', { class: 'collapse', 'aria-expanded': 'true', onclick: () => {
      const hid = details.classList.toggle('hidden');
      toggle.textContent = hid ? '▸' : '▾';
      toggle.setAttribute('aria-expanded', String(!hid));
    } }, '▾');
    fill(card,
      h('h3', null, toggle, ' ', ex.title, this.progress.has('mex:' + ex.id) ? '  ✔ passed' : ''),
      details,
      h('div', { class: 'row' },
        h('button', { onclick: () => { if (hintIdx < ex.hints.length) hints.append(h('li', null, ex.hints[hintIdx++])); } }, '💡 Hint'),
        h('button', { onclick: () => this.showTargetPreview() }, 'Show target'),
        h('button', { onclick: () => this.check() }, '✓ Check part'),
        h('button', { onclick: () => confirmDialog('Replace your program with the reference solution?', 'Show solution', () => { this.editor.setDoc(ex.solution); this.newStock(false); }) }, 'Show solution'),
        h('button', { onclick: () => this.editor.setDoc(ex.starter) }, 'Restart'),
        h('button', { onclick: () => this.hideExercise() }, 'Close')));
    card.classList.remove('hidden');
    $('#btnCheck').removeAttribute('disabled');
  }

  private hideExercise() {
    this.exercise = null;
    $('#exerciseCard').classList.add('hidden');
    this.v2.setDeviation(null, 0);
    $('#btnCheck').setAttribute('disabled', '');
    this.saveSession();
  }

  /** draw the target part (reference solution) into the inspection tab */
  private showTargetPreview() {
    if (!this.exercise) return;
    const ref = simulateBlock(this.exercise.solution, this.exercise.stock, this.cfg(), this.exercise.conventions);
    const c = h('canvas', { class: 'target-img' });
    const img = c.getContext('2d')!;
    c.width = ref.nx;
    c.height = ref.ny;
    const id = img.createImageData(ref.nx, ref.ny);
    for (let j = 0; j < ref.ny; j++) for (let i = 0; i < ref.nx; i++) {
      const hk = ref.h[j * ref.nx + i];
      const t = Math.min(1, Math.max(0, (ref.top - hk) / (ref.top - ref.bottom)));
      const p = ((ref.ny - 1 - j) * ref.nx + i) * 4;
      const v = hk <= ref.bottom + 0.01 ? 30 : 230 - t * 170;
      id.data[p] = v * 0.85;
      id.data[p + 1] = v * 0.93;
      id.data[p + 2] = v;
      id.data[p + 3] = 255;
    }
    img.putImageData(id, 0, 0);
    fill($('#inspectBody'), h('p', null, h('b', null, 'Target part (top view, darker = deeper). '), 'Hover over the Top view of your own part to compare heights.'), c);
    this.tab('inspect');
  }

  check() {
    if (!this.exercise) {
      toast('Load an exercise first – it defines the target part.', 'warn');
      return;
    }
    const ex = this.exercise;
    const ref = simulateBlock(ex.solution, ex.stock, this.cfg(), ex.conventions);
    const res = checkBlock(this.block, ref, ex.tol);
    this.v2.setDeviation(res.dev, ex.tol);
    if (this.view === '3d') this.setView('split');
    if (this.v2.mode !== 'top') this.setView('top');
    fill($('#inspectBody'),
      h('p', { class: res.pass ? 'pass' : 'fail' }, res.pass ? '✔ PART OK – within tolerance' : '✘ PART REJECTED'),
      h('ul', null, res.summary.map((s) => h('li', null, s))),
      h('p', { class: 'muted small' }, 'Top view: blue = material left, red = gouged (outside ±tolerance). Walls are judged through the floors and tops next to them.'));
    this.tab('inspect');
    if (res.pass) {
      if (!this.progress.has('mex:' + ex.id)) {
        this.progress.add('mex:' + ex.id);
        this.saveProgress();
      }
      toast(`🎉 ${ex.title} passed!`, 'ok', 6000);
    } else toast('Part out of tolerance – see Inspection', 'err');
  }

  // ------------------------------------------------------------------ dialogs API

  applyTools(tools: MillTool[], offsets: Map<number, MillOffset>) {
    this.tools.splice(0, this.tools.length, ...tools);
    this.offsets = offsets;
    this.machine.tools = this.tools;
    store.set(S('tools'), this.tools);
    store.set(S('offsets'), Array.from(offsets.entries()));
    this.needsReload = true;
    this.reinterpret();
    this.updateJogTools();
  }
  applyStock(def: BlockStock, message?: string) {
    this.stockDef = { ...def };
    this.updateConv();
    this.block.reset(this.stockDef);
    this.newStock(false);
    this.updateSectionSlider();
    this.saveSession();
    requestAnimationFrame(() => {
      this.v2.fit();
      this.v3.view('iso');
    });
    toast(message ?? `New block ${def.sizeX} × ${def.sizeY} × ${def.sizeZ} loaded`, 'ok');
  }
  /** quick button: automatic tool length + radius compensation on/off */
  toggleAutoComp() {
    if (!this.confirmIdle()) return;
    const on = !(this.settings.autoLength && this.settings.autoRadius);
    this.applySettings({ ...this.settings, autoLength: on, autoRadius: on }, this.workOffsets, this.reloadStockOnStart);
    toast(on ? 'Automatic tool compensation ON – no G43 H… after M06, G41/G42 without D' : 'Automatic tool compensation OFF – program G43 H… and G41/G42 D…', 'ok');
  }
  /** quick button: move the work zero G54 to a top corner / the centre of the block (loads a fresh block) */
  setWorkZero(origin: BlockStock['origin'], zRef: 'finished' | 'raw'): boolean {
    if (!this.confirmIdle()) return false;
    if (this.exercise) {
      toast('The exercise drawing fixes the work zero – load an example or a new program to change it', 'warn');
      return false;
    }
    if (origin === this.stockDef.origin && zRef === (this.stockDef.zRef ?? 'finished')) return true;
    this.applyStock({ ...this.stockDef, origin, zRef }, `G54 = ${ORIGIN_NAMES[origin]}, Z0 on the ${zRef === 'raw' ? 'raw' : 'finished'} top – fresh block loaded`);
    this.reinterpret();
    return true;
  }
  /** one-line summary of the work zero and the programming conventions under the DRO */
  private updateConv() {
    const d = this.stockDef, s = this.settings;
    const parts = [`G54 = ${ORIGIN_NAMES[d.origin]}, Z0 ${d.zRef === 'raw' ? 'raw' : 'finished'} top`];
    if (s.autoLength) parts.push('auto length');
    if (s.autoRadius) parts.push('auto radius');
    if (s.pointRef === 'center') parts.push('Z = nose centre');
    $('#droConv').textContent = parts.join(' · ');
    // quick buttons
    const on = !!s.autoLength && !!s.autoRadius, part = !on && (!!s.autoLength || !!s.autoRadius);
    const q = $('#qComp');
    q.classList.toggle('on', on);
    q.classList.toggle('partial', part);
    q.setAttribute('aria-pressed', String(on));
    $('#qCompS').textContent = on ? 'ON · length + radius' : part ? `ON · ${s.autoLength ? 'length' : 'radius'} only` : 'OFF · G43 H / D';
    $('#qZeroS').textContent = `${ORIGIN_NAMES[d.origin].replace(' corner', '').replace('centre of the block', 'centre')} · Z0 ${d.zRef === 'raw' ? 'raw' : 'finished'}`;
  }
  applySettings(s: MillSettings, w: Record<number, V3>, reload: boolean) {
    Object.assign(this.settings, s);
    this.updateConv();
    this.workOffsets = w;
    this.reloadStockOnStart = reload;
    store.set(S('settings'), this.settings);
    store.set(S('work'), w);
    store.set(S('reloadStock'), reload);
    this.needsReload = true;
    this.reinterpret();
  }
  saveProgress() {
    store.set('progress', Array.from(this.progress));
  }
  saveCustomExercises() {
    store.set(S('customExercises'), this.customExercises);
  }

  // ------------------------------------------------------------------ machine control

  newStock(msg = true) {
    if (this.running) this.reset();
    this.machine.resetAll();
    this.v2.setDeviation(null, 0);
    this.v3.refresh();
    this.v2.invalidate();
    this.needsReload = true;
    if (msg) this.msg({ type: 'info', message: 'New block loaded, spindle at home', line: -1 });
  }

  private loadIntoMachine(): boolean {
    this.result = interpretMill(this.editor.getDoc(), this.cfg(), this.initState());
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
    this.estimate = estimateMillTime(r.ops, this.settings);
    this.machine.time = 0;
    this.machine.cutTime = 0;
    this.needsReload = false;
    return true;
  }

  cycleStart() {
    const m = this.machine;
    if (m.status === 'alarm') return void toast('Alarm active – press RESET first', 'err');
    if (this.mode === 'JOG') return void toast('CYCLE START works in AUTO and MDI mode', 'warn');
    if (m.status === 'hold' || m.status === 'stopped') {
      if (this.mode === 'AUTO' && this.running === 'program' && this.needsReload) return void toast('The program was changed – press RESET to restart it', 'warn');
      m.status = 'running';
      return;
    }
    if (m.status === 'running') return;
    if (this.mode === 'MDI') return this.runMdi();
    if (m.status === 'done' && this.reloadStockOnStart) {
      m.resetAll();
      this.v3.refresh();
      this.msg({ type: 'info', message: 'Fresh block loaded for the new cycle', line: -1 });
    }
    if (!this.loadIntoMachine()) return;
    this.v2.setDeviation(null, 0);
    this.running = 'program';
    this.opsSource = 'program';
    m.status = 'running';
    this.editor.setReadOnly(true);
    this.msg({ type: 'info', message: `Cycle start – estimated cycle time ${fmtTime(this.estimate.total)}`, line: -1 });
  }

  private runMdi() {
    const txt = ($('#mdiText') as HTMLTextAreaElement).value.trim();
    if (!txt) return;
    const r = interpretMill(txt, this.cfg(), this.initState(this.mdiState));
    const errs = r.diags.filter((d) => d.severity === 'error');
    if (errs.length) return void toast('MDI: ' + errs[0].message, 'err', 5000);
    const ops = r.ops.filter((o) => o.kind !== 'end');
    this.mdiState = r.state;
    this.mdiState.comp = 40;
    this.machine.load(ops);
    this.v2.setOps(ops);
    this.v3.setOps(ops);
    this.running = 'mdi';
    this.opsSource = 'mdi';
    this.mdiText = txt;
    this.needsReload = true;
    this.machine.status = 'running';
    this.mdiHistory = [txt, ...this.mdiHistory.filter((x) => x !== txt)].slice(0, 12);
    fill($('#mdiHist'), this.mdiHistory.map((t) => h('div', { title: 'Click to reuse', onclick: () => (($('#mdiText') as HTMLTextAreaElement).value = t) }, t.replace(/\n/g, ' ⏎ '))));
    for (const d of r.diags) if (d.severity === 'warning') this.msg({ type: 'warning', message: 'MDI: ' + d.message, line: -1 });
  }

  feedHold() {
    const m = this.machine;
    if (m.status === 'running') {
      m.status = 'hold';
      this.turbo = false;
    } else if (m.status === 'hold') m.status = 'running';
  }

  reset() {
    this.machine.controlReset();
    this.turbo = false;
    this.running = null;
    this.editor.setReadOnly(false);
    this.editor.setExecLine(null);
    $('#alarmBanner').classList.add('hidden');
    this.reinterpret();
  }

  // ------------------------------------------------------------------ timeline

  seek(t: number) {
    if (this.mode !== 'AUTO') return void toast('The timeline works in AUTO mode', 'warn');
    const m = this.machine;
    if (this.running !== 'program' || this.needsReload) {
      if (this.running) this.reset();
      if (!this.loadIntoMachine()) return;
      this.running = 'program';
      this.opsSource = 'program';
      this.editor.setReadOnly(true);
    }
    const saved = { fo: m.feedOverride, ro: m.rapidOverride, so: m.spindleOverride, sb: m.singleBlock, os: m.optionalStop };
    m.feedOverride = m.rapidOverride = m.spindleOverride = 1;
    m.singleBlock = false;
    m.optionalStop = false;
    m.resetAll();
    $('#alarmBanner').classList.add('hidden');
    m.status = 'running';
    for (let g = 0; m.time < t - 1e-6 && g < 200000; g++) {
      if ((m.status as string) === 'stopped') m.status = 'running';
      if (m.status !== 'running') break;
      m.advance(Math.min(2, t - m.time + 1e-6));
    }
    Object.assign(m, { feedOverride: saved.fo, rapidOverride: saved.ro, spindleOverride: saved.so, singleBlock: saved.sb, optionalStop: saved.os });
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
    let k = i;
    while (k > 0 && ops[k - 1].line === ops[i].line) k--;
    if (m.time - (this.estimate.opStart[k] ?? 0) < 0.05 && k > 0) {
      const L = ops[k - 1].line;
      k--;
      while (k > 0 && ops[k - 1].line === L) k--;
    }
    this.seek(this.estimate.opStart[k] ?? 0);
  }

  private stepForward() {
    const m = this.machine;
    if (this.mode !== 'AUTO') return;
    if (m.status === 'alarm') return void toast('Alarm active – press RESET first', 'err');
    this.stepOnce = true;
    m.singleBlock = true;
    if (m.status === 'hold' || m.status === 'stopped') m.status = 'running';
    else this.cycleStart();
  }

  private updateTimeline() {
    const m = this.machine;
    const total = Math.max(this.estimate.total, m.time, 0.1);
    const sl = $('#tlSlider') as HTMLInputElement;
    sl.max = String(Math.round(total * 10));
    if (!this.tlDragging) sl.value = String(Math.round(m.time * 10));
    $('#tlTime').textContent = `${fmtTime(this.tlDragging ? +sl.value / 10 : m.time)} / ${fmtTime(total)}`;
    const op = m.ops[Math.min(m.i, m.ops.length - 1)];
    $('#tlBlock').textContent = this.running && op ? `L${op.line + 1} ${(this.editor.getDoc().split('\n')[op.line] ?? '').trim()}` : '';
    const ops = this.result?.ops ?? [];
    const key = `${ops.length}|${this.estimate.total}`;
    if (key !== this.tlKey && this.estimate.opStart.length === ops.length) {
      this.tlKey = key;
      const stops: string[] = [];
      let t0 = 0, k = 0, have = false;
      const tot = this.estimate.total || 1;
      const push = (t1: number) => {
        if (!have) return;
        stops.push(`${k++ % 2 ? 'var(--muted)' : 'var(--accent)'} ${((t0 / tot) * 100).toFixed(2)}% ${((t1 / tot) * 100).toFixed(2)}%`);
      };
      ops.forEach((o, i) => {
        if (o.kind === 'tool') {
          push(this.estimate.opStart[i]);
          t0 = this.estimate.opStart[i];
          have = true;
        }
      });
      push(tot);
      $('#tlTrack').style.background = stops.length ? `linear-gradient(90deg, ${stops.join(', ')})` : '';
    }
  }

  // ------------------------------------------------------------------ messages

  private msg(e: MillEvent) {
    const list = $('#msgList');
    const ic = { alarm: '⛔', warning: '⚠', info: 'ℹ', stop: '⏸', end: '✔', toolchange: '🔧' }[e.type];
    list.prepend(h('li', { class: e.type },
      h('span', { class: 'ic' }, ic),
      h('span', { class: 't' }, fmtTime(this.machine.time)),
      e.line >= 0 && this.opsSource === 'mdi' ? h('span', { class: 't' }, `MDI ${e.line + 1}`) : e.line >= 0 ? h('span', { class: 'ln', onclick: () => this.editor.goToLine(e.line) }, `L${e.line + 1}`) : null,
      h('span', null, e.message, e.hint ? h('span', { class: 'hint' }, e.hint) : null)));
    while (list.children.length > 200) list.lastChild?.remove();
  }

  private processEvents() {
    for (const e of this.machine.events.splice(0)) {
      if (e.type === 'end' && this.opsSource === 'mdi') e.message = 'MDI blocks executed';
      this.msg(e);
      if (e.type === 'alarm') {
        this.turbo = false;
        const b = $('#alarmBanner');
        const src = this.opsSource === 'mdi' ? this.mdiText : this.editor.getDoc();
        fill(b,
          h('b', null, '⛔ ALARM: ' + e.message),
          e.hint ? h('p', null, e.hint) : null,
          e.line >= 0 ? h('p', null, `${this.opsSource === 'mdi' ? 'MDI block' : 'Block'} ${e.line + 1}: ${src.split('\n')[e.line]?.trim() ?? ''}`) : null,
          h('div', null,
            e.line >= 0 && this.opsSource === 'program' ? h('button', { onclick: () => this.editor.goToLine(e.line) }, 'Show block') : null,
            h('button', { onclick: () => this.reset() }, 'RESET'),
            h('button', { onclick: () => { this.reset(); this.newStock(); } }, 'RESET + new block')));
        b.classList.remove('hidden');
        toast('ALARM: ' + e.message, 'err', 6000);
      } else if (e.type === 'stop') {
        this.turbo = false;
        toast(e.message, 'info');
      } else if (e.type === 'end') {
        this.turbo = false;
        if (this.running === 'program') {
          const et = this.machine.engageTime;
          const tot = et.climb + et.conventional + et.slot;
          this.msg({ type: 'end', message: `Cycle complete in ${fmtTime(this.machine.time)}${tot > 0 ? ` – side cutting: ${Math.round((et.climb / tot) * 100)} % climb, ${Math.round((et.conventional / tot) * 100)} % conventional, ${Math.round((et.slot / tot) * 100)} % slotting` : ''}`, line: -1 });
          if (this.exercise) toast('Program finished – press “Check part”', 'ok', 5000);
        }
        if (this.opsSource === 'mdi' && this.machine.status === 'done') this.machine.status = 'idle';
        this.running = null;
        this.editor.setReadOnly(false);
      }
    }
  }

  // ------------------------------------------------------------------ frame

  private frame(now: number) {
    const dt = Math.min(0.1, (now - (this.t0 || now)) / 1000);
    this.t0 = now;
    const m = this.machine;
    if (this.jogDir && this.mode === 'JOG') this.jogStep(dt);
    if (m.status === 'running') {
      if (this.turbo) {
        const t0 = performance.now();
        while (m.status === 'running' && performance.now() - t0 < 28) m.advance(1.5);
      } else m.advance(dt * this.speed);
    }
    this.processEvents();
    if (this.stepOnce && m.status !== 'running') {
      this.stepOnce = false;
      m.singleBlock = ($('#tSingle') as HTMLInputElement).checked;
    }
    this.sound.update(m);
    const execOp = m.ops[Math.min(m.i, m.ops.length - 1)];
    const showExec = this.running === 'program' && ['running', 'hold', 'stopped', 'alarm'].includes(m.status);
    this.editor.setExecLine(showExec && execOp ? execOp.line : null);
    const sig = `${m.pos.x.toFixed(3)},${m.pos.y.toFixed(3)},${m.pos.z.toFixed(3)},${this.block.version},${m.i},${m.tool},${m.status}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.v2.invalidate();
    }
    if (this.view !== '3d') this.v2.draw();
    this.v3.update(dt, now);
    if (now - this.lastChart > 250 && !$('#tab-charts').classList.contains('hidden')) {
      this.lastChart = now;
      Object.assign(this.charts, { samples: m.samples, now: m.time, total: this.estimate.total, powerLimit: this.settings.powerKW });
      this.charts.draw();
    }
    if (now - this.lastDro > 50) {
      this.lastDro = now;
      this.updateDro();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  private updateDro() {
    const m = this.machine;
    const L = m.live;
    const w = this.workOffsets[54] ?? { x: 0, y: 0, z: 0 };
    $('#droX').textContent = (m.pos.x - w.x).toFixed(3);
    $('#droY').textContent = (m.pos.y - w.y).toFixed(3);
    // Z of the programmed point: the tip, or the nose-radius centre with the 'center' reference
    const po = pointOffset(m.toolDef, this.settings);
    $('#droZ').textContent = (m.pos.z - w.z + po).toFixed(3);
    $('#droZunit').textContent = po > 0 ? 'ctr' : 'tip';
    const op = m.ops[m.i];
    $('#droDtg').textContent = op && op.kind === 'move' && this.running ? `X ${(op.to.x - m.pos.x).toFixed(2)} Y ${(op.to.y - m.pos.y).toFixed(2)} Z ${(op.to.z - m.pos.z).toFixed(2)}` : 'X 0 Y 0 Z 0';
    $('#droT').textContent = `T${String(m.tool).padStart(2, '0')}`;
    $('#droRpm').textContent = L.rpm.toFixed(0);
    $('#droVc').textContent = L.vc.toFixed(0);
    $('#droFeed').textContent = m.status === 'running' ? L.feedMmMin.toFixed(0) : '0';
    $('#droFz').textContent = L.fz > 0 ? L.fz.toFixed(3) : '–';
    const eng = $('#droEng');
    eng.textContent = L.engagement ? L.engagement.toUpperCase() : '–';
    eng.className = 'eng-' + (L.engagement || 'none');
    const snap = this.result?.modal.get(L.line);
    if (snap && this.running) {
      const mv = op && op.kind === 'move' ? op : null;
      const motion = mv ? (mv.type === 'rapid' ? 'G00' : mv.type === 'linear' ? 'G01' : mv.cw ? 'G02' : 'G03') : `G0${snap.motion}`;
      $('#droModal').textContent = `${motion} G${snap.plane} G21 G${snap.comp} G${snap.lenComp}${snap.autoLen ? '(auto)' : ''} G${snap.cyc} G${snap.abs ? 90 : 91} G${snap.feedPerRev ? 95 : 94} G${snap.work} G${snap.ret}${snap.polar ? ' G16' : ''}${snap.rot ? ' G68' : ''}${mv?.cycle ? ' · ' + mv.cycle : ''}`;
    }
    const led = (id: string, on: boolean, cls = 'on') => {
      const e = $(id);
      e.classList.remove('on', 'warn', 'alarm');
      if (on) e.classList.add(cls);
    };
    led('#ledSpindle', m.spindle.dir !== 'off');
    $('#ledSpindle').textContent = m.spindle.dir === 'off' ? 'SPINDLE' : `SPINDLE ${m.spindle.dir.toUpperCase()}`;
    led('#ledCoolant', m.coolant);
    led('#ledCut', L.cutting && m.status === 'running');
    $('#ledStatus').textContent = m.status === 'stopped' ? 'STOP' : m.status.toUpperCase();
    led('#ledStatus', m.status !== 'idle', m.status === 'alarm' ? 'alarm' : m.status === 'hold' || m.status === 'stopped' ? 'warn' : 'on');
    ($('#loadBar') as HTMLElement).style.width = Math.min(100, (L.powerKW / this.settings.powerKW) * 100) + '%';
    $('#loadV').textContent = `${L.powerKW.toFixed(1)} kW`;
    $('#mrrV').textContent = `${L.mrr.toFixed(1)} cm³/min`;
    $('#timeV').textContent = `${fmtTime(m.time)} / ${fmtTime(this.estimate.total)}`;
    const lineTxt = L.line >= 0 ? this.editor.getDoc().split('\n')[L.line] ?? '' : '';
    $('#stripBlock').textContent = this.running && L.line >= 0 ? `N:${L.line + 1}  ${lineTxt.trim()}` : m.status === 'alarm' ? 'ALARM – press RESET' : this.mode === 'JOG' ? 'JOG mode' : 'Ready – press CYCLE START';
    $('#stripLabel').textContent = this.running ? L.label : '';
    this.updateTimeline();
  }

  // ------------------------------------------------------------------ cursor & lists

  private onCursor(line: number) {
    this.cursorLine = line;
    this.v2.selectedLine = line;
    this.v2.invalidate();
    const r = this.result;
    const body = $('#explainBody');
    if (!r || !r.blocks[line]) return void body.replaceChildren();
    let before;
    for (let l = line - 1; l >= 0; l--) {
      const s = r.modal.get(l);
      if (s) {
        before = s;
        break;
      }
    }
    const ex = explainMillBlock(r.blocks[line], before);
    const trace = r.varTrace.get(line);
    const t = this.estimate.perLine.get(line);
    fill(body,
      h('p', { class: 'sum' }, h('b', null, `Line ${line + 1}: `), ex.summary || '(empty line)', t ? h('span', { class: 'muted' }, `  ⏱ ${t.toFixed(1)} s`) : null),
      ex.words.length ? h('table', null, ex.words.map((w) => h('tr', null, h('td', { class: 'k-' + w.kind }, w.word), h('td', null, w.text)))) : null,
      trace ? h('div', { class: 'diag info' }, '▶ ' + trace + ' (last time this block ran)') : null,
      r.diags.filter((d) => d.line === line).map((d) => h('div', { class: 'diag ' + d.severity }, (d.severity === 'error' ? '⛔ ' : d.severity === 'warning' ? '⚠ ' : 'ℹ ') + d.message, d.hint ? h('div', { class: 'muted' }, d.hint) : null)));
  }

  private renderCheckList() {
    const r = this.result;
    if (!r) return;
    fill($('#checkList'), r.diags.length
      ? r.diags.map((d) => h('li', { class: d.severity }, h('span', { class: 'ic' }, d.severity === 'error' ? '⛔' : d.severity === 'warning' ? '⚠' : 'ℹ'), h('span', { class: 'ln', onclick: () => this.editor.goToLine(d.line) }, `L${d.line + 1}`), h('span', null, d.message, d.hint ? h('span', { class: 'hint' }, d.hint) : null)))
      : [h('li', { class: 'end' }, h('span', { class: 'ic' }, '✔'), h('span', null, 'No problems found. The simulation still checks for crashes while running.'))]);
  }

  private renderOps() {
    const r = this.result;
    if (!r) return;
    interface G { tool: number; line: number; time: number; cut: number; rapid: number; moves: number }
    const groups: G[] = [];
    let g: G | null = null;
    const seen = new Set<number>();
    for (const o of r.ops as MillOp[]) {
      if (o.kind === 'tool' || !g) {
        g = { tool: o.kind === 'tool' ? o.tool : this.machine.tool, line: o.line, time: 0, cut: 0, rapid: 0, moves: 0 };
        groups.push(g);
      }
      if (!seen.has(o.line)) {
        seen.add(o.line);
        g.time += this.estimate.perLine.get(o.line) ?? 0;
      }
      if (o.kind === 'move') {
        const L = moveLength3(o as MillMove);
        if (o.type === 'rapid') g.rapid += L;
        else g.cut += L;
        g.moves++;
      }
    }
    fill($('#opsTable'), h('table', { class: 'data' },
      h('tr', null, ['Tool', 'Description', 'From line', 'Moves', 'Feed path mm', 'Rapid mm', 'Time'].map((c, i) => h('th', { class: i >= 3 ? 'num' : '' }, c))),
      groups.filter((x) => x.moves).map((x) => {
        const t = this.tools.find((tt) => tt.id === x.tool);
        return h('tr', null, h('td', null, `T${String(x.tool).padStart(2, '0')}`), h('td', null, t ? `${t.name} (${MILL_TOOL_LABEL[t.type]})` : '(empty pocket)'),
          h('td', null, h('span', { class: 'ln', style: { cursor: 'pointer', color: 'var(--info)' }, onclick: () => this.editor.goToLine(x.line) }, `L${x.line + 1}`)),
          h('td', { class: 'num' }, x.moves), h('td', { class: 'num' }, x.cut.toFixed(0)), h('td', { class: 'num' }, x.rapid.toFixed(0)), h('td', { class: 'num' }, fmtTime(x.time)));
      }),
      h('tr', null, h('td', { colspan: 6 }, h('b', null, `Total (cutting ${fmtTime(this.estimate.cutting)})`)), h('td', { class: 'num' }, h('b', null, fmtTime(this.estimate.total))))));
  }

  private renderChartTable() {
    const host = $('#chartTable');
    if (host.classList.contains('hidden')) return;
    const rows = summarizeByLine(this.machine.samples);
    fill(host, rows.length ? h('table', { class: 'data' },
      h('tr', null, ['Line', 'Tool', 'From', 'To', 'Max rpm', 'Max feed mm/min', 'Max kW'].map((c, i) => h('th', { class: i >= 2 ? 'num' : '' }, c))),
      rows.map((r) => h('tr', null, h('td', null, h('span', { class: 'ln', style: { cursor: 'pointer', color: 'var(--info)' }, onclick: () => this.editor.goToLine(r.line) }, `L${r.line + 1}`)), h('td', null, `T${String(r.tool).padStart(2, '0')}`),
        h('td', { class: 'num' }, fmtTime(r.t0)), h('td', { class: 'num' }, fmtTime(r.t1)), h('td', { class: 'num' }, r.rpmMax.toFixed(0)), h('td', { class: 'num' }, r.feedMax.toFixed(0)), h('td', { class: 'num' }, r.kwMax.toFixed(2)))))
      : h('p', { class: 'muted' }, 'No data yet – run the program.'));
  }

  // ------------------------------------------------------------------ views / modes

  setView(v: ViewKey) {
    this.view = v;
    const two = v === 'top' || v === 'front' || v === 'side';
    $('#views').dataset.mode = two ? '2d' : v;
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (two) this.v2.setMode(v as View2DMode);
    else if (v === 'split' && this.v2.mode !== 'top') this.v2.setMode('top');
    $('#opts2d').classList.toggle('hidden', v === '3d');
    $('#opts3d').classList.toggle('hidden', two);
    this.v3.setVisible(!two);
    this.updateSectionSlider();
    store.set(S('view'), v);
    requestAnimationFrame(() => {
      this.v2.resize();
      this.v3.resize();
    });
  }

  private updateSectionSlider() {
    const sl = $('#secPos') as HTMLInputElement;
    const b = this.block;
    const side = this.v2.mode === 'side';
    sl.min = String(side ? b.x0 : b.y0);
    sl.max = String(side ? b.x1 : b.y1);
    sl.value = String(side ? this.v2.secX : this.v2.secY);
    if (+sl.value < +sl.min || +sl.value > +sl.max) {
      const mid = side ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2;
      if (side) this.v2.secX = mid;
      else this.v2.secY = mid;
      sl.value = String(mid);
    }
    $('#secPosV').textContent = `${side ? 'X' : 'Y'}${(+sl.value).toFixed(1)}`;
    $('.sec-ctl').classList.toggle('hidden', this.v2.mode === 'top');
  }

  private setMode(m: Mode) {
    if (this.running && this.machine.status !== 'idle' && this.machine.status !== 'done') return void toast('Stop the machine first (RESET)', 'warn');
    if (this.mode === 'MDI' && m !== 'MDI') this.reinterpret();
    this.mode = m;
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    for (const p of ['AUTO', 'MDI', 'JOG']) $('#panel' + p).classList.toggle('hidden', p !== m);
    if (m === 'JOG') this.updateJogTools();
  }

  private applyTheme() {
    this.v2.refreshColors();
    this.v3.setBackground(isLightTheme());
  }

  private tab(name: string) {
    $$('#bottomTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    for (const t of ['messages', 'check', 'ops', 'inspect', 'charts']) $('#tab-' + t).classList.toggle('hidden', t !== name);
    $('.bottom').classList.toggle('tall', name === 'charts');
    if (name === 'charts') {
      requestAnimationFrame(() => {
        this.v2.resize();
        this.v3.resize();
        Object.assign(this.charts, { samples: this.machine.samples, now: this.machine.time, total: this.estimate.total, powerLimit: this.settings.powerKW });
        this.charts.resize();
        this.renderChartTable();
      });
    }
  }

  private updateJogTools() {
    fill($('#jogTool'), this.tools.map((t) => h('option', { value: String(t.id), selected: t.id === this.machine.tool }, `T${String(t.id).padStart(2, '0')} ${t.name}`)));
  }

  private jogStep(dt: number) {
    const m = this.machine;
    if (!this.jogDir || m.status === 'alarm' || m.status === 'running') return;
    const rate = this.jogRapid ? this.settings.rapidRate * m.rapidOverride : +($('#jogFeed') as HTMLInputElement).value;
    const d = (rate / 60) * dt;
    m.jog({ x: m.pos.x + this.jogDir.x * d, y: m.pos.y + this.jogDir.y * d, z: m.pos.z + this.jogDir.z * d }, rate, this.jogRapid);
  }

  private jogIncrement(dir: V3) {
    const m = this.machine;
    if (m.status === 'alarm') return void toast('Alarm active – press RESET', 'err');
    const inc = this.jogInc;
    const rate = this.jogRapid ? this.settings.rapidRate : +($('#jogFeed') as HTMLInputElement).value;
    m.jog({ x: m.pos.x + dir.x * inc, y: m.pos.y + dir.y * inc, z: m.pos.z + dir.z * inc }, rate, this.jogRapid);
  }

  // ------------------------------------------------------------------ bindings

  private bindUi() {
    const acts: Record<string, () => void> = {
      examples: () => D.millExamplesDialog(this),
      exercises: () => D.millExercisesDialog(this),
      lessons: () => D.millLessonsDialog(this),
      reference: () => D.millReferenceDialog(),
      wizard: () => D.millWizardDialog(this),
      tools: () => D.millToolsDialog(this),
      stock: () => D.millStockDialog(this),
      calc: () => D.millCalcDialog(this.stockDef.material),
      settings: () => D.millSettingsDialog(this),
      help: () => D.millHelpDialog(),
      new: () => {
        if (!this.confirmIdle()) return;
        confirmDialog('Start a new, empty program? The current program is replaced.', 'New program', () => {
          this.hideExercise();
          this.loadProgram(MILL_EXAMPLES.find((e) => e.id === 'm-empty')!.code, null);
        });
      },
      open: () => ($('#fileInput') as HTMLInputElement).click(),
      save: () => this.saveFile(),
      sound: () => {
        if (this.sound.enabled) this.sound.disable();
        else if (!this.sound.enable()) toast('This browser has no audio support', 'warn');
        $('#soundBtn').textContent = this.sound.enabled ? 'Sound on' : 'Sound off';
        $('#soundBtn').setAttribute('aria-pressed', String(this.sound.enabled));
      },
      theme: () => {
        const cur = isLightTheme() ? 'dark' : 'light';
        document.documentElement.dataset.theme = cur;
        store.set('theme', cur);
        this.applyTheme();
      },
    };
    $$('.menu button').forEach((b) => b.addEventListener('click', () => acts[b.dataset.act!]?.()));
    ($('#fileInput') as HTMLInputElement).addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      f.text().then((txt) => {
        this.hideExercise();
        this.loadProgram(txt, null);
        toast(`Opened ${f.name}`, 'ok');
      });
      (e.target as HTMLInputElement).value = '';
    });
    $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view as ViewKey)));
    $$('#opts2d input[data-opt]').forEach((inp) => inp.addEventListener('change', () => {
      (this.v2.opts as Record<string, boolean>)[inp.dataset.opt!] = (inp as HTMLInputElement).checked;
      this.v2.invalidate();
    }));
    $('#secPos').addEventListener('input', (e) => {
      const v = +(e.target as HTMLInputElement).value;
      if (this.v2.mode === 'side') this.v2.secX = v;
      else this.v2.secY = v;
      $('#secPosV').textContent = `${this.v2.mode === 'side' ? 'X' : 'Y'}${v.toFixed(1)}`;
      this.v2.invalidate();
    });
    $('#opt3dPath').addEventListener('change', (e) => (this.v3.showPath = (e.target as HTMLInputElement).checked));
    $$('[data-cam]').forEach((b) => b.addEventListener('click', () => this.v3.view(b.dataset.cam as 'iso')));
    $('#fitBtn').addEventListener('click', () => {
      this.v2.fit();
      this.v3.view('iso');
    });
    $('#shotBtn').addEventListener('click', () => {
      const url = this.view === '3d' || this.view === 'split' ? this.v3.snapshot() : this.v2.canvas.toDataURL('image/png');
      fetch(url).then((r) => r.blob()).then((b) => download('milllab-view.png', b));
    });
    $$('#bottomTabs button').forEach((b) => b.addEventListener('click', () => this.tab(b.dataset.tab!)));
    $('#chartTableBtn').addEventListener('click', (e) => {
      const on = $('#chartTable').classList.toggle('hidden') === false;
      $('#chartHost').classList.toggle('hidden', on);
      (e.currentTarget as HTMLElement).textContent = on ? 'Chart' : 'Table';
      (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
      if (on) this.renderChartTable();
      else requestAnimationFrame(() => this.charts.resize());
    });
    $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode as Mode)));
    $('#btnStart').addEventListener('click', () => this.cycleStart());
    $('#qComp').addEventListener('click', () => this.toggleAutoComp());
    $('#qZero').addEventListener('click', () => D.workZeroPopover(this, $('#qZero')));
    $('#btnHold').addEventListener('click', () => this.feedHold());
    $('#btnReset').addEventListener('click', () => this.reset());
    $('#btnInstant').addEventListener('click', () => {
      if (this.machine.status !== 'running') this.cycleStart();
      if (this.machine.status === 'running') this.turbo = true;
    });
    $('#btnNewStock').addEventListener('click', () => this.newStock());
    $('#btnCheck').addEventListener('click', () => this.check());
    $('#btnCheck').setAttribute('disabled', '');
    const sl = $('#tlSlider') as HTMLInputElement;
    sl.addEventListener('input', () => (this.tlDragging = true));
    sl.addEventListener('change', () => {
      this.tlDragging = false;
      this.seek(+sl.value / 10);
    });
    $('#tlBack').addEventListener('click', () => this.stepBack());
    $('#tlFwd').addEventListener('click', () => this.stepForward());
    const tS = $('#tSingle') as HTMLInputElement;
    tS.addEventListener('change', () => (this.machine.singleBlock = tS.checked));
    const tO = $('#tOpt') as HTMLInputElement;
    tO.addEventListener('change', () => (this.machine.optionalStop = tO.checked));
    $('#tSkip').addEventListener('change', () => {
      this.needsReload = true;
      this.reinterpret();
    });
    const ovF = $('#ovFeed') as HTMLInputElement;
    ovF.addEventListener('input', () => {
      this.machine.feedOverride = +ovF.value / 100;
      $('#ovFeedV').textContent = ovF.value + '%';
    });
    const ovS = $('#ovSpindle') as HTMLInputElement;
    ovS.addEventListener('input', () => {
      this.machine.spindleOverride = +ovS.value / 100;
      $('#ovSpindleV').textContent = ovS.value + '%';
    });
    $$('#ovRapid button').forEach((b) => b.addEventListener('click', () => {
      this.machine.rapidOverride = +b.dataset.v!;
      $$('#ovRapid button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    const sp = $('#simSpeed') as HTMLInputElement;
    const spUpd = () => {
      this.speed = SPEEDS[+sp.value];
      $('#simSpeedV').textContent = '×' + this.speed;
    };
    sp.addEventListener('input', spUpd);
    spUpd();
    // jog
    const dirs: Record<string, V3> = { 'x+': { x: 1, y: 0, z: 0 }, 'x-': { x: -1, y: 0, z: 0 }, 'y+': { x: 0, y: 1, z: 0 }, 'y-': { x: 0, y: -1, z: 0 }, 'z+': { x: 0, y: 0, z: 1 }, 'z-': { x: 0, y: 0, z: -1 } };
    $$('[data-jog]').forEach((b) => {
      const d = b.dataset.jog!;
      if (d === 'rapid') {
        b.addEventListener('click', () => {
          this.jogRapid = !this.jogRapid;
          b.classList.toggle('on', this.jogRapid);
        });
        return;
      }
      b.addEventListener('pointerdown', () => {
        if (this.jogInc === 0) this.jogDir = dirs[d];
        else this.jogIncrement(dirs[d]);
      });
      const stop = () => (this.jogDir = null);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
    });
    $$('#jogInc button').forEach((b) => b.addEventListener('click', () => {
      this.jogInc = +b.dataset.v!;
      $$('#jogInc button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    const jf = $('#jogFeed') as HTMLInputElement;
    jf.addEventListener('input', () => ($('#jogFeedV').textContent = jf.value + ' mm/min'));
    const spindle = (dir: 'cw' | 'ccw' | 'off') => {
      const rpm = Math.min(this.settings.maxRpm, Math.max(0, +($('#spRpm') as HTMLInputElement).value || 0));
      this.machine.spindle = { rpm, dir };
    };
    $('#spCW').addEventListener('click', () => spindle('cw'));
    $('#spCCW').addEventListener('click', () => spindle('ccw'));
    $('#spStop').addEventListener('click', () => spindle('off'));
    $('#jogTool').addEventListener('change', (e) => {
      const id = +(e.target as HTMLSelectElement).value;
      const m = this.machine;
      const oldL = m.toolDef?.length ?? 0;
      m.tool = id;
      m.pos = { ...m.pos, z: m.pos.z + oldL - (m.toolDef?.length ?? 0) };
      this.msg({ type: 'toolchange', message: `Manual tool change → T${String(id).padStart(2, '0')}`, line: -1 });
    });
    $('#jogCool').addEventListener('click', (e) => {
      this.machine.coolant = !this.machine.coolant;
      (e.currentTarget as HTMLElement).classList.toggle('on', this.machine.coolant);
    });
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
      } else if (this.mode === 'JOG' && !inField(e)) {
        const map: Record<string, V3> = { ArrowLeft: dirs['x-'], ArrowRight: dirs['x+'], ArrowUp: dirs['y+'], ArrowDown: dirs['y-'], PageUp: dirs['z+'], PageDown: dirs['z-'] };
        const d = map[e.key];
        if (!d) return;
        e.preventDefault();
        this.jogRapid = e.shiftKey;
        if (this.jogInc === 0) this.jogDir = d;
        else if (!e.repeat) this.jogIncrement(d);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key.startsWith('Arrow') || e.key.startsWith('Page')) {
        this.jogDir = null;
        if (!$('#jogRapid').classList.contains('on')) this.jogRapid = false;
      }
    });
    window.addEventListener('beforeunload', () => this.saveSession());
  }

  private saveFile() {
    const m = /^\s*O(\d+)/m.exec(this.editor.getDoc());
    download(`O${m ? m[1].padStart(4, '0') : '1000'}.nc`, this.editor.getDoc());
  }
}

declare global {
  interface Window {
    milllab: MillApp;
  }
}
window.milllab = new MillApp();
