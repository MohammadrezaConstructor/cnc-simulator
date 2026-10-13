import { h, openDialog, toast, fill, download } from './dom';
import { EXAMPLES } from '../content/examples';
import { EXERCISES, type Exercise } from '../content/exercises';
import { exportExercise, importExercises, nameControls } from './dialogs2';
import { LESSONS } from '../content/lessons';
import { GCODES, MCODES, ADDRESSES, MACROS, type CodeRef } from '../content/gcodeRef';
import type { MachineSettings, MaterialId, OffsetEntry, P, StockDef, ToolDef, ToolType } from '../types';
import { buildToolShape, TOOL_TYPE_LABEL, defaultTools, defaultOffsets } from '../sim/tools';
import { MATERIALS } from '../sim/machine';

export interface AppApi {
  tools: ToolDef[];
  offsets: Map<number, OffsetEntry>;
  stockDef: StockDef;
  settings: MachineSettings;
  workOffsets: Record<number, P>;
  progress: Set<string>;
  loadExample(id: string): void;
  loadExercise(id: string): void;
  applyTools(tools: ToolDef[], offsets: Map<number, OffsetEntry>): void;
  applyStock(def: StockDef): void;
  applySettings(s: MachineSettings, w: Record<number, P>, reloadStock: boolean): void;
  reloadStockOnStart: boolean;
  saveProgress(): void;
  customExercises: Exercise[];
  saveCustomExercises(): void;
  loadExerciseObject(ex: Exercise): void;
  openBuilder(): void;
}

const num = (v: number, onChange: (v: number) => void, attrs: Record<string, unknown> = {}) =>
  h('input', {
    type: 'number',
    value: String(v),
    step: 'any',
    ...attrs,
    oninput: (e: Event) => {
      const x = parseFloat((e.target as HTMLInputElement).value);
      if (isFinite(x)) onChange(x);
    },
  });

// ------------------------------------------------------------------ examples & exercises

export function examplesDialog(app: AppApi) {
  const body = h(
    'div',
    { class: 'cards' },
    EXAMPLES.map((ex) =>
      h(
        'button',
        { class: 'card', onclick: () => { close(); app.loadExample(ex.id); } },
        h('h4', null, ex.title),
        h('div', { class: 'tags' }, h('span', { class: `tag lvl-${ex.level}` }, ex.level), ex.topics.map((t) => h('span', { class: 'tag' }, t))),
        h('p', null, ex.description),
        h('p', null, `Stock Ø${ex.stock.diameter} × ${ex.stock.length} ${MATERIALS[ex.stock.material].name}${ex.target ? ' · has target drawing' : ''}`),
      ),
    ),
  );
  const close = openDialog({ title: 'Example programs', body, size: 'wide' });
}

export function exercisesDialog(app: AppApi) {
  const customHost = h('div', { class: 'cards' });
  const card = (ex: Exercise) =>
    h(
      'div',
      { class: 'card', role: 'button', tabindex: '0', onclick: () => { close(); app.loadExerciseObject(ex); }, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { close(); app.loadExerciseObject(ex); } } },
      h('h4', null, ex.title, app.progress.has('ex:' + ex.id) ? '  ✔' : ''),
      h('div', { class: 'tags' }, h('span', { class: `tag lvl-${ex.level}` }, ex.level), ex.custom ? h('span', { class: 'tag' }, 'custom') : null, ex.target.ra ? h('span', { class: 'tag' }, `Ra ≤ ${ex.target.ra}`) : null),
      h('p', null, ex.brief.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').slice(0, 170) + '…'),
      ex.custom
        ? h('div', { class: 'row', style: { display: 'flex', gap: '6px' } },
            h('button', { onclick: (e: Event) => { e.stopPropagation(); download(`${ex.title.replace(/[^\w-]+/g, '_')}.lathelab.json`, exportExercise(ex), 'application/json'); } }, 'Download'),
            h('button', { onclick: (e: Event) => { e.stopPropagation(); navigator.clipboard?.writeText(exportExercise(ex)).then(() => toast('Copied', 'ok'), () => toast('Copy blocked', 'warn')); } }, 'Copy JSON'),
            h('button', { onclick: (e: Event) => { e.stopPropagation(); app.customExercises.splice(app.customExercises.indexOf(ex), 1); app.saveCustomExercises(); renderCustom(); } }, 'Delete'))
        : null,
    );
  const renderCustom = () => {
    fill(customHost, app.customExercises.length ? app.customExercises.map(card) : [h('p', { class: 'muted' }, 'No custom exercises yet.')]);
  };
  renderCustom();
  const paste = h('textarea', { rows: 3, placeholder: 'Paste exercise JSON here…', spellcheck: 'false', 'aria-label': 'Exercise JSON to import' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Exercise file to import' });
  const doImport = (text: string) => {
    try {
      const list = importExercises(text);
      if (!list.length) throw new Error('no exercise found');
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
  const body = h(
    'div',
    null,
    h('p', { class: 'muted' }, 'Each exercise loads a bar, a drawing and a program skeleton. Write the program, run it, then press “Check part” – the simulator measures your part against the drawing.'),
    h('div', { class: 'cards' }, EXERCISES.map(card)),
    h('h3', null, 'Your exercises'),
    h('p', { class: 'muted small' }, 'Teachers: run a reference program, then use “Create from current program” – the machined part becomes the drawing. Share exercises as JSON files; they are stored in this browser only.'),
    customHost,
    h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
      h('button', { class: 'primary', onclick: () => { close(); app.openBuilder(); } }, '＋ Create from current program'),
      h('button', { onclick: () => fileIn.click() }, 'Import .json file'),
      h('button', { onclick: () => doImport(paste.value) }, 'Import pasted JSON'),
      fileIn),
    paste,
  );
  const close = openDialog({ title: 'Exercises', body, size: 'wide' });
}

// ------------------------------------------------------------------ lessons

export function lessonsDialog(app: AppApi, startId?: string) {
  let current = startId ?? LESSONS.find((l) => !app.progress.has('lesson:' + l.id))?.id ?? LESSONS[0].id;
  const list = h('div', { class: 'lesson-list' });
  const content = h('div', { class: 'lesson-body' });
  const render = () => {
    list.replaceChildren(
      ...LESSONS.map((l) =>
        h(
          'button',
          { class: l.id === current ? 'on' : '', onclick: () => { current = l.id; render(); } },
          l.title,
          app.progress.has('lesson:' + l.id) ? h('span', { class: 'done' }, '✔') : null,
        ),
      ),
    );
    const L = LESSONS.find((l) => l.id === current)!;
    const idx = LESSONS.indexOf(L);
    const quiz = L.quiz?.length
      ? h(
          'div',
          { class: 'quiz' },
          h('h4', null, 'Check yourself'),
          L.quiz.map((q) => {
            const why = h('div', { class: 'why hidden' }, q.why);
            const opts = h('div', { class: 'opts-q' });
            q.options.forEach((o, i) => {
              opts.appendChild(
                h('button', {
                  onclick: (e: Event) => {
                    const b = e.currentTarget as HTMLButtonElement;
                    b.classList.add(i === q.answer ? 'right' : 'wrong');
                    if (i === q.answer) why.classList.remove('hidden');
                    checkDone();
                  },
                }, o),
              );
            });
            return h('div', null, h('div', { class: 'q' }, q.q), opts, why);
          }),
        )
      : null;
    const checkDone = () => {
      const all = content.querySelectorAll('.quiz .opts-q');
      const ok = Array.from(all).every((o) => o.querySelector('.right'));
      if (!ok) return;
      if (!app.progress.has('lesson:' + L.id)) {
        app.progress.add('lesson:' + L.id);
        app.saveProgress();
      }
      // the mark is added once – further clicks on answers must not stack more ticks
      const btn = list.querySelectorAll('button')[idx];
      if (btn && !btn.querySelector('.done')) btn.append(h('span', { class: 'done' }, '✔'));
    };
    fill(content,
      h('h3', null, L.title),
      h('div', { html: L.html }),
      L.examples?.length
        ? h('p', null, 'Try it: ', L.examples.map((id) => {
            const ex = EXAMPLES.find((e) => e.id === id);
            return ex ? h('button', { onclick: () => { close(); app.loadExample(id); }, style: { marginRight: '6px' } }, ex.title) : null;
          }))
        : null,
      quiz,
      h('div', { class: 'row', style: { display: 'flex', justifyContent: 'space-between', marginTop: '14px' } },
        h('button', { disabled: idx === 0, onclick: () => { current = LESSONS[idx - 1].id; render(); } }, '← Previous'),
        h('button', {
          disabled: idx === LESSONS.length - 1,
          onclick: () => {
            if (!L.quiz?.length) {
              app.progress.add('lesson:' + L.id);
              app.saveProgress();
            }
            current = LESSONS[idx + 1].id;
            render();
          },
        }, 'Next →'),
      ),
    );
    content.scrollTop = 0;
  };
  render();
  const close = openDialog({ title: 'Lessons – CNC turning with Fanuc G-code', body: h('div', { class: 'lessons' }, list, content), size: 'wide' });
}

// ------------------------------------------------------------------ reference

export function referenceDialog(filter = '') {
  const input = h('input', { type: 'text', class: 'ref-search', placeholder: 'Search: e.g. G71, thread, compensation…', value: filter, 'aria-label': 'Search the G-code reference' });
  const out = h('div');
  const item = (c: CodeRef) =>
    h(
      'div',
      { class: 'ref-item' },
      h('h4', null, h('span', null, c.code), c.title, h('small', { class: 'muted' }, `  · ${c.group}${c.modal ? ' · modal' : ''}`)),
      c.syntax ? h('pre', null, c.syntax) : null,
      h('p', null, c.text),
      c.params ? h('table', { class: 'data' }, c.params.map(([k, v]) => h('tr', null, h('td', null, h('code', null, k)), h('td', null, v)))) : null,
      c.example ? h('pre', null, c.example) : null,
      c.tip ? h('p', { class: 'muted' }, '💡 ' + c.tip) : null,
    );
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const all = [...GCODES, ...MCODES, ...MACROS, ...ADDRESSES];
    const hits = all.filter((c) => !q || (c.code + ' ' + c.title + ' ' + c.text + ' ' + c.group).toLowerCase().includes(q));
    out.replaceChildren(...(hits.length ? hits.map(item) : [h('p', { class: 'muted' }, 'Nothing found.')]));
  };
  input.addEventListener('input', render);
  render();
  openDialog({ title: 'G-code reference (Fanuc lathe, Group A)', body: h('div', null, input, out), size: 'wide' });
}

// ------------------------------------------------------------------ tools & offsets

function drawToolPreview(cv: HTMLCanvasElement, t: ToolDef) {
  const ctx = cv.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 260, H = cv.clientHeight || 200;
  cv.width = W * dpr;
  cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  ctx.fillStyle = css('--v-bg');
  ctx.fillRect(0, 0, W, H);
  let sh;
  try {
    sh = buildToolShape(t);
  } catch {
    return;
  }
  const pts = [...sh.cutter, ...sh.holder.flat()].filter((p) => Math.abs(p.x) < 40 && Math.abs(p.z) < 40);
  pts.push({ x: 0, z: 0 });
  const zmin = Math.min(...pts.map((p) => p.z)) - 2, zmax = Math.max(...pts.map((p) => p.z)) + 2;
  const xmin = Math.min(...pts.map((p) => p.x)) - 2, xmax = Math.max(...pts.map((p) => p.x)) + 2;
  const s = Math.min(W / (zmax - zmin), H / (xmax - xmin));
  const X = (z: number) => (z - zmin) * s + (W - (zmax - zmin) * s) / 2;
  const Y = (x: number) => H - ((x - xmin) * s + (H - (xmax - xmin) * s) / 2);
  const poly = (p: { x: number; z: number }[], fill: string) => {
    ctx.beginPath();
    p.forEach((q, i) => (i ? ctx.lineTo(X(q.z), Y(q.x)) : ctx.moveTo(X(q.z), Y(q.x))));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = css('--v-stock-edge');
    ctx.stroke();
  };
  for (const hp of sh.holder) poly(hp, css('--v-holder'));
  poly(sh.cutter, css('--v-cutter'));
  ctx.strokeStyle = css('--v-sel');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(X(0) - 8, Y(0));
  ctx.lineTo(X(0) + 8, Y(0));
  ctx.moveTo(X(0), Y(0) - 8);
  ctx.lineTo(X(0), Y(0) + 8);
  ctx.stroke();
  ctx.fillStyle = css('--v-text');
  ctx.font = '11px sans-serif';
  ctx.fillText('+ = programmed point (imaginary tip)', 6, 14);
}

export function toolsDialog(app: AppApi) {
  let tools = app.tools.map((t) => ({ ...t }));
  let offsets = new Map(Array.from(app.offsets.entries()).map(([k, v]) => [k, { ...v }]));
  let sel = tools[0]?.id ?? 1;
  const preview = h('canvas', { class: 'tool-preview' });
  const info = h('p', { class: 'muted small' });
  const tableHost = h('div', { class: 'tool-table' });
  const types = Object.keys(TOOL_TYPE_LABEL) as ToolType[];

  /** preview + description of the selected tool */
  const showSel = () => {
    const t = tools.find((x) => x.id === sel);
    if (t) {
      requestAnimationFrame(() => drawToolPreview(preview, t));
      info.textContent = `${TOOL_TYPE_LABEL[t.type]} – tip number ${t.tipNo}. Width = groove/part-off width, drill Ø or boring bar Ø. Reach = max. groove depth / drill flute length / bar length. Drills use the last angle as point angle.`;
    }
  };
  /** selecting a row must NOT rebuild the table – that would swallow the click / focus on its fields */
  const select = (id: number) => {
    if (sel === id) return;
    sel = id;
    tableHost.querySelectorAll<HTMLElement>('tr[data-id]').forEach((tr) => tr.classList.toggle('sel', +tr.dataset.id! === id));
    showSel();
  };

  const render = () => {
    // keep the keyboard focus on the same field when the table has to be rebuilt (type change, add, remove)
    const focusName = tableHost.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : null;
    const rows = [];
    for (let id = 1; id <= 12; id++) {
      const t = tools.find((x) => x.id === id);
      const o = offsets.get(id) ?? { wx: 0, wz: 0, r: 0, t: 0 };
      offsets.set(id, o);
      const T = `T${String(id).padStart(2, '0')}`;
      const upd = () => {
        if (id === sel && t) drawToolPreview(preview, t);
      };
      if (!t) {
        rows.push(h('tr', null, h('td', null, T), h('td', { colspan: 14 },
          h('span', { class: 'muted' }, 'empty station '),
          h('button', { 'aria-label': `Add a tool in station ${T}`, onclick: () => { tools.push({ ...defaultTools()[0], id, name: 'New tool' }); sel = id; render(); } }, '+ add tool'))));
        continue;
      }
      const field = (k: keyof ToolDef, name: string, attrs: Record<string, unknown> = {}) =>
        num(t[k] as number, (v) => { (t as unknown as Record<string, number>)[k] = v; if (k === 'noseR') { o.r = v; rIn.value = String(v); } upd(); }, { ...attrs, 'aria-label': `${T} ${name}` });
      const rIn = num(o.r, (v) => (o.r = v), { min: 0, step: 0.1, 'aria-label': `${T} offset R (nose radius for G41/G42)` }) as HTMLInputElement;
      rows.push(
        h('tr', { class: id === sel ? 'sel' : '', dataset: { id: String(id) }, onclick: () => select(id) },
          h('td', null, h('b', null, T)),
          h('td', null, h('select', { 'aria-label': `${T} tool type`, onchange: (e: Event) => { t.type = (e.target as HTMLSelectElement).value as ToolType; const d = defaultTools().find((x) => x.type === t.type); if (d) Object.assign(t, { ...d, id, name: d.name }); o.r = t.noseR; o.t = t.tipNo; render(); } },
            types.map((ty) => h('option', { value: ty, selected: ty === t.type }, TOOL_TYPE_LABEL[ty])))),
          h('td', null, h('input', { type: 'text', value: t.name, 'aria-label': `${T} name`, oninput: (e: Event) => (t.name = (e.target as HTMLInputElement).value) })),
          h('td', null, field('noseR', 'nose radius', { min: 0, step: 0.1 })),
          h('td', null, field('tipNo', 'tip number', { min: 0, max: 9, step: 1 })),
          h('td', null, field('insertAngle', 'insert angle', { min: 20, max: 90 })),
          h('td', null, field('approach', 'approach angle', { min: 45, max: 120 })),
          h('td', null, field('size', 'edge length', { min: 3, max: 30 })),
          h('td', null, field('width', 'width / diameter', { min: 0.5, max: 60 })),
          h('td', null, field('reach', 'reach', { min: 1, max: 200 })),
          h('td', null, field('threadAngle', 'thread / point angle', { min: 29, max: 140 })),
          h('td', null, num(o.wx, (v) => (o.wx = v), { step: 0.01, 'aria-label': `${T} wear X (diameter)` })),
          h('td', null, num(o.wz, (v) => (o.wz = v), { step: 0.01, 'aria-label': `${T} wear Z` })),
          h('td', null, rIn),
          h('td', null, num(o.t, (v) => (o.t = Math.round(v)), { min: 0, max: 9, step: 1, 'aria-label': `${T} offset T (tip number for G41/G42)` })),
          h('td', null, h('button', { title: 'Remove tool', 'aria-label': `Remove tool ${T}`, onclick: (e: Event) => { e.stopPropagation(); tools = tools.filter((x) => x.id !== id); render(); } }, '✕')),
        ),
      );
    }
    tableHost.replaceChildren(
      h('table', null,
        h('tr', null, ['T', 'Type', 'Name', 'Nose R', 'Tip', 'Insert ∠', 'Approach κ', 'Edge', 'Width / Ø', 'Reach', 'Thread / point ∠', 'Wear X (Ø)', 'Wear Z', 'Offset R', 'Offset T', ''].map((c) => h('th', null, c))),
        rows,
      ),
    );
    if (focusName) Array.from(tableHost.querySelectorAll<HTMLElement>('[aria-label]')).find((e) => e.getAttribute('aria-label') === focusName)?.focus();
    showSel();
  };
  render();
  const body = h(
    'div',
    null,
    h('p', { class: 'muted' }, 'Geometry of the tools in the turret and the offset page. Offsets are numbered like the stations (T0303 uses offset 03). Wear X is a diameter value. Offset R/T are used by G41/G42 – they normally equal the insert’s nose radius and tip number.'),
    h('div', { class: 'tools-layout' }, h('div', null, preview, info), tableHost),
  );
  openDialog({
    title: 'Tools & offsets',
    body,
    size: 'wide',
    buttons: [
      { label: 'Restore defaults', onClick: () => { tools = defaultTools(); offsets = defaultOffsets(tools); render(); return false; } },
      { label: 'Cancel' },
      { label: 'Apply', primary: true, onClick: () => { app.applyTools(tools.sort((a, b) => a.id - b.id), offsets); toast('Tool table updated – program re-checked', 'ok'); } },
    ],
  });
}

// ------------------------------------------------------------------ stock

export function stockDialog(app: AppApi) {
  const d = { ...app.stockDef };
  const form = h(
    'div',
    { class: 'form' },
    h('label', null, 'Material'),
    h('select', { onchange: (e: Event) => (d.material = (e.target as HTMLSelectElement).value as MaterialId) },
      (Object.keys(MATERIALS) as MaterialId[]).map((m) => h('option', { value: m, selected: m === d.material }, `${MATERIALS[m].name} (Vc ${MATERIALS[m].vc[0]}–${MATERIALS[m].vc[1]} m/min)`))),
    h('label', null, 'Outside diameter Ø'), num(d.diameter, (v) => (d.diameter = v), { min: 2, max: 300 }),
    h('label', null, 'Bar length (total)'), num(d.length, (v) => (d.length = v), { min: 5, max: 600 }),
    h('label', null, 'Existing bore Ø (0 = solid)'), num(d.bore, (v) => (d.bore = v), { min: 0 }),
    h('label', null, 'Face allowance beyond Z0'), num(d.faceAllowance, (v) => (d.faceAllowance = v), { min: 0, max: 20 }),
    h('label', null, 'Length held in the jaws'), num(d.gripLength, (v) => (d.gripLength = v), { min: 5, max: 200 }),
  );
  nameControls(form);
  const body = h('div', null, form, h('p', { class: 'muted' }, 'The bar sticks out of the chuck by (length − grip). Z0 is the finished front face; the raw bar ends at +face allowance.'));
  openDialog({
    title: 'Workpiece (bar stock)',
    body,
    size: 'narrow',
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Load new bar',
        primary: true,
        onClick: () => {
          if (d.bore >= d.diameter) {
            toast('The bore must be smaller than the outside diameter', 'err');
            return false;
          }
          if (d.gripLength >= d.length) {
            toast('Grip length must be shorter than the bar', 'err');
            return false;
          }
          app.applyStock(d);
          return true;
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ settings

export function settingsDialog(app: AppApi) {
  const s = { ...app.settings };
  const w: Record<number, P> = JSON.parse(JSON.stringify(app.workOffsets));
  let reload = app.reloadStockOnStart;
  const form = h(
    'div',
    { class: 'form' },
    h('label', null, 'Rapid traverse (mm/min)'), num(s.rapidRate, (v) => (s.rapidRate = v), { min: 1000, max: 60000, step: 1000 }),
    h('label', null, 'Max. spindle speed (rpm)'), num(s.maxRpm, (v) => (s.maxRpm = v), { min: 500, max: 10000, step: 100 }),
    h('label', null, 'Spindle power (kW)'), num(s.powerKW, (v) => (s.powerKW = v), { min: 1, max: 100 }),
    h('label', null, 'Home position X (Ø)'), num(s.homeX, (v) => (s.homeX = v)),
    h('label', null, 'Home position Z'), num(s.homeZ, (v) => (s.homeZ = v)),
    h('label', null, 'Tool change time (s)'), num(s.toolChangeTime, (v) => (s.toolChangeTime = v), { min: 0, max: 10, step: 0.1 }),
    h('label', { title: 'Many machines move each axis at full rapid speed independently ("dog-leg"). The path is then NOT a straight line.' }, 'G00 path'),
    h('select', { onchange: (e: Event) => (s.rapidMode = (e.target as HTMLSelectElement).value as 'linear' | 'dogleg') },
      h('option', { value: 'linear', selected: s.rapidMode !== 'dogleg' }, 'Straight line (interpolated)'),
      h('option', { value: 'dogleg', selected: s.rapidMode === 'dogleg' }, 'Dog-leg: 45° first, then one axis')),
    h('label', null, 'Fresh bar at CYCLE START after M30'),
    h('input', { type: 'checkbox', checked: reload, onchange: (e: Event) => (reload = (e.target as HTMLInputElement).checked) }),
  );
  const wo = h('table', { class: 'data' },
    h('tr', null, h('th', null, 'Work offset'), h('th', null, 'Shift X (Ø)'), h('th', null, 'Shift Z')),
    [54, 55, 56, 57, 58, 59].map((g) => h('tr', null, h('td', null, `G${g}`),
      h('td', null, num((w[g]?.x ?? 0) * 2, (v) => (w[g] = { ...(w[g] ?? { x: 0, z: 0 }), x: v / 2 }), { 'aria-label': `G${g} shift X (diameter)` })),
      h('td', null, num(w[g]?.z ?? 0, (v) => (w[g] = { ...(w[g] ?? { x: 0, z: 0 }), z: v }), { 'aria-label': `G${g} shift Z` })))),
  );
  nameControls(form);
  openDialog({
    title: 'Machine settings',
    body: h('div', null, form, h('h4', null, 'Work coordinate systems'), h('p', { class: 'muted small' }, 'Shift of each work zero relative to the simulator zero (normally only Z is used, e.g. for a second part).'), wo),
    size: 'narrow',
    buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => app.applySettings(s, w, reload) }],
  });
}

// ------------------------------------------------------------------ calculator

export function calcDialog(material: MaterialId) {
  const card = (title: string, fields: [string, number, string][], calc: (v: number[]) => string) => {
    const vals = fields.map((f) => f[1]);
    const out = h('div', { class: 'out' });
    const upd = () => (out.innerHTML = calc(vals));
    const form = h('div', { class: 'form' },
      fields.flatMap(([label, , unit], i) => [h('label', null, `${label}${unit ? ` (${unit})` : ''}`), num(vals[i], (v) => { vals[i] = v; upd(); })]));
    nameControls(form);
    upd();
    return h('div', { class: 'calc-card' }, h('h4', null, title), form, out);
  };
  const kc = MATERIALS[material].kc;
  const body = h(
    'div',
    { class: 'calc-grid' },
    card('Spindle speed', [['Cutting speed Vc', 200, 'm/min'], ['Diameter D', 40, 'mm']], ([vc, d]) => `n = 1000·Vc/(π·D) = ${((1000 * vc) / (Math.PI * d)).toFixed(0)} rpm`),
    card('Cutting speed from rpm', [['Spindle speed n', 1500, 'rpm'], ['Diameter D', 40, 'mm']], ([n, d]) => `Vc = π·D·n/1000 = ${((Math.PI * d * n) / 1000).toFixed(1)} m/min`),
    card('Feed & machining time', [['Feed f', 0.25, 'mm/rev'], ['Spindle speed n', 1500, 'rpm'], ['Length of cut L', 50, 'mm']], ([f, n, L]) => {
      const vf = f * n;
      return `Vf = f·n = ${vf.toFixed(0)} mm/min<br>t = L/Vf = ${((L / vf) * 60).toFixed(1)} s`;
    }),
    card('Surface roughness', [['Feed f', 0.15, 'mm/rev'], ['Nose radius rε', 0.8, 'mm']], ([f, r]) => {
      const rt = ((f * f) / (8 * r)) * 1000;
      return `Rt ≈ f²/(8·rε) = ${rt.toFixed(2)} µm<br>Ra ≈ Rt/4 ≈ ${(rt / 4).toFixed(2)} µm`;
    }),
    card(`Removal rate & power (kc ${kc} N/mm²)`, [['Vc', 200, 'm/min'], ['Depth of cut ap', 2, 'mm'], ['Feed f', 0.25, 'mm/rev']], ([vc, ap, f]) => {
      const q = vc * ap * f;
      return `Q = Vc·ap·f = ${q.toFixed(1)} cm³/min<br>P ≈ Q·kc/60000 = ${((q * kc) / 60000).toFixed(2)} kW (at the tool)`;
    }),
    card('Metric thread (60°)', [['Major diameter', 20, 'mm'], ['Pitch P', 1.5, 'mm']], ([d, p]) => {
      const he = 0.6134 * p, hi = 0.5413 * p;
      return `External: h = 0.6134·P = ${he.toFixed(3)}, minor Ø ${(d - 2 * he).toFixed(3)}, G76 P${Math.round(he * 1000)}<br>Internal: h = 0.5413·P = ${hi.toFixed(3)}, bore Ø ${(d - 2 * hi).toFixed(3)}`;
    }),
    card('Taper', [['Large Ø D', 40, 'mm'], ['Small Ø d', 30, 'mm'], ['Taper length L', 20, 'mm']], ([D, d, L]) => {
      const a = (Math.atan((D - d) / 2 / L) * 180) / Math.PI;
      return `Half angle α/2 = ${a.toFixed(3)}°<br>Ratio 1:${(L / (D - d)).toFixed(2)}<br>G90 R = ${(-(D - d) / 2).toFixed(3)} (small end first)`;
    }),
  );
  openDialog({ title: 'Cutting data calculator', body, size: 'wide' });
}

// ------------------------------------------------------------------ help

export function helpDialog() {
  const body = h('div', {
    html: `
<h3>Quick start</h3>
<ol>
<li>Pick a program from <b>Examples</b> (or write your own in the editor – errors and warnings appear live).</li>
<li>Check the tool path in the <b>2D</b> view: red dashed = rapid, blue = feed, green = arcs, purple = threading. Click a path segment to jump to its block.</li>
<li>Press <b>CYCLE START</b>. Use <b>SINGLE BLOCK</b> to step through, <b>FEED HOLD</b> to pause, the overrides and the simulation speed slider to slow down or speed up.</li>
<li>Watch the material being removed in <b>3D</b> (orbit with the mouse; tick <i>Section ¾</i> to look inside bores).</li>
<li>For exercises press <b>Check part</b> – deviations are drawn in the 2D view (blue = material left, red = gouge), and the theoretical surface roughness is reported (tick <b>Ra map</b> to see it).</li>
<li>Use the <b>timeline</b> in the AUTO panel to jump to any moment of the cycle; ⏮ steps back one block, ⏭ runs one block. The <b>Charts</b> tab plots rpm, feed and spindle power.</li>
<li>The <b>Wizard</b> writes a complete program from a list of profile points; <b>Exercises → Create from current program</b> turns your program into a graded exercise for others.</li>
</ol>
<h3>Modes</h3>
<p><b>AUTO</b> runs the program in the editor. <b>MDI</b> runs single blocks you type (e.g. <code>G00 X60 Z5</code>). <b>JOG</b> moves the tool by hand – with the spindle on, the tool really cuts.</p>
<h3>Keyboard</h3>
<table class="data">
<tr><td><span class="kbd">Ctrl</span>+<span class="kbd">Enter</span></td><td>Cycle start</td></tr>
<tr><td><span class="kbd">Space</span> (outside the editor)</td><td>Feed hold</td></tr>
<tr><td><span class="kbd">Esc</span></td><td>Reset</td></tr>
<tr><td><span class="kbd">Ctrl</span>+<span class="kbd">S</span></td><td>Save program</td></tr>
<tr><td><span class="kbd">Ctrl</span>+<span class="kbd">F</span></td><td>Search in the editor</td></tr>
<tr><td>Arrow keys (JOG mode)</td><td>Jog X/Z, with <span class="kbd">Shift</span> = rapid</td></tr>
<tr><td>Mouse wheel / drag / double-click (2D)</td><td>Zoom / pan / fit</td></tr>
</table>
<h3>What is simulated</h3>
<p>Fanuc-style lathe control (Group A G-codes, diameter programming): G00–G04, G18, G20/21, G28, G32, G40–G42 tool nose radius compensation, G50, G54–G59, G70–G76, G90/G92/G94, G96/G97, G98/G99, M00–M09, M30, M98/M99, block skip and sub-programs, G71/G72 type II, G76 run-out chamfer, direct chamfer / corner radius (,C ,R) and Custom Macro B (#variables, expressions, IF/GOTO/WHILE, #3000 alarms).
Material removal uses the real tool shape (insert + holder) swept along the path, so insert angle, nose radius and holder clearance all matter. Crashes (rapid into material, holder or chuck collision, cutting with the spindle stopped) raise an alarm.</p>
<p class="muted">Simplifications: rapid moves are straight lines unless Settings → G00 path is set to dog-leg; acceleration is not modelled; threads are shown as a helix in 3D but stamped once per revolution in the section.</p>`,
  });
  openDialog({ title: 'Help', body, size: 'narrow' });
}
