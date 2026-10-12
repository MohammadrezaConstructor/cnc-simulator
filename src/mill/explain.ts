// Plain-language explanation of a milling block.

import type { Block, Word } from '../gcode/lexer';
import { explainMacro, type Explanation } from '../gcode/explain';
import type { MillModalSnap } from './interp';
import { findMillCode } from './ref';

const num = (v: number) => (Number.isInteger(v) ? v.toFixed(0) : String(+v.toFixed(4)));

export function explainMillBlock(b: Block, before?: MillModalSnap): Explanation {
  if (b.macro) return explainMacro(b);
  const words: Explanation['words'] = [];
  if (b.blockDelete) words.push({ word: '/', kind: 'skip', text: 'Block delete: skipped when BLOCK SKIP is ON.' });
  if (b.o !== undefined) words.push({ word: `O${b.o}`, kind: 'n', text: `Program number ${b.o}.` });
  if (b.n !== undefined) words.push({ word: `N${b.n}`, kind: 'n', text: `Sequence number ${b.n}.` });
  const gs = b.words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10) / 10);
  const ms = b.words.filter((w) => w.letter === 'M').map((w) => Math.round(w.value));
  const has = (k: string) => b.words.some((w) => w.letter === k);
  const motion = gs.find((g) => g <= 3) ?? before?.motion ?? 0;
  const cyc = gs.find((g) => [73, 74, 76, 81, 82, 83, 84, 85, 86, 89].includes(g)) ?? (gs.includes(80) ? 80 : before?.cyc ?? 80);
  const inCycle = cyc !== 80 && !gs.some((g) => g <= 3);
  const abs = gs.includes(90) ? true : gs.includes(91) ? false : before?.abs ?? true;
  const polar = gs.includes(16) ? true : gs.includes(15) ? false : !!before?.polar;
  const g68 = gs.includes(68);
  const val = (w: Word) => (w.expr !== undefined ? w.expr : num(w.value));

  for (const w of b.words) {
    const tag = `${w.letter}${w.raw}`;
    let text = '';
    let kind = 'addr';
    if (w.expr !== undefined) {
      words.push({ word: tag, kind: 'f', text: `Value computed from ${w.expr} when the block runs (see the evaluated value below).` });
      continue;
    }
    switch (w.letter) {
      case 'G':
      case 'M': {
        const r = findMillCode(`${w.letter}${Math.round(w.value)}`);
        kind = w.letter === 'G' ? 'g' : 'm';
        text = r ? `${r.title}${r.modal ? ' (modal)' : ''}.` : 'Unknown / unsupported code.';
        break;
      }
      case 'X':
        text = g68 ? `Rotation centre X${num(w.value)}.` : polar ? `Polar radius ${num(w.value)} mm.` : abs ? `Target X${num(w.value)}.` : `Move ${num(w.value)} mm in X (incremental).`;
        break;
      case 'Y':
        text = g68 ? `Rotation centre Y${num(w.value)}.` : polar ? `Polar angle ${num(w.value)}° (CCW from +X).` : abs ? `Target Y${num(w.value)}.` : `Move ${num(w.value)} mm in Y (incremental).`;
        break;
      case 'Z':
        text = inCycle ? `Hole depth: the tool tip goes to Z${num(w.value)}${abs ? '' : ' (incremental from R)'}.` : abs ? `Target Z${num(w.value)} ${w.value < 0 ? '(inside the material when Z0 is the top face)' : '(above Z0)'}.` : `Move ${num(w.value)} mm in Z.`;
        break;
      case 'R':
        text = g68 ? `Rotation angle ${num(w.value)}°.` : inCycle ? `R-plane at Z${num(w.value)}: rapid stops here before the cutting feed starts.` : `Arc radius ${num(Math.abs(w.value))} mm${w.value < 0 ? ' (arc > 180°)' : ''}.`;
        break;
      case 'I':
      case 'J':
      case 'K':
        text = inCycle && w.letter === 'K' ? `Repeat the hole ${num(w.value)} times.` : `Arc centre is ${num(w.value)} mm from the start point in ${w.letter === 'I' ? 'X' : w.letter === 'J' ? 'Y' : 'Z'}.`;
        break;
      case 'Q':
        text = inCycle ? `Peck depth ${w.hasDecimal ? num(w.value) : num(w.value / 1000)} mm${w.hasDecimal ? '' : ' (no decimal point = µm!)'}.` : 'Q parameter.';
        break;
      case 'P':
        text = ms.includes(98) ? `Call sub-program O${w.raw.padStart(4, '0')}.` : `Dwell ${w.hasDecimal ? num(w.value) + ' s' : num(w.value) + ' ms'}.`;
        break;
      case 'L':
        text = `Repeat ${num(w.value)} times.`;
        break;
      case 'F':
        kind = 'f';
        text = `Feed ${num(w.value)} ${before?.feedPerRev ? 'mm/rev' : 'mm/min'}.`;
        break;
      case 'S':
        kind = 'f';
        text = `Spindle speed ${num(w.value)} rev/min.`;
        break;
      case 'T':
        kind = 't';
        text = `Prepare tool T${String(Math.round(w.value)).padStart(2, '0')} (M06 puts it into the spindle).`;
        break;
      case 'H':
        kind = 't';
        text = `Length offset register H${String(Math.round(w.value)).padStart(2, '0')} (tool length measured at setup).`;
        break;
      case 'D':
        kind = 't';
        text = `Radius offset register D${String(Math.round(w.value)).padStart(2, '0')} (tool radius for G41/G42).`;
        break;
      case ',C':
        kind = 'g';
        text = `Direct chamfer with ${num(w.value)} mm legs at the end of this move.`;
        break;
      case ',R':
        kind = 'g';
        text = `Direct corner radius R${num(w.value)} at the end of this move.`;
        break;
      default:
        text = findMillCode(w.letter)?.text ?? '';
    }
    words.push({ word: tag, text, kind });
  }

  const x = b.words.find((w) => w.letter === 'X'), y = b.words.find((w) => w.letter === 'Y'), z = b.words.find((w) => w.letter === 'Z');
  const dest = [x && `X${val(x)}`, y && `Y${val(y)}`, z && `Z${val(z)}`].filter(Boolean).join(' ');
  let summary = '';
  const axis = !!(x || y || z);
  if (b.words.length === 0 && b.comment) summary = `Comment: “${b.comment.trim()}” – ignored by the control.`;
  else if (b.percent && !b.words.length) summary = 'Tape start/end marker.';
  else if (ms.includes(6)) summary = 'Tool change: Z goes up to the tool-change position, the spindle stops, the new tool is loaded.';
  else if (gs.includes(28)) summary = 'Return to the machine home position (via the intermediate point given).';
  else if (gs.includes(43)) summary = `Tool length compensation ON – from now on Z is the tip of the tool${axis ? `; move to ${dest}` : ''}.`;
  else if (gs.includes(80)) summary = 'Cancel the hole cycle.';
  else if (gs.includes(68)) summary = 'Rotate the coordinate system.';
  else if (inCycle && (axis || gs.some((g) => g > 72 && g < 90))) summary = `${findMillCode(`G${cyc}`)?.title ?? `G${cyc}`}: ${x || y ? `hole at ${[x && `X${val(x)}`, y && `Y${val(y)}`].filter(Boolean).join(' ')}` : 'hole at the current position'}.`;
  else if (axis || has('I') || has('J')) {
    summary = motion === 0 ? `Rapid (no cutting!) to ${dest}.` : motion === 1 ? `Cut in a straight line to ${dest}${x || y ? (z ? ' (ramping)' : '') : ' (plunge / retract in Z)'}.` : `${motion === 2 ? 'Clockwise' : 'Counter-clockwise'} arc to ${dest || 'the start point (full circle)'}${z && (x || y) ? ' – helical because Z changes' : ''}.`;
  } else if (ms.length) summary = ms.map((m) => findMillCode(`M${m}`)?.title ?? `M${m}`).join(', ') + '.';
  else if (gs.length) summary = gs.map((g) => findMillCode(`G${g}`)?.title ?? `G${g}`).join(', ') + '.';
  else if (b.words.length) summary = 'Modal values only (no motion).';
  if (b.comment && b.words.length) summary += ` Comment: “${b.comment.trim()}”.`;
  return { summary, words };
}
