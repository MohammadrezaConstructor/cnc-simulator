// Program wizard (conversational programming) and the teacher's exercise builder.

import { h, openDialog, toast, download, fill } from './dom';
import { partDrawing } from './drawing';
import { defaultSpec, generate, checkSpec, requiredAllowance, DEFAULT_VC, type WizardSpec, type ProfilePoint } from '../content/wizardGen';
import { contourFromGcode, targetFromStock } from '../sim/inspect';
import { MATERIALS } from '../sim/machine';
import type { Exercise } from '../content/exercises';
import type { Target } from '../content/examples';
import type { MachineSettings, MaterialId, StockDef, ToolDef } from '../types';
import type { Stock } from '../sim/stock';

export interface WizardApi {
  tools: ToolDef[];
  settings: MachineSettings;
  stockDef: StockDef;
  loadGenerated(code: string, target: Target, stock: StockDef, title: string): void;
}

const numIn = (v: number, set: (v: number) => void, attrs: Record<string, unknown> = {}) =>
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

/** give form controls that have no accessible name the text of their visible label as aria-label:
 *  in a `.form` grid every <label> names the control(s) that follow it */
export function nameControls(root: Element) {
  const forms = root.matches('.form') ? [root] : Array.from(root.querySelectorAll('.form'));
  for (const form of forms) {
    let label = '';
    for (const c of Array.from(form.children)) {
      if (c.tagName === 'LABEL') label = (c.textContent ?? '').trim();
      else if (label && c.matches('input, select, textarea') && !c.hasAttribute('aria-label')) c.setAttribute('aria-label', label);
    }
  }
}

const toolSelect = (tools: ToolDef[], types: string[], value: number, set: (v: number) => void) =>
  h('select', { onchange: (e: Event) => set(+(e.target as HTMLSelectElement).value) },
    tools.filter((t) => types.includes(t.type)).map((t) => h('option', { value: String(t.id), selected: t.id === value }, `T${String(t.id).padStart(2, '0')} ${t.name}`)));

let lastSpec: WizardSpec | null = null;

/** two columns on a wide screen, one on a phone – never wider than the dialog (no sideways scrolling) */
const WIZ_GRID = { gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' };

export function wizardDialog(app: WizardApi) {
  const s: WizardSpec = lastSpec ? JSON.parse(JSON.stringify(lastSpec)) : defaultSpec(app.stockDef);
  s.maxRpm = Math.min(s.maxRpm, app.settings.maxRpm);
  const pointsHost = h('div', { class: 'tool-table' });
  const problems = h('ul', { class: 'wiz-problems' });
  const preview = h('div', { class: 'wiz-preview' });
  const note = h('p', { class: 'muted small' });

  const refresh = () => {
    const probs = checkSpec(s, app.tools);
    fill(problems, probs.map((p) => h('li', null, '⚠ ' + p)));
    if (!probs.length) fill(problems, h('li', { class: 'ok' }, '✔ Profile and operations look consistent.'));
    try {
      const { target } = generate(s, app.tools);
      preview.replaceChildren(partDrawing(contourFromGcode(target.outer, app.settings), [], s.stock.diameter / 2));
    } catch {
      preview.replaceChildren();
    }
    const R = app.tools.find((t) => t.id === s.rough.tool)?.noseR ?? 0.8;
    const need = requiredAllowance(s, R);
    note.textContent = need > s.rough.allowX ? `Back-facing slopes: the finishing allowance will be raised to U${need} so the uncompensated roughing passes cannot gouge.` : '';
  };

  const renderPoints = () => {
    const rows = s.points.map((p, i) =>
      h('tr', null,
        h('td', null, String(i + 1)),
        h('td', null, numIn(p.d, (v) => { p.d = v; refresh(); }, { min: 0, 'aria-label': `Point ${i + 1} diameter` })),
        h('td', null, numIn(p.z, (v) => { p.z = v; refresh(); }, { max: 0, 'aria-label': `Point ${i + 1} Z` })),
        h('td', null, h('select', { 'aria-label': `Point ${i + 1} corner`, onchange: (e: Event) => { p.corner = (e.target as HTMLSelectElement).value as ProfilePoint['corner']; refresh(); } },
          (['none', 'C', 'R'] as const).map((c) => h('option', { value: c, selected: c === p.corner }, c === 'none' ? 'sharp' : c === 'C' ? 'chamfer ,C' : 'radius ,R')))),
        h('td', null, numIn(p.size, (v) => { p.size = v; refresh(); }, { min: 0, 'aria-label': `Point ${i + 1} corner size` })),
        h('td', { style: { whiteSpace: 'nowrap' } },
          h('button', { title: 'Insert a point below', 'aria-label': `Insert a point below point ${i + 1}`, onclick: () => { s.points.splice(i + 1, 0, { ...p, corner: 'none', size: 0 }); renderPoints(); } }, '+'),
          h('button', { title: 'Delete point', 'aria-label': `Delete point ${i + 1}`, disabled: s.points.length <= 2, onclick: () => { s.points.splice(i, 1); renderPoints(); } }, '✕')),
      ),
    );
    fill(pointsHost, h('table', null, h('tr', null, ['#', 'Ø', 'Z', 'Corner', 'Size', ''].map((c) => h('th', null, c))), rows));
    refresh();
  };

  // min-width:0 – a fieldset defaults to min-content width and would push the dialog sideways on a phone
  const section = (title: string, ...kids: Node[]) => h('fieldset', { class: 'wiz-sec', style: { minWidth: '0' } }, h('legend', null, title), ...kids);
  const row = (label: string, ...kids: Node[]) => {
    // name the controls after the row label; "A · B" / "A × B" labels name several controls in order
    const ctrls = kids.filter((k): k is HTMLElement => k instanceof HTMLElement && k.matches('input, select, textarea'));
    const parts = label.split(/\s[·×]\s/);
    ctrls.forEach((c, i) => c.setAttribute('aria-label', ctrls.length === 1 ? label : parts.length === ctrls.length ? parts[i] : `${label} ${i + 1}`));
    return h('div', { class: 'wiz-row', style: { minWidth: '0' } }, h('label', { style: { maxWidth: '100%' } }, label), ...kids);
  };
  const check = (v: boolean, set: (v: boolean) => void) => h('input', { type: 'checkbox', checked: v, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); refresh(); } });

  const body = h('div', { class: 'wiz' },
    h('p', { class: 'muted' }, 'Describe the finished outside contour point by point (from the front face towards the chuck), pick the operations, and the wizard writes a complete, commented program – plus the drawing for "Check part". Corners use the direct ,C / ,R words.'),
    h('div', { class: 'wiz-grid', style: WIZ_GRID },
      h('div', null,
        section('Part and bar',
          row('Name', h('input', { type: 'text', value: s.name, oninput: (e: Event) => (s.name = (e.target as HTMLInputElement).value) })),
          row('Bar Ø × length', numIn(s.stock.diameter, (v) => { s.stock.diameter = v; refresh(); }, { min: 5 }), numIn(s.stock.length, (v) => { s.stock.length = v; refresh(); }, { min: 10 })),
          row('Material', h('select', { onchange: (e: Event) => { s.stock.material = (e.target as HTMLSelectElement).value as MaterialId; s.rough.vc = DEFAULT_VC[s.stock.material]; s.finish.vc = Math.round(DEFAULT_VC[s.stock.material] * 1.2); refresh(); } },
            (Object.keys(MATERIALS) as MaterialId[]).map((m) => h('option', { value: m, selected: m === s.stock.material }, MATERIALS[m].name)))),
          row('Speed limit G50', numIn(s.maxRpm, (v) => (s.maxRpm = v), { min: 200 })),
        ),
        section('Profile points', pointsHost),
        section('Roughing (G71)',
          row('Tool', toolSelect(app.tools, ['turn'], s.rough.tool, (v) => { s.rough.tool = v; refresh(); })),
          row('Vc m/min · ap mm · f mm/rev', numIn(s.rough.vc, (v) => (s.rough.vc = v)), numIn(s.rough.ap, (v) => (s.rough.ap = v), { min: 0.2 }), numIn(s.rough.f, (v) => (s.rough.f = v), { min: 0.02 })),
          row('Allowance U (Ø) · W', numIn(s.rough.allowX, (v) => { s.rough.allowX = v; refresh(); }, { min: 0 }), numIn(s.rough.allowZ, (v) => (s.rough.allowZ = v), { min: 0 })),
          row('Face the front first', check(s.face, (v) => (s.face = v))),
          note,
        ),
      ),
      h('div', null,
        section('Finishing (G70)',
          row('Enabled', check(s.finish.enabled, (v) => (s.finish.enabled = v))),
          row('Tool', toolSelect(app.tools, ['turn'], s.finish.tool, (v) => { s.finish.tool = v; refresh(); })),
          row('Vc m/min · f mm/rev', numIn(s.finish.vc, (v) => (s.finish.vc = v)), numIn(s.finish.f, (v) => (s.finish.f = v), { min: 0.02 })),
          row('Nose radius comp. G42', check(s.finish.comp, (v) => (s.finish.comp = v))),
        ),
        section('Groove',
          row('Enabled', check(s.groove.enabled, (v) => (s.groove.enabled = v))),
          row('Left edge Z · width', numIn(s.groove.zLeft, (v) => { s.groove.zLeft = v; refresh(); }), numIn(s.groove.width, (v) => { s.groove.width = v; refresh(); }, { min: 0.5 })),
          row('Bottom Ø', numIn(s.groove.d, (v) => (s.groove.d = v), { min: 0 })),
          row('Tool', toolSelect(app.tools, ['groove'], s.groove.tool, (v) => { s.groove.tool = v; s.groove.toolWidth = app.tools.find((t) => t.id === v)?.width ?? 3; refresh(); })),
        ),
        section('Thread (G76, metric 60°)',
          row('Enabled', check(s.thread.enabled, (v) => (s.thread.enabled = v))),
          row('Major Ø · pitch', numIn(s.thread.dMajor, (v) => (s.thread.dMajor = v)), numIn(s.thread.pitch, (v) => (s.thread.pitch = v), { min: 0.2 })),
          row('From Z · to Z', numIn(s.thread.zStart, (v) => { s.thread.zStart = v; refresh(); }), numIn(s.thread.zEnd, (v) => { s.thread.zEnd = v; refresh(); })),
          row('Tool', toolSelect(app.tools, ['thread'], s.thread.tool, (v) => (s.thread.tool = v))),
        ),
        section('Part-off',
          row('Enabled', check(s.partoff.enabled, (v) => (s.partoff.enabled = v))),
          row('Part length', numIn(s.partoff.length, (v) => { s.partoff.length = v; refresh(); }, { min: 1 })),
          row('Tool', toolSelect(app.tools, ['partoff', 'groove'], s.partoff.tool, (v) => { s.partoff.tool = v; s.partoff.toolWidth = app.tools.find((t) => t.id === v)?.width ?? 3; refresh(); })),
        ),
        section('Preview', preview, problems),
      ),
    ),
  );
  renderPoints();
  let closeDlg = () => {};
  closeDlg = openDialog({
    title: 'Program wizard',
    body,
    size: 'wide',
    buttons: [
      { label: 'Reset to example', onClick: () => { lastSpec = null; closeDlg(); wizardDialog(app); return false; } },
      { label: 'Cancel' },
      {
        label: 'Generate program',
        primary: true,
        onClick: () => {
          const probs = checkSpec(s, app.tools);
          if (probs.length) {
            toast('Fix the problems listed under Preview first', 'err');
            return false;
          }
          lastSpec = JSON.parse(JSON.stringify(s));
          const { code, target } = generate(s, app.tools);
          app.loadGenerated(code, target, { ...s.stock }, s.name);
          return true;
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ exercise builder

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const textToHtml = (s: string) => s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export interface BuilderApi {
  stock: Stock;
  stockDef: StockDef;
  settings: MachineSettings;
  currentCode(): string;
  customExercises: Exercise[];
  saveCustomExercises(): void;
  loadExerciseObject(ex: Exercise): void;
}

const SKELETON = `%
O1000 (MY PROGRAM)
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

/** sanitise an exercise read from a file / clipboard (brief is treated as plain text) */
export function sanitizeExercise(o: unknown): Exercise | null {
  const x = o as Partial<Exercise> & { briefText?: string };
  if (!x || typeof x !== 'object' || typeof x.title !== 'string' || !x.stock || !x.target || typeof x.target.outer !== 'string') return null;
  const st = x.stock as StockDef;
  if (![st.diameter, st.length, st.gripLength].every((v) => typeof v === 'number' && v > 0)) return null;
  return {
    id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: x.title.slice(0, 120),
    level: (['Beginner', 'Intermediate', 'Advanced'] as const).includes(x.level as Exercise['level']) ? (x.level as Exercise['level']) : 'Intermediate',
    brief: textToHtml(String(x.briefText ?? '').slice(0, 5000)),
    stock: { diameter: st.diameter, length: st.length, bore: +st.bore || 0, faceAllowance: +st.faceAllowance || 1, gripLength: st.gripLength, material: (Object.keys(MATERIALS) as MaterialId[]).includes(st.material) ? st.material : 'steel' },
    target: {
      outer: x.target.outer.slice(0, 20000),
      inner: typeof x.target.inner === 'string' && x.target.inner.trim() ? x.target.inner.slice(0, 20000) : undefined,
      tol: Math.max(0.005, +x.target.tol || 0.05),
      ignore: Array.isArray(x.target.ignore) ? x.target.ignore.filter((r) => Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === 'number')).slice(0, 20) : undefined,
      ra: typeof x.target.ra === 'number' && x.target.ra > 0 ? x.target.ra : undefined,
    },
    hints: Array.isArray(x.hints) ? x.hints.map(String).slice(0, 20) : [],
    starter: typeof x.starter === 'string' ? x.starter : SKELETON,
    solution: typeof x.solution === 'string' ? x.solution : '',
    custom: true,
    briefText: String(x.briefText ?? ''),
  } as Exercise;
}

export function exportExercise(ex: Exercise): string {
  const { id: _id, brief: _b, ...rest } = ex as Exercise & { custom?: boolean };
  void _id;
  void _b;
  return JSON.stringify({ format: 'lathelab-exercise@1', ...rest }, null, 2);
}

export function builderDialog(app: BuilderApi) {
  const fromPart = targetFromStock(app.stock);
  const machined = fromPart.outer.split('\n').length > 1 && app.stock.version > 1;
  const f = {
    title: 'My exercise',
    level: 'Intermediate',
    brief: 'Describe the part: diameters, lengths, chamfers, tolerances.\n\nThe drawing below is generated from the target contour.',
    tol: 0.05,
    ra: '',
    ignore: '',
    hints: '',
    outer: machined ? fromPart.outer : '',
    inner: machined ? fromPart.inner : '',
  };
  const txt = (key: keyof typeof f, rows = 3) => h('textarea', { rows, spellcheck: 'false', oninput: (e: Event) => ((f as Record<string, unknown>)[key] = (e.target as HTMLTextAreaElement).value) }, String(f[key]));
  const preview = h('div', { class: 'wiz-preview' });
  const drawPreview = () => {
    try {
      const o = contourFromGcode(f.outer, app.settings);
      const i = f.inner.trim() ? contourFromGcode(f.inner, app.settings) : [];
      preview.replaceChildren(o.length > 1 ? partDrawing(o, i, app.stockDef.diameter / 2) : h('p', { class: 'muted' }, 'No outer contour yet.'));
    } catch {
      preview.replaceChildren(h('p', { class: 'muted' }, 'The contour has errors.'));
    }
  };
  drawPreview();
  const outerTa = txt('outer', 8);
  const innerTa = txt('inner', 4);
  outerTa.setAttribute('aria-label', 'Target – outer contour (G-code, Ø values)');
  innerTa.setAttribute('aria-label', 'Target – bore contour (optional)');
  outerTa.addEventListener('change', drawPreview);
  innerTa.addEventListener('change', drawPreview);
  const build = (): Exercise | null => {
    const ignore: [number, number][] = [];
    for (const part of f.ignore.split(/[;,]/)) {
      const m = /(-?\d+\.?\d*)\s*\.\.\s*(-?\d+\.?\d*)/.exec(part);
      if (m) ignore.push([+m[1], +m[2]]);
    }
    if (f.outer.split('\n').length < 2) {
      toast('The target needs an outer contour (run the reference program first, or type it as G-code)', 'err');
      return null;
    }
    return sanitizeExercise({
      title: f.title,
      level: f.level as Exercise['level'],
      briefText: f.brief,
      stock: app.stockDef,
      target: { outer: f.outer, inner: f.inner, tol: f.tol, ignore, ra: f.ra ? +f.ra : undefined },
      hints: f.hints.split('\n').map((x) => x.trim()).filter(Boolean),
      starter: SKELETON,
      solution: app.currentCode(),
    } as unknown as Exercise);
  };
  const body = h('div', { class: 'wiz' },
    h('p', { class: 'muted' }, machined
      ? 'The target contour was taken from the part you just machined, and your current program becomes the reference solution. Edit anything before saving.'
      : 'Tip: run your reference program first – the target contour is then filled in from the machined part automatically.'),
    h('div', { class: 'wiz-grid', style: WIZ_GRID },
      h('div', { class: 'form' },
        h('label', null, 'Title'), h('input', { type: 'text', value: f.title, oninput: (e: Event) => (f.title = (e.target as HTMLInputElement).value) }),
        h('label', null, 'Level'), h('select', { onchange: (e: Event) => (f.level = (e.target as HTMLSelectElement).value) }, ['Beginner', 'Intermediate', 'Advanced'].map((l) => h('option', { selected: l === f.level }, l))),
        h('label', null, 'Task for the student'), txt('brief', 5),
        h('label', null, 'Tolerance ± (Ø)'), numIn(f.tol, (v) => (f.tol = v), { min: 0.005, step: 0.01 }),
        h('label', null, 'Max. Ra µm (optional)'), h('input', { type: 'text', value: '', placeholder: 'e.g. 1.6', oninput: (e: Event) => (f.ra = (e.target as HTMLInputElement).value) }),
        h('label', null, 'Not inspected (Z..Z; …)'), h('input', { type: 'text', value: '', placeholder: 'e.g. -20..-2', oninput: (e: Event) => (f.ignore = (e.target as HTMLInputElement).value) }),
        h('label', null, 'Hints (one per line)'), txt('hints', 3),
      ),
      h('div', null,
        h('label', { class: 'muted' }, 'Target – outer contour (G-code, Ø values)'), outerTa,
        h('label', { class: 'muted' }, 'Target – bore contour (optional)'), innerTa,
        preview,
      ),
    ),
  );
  nameControls(body);
  openDialog({
    title: 'Create an exercise from this program',
    body,
    size: 'wide',
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Copy JSON',
        onClick: () => {
          const ex = build();
          if (!ex) return false;
          const json = exportExercise(ex);
          navigator.clipboard?.writeText(json).then(() => toast('Exercise JSON copied – share it with your students', 'ok'), () => toast('Copy was blocked – use Download instead', 'warn'));
          return false;
        },
      },
      {
        label: 'Download .json',
        onClick: () => {
          const ex = build();
          if (!ex) return false;
          download(`${ex.title.replace(/[^\w-]+/g, '_')}.lathelab.json`, exportExercise(ex), 'application/json');
          return false;
        },
      },
      {
        label: 'Save & try it',
        primary: true,
        onClick: () => {
          const ex = build();
          if (!ex) return false;
          app.customExercises.push(ex);
          app.saveCustomExercises();
          app.loadExerciseObject(ex);
          toast(`Exercise “${ex.title}” saved in this browser`, 'ok');
          return true;
        },
      },
    ],
  });
}

/** import exercises from a JSON text (single exercise or an array) */
export function importExercises(text: string): Exercise[] {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(sanitizeExercise).filter((x): x is Exercise => !!x);
}
