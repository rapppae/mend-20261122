// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none, printing what it changed or why it
// failed. SPEC.md is the whole contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are,
// and write the CLI.

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

/** A file as lines: its own break, its lines, and whether it ends with that break. */
interface FileLines {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** One line of a patch body: context, old, new, or a backslash marker. */
type BodyKind = 'ctx' | 'old' | 'new' | 'back';
interface BodyLine {
  kind: BodyKind;
  text: string;
  /** True when the patch line itself was empty (a context line with no leading space). */
  rawEmpty: boolean;
}

function bodyLine(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '', rawEmpty: true };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1), rawEmpty: false };
  if (c === '-') return { kind: 'old', text: line.slice(1), rawEmpty: false };
  if (c === '+') return { kind: 'new', text: line.slice(1), rawEmpty: false };
  return { kind: 'back', text: line.slice(1), rawEmpty: false };
}

/** Matching (SPEC.md section 5). A line of O and a line of N: `ctx` lines are in both. */
interface LineEntry {
  text: string;
  ctx: boolean;
  /** For a context line, its index in O, so it can be read back from the file. */
  oIndex: number;
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in the file's lines at one tier. */
function occurrences(oldLines: string[], fileLines: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k += 1) {
      if (!tierEqual(oldLines[k]!, fileLines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences, or null. */
function firstTier(oldLines: string[], fileLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const occ = occurrences(oldLines, fileLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Tier 2 re-indent of one new line: its P prefix, from O's first line, becomes F, the file's. */
function reindent(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** The lines N writes over a match at `at`: context lines are the file's own matched lines. */
function buildNew(o: LineEntry[], n: LineEntry[], fileLines: string[], at: number, tier: number): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadingWs(o[0]!.text);
    f = leadingWs(fileLines[at]!);
  }
  return n.map((e) => {
    if (e.ctx) return fileLines[at + e.oIndex]!;
    return tier === 2 ? reindent(e.text, p, f) : e.text;
  });
}

/** O and N of a hunk or chunk body, each in body order. */
function entriesOf(body: BodyLine[]): { o: LineEntry[]; n: LineEntry[] } {
  const o: LineEntry[] = [];
  const n: LineEntry[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const e: LineEntry = { text: b.text, ctx: true, oIndex: o.length };
      o.push(e);
      n.push(e);
    } else if (b.kind === 'old') {
      o.push({ text: b.text, ctx: false, oIndex: -1 });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

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

/** Unified diffs (SPEC.md section 6). */

interface Hunk {
  /** A, the old start line from the header. */
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  diffOld: string;
  diffNew: string;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, trimmed. */
function diffPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: Hunk | null = null;
  let header = false;

  const closeHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawEmpty) hunk.body.pop();
      cur.hunks.push(hunk);
      hunk = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (isDiffGit(line)) {
        closeHunk();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeHunk();
        continue;
      }
      if (line.startsWith('@@')) {
        closeHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push(bodyLine(line));
        i += 1;
        continue;
      }
      closeHunk();
      continue;
    }
    if (isDiffGit(line)) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: null,
        newPath: null,
        pairOld: null,
        pairNew: null,
        hasPair: false,
        diffOld: m[1]!,
        diffNew: m[2]!,
        renameFrom: null,
        renameTo: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      header = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = diffPath(line);
        const newP = diffPath(next);
        if (cur !== null && header && !cur.hasPair) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
          cur.hasPair = true;
        } else {
          cur = {
            oldPath: null,
            newPath: null,
            pairOld: oldP,
            pairNew: newP,
            hasPair: true,
            diffOld: '',
            diffNew: '',
            renameFrom: null,
            renameTo: null,
            isCreate: false,
            isDelete: false,
            hunks: [],
          };
          sections.push(cur);
          header = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && header) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      header = false;
      i += 1;
      continue;
    }
    if (cur !== null && header) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
    }
    i += 1;
  }
  closeHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoBreak(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k -= 1) {
    const b = h.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') return h.body[k + 1]?.kind === 'back';
  }
  return false;
}

/** One section's hunks applied in order to a file's text, with the running offset d. */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let fl = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = entriesOf(h.body);
    const noBreak = hunkNoBreak(h);
    if (o.length === 0) {
      const idx = Math.max(0, Math.min(h.a + d, fl.lines.length));
      const added = n.map((e) => e.text);
      fl = {
        br: fl.br,
        lines: [...fl.lines.slice(0, idx), ...added, ...fl.lines.slice(idx)],
        finalBreak: idx === fl.lines.length ? !noBreak : fl.finalBreak,
      };
      d += n.length;
    } else {
      const found = firstTier(
        o.map((e) => e.text),
        fl.lines,
        strict,
      );
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const added = buildNew(o, n, fl.lines, best, found.tier);
      const atEnd = best + o.length === fl.lines.length;
      fl = {
        br: fl.br,
        lines: [...fl.lines.slice(0, best), ...added, ...fl.lines.slice(best + o.length)],
        finalBreak: atEnd ? !noBreak : fl.finalBreak,
      };
      d += n.length - o.length;
    }
  }
  return joinFile(fl);
}

function unifiedSectionEdit(sec: UniSection, strict: boolean, moves: Array<[string, string]>): Edit {
  const oldPath = sec.hasPair ? sec.pairOld : sec.renameFrom ?? (sec.diffOld === '' ? null : sec.diffOld);
  const newPath = sec.hasPair ? sec.pairNew : sec.renameTo ?? (sec.diffNew === '' ? null : sec.diffNew);
  const isCreate = sec.isCreate || oldPath === null;
  const isDelete = !isCreate && (sec.isDelete || newPath === null);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return (tree: Tree) => {
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          const b = h.body[k]!;
          if (b.kind === 'new') {
            plus.push(b.text);
            noBreak = h.body[k + 1]?.kind === 'back';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
    } else if (isDelete) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    } else if (isMove) {
      const op = oldPath!;
      const np = newPath!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(text, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      moves.push([op, np]);
    } else {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      tree.now.set(p, applyUnifiedHunks(text, sec.hunks, strict, p));
    }
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */

function searchReplaceEdits(lines: string[], strict: boolean, _moves: Array<[string, string]>): Edit[] {
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j -= 1) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${s + 1}`);
      }
      let sep = -1;
      for (let k = s + 1; k < lines.length; k += 1) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') {
          sep = k;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (sep === -1) throw new Exit2(`error: parse ${s + 1}`);
      let end = -1;
      for (let k = sep + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
      if (end === -1) throw new Exit2(`error: parse ${s + 1}`);
      blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevPath = path;
      prevEnd = end;
      i = end + 1;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const fl = splitFile(text);
    const found = firstTier(b.oldLines, fl.lines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const o = b.oldLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const n = b.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const added = buildNew(o, n, fl.lines, at, found.tier);
    const out: FileLines = {
      br: fl.br,
      lines: [...fl.lines.slice(0, at), ...added, ...fl.lines.slice(at + b.oldLines.length)],
      finalBreak: fl.finalBreak,
    };
    tree.now.set(b.path, joinFile(out));
  });
}

/** V4A patches (SPEC.md section 8). */

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const isV4aHeader = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const raw: { text: string; num: number }[] = [];
      while (i < end && !isV4aHeader(lines[i]!)) {
        raw.push({ text: lines[i]!, num: i });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.num + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < end && !isV4aHeader(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i += 1;
      const raw: { text: string; num: number }[] = [];
      while (i < end && !isV4aHeader(lines[i]!)) {
        raw.push({ text: lines[i]!, num: i });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      edits.push(v4aUpdateEdit(path, raw, updateLine, strict, moves));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdateEdit(
  path: string,
  raw: { text: string; num: number }[],
  updateLine: number,
  strict: boolean,
  moves: Array<[string, string]>,
): Edit {
  let moveTo: string | null = null;
  let rest = raw;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    rest = raw.slice(1);
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let sawChunk = false;
  for (const r of rest) {
    const line = r.text;
    if (line === '*** End of File') {
      if (cur === null) {
        if (!sawChunk && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
        throw new Exit2(`error: parse ${r.num + 1}`);
      }
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      sawChunk = true;
    } else if (line.startsWith('@@')) {
      if (cur !== null) {
        chunks.push(cur);
        sawChunk = true;
      }
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
    } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        if (sawChunk) throw new Exit2(`error: parse ${r.num + 1}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push(bodyLine(line));
    } else {
      throw new Exit2(`error: parse ${r.num + 1}`);
    }
  }
  if (cur !== null) {
    chunks.push(cur);
    sawChunk = true;
  }
  if (!sawChunk && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fl = splitFile(text);
    let cursor = 0;
    const topTier = strict ? 0 : 2;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        for (let t = 0; t <= topTier && foundIdx < 0; t += 1) {
          for (let k = cursor; k < fl.lines.length; k += 1) {
            if (tierEqual(ch.anchor, fl.lines[k]!, t)) {
              foundIdx = k;
              break;
            }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const { o, n } = entriesOf(ch.body);
      if (o.length === 0) {
        const idx = ch.eof ? fl.lines.length : cursor;
        const added = n.map((e) => e.text);
        fl = {
          br: fl.br,
          lines: [...fl.lines.slice(0, idx), ...added, ...fl.lines.slice(idx)],
          finalBreak: fl.finalBreak,
        };
        cursor = idx + added.length;
      } else {
        const oldTexts = o.map((e) => e.text);
        let found: { tier: number; at: number } | null = null;
        for (let t = 0; t <= topTier && found === null; t += 1) {
          for (let k = cursor; k + oldTexts.length <= fl.lines.length; k += 1) {
            if (ch.eof && k + oldTexts.length !== fl.lines.length) continue;
            let ok = true;
            for (let j = 0; j < oldTexts.length; j += 1) {
              if (!tierEqual(oldTexts[j]!, fl.lines[k + j]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              found = { tier: t, at: k };
              break;
            }
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const added = buildNew(o, n, fl.lines, found.at, found.tier);
        fl = {
          br: fl.br,
          lines: [...fl.lines.slice(0, found.at), ...added, ...fl.lines.slice(found.at + oldTexts.length)],
          finalBreak: fl.finalBreak,
        };
        cursor = found.at + added.length;
      }
    }
    const out = joinFile(fl);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict, moves);
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
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
