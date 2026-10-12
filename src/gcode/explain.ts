// Plain-language explanation of a G-code block (for students).

import type { Block, Word } from './lexer';
import type { ModalSnap } from './interpreter';
import { findCode } from '../content/gcodeRef';

export interface Explanation {
  summary: string;
  words: { word: string; text: string; kind: string }[];
}

const num = (v: number) => (Number.isInteger(v) ? v.toFixed(0) : String(+v.toFixed(4)));
const um = (w: Word) => (w.hasDecimal ? w.value : w.value / 1000);

export function explainMacro(b: Block): Explanation {
  const m = b.macro!;
  const words: Explanation['words'] = [];
  if (b.n !== undefined) words.push({ word: `N${b.n}`, kind: 'n', text: `Sequence number ${b.n} – a GOTO target.` });
  const v = (t: string) => (t.startsWith('[') ? `#${t}` : `#${t}`);
  const range = (t: string) => {
    const n = +t;
    if (!Number.isFinite(n)) return '';
    return n >= 1 && n <= 33 ? ' (local variable)' : n >= 100 && n <= 199 ? ' (common variable)' : n >= 500 && n <= 999 ? ' (common, kept after power-off)' : n === 3000 ? ' (alarm: stops the program with a message)' : n === 3006 ? ' (stop with a message)' : '';
  };
  let summary = '';
  switch (m.kind) {
    case 'assign':
      summary = `Macro assignment: ${v(m.target)} becomes ${m.expr}.`;
      words.push({ word: v(m.target), kind: 'f', text: 'Variable that receives the value' + range(m.target) + '.' });
      words.push({ word: m.expr, kind: 'addr', text: 'Expression: + − * /, [ ] brackets, SIN COS TAN ATAN SQRT ABS ROUND FIX FUP (angles in degrees).' });
      break;
    case 'if-then':
      summary = `If [${m.cond}] is true, ${v(m.target)} becomes ${m.expr}.`;
      words.push({ word: `[${m.cond}]`, kind: 'g', text: 'Condition – EQ NE GT GE LT LE, combined with AND / OR.' });
      break;
    case 'if-goto':
      summary = `If [${m.cond}] is true, jump to block N${m.n}; otherwise continue with the next block.`;
      words.push({ word: `[${m.cond}]`, kind: 'g', text: 'Condition – EQ NE GT GE LT LE, combined with AND / OR.' });
      words.push({ word: `GOTO ${m.n}`, kind: 'm', text: 'Jump target (N-number).' });
      break;
    case 'goto':
      summary = `Unconditional jump to block N${m.n}.`;
      break;
    case 'while':
      summary = `Loop: repeat the blocks up to END ${m.id} while [${m.cond}] is true.`;
      words.push({ word: `[${m.cond}]`, kind: 'g', text: 'Checked before every pass – make sure something inside the loop changes it, or the loop never ends.' });
      words.push({ word: `DO ${m.id}`, kind: 'm', text: 'Loop identifier (1–3); END with the same number closes the loop.' });
      break;
    case 'end':
      summary = `End of loop ${m.id}: jump back to WHILE … DO ${m.id}.`;
      break;
  }
  if (b.comment) summary += ` Comment: “${b.comment.trim()}”.`;
  return { summary, words };
}

export function explainBlock(b: Block, before?: ModalSnap): Explanation {
  if (b.macro) return explainMacro(b);
  const words: Explanation['words'] = [];
  if (b.blockDelete) words.push({ word: '/', kind: 'skip', text: 'Block delete: skipped when the BLOCK SKIP switch is ON.' });
  if (b.o !== undefined) words.push({ word: `O${b.o}`, kind: 'n', text: `Program number ${b.o}.` });
  if (b.n !== undefined) words.push({ word: `N${b.n}`, kind: 'n', text: `Sequence number ${b.n} (a label, e.g. for G70–G73 P/Q).` });

  const gs = b.words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value));
  const ms = b.words.filter((w) => w.letter === 'M').map((w) => Math.round(w.value));
  const has = (k: string) => b.words.some((w) => w.letter === k);
  const motionG = gs.find((g) => [0, 1, 2, 3, 32, 90, 92, 94].includes(g));
  const motion = motionG ?? before?.motion ?? 0;
  const cycle = gs.find((g) => g >= 70 && g <= 76);
  const second = has('P') && has('Q');
  const axisWords = has('X') || has('Z') || has('U') || has('W');
  const css = gs.includes(96) ? true : gs.includes(97) ? false : !!before?.css;
  const perRev = gs.includes(99) ? true : gs.includes(98) ? false : before?.feedPerRev ?? true;
  const threading = motion === 32 || motion === 92 || cycle === 76;

  for (const w of b.words) {
    const tag = `${w.letter}${w.raw}`;
    let text = '';
    let kind = 'addr';
    if (w.expr !== undefined) {
      words.push({ word: tag, kind: 'f', text: `Value computed from the macro expression ${w.expr} when the block runs (see the evaluated value below).` });
      continue;
    }
    if (w.letter === ',C' || w.letter === ',R') {
      words.push({
        word: tag,
        kind: 'g',
        text: w.letter === ',C'
          ? `Direct chamfer: the corner at the end of this G01 move is cut off with ${num(w.value)} mm legs. The next block must be a G01 move.`
          : `Direct corner radius: a tangent R${num(w.value)} arc is inserted between this G01 move and the next one.`,
      });
      continue;
    }
    switch (w.letter) {
      case 'G':
      case 'M': {
        const r = findCode(`${w.letter}${Math.round(w.value)}`);
        kind = w.letter === 'G' ? 'g' : 'm';
        text = r ? `${r.title}${r.modal ? ' (modal – stays active)' : ''}.` : 'Unknown / unsupported code.';
        break;
      }
      case 'X':
        text = `Target DIAMETER ${num(w.value)} mm (tool ${num(w.value / 2)} mm from the centre line).`;
        if (cycle === 76) text = `Thread root (minor) diameter ${num(w.value)}.`;
        if (cycle === 75) text = `Groove bottom diameter ${num(w.value)}.`;
        if (motion === 92 && !cycle) text = `Diameter of this threading pass: ${num(w.value)}.`;
        break;
      case 'Z':
        text = `Target Z ${num(w.value)} mm ${w.value < 0 ? '(towards the chuck from Z0)' : w.value > 0 ? '(in front of Z0)' : '(on the Z0 face)'}.`;
        if (cycle === 74) text = `Final drilling depth Z${num(w.value)}.`;
        if (cycle === 76) text = `Thread ends at Z${num(w.value)}.`;
        break;
      case 'U':
        if (cycle === 71 && !second) text = `Depth of cut per side: ${num(w.value)} mm (radius).`;
        else if (cycle === 73 && !second) text = `Total relief in X: ${num(w.value)} mm (radius).`;
        else if ((cycle === 71 || cycle === 72 || cycle === 73) && second) text = `Finishing allowance in X: ${num(w.value)} mm on diameter (${num(w.value / 2)} per side).`;
        else text = `Incremental X move: ${num(w.value)} on diameter = ${num(w.value / 2)} mm ${w.value < 0 ? 'towards' : 'away from'} the centre.`;
        break;
      case 'W':
        if (cycle === 72 && !second) text = `Depth of cut per pass in Z: ${num(w.value)} mm.`;
        else if (cycle === 73 && !second) text = `Total relief in Z: ${num(w.value)} mm.`;
        else if ((cycle === 71 || cycle === 72 || cycle === 73) && second) text = `Finishing allowance in Z: ${num(w.value)} mm.`;
        else text = `Incremental Z move: ${num(w.value)} mm ${w.value < 0 ? 'towards the chuck' : 'away from the chuck'}.`;
        break;
      case 'R':
        if (cycle === 71 || cycle === 72) text = `Retract amount after each roughing layer: ${num(w.value)} mm.`;
        else if (cycle === 73) text = `Number of passes: ${num(w.value)}.`;
        else if (cycle === 74 || cycle === 75) text = `Retract after each peck (chip breaking): ${num(w.value)} mm.`;
        else if (cycle === 76) text = axisWords ? `Taper of the thread: ${num(w.value)} mm (radius).` : `Finishing allowance: ${num(w.value)} mm.`;
        else if (motion === 2 || motion === 3) text = `Arc radius ${num(Math.abs(w.value))} mm${w.value < 0 ? ' (negative: arc larger than 180°)' : ''}.`;
        else if (motion === 90 || motion === 92 || motion === 94) text = `Taper: ${num(w.value)} mm (radius difference at the start of the cut).`;
        else text = 'R-parameter.';
        break;
      case 'I':
        text = `Arc centre is ${num(w.value)} mm (radius) from the start point in X.`;
        break;
      case 'K':
        text = `Arc centre is ${num(w.value)} mm from the start point in Z.`;
        break;
      case 'F':
        kind = 'f';
        if (threading) text = `Thread lead ${num(w.value)} mm per revolution.`;
        else text = perRev ? `Feed ${num(w.value)} mm per revolution (G99).` : `Feed ${num(w.value)} mm per minute (G98).`;
        break;
      case 'S':
        kind = 'f';
        if (gs.includes(50)) text = `Spindle speed limit: ${num(w.value)} rev/min.`;
        else if (css) text = `Cutting speed ${num(w.value)} m/min (constant surface speed – rpm follows the diameter).`;
        else text = `Spindle speed ${num(w.value)} rev/min.`;
        break;
      case 'T': {
        kind = 't';
        const raw = w.raw.split('.')[0];
        const tool = raw.length >= 3 ? Math.floor(w.value / 100) : w.value;
        const off = raw.length >= 3 ? Math.round(w.value) % 100 : w.value;
        text = `Index the turret to tool ${String(tool).padStart(2, '0')} and activate offset ${String(off).padStart(2, '0')}${off === 0 ? ' (offset cancelled)' : ''}.`;
        break;
      }
      case 'P':
        if (gs.includes(4)) text = `Dwell ${w.hasDecimal ? num(w.value) + ' s' : num(w.value) + ' ms'}.`;
        else if (cycle && cycle <= 73) text = `Profile starts at block N${num(w.value)}.`;
        else if (cycle === 74) text = `X shift between plunges: ${num(um(w))} mm.`;
        else if (cycle === 75) text = `Peck depth in X: ${num(um(w))} mm.`;
        else if (cycle === 76 && !axisWords) {
          const v = Math.round(w.value);
          text = `${Math.floor(v / 10000)} finishing pass(es), chamfer ${(Math.floor(v / 100) % 100) / 10} × lead, tool angle ${v % 100}°.`;
        } else if (cycle === 76) text = `Thread height ${num(um(w))} mm (radius).`;
        else if (ms.includes(98)) {
          const raw = w.raw.replace(/^[+-]/, '');
          if (raw.length > 4) text = `Call sub-program O${raw.slice(-4)} ${Number(raw.slice(0, -4))} time(s).`;
          else text = `Call sub-program O${raw.padStart(4, '0')}.`;
        } else text = 'P-parameter.';
        break;
      case 'Q':
        if (cycle && cycle <= 73) text = `Profile ends at block N${num(w.value)}.`;
        else if (cycle === 74) text = `Peck depth in Z: ${num(um(w))} mm.`;
        else if (cycle === 75) text = `Z shift between plunges: ${num(um(w))} mm (must be less than the tool width).`;
        else if (cycle === 76) text = axisWords ? `First depth of cut ${num(um(w))} mm (radius).` : `Minimum depth of cut ${num(um(w))} mm.`;
        else text = 'Q-parameter.';
        break;
      case 'L':
        text = `Repeat count ${num(w.value)}.`;
        break;
      default:
        text = findCode(w.letter)?.text ?? '';
    }
    words.push({ word: tag, text, kind });
  }

  // ------------------------------------------------------------ summary sentence
  const x = b.words.find((w) => w.letter === 'X');
  const z = b.words.find((w) => w.letter === 'Z');
  const u = b.words.find((w) => w.letter === 'U');
  const wv = b.words.find((w) => w.letter === 'W');
  const val = (w: Word) => (w.expr !== undefined ? w.expr : num(w.value));
  const dest = [x ? `Ø${val(x)}` : u ? `ΔØ${val(u)}` : '', z ? `Z${val(z)}` : wv ? `ΔZ${val(wv)}` : '']
    .filter(Boolean)
    .join(' ');
  let summary = '';
  if (b.words.length === 0 && b.comment) summary = `Comment: “${b.comment.trim()}” – ignored by the control.`;
  else if (b.percent && b.words.length === 0) summary = 'Tape start/end marker.';
  else if (cycle !== undefined) {
    const r = findCode(`G${cycle}`)!;
    const firstBlock = (cycle >= 71 && cycle <= 76) && !second && !(cycle >= 74 && axisWords);
    summary = `${r.title}${firstBlock ? ' – first block: sets the cycle parameters only, nothing moves yet' : ''}.`;
    if (cycle === 70) summary = 'Finishing cycle: run the profile blocks once with the finishing tool, then return to the start point.';
  } else if (gs.includes(28)) summary = 'Return to the machine reference (home) position.';
  else if (gs.includes(4)) summary = 'Dwell – the axes wait while the spindle keeps turning.';
  else if (gs.includes(50) && has('S')) summary = 'Limit the spindle speed (safety for G96).';
  else if (gs.includes(50)) summary = 'Set the work coordinate system from the current position.';
  else if (axisWords) {
    switch (motion) {
      case 0: summary = `Rapid traverse (no cutting!) to ${dest}.`; break;
      case 1: {
        const kindTxt = (x || u) && (z || wv) ? 'taper/chamfer' : x || u ? 'facing / plunging' : 'straight turning';
        summary = `Cutting feed in a straight line (${kindTxt}) to ${dest}.`;
        break;
      }
      case 2: summary = `Clockwise arc to ${dest}.`; break;
      case 3: summary = `Counter-clockwise arc to ${dest}.`; break;
      case 32: summary = `Thread cutting move to ${dest}.`; break;
      case 90: summary = `G90 turning cycle (modal repeat) to ${dest}: rapid in, cut, face out, rapid back.`; break;
      case 92: summary = `G92 threading pass (modal repeat) at ${dest}.`; break;
      case 94: summary = `G94 facing cycle (modal repeat) to ${dest}.`; break;
    }
  } else if (ms.length) summary = ms.map((m) => findCode(`M${m}`)?.title ?? `M${m}`).join(', ') + '.';
  else if (gs.length) summary = gs.map((g) => findCode(`G${g}`)?.title ?? `G${g}`).join(', ') + '.';
  else if (b.words.some((w) => w.letter === 'T')) summary = 'Tool change.';
  else if (b.words.length) summary = 'Modal values only (no motion).';
  if (b.comment && b.words.length) summary += ` Comment: “${b.comment.trim()}”.`;
  return { summary, words };
}
