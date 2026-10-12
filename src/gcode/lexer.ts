import type { Diagnostic } from '../types';
import { parseMacro, matchBracket, type MacroStmt } from './macro';

export interface Word {
  /** address letter; ",C" and ",R" for direct chamfer / corner rounding */
  letter: string;
  value: number;
  raw: string;
  /** true if the number was written with a decimal point (matters for Fanuc µm-words such as G76 P/Q) */
  hasDecimal: boolean;
  /** column of the letter in the source line */
  col: number;
  /** macro expression (e.g. "#1", "-[#2+5]"), evaluated when the block executes */
  expr?: string;
}

export interface Block {
  /** 0-based source line */
  line: number;
  text: string;
  words: Word[];
  comment?: string;
  /** line starts with '/' (skipped when Block Skip is ON) */
  blockDelete: boolean;
  /** N sequence number */
  n?: number;
  /** O program number (subprogram label) */
  o?: number;
  /** '%' tape start/end marker line */
  percent: boolean;
  /** Custom Macro B statement (assignment, IF, GOTO, WHILE, END) */
  macro?: MacroStmt;
  errors: Diagnostic[];
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)/;

/** Read a macro value term at s[i]: "#12", "#[…]", "[…]", optionally preceded by a sign. */
function readExprTerm(s: string, i: number): string | null {
  let k = i;
  if (s[k] === '-' || s[k] === '+') k++;
  if (s[k] === '#') {
    k++;
    if (s[k] === '[') {
      const e = matchBracket(s, k);
      if (e < 0) return null;
      return s.slice(i, e + 1);
    }
    const m = /^\d+/.exec(s.slice(k));
    if (!m) return null;
    return s.slice(i, k + m[0].length);
  }
  if (s[k] === '[') {
    const e = matchBracket(s, k);
    if (e < 0) return null;
    return s.slice(i, e + 1);
  }
  return null;
}

export function lexLine(text: string, line: number): Block {
  const b: Block = { line, text, words: [], blockDelete: false, percent: false, errors: [] };
  const comments: string[] = [];
  // 1. strip comments
  let s = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      const end = text.indexOf(')', i);
      if (end < 0) {
        comments.push(text.slice(i + 1));
        b.errors.push({ line, severity: 'warning', message: 'Comment is missing its closing ")"' });
        break;
      }
      comments.push(text.slice(i + 1, end));
      s += ' '.repeat(end - i + 1);
      i = end;
      continue;
    }
    if (ch === ';') {
      const rest = text.slice(i + 1).trim();
      if (rest) comments.push(rest);
      break;
    }
    s += ch;
  }
  if (comments.length) b.comment = comments.join(' ');
  // 2. block delete, %, N/O
  let i = 0;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === '/') {
    b.blockDelete = true;
    i++;
  }
  const headRe = /^\s*([NnOo])\s*(\d+)/;
  for (;;) {
    const m = headRe.exec(s.slice(i));
    if (!m) break;
    if (m[1].toUpperCase() === 'N' && b.n === undefined) b.n = parseInt(m[2], 10);
    else if (m[1].toUpperCase() === 'O' && b.o === undefined) b.o = parseInt(m[2], 10);
    else break;
    i += m[0].length;
  }
  // 3. macro statement?
  const rest = s.slice(i);
  const upper = rest.trim().toUpperCase();
  if (/^(#|IF\b|IF\[|GOTO|WHILE|END\s*\d)/.test(upper)) {
    try {
      const mac = parseMacro(upper);
      if (mac) {
        b.macro = mac;
        return b;
      }
    } catch (e) {
      b.errors.push({ line, severity: 'error', message: (e as Error).message });
      return b;
    }
  }
  // 4. words
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '%') {
      b.percent = true;
      i++;
      continue;
    }
    let comma = false;
    let pos = i;
    if (ch === ',') {
      comma = true;
      pos = i + 1;
    }
    const L = (s[pos] ?? '').toUpperCase();
    if (L >= 'A' && L <= 'Z') {
      let k = pos + 1;
      while (k < s.length && s[k] === ' ') k++;
      const num = NUM_RE.exec(s.slice(k));
      const letter = comma ? ',' + L : L;
      if (comma && L !== 'C' && L !== 'R') {
        b.errors.push({ line, severity: 'error', message: `",${L}" is not supported – use ",C" (chamfer) or ",R" (corner radius)` });
      }
      if (num) {
        const raw = num[0];
        b.words.push({ letter, value: parseFloat(raw), raw, hasDecimal: raw.includes('.'), col: i });
        i = k + raw.length;
        continue;
      }
      const ex = readExprTerm(s, k);
      if (ex) {
        b.words.push({ letter, value: NaN, raw: ex, hasDecimal: true, col: i, expr: ex });
        i = k + ex.length;
        continue;
      }
      b.errors.push({ line, severity: 'error', message: `Address "${letter}" has no numeric value` });
      i = pos + 1;
      continue;
    }
    if (ch === '#' || ch === '[') {
      b.errors.push({ line, severity: 'error', message: 'Macro expression without an address – use "#1 = …" for assignments' });
      break;
    }
    b.errors.push({ line, severity: 'error', message: `Unexpected character "${ch}"` });
    i++;
  }
  // stray N/O later in the block
  const kept: Word[] = [];
  for (const w of b.words) {
    if (w.letter === 'N' || w.letter === 'O') {
      b.errors.push({ line, severity: 'warning', message: `${w.letter}-word should be the first word of the block` });
      if (w.letter === 'N') b.n = w.value;
      else b.o = w.value;
    } else kept.push(w);
  }
  b.words = kept;
  return b;
}

export function lexProgram(src: string): Block[] {
  return src.split(/\r?\n/).map((t, i) => lexLine(t, i));
}
