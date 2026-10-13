import { h, openDialog, toast, fill, download } from '../ui/dom';
import { MILL_EXAMPLES, type MillExample } from './content/examples';
import { MILL_EXERCISES, type MillExercise } from './content/exercises';
import { MILL_LESSONS } from './content/lessons';
import { MILL_G, MILL_M, MILL_ADDR } from './ref';
import { MACROS, type CodeRef } from '../content/gcodeRef';
import { MATERIALS } from '../sim/machine';
import type { MaterialId } from '../types';
import type { BlockStock, MillOffset, MillSettings, MillTool, MillToolType, V3 } from './types';
import { MILL_TOOL_LABEL, defaultMillTools, defaultMillOffsets, toolProfile } from './tools';
import { defaultMillSpec, generateMill, checkMillSpec, shiftFeature, type MillFeature, type MillWizardSpec } from './wizardGen';
import { simulateBlock } from './inspect';
import { blockFrame, ORIGIN_NAMES } from './stock';
import { textToHtml } from '../ui/dialogs2';
import type { MillConfig } from './interp';

export interface MillAppApi {
  tools: MillTool[];
  offsets: Map<number, MillOffset>;
  stockDef: BlockStock;
  settings: MillSettings;
  workOffsets: Record<number, V3>;
  progress: Set<string>;
  customExercises: MillExercise[];
  reloadStockOnStart: boolean;
  loadExample(ex: MillExample): void;
  loadExercise(ex: MillExercise): void;
  loadGenerated(code: string, stock: BlockStock, title: string): void;
  applyTools(t: MillTool[], o: Map<number, MillOffset>): void;
  applyStock(s: BlockStock): boolean;
  setWorkZero(origin: BlockStock['origin'], zRef: 'finished' | 'raw'): boolean;
  applySettings(s: MillSettings, w: Record<number, V3>, reload: boolean): void;
  saveProgress(): void;
  saveCustomExercises(): void;
  currentCode(): string;
  cfg(): MillConfig;
}

const num = (v: number, set: (v: number) => void, attrs: Record<string, unknown> = {}) =>
  h('input', {
    type: 'number',
    value: String(v),
    step: 'any',
    ...attrs,
    oninput: (e: Event) => {
      const x = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(x)) set(x);
    },
  });

// ------------------------------------------------------------------ examples / exercises

export function millExamplesDialog(app: MillAppApi) {
  const body = h('div', { class: 'cards' },
    MILL_EXAMPLES.map((ex) =>
      h('button', { class: 'card', onclick: () => { close(); app.loadExample(ex); } },
        h('h4', null, ex.title),
        h('div', { class: 'tags' }, h('span', { class: `tag lvl-${ex.level}` }, ex.level), ex.topics.map((t) => h('span', { class: 'tag' }, t))),
        h('p', null, ex.description),
        h('p', null, `Block ${ex.stock.sizeX} × ${ex.stock.sizeY} × ${ex.stock.sizeZ} ${MATERIALS[ex.stock.material].name}`))),
  );
  const close = openDialog({ title: 'Example programs – milling', body, size: 'wide' });
}

export function exportMillExercise(ex: MillExercise) {
  const { id: _i, brief: _b, ...rest } = ex;
  void _i;
  void _b;
  return JSON.stringify({ format: 'lathelab-mill-exercise@1', ...rest }, null, 2);
}

export function sanitizeMillExercise(o: unknown): MillExercise | null {
  const x = o as Partial<MillExercise>;
  if (!x || typeof x !== 'object' || typeof x.title !== 'string' || typeof x.solution !== 'string' || !x.stock) return null;
  const s = x.stock as BlockStock;
  if (![s.sizeX, s.sizeY, s.sizeZ].every((v) => typeof v === 'number' && v > 0 && v < 2000)) return null;
  return {
    id: 'mu' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: x.title.slice(0, 120),
    level: (['Beginner', 'Intermediate', 'Advanced'] as const).includes(x.level as MillExercise['level']) ? (x.level as MillExercise['level']) : 'Intermediate',
    brief: textToHtml(String(x.briefText ?? '').slice(0, 5000)),
    briefText: String(x.briefText ?? '').slice(0, 5000),
    stock: {
      sizeX: s.sizeX, sizeY: s.sizeY, sizeZ: s.sizeZ,
      origin: Object.hasOwn(ORIGIN_NAMES, s.origin) ? s.origin : 'corner',
      topAllowance: Math.max(0, +s.topAllowance || 0),
      zRef: s.zRef === 'raw' ? 'raw' : 'finished',
      material: (Object.keys(MATERIALS) as MaterialId[]).includes(s.material) ? s.material : 'aluminium',
      aboveJaws: Math.max(1, +s.aboveJaws || 15),
    },
    solution: x.solution.slice(0, 200000),
    tol: Math.max(0.005, +(x.tol ?? 0.05) || 0.05),
    hints: Array.isArray(x.hints) ? x.hints.map(String).slice(0, 20) : [],
    starter: typeof x.starter === 'string' ? x.starter : '%\nO1000\n\nM30\n%\n',
    custom: true,
    conventions: x.conventions ? { autoLength: !!x.conventions.autoLength, autoRadius: !!x.conventions.autoRadius, pointRef: x.conventions.pointRef === 'center' ? 'center' : 'tip' } : undefined,
  };
}

export function millExercisesDialog(app: MillAppApi) {
  const customHost = h('div', { class: 'cards' });
  const card = (ex: MillExercise) =>
    h('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => { close(); app.loadExercise(ex); }, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { close(); app.loadExercise(ex); } } },
      h('h4', null, ex.title, app.progress.has('mex:' + ex.id) ? '  ✔' : ''),
      h('div', { class: 'tags' }, h('span', { class: `tag lvl-${ex.level}` }, ex.level), ex.custom ? h('span', { class: 'tag' }, 'custom') : null),
      h('p', null, ex.brief.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').slice(0, 170) + '…'),
      ex.custom
        ? h('div', { class: 'row', style: { display: 'flex', gap: '6px' } },
            h('button', { onclick: (e: Event) => { e.stopPropagation(); download(`${ex.title.replace(/[^\w-]+/g, '_')}.mill.json`, exportMillExercise(ex), 'application/json'); } }, 'Download'),
            h('button', { onclick: (e: Event) => { e.stopPropagation(); navigator.clipboard?.writeText(exportMillExercise(ex)).then(() => toast('Copied', 'ok'), () => toast('Copy blocked', 'warn')); } }, 'Copy JSON'),
            h('button', { onclick: (e: Event) => { e.stopPropagation(); app.customExercises.splice(app.customExercises.indexOf(ex), 1); app.saveCustomExercises(); renderCustom(); } }, 'Delete'))
        : null);
  const renderCustom = () => fill(customHost, app.customExercises.length ? app.customExercises.map(card) : [h('p', { class: 'muted' }, 'No custom exercises yet.')]);
  renderCustom();
  const paste = h('textarea', { rows: 3, placeholder: 'Paste exercise JSON here…', spellcheck: 'false' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const doImport = (text: string) => {
    try {
      const data = JSON.parse(text);
      const list = (Array.isArray(data) ? data : [data]).map(sanitizeMillExercise).filter((x): x is MillExercise => !!x);
      if (!list.length) throw new Error('no milling exercise found');
      app.customExercises.push(...list);
      app.saveCustomExercises();
      renderCustom();
      toast(`Imported ${list.length} exercise(s)`, 'ok');
    } catch (e) {
      toast('Import failed: ' + (e as Error).message, 'err');
    }
  };
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    if (f) f.text().then(doImport);
    fileIn.value = '';
  });
  const body = h('div', null,
    h('p', { class: 'muted' }, 'Each exercise loads a block and a program skeleton. The finished part is defined by a hidden reference program – “Check part” compares your height map with it (±tolerance on every floor and top).'),
    h('div', { class: 'cards' }, MILL_EXERCISES.map(card)),
    h('h3', null, 'Your exercises'),
    h('p', { class: 'muted small' }, 'Teachers: write and run a reference program, then “Create from current program”. Share the JSON file with your students.'),
    customHost,
    h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
      h('button', { class: 'primary', onclick: () => { close(); millBuilderDialog(app); } }, '＋ Create from current program'),
      h('button', { onclick: () => fileIn.click() }, 'Import .json file'),
      h('button', { onclick: () => doImport(paste.value) }, 'Import pasted JSON'),
      fileIn),
    paste);
  const close = openDialog({ title: 'Exercises – milling', body, size: 'wide' });
}

export function millBuilderDialog(app: MillAppApi) {
  const f = { title: 'My milling exercise', level: 'Intermediate', brief: 'Describe the part: features, positions, depths.\n\nThe finished part is what your current program produces.', tol: 0.05, hints: '' };
  const ta = (key: 'brief' | 'hints', rows: number) => h('textarea', { rows, oninput: (e: Event) => (f[key] = (e.target as HTMLTextAreaElement).value) }, f[key]);
  const body = h('div', { class: 'form' },
    h('label', null, 'Title'), h('input', { type: 'text', value: f.title, oninput: (e: Event) => (f.title = (e.target as HTMLInputElement).value) }),
    h('label', null, 'Level'), h('select', { onchange: (e: Event) => (f.level = (e.target as HTMLSelectElement).value) }, ['Beginner', 'Intermediate', 'Advanced'].map((l) => h('option', { selected: l === f.level }, l))),
    h('label', null, 'Task for the student'), ta('brief', 5),
    h('label', null, 'Tolerance ± (Z)'), num(f.tol, (v) => (f.tol = v), { min: 0.005, step: 0.01 }),
    h('label', null, 'Hints (one per line)'), ta('hints', 3));
  const build = () => sanitizeMillExercise({
    title: f.title, level: f.level, briefText: f.brief, stock: app.stockDef, solution: app.currentCode(), tol: f.tol,
    conventions: { autoLength: !!app.settings.autoLength, autoRadius: !!app.settings.autoRadius, pointRef: app.settings.pointRef ?? 'tip' },
    hints: f.hints.split('\n').map((x) => x.trim()).filter(Boolean), starter: `%\nO1000 (${f.title.toUpperCase().replace(/[()]/g, '')})\nG21 G17 G40 G49 G80 G90 G94\nG91 G28 Z0\nG90\n\n(... YOUR PROGRAM ...)\n\nM30\n%\n`,
  } as unknown as MillExercise)!;
  openDialog({
    title: 'Create an exercise from this program',
    body: h('div', null, h('p', { class: 'muted' }, 'Your current program becomes the hidden reference solution; the current block size and material are used.'), body),
    size: 'narrow',
    buttons: [
      { label: 'Cancel' },
      { label: 'Download .json', onClick: () => { const ex = build(); download(`${ex.title.replace(/[^\w-]+/g, '_')}.mill.json`, exportMillExercise(ex), 'application/json'); return false; } },
      { label: 'Copy JSON', onClick: () => { navigator.clipboard?.writeText(exportMillExercise(build())).then(() => toast('Copied – share it with your students', 'ok'), () => toast('Copy blocked', 'warn')); return false; } },
      { label: 'Save & try it', primary: true, onClick: () => { const ex = build(); app.customExercises.push(ex); app.saveCustomExercises(); app.loadExercise(ex); toast(`Exercise “${ex.title}” saved in this browser`, 'ok'); return true; } },
    ],
  });
}

// ------------------------------------------------------------------ lessons & reference

export function millLessonsDialog(app: MillAppApi) {
  let current = MILL_LESSONS.find((l) => !app.progress.has('mlesson:' + l.id))?.id ?? MILL_LESSONS[0].id;
  const list = h('div', { class: 'lesson-list' });
  const content = h('div', { class: 'lesson-body' });
  const render = () => {
    fill(list, MILL_LESSONS.map((l) => h('button', { class: l.id === current ? 'on' : '', onclick: () => { current = l.id; render(); } }, l.title, app.progress.has('mlesson:' + l.id) ? h('span', { class: 'done' }, '✔') : null)));
    const L = MILL_LESSONS.find((l) => l.id === current)!;
    const idx = MILL_LESSONS.indexOf(L);
    const checkDone = () => {
      if (Array.from(content.querySelectorAll('.quiz .opts-q')).every((o) => o.querySelector('.right'))) {
        app.progress.add('mlesson:' + L.id);
        app.saveProgress();
      }
    };
    fill(content,
      h('h3', null, L.title),
      h('div', { html: L.html }),
      L.examples?.length ? h('p', null, 'Try it: ', L.examples.map((id) => {
        const ex = MILL_EXAMPLES.find((e) => e.id === id);
        return ex ? h('button', { onclick: () => { close(); app.loadExample(ex); }, style: { marginRight: '6px' } }, ex.title) : null;
      })) : null,
      L.quiz?.length ? h('div', { class: 'quiz' }, h('h4', null, 'Check yourself'), L.quiz.map((q) => {
        const why = h('div', { class: 'why hidden' }, q.why);
        return h('div', null, h('div', { class: 'q' }, q.q), h('div', { class: 'opts-q' }, q.options.map((o, i) => h('button', { onclick: (e: Event) => { (e.currentTarget as HTMLElement).classList.add(i === q.answer ? 'right' : 'wrong'); if (i === q.answer) why.classList.remove('hidden'); checkDone(); } }, o))), why);
      })) : null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '14px' } },
        h('button', { disabled: idx === 0, onclick: () => { current = MILL_LESSONS[idx - 1].id; render(); } }, '← Previous'),
        h('button', { disabled: idx === MILL_LESSONS.length - 1, onclick: () => { if (!L.quiz?.length) { app.progress.add('mlesson:' + L.id); app.saveProgress(); } current = MILL_LESSONS[idx + 1].id; render(); } }, 'Next →')));
    content.scrollTop = 0;
  };
  render();
  const close = openDialog({ title: 'Lessons – CNC milling with Fanuc G-code', body: h('div', { class: 'lessons' }, list, content), size: 'wide' });
}

export function millReferenceDialog() {
  const input = h('input', { type: 'text', class: 'ref-search', placeholder: 'Search: e.g. G83, tapping, compensation…' });
  const out = h('div');
  const item = (c: CodeRef) => h('div', { class: 'ref-item' },
    h('h4', null, h('span', null, c.code), c.title, h('small', { class: 'muted' }, `  · ${c.group}${c.modal ? ' · modal' : ''}`)),
    c.syntax ? h('pre', null, c.syntax) : null,
    h('p', null, c.text),
    c.params ? h('table', { class: 'data' }, c.params.map(([k, v]) => h('tr', null, h('td', null, h('code', null, k)), h('td', null, v)))) : null,
    c.tip ? h('p', { class: 'muted' }, '💡 ' + c.tip) : null);
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const all = [...MILL_G, ...MILL_M, ...MACROS, ...MILL_ADDR];
    const hits = all.filter((c) => !q || (c.code + ' ' + c.title + ' ' + c.text + ' ' + c.group).toLowerCase().includes(q));
    fill(out, hits.length ? hits.map(item) : [h('p', { class: 'muted' }, 'Nothing found.')]);
  };
  input.addEventListener('input', render);
  render();
  openDialog({ title: 'G-code reference – milling (Fanuc 0i-M style)', body: h('div', null, input, out), size: 'wide' });
}

// ------------------------------------------------------------------ tools, stock, settings

function drawMillTool(cv: HTMLCanvasElement, t: MillTool) {
  const ctx = cv.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 260, H = cv.clientHeight || 220;
  cv.width = W * dpr;
  cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  ctx.fillStyle = css('--v-bg');
  ctx.fillRect(0, 0, W, H);
  const prof = toolProfile(t);
  const R = t.diameter / 2;
  const total = t.length + 30;
  const s = Math.min((H - 20) / total, (W - 20) / Math.max(44, t.diameter + 6));
  const X = (r: number) => W / 2 + r * s;
  const Y = (z: number) => H - 10 - z * s;
  ctx.fillStyle = css('--v-holder');
  ctx.fillRect(X(-22), Y(t.length + 30), 44 * s, 30 * s);
  ctx.fillRect(X(-Math.min(R, 8)), Y(t.length), 2 * Math.min(R, 8) * s, (t.length - prof[prof.length - 1].h) * s);
  ctx.beginPath();
  prof.forEach((p, i) => (i ? ctx.lineTo(X(p.r), Y(p.h)) : ctx.moveTo(X(p.r), Y(p.h))));
  for (let i = prof.length - 1; i >= 0; i--) ctx.lineTo(X(-prof[i].r), Y(prof[i].h));
  ctx.closePath();
  ctx.fillStyle = css('--v-cutter');
  ctx.fill();
  ctx.strokeStyle = css('--v-stock-edge');
  ctx.stroke();
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(10, Y(t.length));
  ctx.lineTo(W - 10, Y(t.length));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = css('--v-text');
  ctx.font = '11px sans-serif';
  ctx.fillText(`gauge line – length ${t.length}`, 10, Y(t.length) - 4);
  ctx.fillText(`Ø${t.diameter}, flutes ${t.fluteLength} long`, 10, H - 2);
}

export function millToolsDialog(app: MillAppApi) {
  let tools = app.tools.map((t) => ({ ...t }));
  let offs = new Map(Array.from(app.offsets.entries()).map(([k, v]) => [k, { ...v }]));
  let sel = tools[0]?.id ?? 1;
  const preview = h('canvas', { class: 'tool-preview', style: { height: '240px' } });
  const host = h('div', { class: 'tool-table' });
  const types = Object.keys(MILL_TOOL_LABEL) as MillToolType[];
  const render = () => {
    const rows: Node[] = [];
    for (let id = 1; id <= 16; id++) {
      const t = tools.find((x) => x.id === id);
      const o = offs.get(id) ?? { h: 0, hw: 0, d: 0, dw: 0 };
      offs.set(id, o);
      if (!t) {
        rows.push(h('tr', null, h('td', null, `T${String(id).padStart(2, '0')}`), h('td', { colspan: 16 }, h('span', { class: 'muted' }, 'empty pocket '), h('button', { onclick: () => { tools.push({ ...defaultMillTools()[1], id, name: 'New end mill' }); o.h = 75; o.d = 5; sel = id; render(); } }, '+ add tool'))));
        continue;
      }
      const upd = () => { if (id === sel) drawMillTool(preview, t); };
      const f = (k: keyof MillTool, attrs: Record<string, unknown> = {}) => num(t[k] as number, (v) => { (t as unknown as Record<string, number>)[k] = v; upd(); }, attrs);
      rows.push(h('tr', { class: id === sel ? 'sel' : '', onclick: (e: Event) => {
        if (sel === id) return;
        sel = id;
        host.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel'));
        (e.currentTarget as HTMLElement).classList.add('sel');
        drawMillTool(preview, t);
      } },
        h('td', null, h('b', null, `T${String(id).padStart(2, '0')}`)),
        h('td', null, h('select', { onchange: (e: Event) => { t.type = (e.target as HTMLSelectElement).value as MillToolType; t.centerCutting = t.type !== 'face'; render(); } }, types.map((ty) => h('option', { value: ty, selected: ty === t.type }, MILL_TOOL_LABEL[ty])))),
        h('td', null, h('input', { type: 'text', value: t.name, oninput: (e: Event) => (t.name = (e.target as HTMLInputElement).value) })),
        h('td', null, f('diameter', { min: 0.5 })),
        h('td', null, f('cornerR', { min: 0 })),
        h('td', null, f('flutes', { min: 1, step: 1 })),
        h('td', null, f('fluteLength', { min: 1 })),
        h('td', null, f('length', { min: 10 })),
        h('td', null, f('tipAngle', { min: 30, max: 180 })),
        h('td', null, f('tipDiameter', { min: 0 })),
        h('td', null, f('pitch', { min: 0 })),
        h('td', null, num(o.h, (v) => (o.h = v))),
        h('td', null, num(o.hw, (v) => (o.hw = v), { step: 0.01 })),
        h('td', null, num(o.d, (v) => (o.d = v))),
        h('td', null, num(o.dw, (v) => (o.dw = v), { step: 0.01 })),
        h('td', null, h('button', { title: 'Copy length/radius into H/D', onclick: (e: Event) => { e.stopPropagation(); o.h = t.length; o.d = t.diameter / 2; render(); } }, '⇢H/D')),
        h('td', null, h('button', { title: 'Remove tool', onclick: (e: Event) => { e.stopPropagation(); tools = tools.filter((x) => x.id !== id); render(); } }, '✕'))));
    }
    fill(host, h('table', null, h('tr', null, ['T', 'Type', 'Name', 'Ø', 'Corner R', 'Flutes', 'Flute length', 'Length', 'Point ∠', 'Tip Ø', 'Pitch', 'H', 'H wear', 'D (radius)', 'D wear', '', ''].map((c) => h('th', null, c))), rows));
    const t = tools.find((x) => x.id === sel);
    if (t) requestAnimationFrame(() => drawMillTool(preview, t));
  };
  render();
  openDialog({
    title: 'Tool magazine & offsets',
    body: h('div', null, h('p', { class: 'muted' }, 'Tool geometry (what really cuts) and the offset page (what the control believes): H = length used by G43, D = radius used by G41/G42. Wrong H or D values produce real mistakes in the simulation – try it.'), h('div', { class: 'tools-layout' }, preview, host)),
    size: 'wide',
    buttons: [
      { label: 'Restore defaults', onClick: () => { tools = defaultMillTools(); offs = defaultMillOffsets(tools); render(); return false; } },
      { label: 'Cancel' },
      { label: 'Apply', primary: true, onClick: () => { app.applyTools(tools.sort((a, b) => a.id - b.id), offs); toast('Tool magazine updated', 'ok'); } },
    ],
  });
}

/** selects for the work zero (X0 Y0 corner, Z0 reference) – shared by the stock dialog and the wizard */
function workZeroSelects(d: BlockStock, onChange: () => void) {
  const origin = h('select', { onchange: (e: Event) => { d.origin = (e.target as HTMLSelectElement).value as BlockStock['origin']; onChange(); } },
    (Object.keys(ORIGIN_NAMES) as BlockStock['origin'][]).map((k) => h('option', { value: k, selected: d.origin === k }, ORIGIN_NAMES[k])));
  const zref = h('select', { onchange: (e: Event) => { d.zRef = (e.target as HTMLSelectElement).value as 'finished' | 'raw'; onChange(); } },
    h('option', { value: 'finished', selected: d.zRef !== 'raw' }, 'finished top (after facing)'),
    h('option', { value: 'raw', selected: d.zRef === 'raw' }, 'raw top of the block'));
  return { origin, zref };
}

/** small sketch of the block with the work zero: top view + front view */
function workZeroSketch(input: BlockStock): SVGElement {
  // half-typed or invalid sizes must not produce negative SVG dimensions
  const pos = (v: number, min: number) => (Number.isFinite(v) && v >= min ? v : min);
  const d = { ...input, sizeX: pos(input.sizeX, 1), sizeY: pos(input.sizeY, 1), sizeZ: pos(input.sizeZ, 1), topAllowance: pos(input.topAllowance, 0) };
  const g = blockFrame(d);
  const W = 280, H = 150;
  const k = Math.min(140 / d.sizeX, 90 / d.sizeY, 40 / Math.max(1, d.sizeZ));
  const bw = d.sizeX * k, bh = d.sizeY * k, bz = Math.max(10, d.sizeZ * k);
  const ta = d.topAllowance > 0 ? Math.min(bz / 3, Math.max(4, d.topAllowance * k)) : 0; // exaggerated to be visible
  const ox = 30, oy = 38 + bh; // top view: front left corner on screen (room above for the Y arrow)
  const px = ox + -g.x0 * k, py = oy - -g.y0 * k; // work zero on screen
  const fy = oy + 30; // front view: top line
  const zy = d.zRef === 'raw' ? fy : fy + ta;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Math.max(H, fy + bz + 20));
  svg.setAttribute('class', 'wz-sketch');
  const r = (n: number) => Math.round(n * 10) / 10;
  const el = (tag: string, a: Record<string, number | string>, text?: string) => {
    const e = document.createElementNS(ns, tag);
    for (const [k2, v] of Object.entries(a)) e.setAttribute(k2, String(typeof v === 'number' ? r(v) : v));
    if (text) e.textContent = text;
    svg.appendChild(e);
  };
  el('text', { x: ox + bw + 42, y: oy - bh / 2 + 4, class: 'wz-t' }, 'top view');
  el('rect', { x: ox, y: oy - bh, width: bw, height: bh, class: 'wz-b' });
  el('line', { x1: px, y1: py, x2: px + 26, y2: py, class: 'wz-x' });
  el('text', { x: px + 28, y: py + 4, class: 'wz-xl' }, 'X');
  el('line', { x1: px, y1: py, x2: px, y2: py - 26, class: 'wz-y' });
  el('text', { x: px - 4, y: py - 29, class: 'wz-yl' }, 'Y');
  el('circle', { cx: px, cy: py, r: 4, class: 'wz-o' });
  el('text', { x: ox + bw + 42, y: fy + bz / 2 + 8, class: 'wz-t' }, 'front view');
  el('rect', { x: ox, y: fy, width: bw, height: bz, class: 'wz-b' });
  if (ta) el('rect', { x: ox, y: fy, width: bw, height: ta, class: 'wz-a' });
  el('line', { x1: ox - 12, y1: zy, x2: ox + bw + 12, y2: zy, class: 'wz-z' });
  el('text', { x: ox + bw + 14, y: zy + 4, class: 'wz-zl' }, 'Z0');
  el('circle', { cx: px, cy: zy, r: 4, class: 'wz-o' });
  el('text', { x: ox, y: fy + bz + 14, class: 'wz-t' }, 'orange = stock to face off (not to scale)');
  return svg;
}

/** clickable top view of the block: 4 corners + centre; the current work zero is highlighted with its X/Y arrows */
function workZeroPicker(d: BlockStock, pick: (o: BlockStock['origin']) => void): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const k = Math.min(160 / d.sizeX, 110 / d.sizeY);
  const bw = d.sizeX * k, bh = d.sizeY * k;
  const ox = 50, oy = 44; // back left corner of the block on screen (room for arrows and labels)
  const W = bw + 2 * ox, H = bh + 2 * oy;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'wz-pick');
  const el = (tag: string, a: Record<string, number | string>, text?: string, parent: Element = svg) => {
    const e = document.createElementNS(ns, tag);
    for (const [key, v] of Object.entries(a)) e.setAttribute(key, String(typeof v === 'number' ? Math.round(v * 10) / 10 : v));
    if (text) e.textContent = text;
    parent.appendChild(e);
    return e;
  };
  el('rect', { x: ox, y: oy, width: bw, height: bh, class: 'wz-b' });
  el('text', { x: ox + bw / 2, y: oy + bh + 26, class: 'wz-t', 'text-anchor': 'middle' }, 'operator side (front)');
  const pts: [BlockStock['origin'], number, number][] = [
    ['back-left', ox, oy], ['back-right', ox + bw, oy], ['corner', ox, oy + bh], ['front-right', ox + bw, oy + bh], ['center', ox + bw / 2, oy + bh / 2],
  ];
  const cur = pts.find((p) => p[0] === d.origin)!;
  // axes of the current zero
  el('line', { x1: cur[1], y1: cur[2], x2: cur[1] + 28, y2: cur[2], class: 'wz-x' });
  el('text', { x: cur[1] + 30, y: cur[2] + 4, class: 'wz-xl' }, 'X+');
  el('line', { x1: cur[1], y1: cur[2], x2: cur[1], y2: cur[2] - 28, class: 'wz-y' });
  el('text', { x: cur[1] - 6, y: cur[2] - 30, class: 'wz-yl' }, 'Y+');
  for (const [o, x, y] of pts) {
    const g = el('g', { class: 'wz-hit' + (o === d.origin ? ' on' : ''), role: 'button', tabindex: 0, 'aria-label': ORIGIN_NAMES[o], 'aria-pressed': String(o === d.origin) });
    el('title', {}, ORIGIN_NAMES[o], g);
    el('circle', { cx: x, cy: y, r: 13, class: 'wz-halo' }, undefined, g);
    el('circle', { cx: x, cy: y, r: 6, class: 'wz-dot' }, undefined, g);
    g.addEventListener('click', () => pick(o));
    g.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
        e.preventDefault();
        pick(o);
      }
    });
  }
  return svg;
}

let zeroPop: { el: HTMLElement; close: () => void } | null = null;

/** popover of the WORK ZERO quick button: pick the G54 corner and the Z0 reference, applied at once */
export function workZeroPopover(app: MillAppApi, anchor: HTMLElement) {
  if (zeroPop) {
    zeroPop.close();
    return;
  }
  const pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Work zero G54' });
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', onScroll, true);
    anchor.setAttribute('aria-expanded', 'false');
    zeroPop = null;
  };
  const outside = (e: Event) => {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  // the anchor scrolled away (control pane / page) – a fixed popover would float detached
  const onScroll = (e: Event) => {
    if (!pop.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      anchor.focus();
    }
  };
  const render = () => {
    const d = app.stockDef;
    const zr = d.zRef ?? 'finished';
    const zBtn = (v: 'finished' | 'raw', label: string) =>
      h('button', { class: zr === v ? 'on' : '', 'aria-pressed': String(zr === v), onclick: () => { if (app.setWorkZero(d.origin, v)) render(); } }, label);
    fill(pop,
      h('div', { class: 'pop-h' }, h('b', null, 'Work zero G54'), h('button', { class: 'icon', 'aria-label': 'Close', onclick: close }, '✕')),
      h('p', { class: 'muted small' }, 'Click a corner or the centre of the block top – G54 is set there, like probing the part on the machine.'),
      workZeroPicker(d, (o) => { if (app.setWorkZero(o, zr)) { render(); (pop.querySelector('.wz-hit.on') as HTMLElement | null)?.focus(); } }),
      h('div', { class: 'pop-row' }, h('span', null, 'Z0 on the'), h('div', { class: 'seg small' }, zBtn('finished', 'finished top'), zBtn('raw', 'raw top'))),
      h('p', { class: 'muted small' }, d.zRef === 'raw'
        ? `Z0 = top of the raw block; the finished top is at Z-${d.topAllowance}.`
        : `Z0 = finished top; ${d.topAllowance} mm stock above it is faced off.`, ' A change loads a fresh block – program X/Y from the chosen point.'));
  };
  render();
  document.body.appendChild(pop);
  // beside the control panel when there is room (keeps the DRO visible), else below/above the button
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const clampTop = (t: number) => Math.max(8, Math.min(t, window.innerHeight - ph - 8));
  const panel = anchor.closest('.control-pane')?.getBoundingClientRect() ?? r;
  if (panel.left - pw - 10 >= 8 && window.innerWidth > 900) {
    pop.style.left = `${panel.left - pw - 10}px`;
    pop.style.top = `${clampTop(r.top - 60)}px`;
  } else {
    pop.style.left = `${Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8))}px`;
    pop.style.top = `${r.bottom + 6 + ph > window.innerHeight - 8 ? clampTop(r.top - ph - 6) : r.bottom + 6}px`;
  }
  anchor.setAttribute('aria-expanded', 'true');
  (pop.querySelector('.wz-hit.on') as HTMLElement | null)?.focus({ preventScroll: true });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', esc, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', close);
  zeroPop = { el: pop, close };
}

export function millStockDialog(app: MillAppApi) {
  const d = { ...app.stockDef };
  const sketchHost = h('div', { class: 'wz-host' });
  const redraw = () => fill(sketchHost, workZeroSketch(d));
  const wz = workZeroSelects(d, redraw);
  const form = h('div', { class: 'form' },
    h('label', null, 'Material'), h('select', { onchange: (e: Event) => (d.material = (e.target as HTMLSelectElement).value as MaterialId) }, (Object.keys(MATERIALS) as MaterialId[]).map((m) => h('option', { value: m, selected: m === d.material }, MATERIALS[m].name))),
    h('label', null, 'Size X'), num(d.sizeX, (v) => { d.sizeX = v; redraw(); }, { min: 10, max: 600 }),
    h('label', null, 'Size Y'), num(d.sizeY, (v) => { d.sizeY = v; redraw(); }, { min: 10, max: 400 }),
    h('label', null, 'Height Z'), num(d.sizeZ, (v) => { d.sizeZ = v; redraw(); }, { min: 3, max: 200 }),
    h('label', null, 'Stock to face off the top'), num(d.topAllowance, (v) => { d.topAllowance = v; redraw(); }, { min: 0, max: 10 }),
    h('label', null, 'Work zero X0 Y0 (G54)'), wz.origin,
    h('label', null, 'Z0 (G54) at the'), wz.zref,
    h('label', null, 'Height above the vise jaws'), num(d.aboveJaws, (v) => (d.aboveJaws = v), { min: 2, max: 200 }));
  redraw();
  openDialog({
    title: 'Workpiece (block)',
    body: h('div', null, form, sketchHost,
      h('p', { class: 'muted' }, 'The work zero G54 is set automatically to the chosen top corner (or the centre) of the block – like probing the part on the machine. Program X/Y from that corner: with a right or back corner the part lies in negative X or Y. With Z0 on the finished top the raw top is at Z+allowance and the face mill cuts at Z0; with Z0 on the raw top, the finished top is at Z−allowance. The vise clamps the Y sides; parallels support the Y edges underneath.')),
    size: 'narrow',
    buttons: [{ label: 'Cancel' }, { label: 'Load new block', primary: true, onClick: () => {
      const bad = ([[d.sizeX, 10, 600, 'Size X'], [d.sizeY, 10, 400, 'Size Y'], [d.sizeZ, 3, 200, 'Height Z'], [d.topAllowance, 0, 10, 'Stock to face off'], [d.aboveJaws, 2, 200, 'Height above the jaws']] as const)
        .find(([v, lo, hi]) => !Number.isFinite(v) || v < lo || v > hi);
      if (bad) { toast(`${bad[3]} must be between ${bad[1]} and ${bad[2]} mm`, 'err'); return false; }
      if (d.aboveJaws > d.sizeZ) { toast('The block cannot stick out more than its height', 'err'); return false; }
      return app.applyStock(d);
    } }],
  });
}

export function millSettingsDialog(app: MillAppApi) {
  const s = { ...app.settings };
  const w: Record<number, V3> = JSON.parse(JSON.stringify(app.workOffsets));
  let reload = app.reloadStockOnStart;
  const form = h('div', { class: 'form' },
    h('label', null, 'Rapid traverse (mm/min)'), num(s.rapidRate, (v) => (s.rapidRate = v), { min: 1000, step: 1000 }),
    h('label', null, 'Max. spindle speed (rpm)'), num(s.maxRpm, (v) => (s.maxRpm = v), { min: 500, step: 500 }),
    h('label', null, 'Spindle power (kW)'), num(s.powerKW, (v) => (s.powerKW = v), { min: 1 }),
    h('label', null, 'Home X / Y (work coords)'), h('div', null, num(s.homeX, (v) => (s.homeX = v)), num(s.homeY, (v) => (s.homeY = v))),
    h('label', null, 'Home Z of the gauge line'), num(s.homeZ, (v) => (s.homeZ = v), { min: 50 }),
    h('label', null, 'Tool change time (s)'), num(s.toolChangeTime, (v) => (s.toolChangeTime = v), { min: 0, step: 0.1 }),
    h('label', null, 'Fresh block at CYCLE START after M30'), h('input', { type: 'checkbox', checked: reload, onchange: (e: Event) => (reload = (e.target as HTMLInputElement).checked) }));
  const conv = h('div', { class: 'form' },
    h('label', null, 'Automatic tool length compensation'), h('input', { type: 'checkbox', checked: !!s.autoLength, onchange: (e: Event) => (s.autoLength = (e.target as HTMLInputElement).checked) }),
    h('label', null, 'Automatic cutter radius (G41/G42 without D)'), h('input', { type: 'checkbox', checked: !!s.autoRadius, onchange: (e: Event) => (s.autoRadius = (e.target as HTMLInputElement).checked) }),
    h('label', null, 'Programmed Z point of the tool'), h('select', { onchange: (e: Event) => (s.pointRef = (e.target as HTMLSelectElement).value as 'tip' | 'center') },
      h('option', { value: 'tip', selected: s.pointRef !== 'center' }, 'tool tip (lowest point)'),
      h('option', { value: 'center', selected: s.pointRef === 'center' }, 'centre of the nose radius')));
  const wo = h('table', { class: 'data' }, h('tr', null, ['Work offset', 'X', 'Y', 'Z'].map((c) => h('th', null, c))),
    [54, 55, 56, 57, 58, 59].map((g) => h('tr', null, h('td', null, `G${g}`), (['x', 'y', 'z'] as const).map((k) => h('td', null, num(w[g]?.[k] ?? 0, (v) => (w[g] = { ...(w[g] ?? { x: 0, y: 0, z: 0 }), [k]: v })))))));
  openDialog({
    title: 'Machine settings',
    body: h('div', null, form,
      h('h4', null, 'Programming conventions'),
      h('p', { class: 'muted small' }, 'Automatic length: after M06 the control applies the new tool’s length (tool table length + H wear) by itself – Z always means the tool point, no G43 H… needed (an explicit G43/G49 still works). Automatic radius: G41/G42 without D use the tool’s radius + D wear. Nose-radius centre: for a ball mill Z is the ball centre (tip = Z − D/2), for bull-nose and face mills the corner-radius centre (tip = Z − R) – as CAM systems output “centre” code. Other tools use the tip. Examples and exercises are written for the standard settings (all off, tip).'),
      conv,
      h('h4', null, 'Work coordinate systems'), h('p', { class: 'muted small' }, 'Shift of each work zero relative to G54 – e.g. a second part clamped next to the first.'), h('div', { class: 'table-scroll' }, wo)),
    size: 'narrow',
    buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => app.applySettings(s, w, reload) }],
  });
}

// ------------------------------------------------------------------ calculator

export function millCalcDialog(material: MaterialId) {
  const card = (title: string, fields: [string, number, string][], calc: (v: number[]) => string) => {
    const vals = fields.map((f) => f[1]);
    const out = h('div', { class: 'out' });
    const upd = () => (out.innerHTML = calc(vals));
    upd();
    return h('div', { class: 'calc-card' }, h('h4', null, title), h('div', { class: 'form' }, fields.flatMap(([l, , u], i) => [h('label', null, `${l}${u ? ` (${u})` : ''}`), num(vals[i], (v) => { vals[i] = v; upd(); })])), out);
  };
  const kc = MATERIALS[material].kc;
  openDialog({
    title: 'Cutting data calculator – milling',
    size: 'wide',
    body: h('div', { class: 'calc-grid' },
      card('Spindle speed', [['Vc', 250, 'm/min'], ['Tool Ø', 10, 'mm']], ([vc, d]) => `S = 1000·Vc/(π·D) = ${((1000 * vc) / (Math.PI * d)).toFixed(0)} rpm`),
      card('Table feed', [['fz', 0.05, 'mm/tooth'], ['Flutes z', 3, ''], ['S', 8000, 'rpm']], ([fz, z, s]) => `F = fz·z·S = ${(fz * z * s).toFixed(0)} mm/min`),
      card('Feed per tooth from F', [['F', 1200, 'mm/min'], ['Flutes z', 3, ''], ['S', 8000, 'rpm']], ([f, z, s]) => `fz = F/(z·S) = ${(f / (z * s)).toFixed(4)} mm`),
      card(`Removal rate & power (kc ${kc})`, [['Width ae', 5, 'mm'], ['Depth ap', 5, 'mm'], ['F', 1200, 'mm/min']], ([ae, ap, f]) => {
        const q = (ae * ap * f) / 1000;
        return `Q = ae·ap·F/1000 = ${q.toFixed(1)} cm³/min<br>P ≈ Q·kc/60000 = ${((q * kc) / 60000).toFixed(2)} kW`;
      }),
      card('Tapping feed', [['Pitch', 1.25, 'mm'], ['S', 800, 'rpm']], ([p, s]) => `F = pitch·S = ${(p * s).toFixed(1)} mm/min`),
      card('Drilling', [['Drill Ø', 6.8, 'mm'], ['Vc', 90, 'm/min'], ['f', 0.12, 'mm/rev']], ([d, vc, f]) => {
        const s = (1000 * vc) / (Math.PI * d);
        return `S = ${s.toFixed(0)} rpm, F = ${(f * s).toFixed(0)} mm/min<br>118° point length = ${(d / 2 / Math.tan((59 * Math.PI) / 180)).toFixed(2)} mm`;
      }),
      card('Ball mill scallop height', [['Ball Ø', 8, 'mm'], ['Step-over', 0.5, 'mm']], ([d, s]) => {
        const r = d / 2;
        return `h = R − √(R² − (s/2)²) = ${(r - Math.sqrt(Math.max(0, r * r - (s / 2) ** 2))).toFixed(4)} mm`;
      })),
  });
}

// ------------------------------------------------------------------ feature wizard

let lastSpec: MillWizardSpec | null = null;

export function millWizardDialog(app: MillAppApi) {
  const s: MillWizardSpec = lastSpec ? JSON.parse(JSON.stringify(lastSpec)) : defaultMillSpec(app.stockDef);
  const featHost = h('div', { class: 'wiz-feats' });
  const problems = h('ul', { class: 'wiz-problems' });
  const prev = h('canvas', { class: 'wiz-prev', width: 360, height: 280 });
  const tsel = (types: MillToolType[], v: number, set: (v: number) => void) => h('select', { onchange: (e: Event) => { set(+(e.target as HTMLSelectElement).value); check(); } },
    app.tools.filter((t) => types.includes(t.type)).map((t) => h('option', { value: String(t.id), selected: t.id === v }, `T${String(t.id).padStart(2, '0')} ${t.name}`)));
  const field = (label: string, v: number, set: (v: number) => void, attrs: Record<string, unknown> = {}) => h('label', { class: 'wiz-f' }, h('span', null, label), num(v, (x) => { set(x); check(); }, attrs));
  const check = () => {
    const p = checkMillSpec(s, app.tools);
    fill(problems, p.length ? p.map((x) => h('li', null, '⚠ ' + x)) : [h('li', { class: 'ok' }, '✔ Ready to generate.')]);
  };
  const MILLS: MillToolType[] = ['flat', 'bull', 'ball'];
  const render = () => {
    fill(featHost, s.features.map((f, i) => {
      const rm = h('button', { title: 'Remove', onclick: () => { s.features.splice(i, 1); render(); } }, '✕');
      const up = h('button', { title: 'Move up', disabled: i === 0, onclick: () => { [s.features[i - 1], s.features[i]] = [s.features[i], s.features[i - 1]]; render(); } }, '↑');
      let fields: Node[] = [];
      let title = '';
      if (f.kind === 'face') {
        title = 'Face the top';
        fields = [field('Z', f.z, (v) => (f.z = v)), h('label', { class: 'wiz-f' }, h('span', null, 'Tool'), tsel(['face', 'flat'], f.tool, (v) => (f.tool = v)))];
      } else if (f.kind === 'pocket' || f.kind === 'boss') {
        title = f.kind === 'pocket' ? 'Rectangular pocket' : 'Boss (outside contour)';
        fields = [field('Centre X', f.x, (v) => (f.x = v)), field('Centre Y', f.y, (v) => (f.y = v)), field('Size X', f.w, (v) => (f.w = v)), field('Size Y', f.l, (v) => (f.l = v)), field('Corner R', f.r, (v) => (f.r = v)), field(f.kind === 'pocket' ? 'Depth' : 'Height', f.depth, (v) => (f.depth = v)), field('Step-down', f.step, (v) => (f.step = v)),
          ...(f.kind === 'boss' ? [field('Rough rings', f.rings, (v) => (f.rings = Math.max(0, Math.round(v))), { step: 1 })] : []),
          h('label', { class: 'wiz-f' }, h('span', null, 'Tool'), tsel(MILLS, f.tool, (v) => (f.tool = v)))];
      } else if (f.kind === 'circle') {
        title = 'Circular pocket';
        fields = [field('Centre X', f.x, (v) => (f.x = v)), field('Centre Y', f.y, (v) => (f.y = v)), field('Diameter', f.d, (v) => (f.d = v)), field('Depth', f.depth, (v) => (f.depth = v)), field('Step-down', f.step, (v) => (f.step = v)), h('label', { class: 'wiz-f' }, h('span', null, 'Tool'), tsel(MILLS, f.tool, (v) => (f.tool = v)))];
      } else if (f.kind === 'slot') {
        title = 'Slot';
        fields = [field('X1', f.x1, (v) => (f.x1 = v)), field('Y1', f.y1, (v) => (f.y1 = v)), field('X2', f.x2, (v) => (f.x2 = v)), field('Y2', f.y2, (v) => (f.y2 = v)), field('Depth', f.depth, (v) => (f.depth = v)), field('Step-down', f.step, (v) => (f.step = v)), h('label', { class: 'wiz-f' }, h('span', null, 'Tool'), tsel(MILLS, f.tool, (v) => (f.tool = v)))];
      } else {
        title = f.pattern === 'grid' ? 'Hole grid' : 'Bolt-hole circle';
        fields = [
          h('label', { class: 'wiz-f' }, h('span', null, 'Pattern'), h('select', { onchange: (e: Event) => { f.pattern = (e.target as HTMLSelectElement).value as 'grid' | 'circle'; if (f.pattern === 'circle' && !f.count) { f.count = 6; f.radius = 20; } render(); } }, h('option', { value: 'grid', selected: f.pattern === 'grid' }, 'grid'), h('option', { value: 'circle', selected: f.pattern === 'circle' }, 'circle (G16 polar)'))),
          field(f.pattern === 'grid' ? 'First X' : 'Centre X', f.x, (v) => (f.x = v)), field(f.pattern === 'grid' ? 'First Y' : 'Centre Y', f.y, (v) => (f.y = v)),
          ...(f.pattern === 'grid'
            ? [field('Count X', f.nx, (v) => (f.nx = Math.max(1, Math.round(v))), { step: 1 }), field('Count Y', f.ny, (v) => (f.ny = Math.max(1, Math.round(v))), { step: 1 }), field('Pitch X', f.dx, (v) => (f.dx = v)), field('Pitch Y', f.dy, (v) => (f.dy = v))]
            : [field('Radius', f.radius, (v) => (f.radius = v)), field('Holes', f.count, (v) => (f.count = Math.max(1, Math.round(v))), { step: 1 }), field('Start angle', f.angle, (v) => (f.angle = v))]),
          field('Depth', f.depth, (v) => (f.depth = v)),
          h('label', { class: 'wiz-f' }, h('span', null, 'Drill'), tsel(['drill', 'ream'], f.drillTool, (v) => (f.drillTool = v))),
          h('label', { class: 'wiz-f' }, h('span', null, 'Tap'), h('input', { type: 'checkbox', checked: f.tap, onchange: (e: Event) => { f.tap = (e.target as HTMLInputElement).checked; check(); } }), tsel(['tap'], f.tapTool, (v) => (f.tapTool = v))),
        ];
      }
      return h('fieldset', { class: 'wiz-sec' }, h('legend', null, `${i + 1}. ${title} `, up, rm), h('div', { class: 'wiz-row' }, fields));
    }));
    check();
  };
  const addF = (f: MillFeature) => {
    s.features.push(f);
    render();
  };
  const st = s.stock;
  const centre = () => {
    const g = blockFrame(st);
    return { cx: (g.x0 + g.x1) / 2, cy: (g.y0 + g.y1) / 2 };
  };
  let { cx, cy } = centre();
  // moving the work zero keeps the features where they are on the part (their coordinates change)
  let prevFrame = blockFrame(st);
  const wz = workZeroSelects(st, () => {
    const g = blockFrame(st);
    s.features.forEach((f) => shiftFeature(f, g.x0 - prevFrame.x0, g.y0 - prevFrame.y0));
    prevFrame = g;
    ({ cx, cy } = centre());
    legend.textContent = blockLegend();
    render();
    drawPreview();
  });
  const blockLegend = () => `Block (X0 Y0 = ${ORIGIN_NAMES[st.origin]}, Z0 = ${st.zRef === 'raw' ? 'raw top' : 'finished top'}; feature depths are measured from the finished top)`;
  const legend = h('legend', null, blockLegend());
  const sizeChanged = () => {
    prevFrame = blockFrame(st);
    ({ cx, cy } = centre());
  };
  const adds = h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
    h('button', { onclick: () => addF({ kind: 'face', z: 0, tool: 1 }) }, '+ Face'),
    h('button', { onclick: () => addF({ kind: 'pocket', x: cx, y: cy, w: 30, l: 20, r: 5, depth: 5, step: 2.5, tool: 2 }) }, '+ Pocket'),
    h('button', { onclick: () => addF({ kind: 'circle', x: cx, y: cy, d: 20, depth: 5, step: 2.5, tool: 2 }) }, '+ Circular pocket'),
    h('button', { onclick: () => addF({ kind: 'boss', x: cx, y: cy, w: 40, l: 30, r: 5, depth: 4, step: 2, tool: 2, rings: 1 }) }, '+ Boss'),
    h('button', { onclick: () => addF({ kind: 'slot', x1: cx - 20, y1: cy, x2: cx + 20, y2: cy, depth: 3, step: 1.5, tool: 3 }) }, '+ Slot'),
    h('button', { onclick: () => addF({ kind: 'holes', pattern: 'grid', x: cx - 30, y: cy - 25, nx: 2, ny: 2, dx: 60, dy: 50, radius: 20, count: 6, angle: 0, depth: 12, spotTool: 4, drillTool: 5, tapTool: 6, tap: false }) }, '+ Holes'));
  const drawPreview = () => {
    const p = checkMillSpec(s, app.tools);
    if (p.length) {
      toast('Fix the problems first', 'warn');
      return;
    }
    const code = generateMill(s, app.tools, app.settings.maxRpm, app.settings);
    const b = simulateBlock(code, s.stock, app.cfg(), true);
    const ctx = prev.getContext('2d')!;
    const img = ctx.createImageData(b.nx, b.ny);
    for (let j = 0; j < b.ny; j++) for (let i = 0; i < b.nx; i++) {
      const hk = b.h[j * b.nx + i];
      const t = Math.min(1, Math.max(0, (b.top - hk) / (b.top - b.bottom)));
      const p4 = ((b.ny - 1 - j) * b.nx + i) * 4;
      const v = hk <= b.bottom + 0.01 ? 25 : 225 - t * 170;
      img.data[p4] = v * 0.85;
      img.data[p4 + 1] = v * 0.92;
      img.data[p4 + 2] = v;
      img.data[p4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = b.nx;
    tmp.height = b.ny;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    const k = Math.min(prev.width / b.nx, prev.height / b.ny);
    ctx.clearRect(0, 0, prev.width, prev.height);
    ctx.drawImage(tmp, 0, 0, b.nx * k, b.ny * k);
  };
  const stockRow = h('div', { class: 'wiz-row' },
    field('Block X', st.sizeX, (v) => { st.sizeX = v; sizeChanged(); }), field('Block Y', st.sizeY, (v) => { st.sizeY = v; sizeChanged(); }), field('Block Z', st.sizeZ, (v) => (st.sizeZ = v)),
    h('label', { class: 'wiz-f' }, h('span', null, 'Material'), h('select', { onchange: (e: Event) => (st.material = (e.target as HTMLSelectElement).value as MaterialId) }, (Object.keys(MATERIALS) as MaterialId[]).map((m) => h('option', { value: m, selected: m === st.material }, MATERIALS[m].name)))),
    h('label', { class: 'wiz-f' }, h('span', null, 'X0 Y0'), wz.origin),
    h('label', { class: 'wiz-f' }, h('span', null, 'Z0'), wz.zref),
    h('label', { class: 'wiz-f' }, h('span', null, 'Name'), h('input', { type: 'text', value: s.name, oninput: (e: Event) => (s.name = (e.target as HTMLInputElement).value) })));
  render();
  let closeDlg = () => {};
  closeDlg = openDialog({
    title: 'Program wizard – milling features',
    size: 'wide',
    body: h('div', { class: 'wiz' },
      h('p', { class: 'muted' }, 'Pick features, the wizard writes a complete, commented program: speeds and feeds from the material, helical entries, climb milling, cutter compensation on finished walls, canned cycles for holes. Read the result – it is meant to be learned from.'),
      h('fieldset', { class: 'wiz-sec' }, legend, stockRow),
      h('div', { class: 'wiz-grid' }, h('div', null, featHost, adds), h('div', null, h('button', { onclick: drawPreview }, 'Preview result'), prev, problems))),
    buttons: [
      { label: 'Reset to example', onClick: () => { lastSpec = null; closeDlg(); millWizardDialog(app); return false; } },
      { label: 'Cancel' },
      { label: 'Generate program', primary: true, onClick: () => {
        const p = checkMillSpec(s, app.tools);
        if (p.length) { toast('Fix the problems listed first', 'err'); return false; }
        lastSpec = JSON.parse(JSON.stringify(s));
        app.loadGenerated(generateMill(s, app.tools, app.settings.maxRpm, app.settings), { ...s.stock }, s.name);
        return true;
      } },
    ],
  });
  requestAnimationFrame(drawPreview);
}

export function millHelpDialog() {
  openDialog({
    title: 'Help – milling simulator',
    size: 'narrow',
    body: h('div', { html: `
<h3>Quick start</h3>
<ol>
<li>Load an <b>Example</b> or write a program – errors and warnings appear live; the panel under the editor explains the current block.</li>
<li>Look at the path in <b>Top</b> (depth map), <b>Front</b> and <b>Side</b> sections; move the section line with the slider.</li>
<li><b>CYCLE START</b>. Use SINGLE BLOCK, FEED HOLD, overrides and the timeline (⏮ ⏭) to study it.</li>
<li>Watch the <b>CLIMB / CONVENTIONAL / SLOT</b> indicator, feed per tooth and spindle load while cutting.</li>
<li>Exercises: press <b>Check part</b> – blue = material left, red = gouged.</li>
</ol>
<h3>Simulated</h3>
<p>Fanuc 0i-M style: G00–G04, G15/G16 polar, G17–G19 planes and helical arcs, G20/G21, G28, G40–G42 (D), G43/G44/G49 (H), G52, G53, G54–G59, G68/G69, G73/G74/G76/G80–G89 with G98/G99 and K repeats, G90/G91, G94/G95, M00–M09, M06 tool change, M30, M98/M99, ,C/,R corners and Custom Macro B.
Material removal uses the real tool shape (flat, bull-nose, ball, drill point, spot, chamfer, face mill) on a height map – no undercuts (3-axis).</p>
<h3>Work zero and conventions</h3>
<p><b>Workpiece</b>: G54 is set automatically to the chosen top corner (front/back, left/right) or the centre of the block, with Z0 on the finished or the raw top.
<b>Settings → Programming conventions</b>: automatic tool length compensation (no G43 H after M06), automatic cutter radius (G41/G42 without D), and the programmed Z point (tool tip, or the centre of the nose radius for ball / bull-nose / face mills). The line under the modal codes shows what is active; lesson 10 explains it.</p>
<p>Quick buttons under the DRO: <b>AUTO TOOL COMP</b> switches automatic length + radius compensation on/off in one click; <b>WORK ZERO G54</b> opens a picker – click a corner or the centre of the block and choose Z0 on the finished or raw top. The work zero is drawn in every view: yellow point with the X+ (red), Y+ (green) and Z+ (blue) directions.</p>
<h3>Keyboard</h3>
<p><span class="kbd">Ctrl</span>+<span class="kbd">Enter</span> cycle start · <span class="kbd">Space</span> feed hold · <span class="kbd">Esc</span> reset · JOG: arrows = X/Y, PgUp/PgDn = Z.</p>` }),
  });
}
