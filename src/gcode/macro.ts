// Fanuc Custom Macro B – expression evaluation.
//
//   #1 = [#2 + 3] * SIN[30]
//   IF [#1 GT 10] GOTO 100
//   WHILE [#5 LE 20] DO 1 … END 1
//
// Variables: #0 is always vacant (null), #1–#33 local, #100–#199 / #500–#999 common.
// Trigonometric functions use degrees, as on the control.

export type Vars = Map<number, number>;

type Tok = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'word'; v: string };

const FUNCS = new Set(['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'SQRT', 'ABS', 'ROUND', 'FIX', 'FUP', 'LN', 'EXP']);
const CMP = new Set(['EQ', 'NE', 'GT', 'GE', 'LT', 'LE']);
const LOGIC = new Set(['AND', 'OR', 'XOR', 'MOD']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = src.toUpperCase();
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: parseFloat(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Z]+/.exec(s.slice(i));
    if (word) {
      out.push({ t: 'word', v: word[0] });
      i += word[0].length;
      continue;
    }
    if ('#[]+-*/,'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected "${c}" in macro expression`);
  }
  return out;
}

const deg = Math.PI / 180;

/** Evaluate an expression. Returns null for a lone vacant variable. */
export function evalExpr(src: string, vars: Vars): number | null {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  const isWord = (set: Set<string>) => peek()?.t === 'word' && set.has(String(peek().v));
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Macro expression: "${v}" expected`);
    p++;
  };
  const z = (v: number | null) => v ?? 0;

  const varRef = (): number | null => {
    // after '#'
    let idx: number;
    if (isOp('[')) {
      p++;
      idx = Math.round(z(orExpr()));
      expect(']');
    } else if (isOp('#')) {
      p++;
      idx = Math.round(z(varRef()));
    } else if (peek()?.t === 'num') idx = Math.round((toks[p++] as { v: number }).v);
    else throw new Error('Macro: variable number expected after #');
    if (idx === 0) return null;
    if (idx < 0 || idx > 9999) throw new Error(`Macro: variable #${idx} does not exist`);
    return vars.has(idx) ? vars.get(idx)! : null;
  };

  const primary = (): number | null => {
    const t = peek();
    if (!t) throw new Error('Macro expression is incomplete');
    if (t.t === 'num') {
      p++;
      return t.v;
    }
    if (t.t === 'op' && t.v === '#') {
      p++;
      return varRef();
    }
    if (t.t === 'op' && t.v === '[') {
      p++;
      const v = orExpr();
      expect(']');
      return v;
    }
    if (t.t === 'word' && FUNCS.has(t.v)) {
      p++;
      expect('[');
      const a = z(orExpr());
      let b: number | null = null;
      if (isOp(',')) {
        p++;
        b = z(orExpr());
      }
      expect(']');
      // ATAN[a]/[b] two-argument form
      if (t.v === 'ATAN' && b === null && isOp('/') && toks[p + 1]?.t === 'op' && toks[p + 1].v === '[') {
        p += 2;
        b = z(orExpr());
        expect(']');
      }
      switch (t.v) {
        case 'SIN': return Math.sin(a * deg);
        case 'COS': return Math.cos(a * deg);
        case 'TAN': return Math.tan(a * deg);
        case 'ASIN': return Math.asin(a) / deg;
        case 'ACOS': return Math.acos(a) / deg;
        case 'ATAN': {
          const r = (b === null ? Math.atan(a) : Math.atan2(a, b)) / deg;
          return r < 0 && b !== null ? r + 360 : r;
        }
        case 'SQRT':
          if (a < 0) throw new Error('Macro: SQRT of a negative number');
          return Math.sqrt(a);
        case 'ABS': return Math.abs(a);
        case 'ROUND': return Math.round(a);
        case 'FIX': return Math.trunc(a);
        case 'FUP': return a >= 0 ? Math.ceil(a) : Math.floor(a);
        case 'LN':
          if (a <= 0) throw new Error('Macro: LN of a number ≤ 0');
          return Math.log(a);
        case 'EXP': return Math.exp(a);
      }
    }
    throw new Error(`Macro: unexpected "${t.v}"`);
  };
  const unary = (): number | null => {
    if (isOp('-')) {
      p++;
      return -z(unary());
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return primary();
  };
  const mul = (): number | null => {
    let a = unary();
    while (isOp('*') || isOp('/') || (peek()?.t === 'word' && peek().v === 'MOD')) {
      const op = toks[p++].v;
      const b = z(unary());
      if (op === '*') a = z(a) * b;
      else if (op === '/') {
        if (b === 0) throw new Error('Macro: division by zero');
        a = z(a) / b;
      } else a = z(a) % b;
    }
    return a;
  };
  const add = (): number | null => {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].v;
      const b = z(mul());
      a = op === '+' ? z(a) + b : z(a) - b;
    }
    return a;
  };
  const cmp = (): number | null => {
    const a = add();
    if (isWord(CMP)) {
      const op = toks[p++].v;
      const b = add();
      // vacant compares equal only to vacant for EQ/NE
      if (op === 'EQ') return (a === null || b === null ? a === b : a === b) ? 1 : 0;
      if (op === 'NE') return (a === null || b === null ? a !== b : a !== b) ? 1 : 0;
      const x = z(a), y = z(b);
      return (op === 'GT' ? x > y : op === 'GE' ? x >= y : op === 'LT' ? x < y : x <= y) ? 1 : 0;
    }
    return a;
  };
  const andExpr = (): number | null => {
    let a = cmp();
    while (peek()?.t === 'word' && peek().v === 'AND') {
      p++;
      const b = cmp();
      a = z(a) !== 0 && z(b) !== 0 ? 1 : 0;
    }
    return a;
  };
  function orExpr(): number | null {
    let a = andExpr();
    while (peek()?.t === 'word' && (peek().v === 'OR' || peek().v === 'XOR')) {
      const op = toks[p++].v;
      const b = andExpr();
      a = op === 'OR' ? (z(a) !== 0 || z(b) !== 0 ? 1 : 0) : (z(a) !== 0) !== (z(b) !== 0) ? 1 : 0;
    }
    return a;
  }
  const v = orExpr();
  if (p < toks.length) {
    const t = toks[p];
    throw new Error(`Macro: unexpected "${t.v}"${LOGIC.has(String(t.v)) ? '' : ' (missing operator or bracket?)'}`);
  }
  if (v !== null && !Number.isFinite(v)) throw new Error('Macro: result is not a finite number');
  return v;
}

/** Macro statement attached to a block by the lexer. */
export type MacroStmt =
  | { kind: 'assign'; target: string; expr: string }
  | { kind: 'if-goto'; cond: string; n: string }
  | { kind: 'if-then'; cond: string; target: string; expr: string }
  | { kind: 'goto'; n: string }
  | { kind: 'while'; cond: string; id: number }
  | { kind: 'end'; id: number };

/** Find the closing "]" that matches the "[" at position i. */
export function matchBracket(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '[') depth++;
    else if (s[k] === ']') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Parse a macro statement line (after N-number and comments are removed). */
export function parseMacro(text: string): MacroStmt | null {
  const s = text.trim().toUpperCase();
  let m: RegExpExecArray | null;
  if ((m = /^#(\d+|\[.*\])\s*=\s*(.+)$/.exec(s))) return { kind: 'assign', target: m[1], expr: m[2] };
  if (/^IF\s*\[/.test(s)) {
    const open = s.indexOf('[');
    const close = matchBracket(s, open);
    if (close < 0) throw new Error('IF: missing "]"');
    const cond = s.slice(open + 1, close);
    const rest = s.slice(close + 1).trim();
    if ((m = /^GOTO\s*(.+)$/.exec(rest))) return { kind: 'if-goto', cond, n: m[1] };
    if ((m = /^THEN\s*#(\d+|\[.*\])\s*=\s*(.+)$/.exec(rest))) return { kind: 'if-then', cond, target: m[1], expr: m[2] };
    throw new Error('IF must be followed by GOTO n or THEN #n = …');
  }
  if ((m = /^GOTO\s*(.+)$/.exec(s))) return { kind: 'goto', n: m[1] };
  if (/^WHILE\s*\[/.test(s)) {
    const open = s.indexOf('[');
    const close = matchBracket(s, open);
    if (close < 0) throw new Error('WHILE: missing "]"');
    const rest = s.slice(close + 1).trim();
    if (!(m = /^DO\s*(\d+)$/.exec(rest))) throw new Error('WHILE […] must be followed by DO 1, DO 2 or DO 3');
    return { kind: 'while', cond: s.slice(open + 1, close), id: +m[1] };
  }
  if ((m = /^END\s*(\d+)$/.exec(s))) return { kind: 'end', id: +m[1] };
  return null;
}
