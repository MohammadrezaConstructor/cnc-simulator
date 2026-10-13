import { EditorState, StateEffect, StateField, type Extension, Compartment, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  Decoration, type DecorationSet, hoverTooltip, gutter, GutterMarker,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { setDiagnostics, lintGutter, type Diagnostic as CMDiag } from '@codemirror/lint';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import type { Diagnostic } from '../types';
import { GCODES, MCODES, findCode, type CodeRef } from '../content/gcodeRef';

/** code reference used for hover help and autocomplete (lathe by default) */
export interface EditorRef {
  find: (code: string) => CodeRef | undefined;
  gcodes: CodeRef[];
  mcodes: CodeRef[];
  /** address letters coloured as axes */
  axes: string;
}
const LATHE_REF: EditorRef = { find: findCode, gcodes: GCODES, mcodes: MCODES, axes: 'XZUW' };
let REF: EditorRef = LATHE_REF;

// ------------------------------------------------------------------ language

const gcodeLang = StreamLanguage.define<{ inComment: boolean }>({
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo(')')) {
        stream.next();
        state.inComment = false;
      } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    const ch = stream.peek()!;
    if (ch === '(') {
      stream.next();
      state.inComment = true;
      if (stream.skipTo(')')) {
        stream.next();
        state.inComment = false;
      } else stream.skipToEnd();
      return 'comment';
    }
    if (ch === ';') {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === '%') {
      stream.next();
      return 'meta';
    }
    if (ch === '/' && stream.sol()) {
      stream.next();
      return 'meta';
    }
    // Custom Macro B: #variables, brackets, operators and keywords
    if (stream.match(/^#\d+/)) return 'string';
    if (ch === '#') {
      stream.next();
      return 'string';
    }
    if (stream.match(/^\d+\.?\d*|^\.\d+/)) return 'number';
    if ('[]=+-*/,'.includes(ch)) {
      stream.next();
      return ch === ',' && /[CRcr]/.test(stream.peek() ?? '') ? 'keyword' : 'operator';
    }
    if (stream.match(/^(IF|GOTO|WHILE|DO|END|THEN|EQ|NE|GT|GE|LT|LE|AND|OR|XOR|MOD|SIN|COS|TAN|ASIN|ACOS|ATAN|SQRT|ABS|ROUND|FIX|FUP|LN|EXP)\b/i)) return 'controlKeyword';
    // an address followed by a macro value (X#1, Z[...])
    const ma = stream.match(/^([A-Za-z])(?=\s*-?[#[])/) as RegExpMatchArray | null;
    if (ma) {
      const L = ma[1].toUpperCase();
      return REF.axes.includes(L) ? 'variableName' : L === 'F' || L === 'S' ? 'propertyName' : 'number';
    }
    const m = stream.match(/^([A-Za-z])\s*[+-]?(\d+\.?\d*|\.\d+)/) as RegExpMatchArray | null;
    if (m) {
      const L = m[1].toUpperCase();
      if (L === 'G') return 'keyword';
      if (L === 'M') return 'atom';
      if (L === 'N' || L === 'O') return 'labelName';
      if (L === 'T') return 'typeName';
      if (L === 'F' || L === 'S') return 'propertyName';
      if (REF.axes.includes(L)) return 'variableName';
      return 'number';
    }
    stream.next();
    return 'invalid';
  },
  // the stream parser is line based: comments can't span lines in G-code
  blankLine: (state) => {
    state.inComment = false;
  },
});

const hl = HighlightStyle.define([
  { tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--cm-g)', fontWeight: '600' },
  { tag: t.atom, color: 'var(--cm-m)', fontWeight: '600' },
  { tag: t.labelName, color: 'var(--cm-n)' },
  { tag: t.typeName, color: 'var(--cm-t)', fontWeight: '600' },
  { tag: t.propertyName, color: 'var(--cm-f)' },
  { tag: t.variableName, color: 'var(--cm-xz)' },
  { tag: t.number, color: 'var(--cm-num)' },
  { tag: t.meta, color: 'var(--cm-meta)' },
  { tag: t.invalid, color: 'var(--danger)', textDecoration: 'underline wavy' },
  { tag: t.string, color: 'var(--cm-var)' },
  { tag: t.operator, color: 'var(--cm-op)' },
  { tag: t.controlKeyword, color: 'var(--cm-m)', fontWeight: '600' },
]);

// ------------------------------------------------------------------ execution line marker

const setExec = StateEffect.define<number | null>();
const execField = StateField.define<{ line: number | null; deco: DecorationSet }>({
  create: () => ({ line: null, deco: Decoration.none }),
  update(v, tr) {
    let line = v.line;
    for (const e of tr.effects) if (e.is(setExec)) line = e.value;
    if (line === v.line && !tr.docChanged) return v;
    if (line === null || line < 0 || line >= tr.state.doc.lines) return { line, deco: Decoration.none };
    const l = tr.state.doc.line(line + 1);
    return { line, deco: Decoration.set([Decoration.line({ class: 'cm-exec-line' }).range(l.from)]) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

class ArrowMarker extends GutterMarker {
  toDOM() {
    const s = document.createElement('span');
    s.textContent = '▶';
    s.className = 'cm-exec-arrow';
    return s;
  }
}
const arrow = new ArrowMarker();
const execGutter = gutter({
  class: 'cm-exec-gutter',
  lineMarker(view, line) {
    const f = view.state.field(execField);
    if (f.line === null || f.line < 0 || f.line >= view.state.doc.lines) return null;
    return view.state.doc.lineAt(line.from).number === f.line + 1 ? arrow : null;
  },
  lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setExec))),
  initialSpacer: () => arrow,
});

// ------------------------------------------------------------------ hover help

const wordHover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const rel = pos - line.from;
  // inside a comment?
  const open = text.lastIndexOf('(', rel);
  const close = text.lastIndexOf(')', rel);
  if (open > close) return null;
  const re = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (rel >= m.index && rel <= m.index + m[0].length) {
      const letter = m[1].toUpperCase();
      const code = letter === 'G' || letter === 'M' ? `${letter}${Math.round(parseFloat(m[2]))}` : letter;
      const ref = REF.find(code);
      if (!ref) return null;
      const start = line.from + m.index;
      return {
        pos: start,
        end: start + m[0].length,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-gref';
          const h = document.createElement('div');
          h.className = 'cm-gref-title';
          h.textContent = `${ref.code} – ${ref.title}`;
          dom.appendChild(h);
          if (ref.syntax) {
            const s = document.createElement('code');
            s.textContent = ref.syntax;
            dom.appendChild(s);
          }
          const p = document.createElement('p');
          p.textContent = ref.text;
          dom.appendChild(p);
          return { dom };
        },
      };
    }
  }
  return null;
});

// ------------------------------------------------------------------ autocomplete

function gcodeCompletions(ctx: CompletionContext) {
  const w = ctx.matchBefore(/[GgMm]\d*/);
  if (!w || (w.from === w.to && !ctx.explicit)) return null;
  const isG = w.text[0].toUpperCase() === 'G';
  const list = (isG ? REF.gcodes : REF.mcodes).map((c) => ({
    label: c.code,
    detail: c.title,
    info: c.syntax ? `${c.syntax}\n\n${c.text}` : c.text,
    type: isG ? 'keyword' : 'function',
  }));
  return { from: w.from, options: list, validFor: /^[GgMm]\d*$/ };
}

// ------------------------------------------------------------------ public API

export interface Editor {
  view: EditorView;
  getDoc(): string;
  setDoc(s: string): void;
  setExecLine(line: number | null): void;
  setDiagnostics(d: Diagnostic[]): void;
  setReadOnly(ro: boolean): void;
  goToLine(line: number, select?: boolean): void;
  cursorLine(): number;
}

export function createEditor(parent: HTMLElement, doc: string, onChange: (s: string) => void, onCursor: (line: number) => void, ref?: EditorRef, opts: { onRun?: () => void } = {}): Editor {
  if (ref) REF = ref;
  const ro = new Compartment();
  const exts: Extension[] = [
    // Ctrl/Cmd+Enter = CYCLE START (must win over CodeMirror's insertBlankLine binding)
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { opts.onRun?.(); return !!opts.onRun; } }])),
    lineNumbers(),
    execGutter,
    lintGutter(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    highlightSelectionMatches(),
    gcodeLang,
    syntaxHighlighting(hl),
    execField,
    wordHover,
    autocompletion({ override: [gcodeCompletions], activateOnTyping: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    ro.of(EditorState.readOnly.of(false)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) onCursor(u.state.doc.lineAt(u.state.selection.main.head).number - 1);
    }),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px' },
      '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    }),
  ];
  const view = new EditorView({ state: EditorState.create({ doc, extensions: exts }), parent });
  let lastExec: number | null = null;
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(s) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s } });
    },
    setExecLine(line) {
      if (line === lastExec) return;
      lastExec = line;
      const effects = [setExec.of(line)];
      if (line !== null && line >= 0 && line < view.state.doc.length + 1 && line < view.state.doc.lines) {
        const l = view.state.doc.line(line + 1);
        view.dispatch({ effects: [...effects, EditorView.scrollIntoView(l.from, { y: 'nearest', yMargin: 60 })] });
      } else view.dispatch({ effects });
    },
    setDiagnostics(d) {
      const doc = view.state.doc;
      const list: CMDiag[] = d
        .filter((x) => x.line >= 0 && x.line < doc.lines)
        .map((x) => {
          const l = doc.line(x.line + 1);
          return { from: l.from, to: Math.max(l.from, l.to), severity: x.severity, message: x.message + (x.hint ? '\n' + x.hint : '') };
        });
      view.dispatch(setDiagnostics(view.state, list));
    },
    setReadOnly(r) {
      view.dispatch({ effects: ro.reconfigure(EditorState.readOnly.of(r)) });
    },
    goToLine(line, select = true) {
      if (line < 0 || line >= view.state.doc.lines) return;
      const l = view.state.doc.line(line + 1);
      view.dispatch({ selection: select ? { anchor: l.from, head: l.to } : { anchor: l.from }, scrollIntoView: true });
      view.focus();
    },
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number - 1,
  };
}
