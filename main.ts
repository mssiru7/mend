// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write, plus unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** ---- line model (SPEC.md section 3) ---- */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}
function serializeFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}
function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}
/** Replacement lines for an O -> N replacement at pos/tier. nFromO[k] is the index in O of N[k]
 *  when N[k] is a context line, else -1. Context lines are written as the file's own lines. */
function replacementLines(fileLines: string[], pos: number, o: string[], n: string[], nFromO: number[], tier: number): string[] {
  const f = tier === 2 && o.length > 0 ? leading(fileLines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leading(o[0]!) : '';
  return n.map((line, k) => {
    const oi = nFromO[k]!;
    if (oi >= 0) return fileLines[pos + oi]!;
    if (tier === 2) return reindent(line, f, p);
    return line;
  });
}

/** One body line of a unified diff hunk or a V4A chunk. noNl is set by a `\` line after it. */
interface BodyItem {
  type: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
}
function splitBody(body: BodyItem[]): { o: string[]; n: string[]; nFromO: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nFromO: number[] = [];
  for (const it of body) {
    if (it.type === 'ctx') {
      nFromO.push(o.length);
      o.push(it.text);
      n.push(it.text);
    } else if (it.type === 'old') {
      o.push(it.text);
    } else {
      n.push(it.text);
      nFromO.push(-1);
    }
  }
  return { o, n, nFromO };
}
function lastNoEol(body: BodyItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const it = body[i]!;
    if (it.type === 'ctx' || it.type === 'new') return it.noNl;
  }
  return false;
}

interface Hunk {
  a: number;
  body: BodyItem[];
  noEol: boolean;
}
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const state = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n, nFromO } = splitBody(h.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const touchesEnd = at === state.lines.length;
      state.lines.splice(at, 0, ...n);
      if (touchesEnd) state.finalBreak = !h.noEol;
      d += n.length;
      continue;
    }
    const found = findTier(state.lines, o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const q of found.occ) {
      const dist = Math.abs(q - target);
      if (dist < best) {
        best = dist;
        pos = q;
      }
    }
    const rep = replacementLines(state.lines, pos, o, n, nFromO, found.tier);
    const touchesEnd = pos + o.length === state.lines.length;
    state.lines.splice(pos, o.length, ...rep);
    if (touchesEnd) state.finalBreak = !h.noEol;
    d += n.length - o.length;
  }
  return serializeFile(state);
}

/** ---- unified diffs (SPEC.md section 6) ---- */
interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  hasDashPlus: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}
function unifiedEdits(lines: string[], strict: boolean, moves: Map<string, string>): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  const push = (): void => {
    if (cur) sections.push(cur);
    cur = null;
  };
  const newSection = (): UnifiedSection => ({ oldPath: null, newPath: null, hasDashPlus: false, isCreate: false, isDelete: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || sep < 0 || rest.slice(2, sep) === '' || rest.slice(sep + 3) === '') throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = newSection();
      cur.oldPath = rest.slice(2, sep);
      cur.newPath = rest.slice(sep + 3);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        push();
        cur = newSection();
        inHeader = true;
      }
      cur.oldPath = stripAB(headerPath(line));
      cur.newPath = stripAB(headerPath(lines[i + 1]!));
      cur.hasDashPlus = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ')) {
          body.push({ type: 'ctx', text: l.slice(1), noNl: false });
          j++;
        } else if (l.startsWith('-')) {
          body.push({ type: 'old', text: l.slice(1), noNl: false });
          j++;
        } else if (l.startsWith('+')) {
          body.push({ type: 'new', text: l.slice(1), noNl: false });
          j++;
        } else if (l.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1]!.noNl = true;
          j++;
        } else if (l === '') {
          body.push({ type: 'ctx', text: '', noNl: false });
          j++;
        } else break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.type === 'ctx' && last.text === '' && !last.noNl) body.pop();
        else break;
      }
      cur.hunks.push({ a: parseInt(m[1]!, 10), body, noEol: lastNoEol(body) });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (!cur.hasDashPlus) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.hasDashPlus) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i++;
      continue;
    }
    i++;
  }
  push();
  return sections.map((s) => {
    const oldRaw = s.oldPath;
    const newRaw = s.newPath;
    const oldP = oldRaw === '/dev/null' ? null : oldRaw;
    const newP = newRaw === '/dev/null' ? null : newRaw;
    const isCreate = s.isCreate || oldRaw === '/dev/null';
    const isDelete = s.isDelete || newRaw === '/dev/null';
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        const np = newP;
        if (np === null) throw new Fail('missing', oldP ?? '');
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let finalBreak = true;
        let anyPlus = false;
        outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const h = s.hunks[hi]!;
          for (let bi = h.body.length - 1; bi >= 0; bi--) {
            const it = h.body[bi]!;
            if (it.type === 'new') {
              finalBreak = !it.noNl;
              break outer;
            }
          }
        }
        for (const h of s.hunks) {
          for (const it of h.body) {
            if (it.type === 'new') {
              plus.push(it.text);
              anyPlus = true;
            }
          }
        }
        tree.now.set(np, !anyPlus ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const op = oldP;
        if (op === null) throw new Fail('missing', newP ?? '');
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(tree.get(oldP)!, s.hunks, strict, oldP);
        tree.now.set(newP, out);
        tree.now.set(oldP, null);
        moves.set(newP, oldP);
        return;
      }
      const p = oldP ?? newP;
      if (p === null) throw new Fail('missing', '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(tree.get(p)!, s.hunks, strict, p));
    };
  });
}

/** ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevEnd = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const sIdx = i;
      let path: string | null = null;
      for (let j = sIdx - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (lastPath !== null) path = lastPath;
        else throw new Exit2(`error: parse ${sIdx + 1}`);
      }
      let eq = -1;
      let rep = -1;
      for (let j = sIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq >= 0) {
        for (let j = eq + 1; j < lines.length; j++) {
          if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
            rep = j;
            break;
          }
        }
      }
      if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      blocks.push({ path, oldLines: lines.slice(sIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
      lastPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else i++;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const state = parseFile(text);
    const found = findTier(state.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const rep = replacementLines(state.lines, pos, b.oldLines, b.newLines, b.newLines.map(() => -1), found.tier);
    state.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, serializeFile(state));
  });
}

/** ---- V4A patches (SPEC.md section 8) ---- */
interface VChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines?: string[];
  moveTo?: string | null;
  chunks?: VChunk[];
  lineNo: number;
}
function v4aEdits(lines: string[], strict: boolean, moves: Map<string, string>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const sec: VSection = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), lines: [], lineNo: i + 1 };
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          sec.lines!.push(l.slice(1));
          i++;
        } else if (l === '') {
          sec.lines!.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (sec.lines!.length > 0 && sec.lines![sec.lines!.length - 1] === '') sec.lines!.pop();
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), lineNo: i + 1 });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const sec: VSection = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), moveTo: null, chunks: [], lineNo: i + 1 };
      i++;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      let cur: VChunk | null = null;
      const flush = (): void => {
        if (cur) {
          while (cur.body.length > 0) {
            const l = cur.body[cur.body.length - 1]!;
            if (l.type === 'ctx' && l.text === '' && !l.noNl) cur.body.pop();
            else break;
          }
          sec.chunks!.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: true };
          else cur.eof = true;
          flush();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          flush();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          if (l === '') cur.body.push({ type: 'ctx', text: '', noNl: false });
          else if (l.startsWith(' ')) cur.body.push({ type: 'ctx', text: l.slice(1), noNl: false });
          else if (l.startsWith('-')) cur.body.push({ type: 'old', text: l.slice(1), noNl: false });
          else cur.body.push({ type: 'new', text: l.slice(1), noNl: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (sec.chunks!.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((sec) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const ls = sec.lines!;
      tree.now.set(sec.path, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const moveTo = sec.moveTo ?? null;
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(sec.path);
    if (text === null) throw new Fail('missing', sec.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = parseFile(text);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const chunk of sec.chunks!) {
      if (chunk.anchor !== null) {
        let foundIdx = -1;
        for (const t of tiers) {
          for (let j = cursor; j < state.lines.length; j++) {
            if (normLine(state.lines[j]!, t) === normLine(chunk.anchor, t)) {
              foundIdx = j;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', sec.path);
        cursor = foundIdx + 1;
      }
      const { o, n, nFromO } = splitBody(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? state.lines.length : cursor;
        state.lines.splice(at, 0, ...n);
        cursor = at + n.length;
        continue;
      }
      let pos = -1;
      let tierUsed = 0;
      for (const t of tiers) {
        const occ = occurrences(state.lines, o, t, cursor);
        const cand = chunk.eof ? occ.filter((q) => q + o.length === state.lines.length) : occ;
        if (cand.length > 0) {
          pos = cand[0]!;
          tierUsed = t;
          break;
        }
      }
      if (pos < 0) throw new Fail('no-match', sec.path);
      const rep = replacementLines(state.lines, pos, o, n, nFromO, tierUsed);
      state.lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = serializeFile(state);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(sec.path, null);
      moves.set(moveTo, sec.path);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves = new Map<string, string>();
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [nw, old] of moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, text: `R ${old} -> ${nw}` });
      consumed.add(old);
      consumed.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
