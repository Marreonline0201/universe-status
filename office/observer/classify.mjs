// Worker Office classifier: one tool call -> (activity, office object kind).
//
// ONE plain-JS ES module, shared by the spool hook (spool-hook.mjs) and, later, the page. No imports, no I/O.
// It is a case-for-case port of the Python reference classify_final.py (worker-office plan section 4.3), which is the
// step-3 classifier classify_s3.py plus:
//   P1  a shell command is split into top-level STEPS (&& || ; newline, outside quotes, after removing heredoc and
//       here-string bodies); a pipeline a | b counts as its first stage that classifies (the producer); the station
//       is the step highest in PRECEDENCE. A parallel batch is resolved by the same precedence.
//   P2  git verbs that touch the working copy are relabelled (checkout/restore/reset/switch -> 'restore files' at the
//       desk; stash -> 'set aside (stash)'; status/branch/remote/rev-parse -> 'glance at history').
//   P3  hook-time Agent rule (classifyAgentPre): background unless run_in_background is explicitly false.
// The reference's measurement toggles (CF_* environment variables) are deliberately NOT ported: the shipped
// classifier always has P1 and P2 on. scripts/classify-test.mjs plants the "off" variants as mutants instead.
//
// Python-compatibility (checked against the reference on office/observer/classify-cases.json):
//  - Python's str.strip()/lstrip() and re's \s use str.isspace(); JS's \s and trim() use a different set.
//    PY_WS below is Python's set exactly (29 code points, read from Python 3.13).
//  - Python re's \d is Unicode category Nd and \w is Unicode L|N plus '_' (verified on Unicode 15.1), so they are
//    written \p{Nd} and [\p{L}\p{N}_] with the u flag. (Node's Unicode tables may be a version newer.)
//  - Python's '.' (no DOTALL) matches everything except \n; JS's '.' also refuses \r, \u2028, \u2029, so [^\n].
//  - Python's (?i) treats dotless i and dotted capital I as 'i'; JS /iu does not, so that letter is spelled out.
//  - str.strip(chars) / lstrip(chars) remove a character SET, not a prefix (stripSet / lstripSet).
//  - `x or y` uses Python truthiness (pyOr); dict lookups use Map / own properties only.
//  - Where Python would raise (tool_input that is not a dict when it is read, a command that is not a string) this
//    port throws a TypeError too; the hook catches it and writes its record without a kind.

// ---------------------------------------------------------------------------------------------- Python helpers
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_CODES = new Set([0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);

function pyStrip(s) {
  let a = 0, b = s.length;
  while (a < b && PY_WS_CODES.has(s.charCodeAt(a))) a++;
  while (b > a && PY_WS_CODES.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}
function pyLstrip(s) {
  let a = 0;
  while (a < s.length && PY_WS_CODES.has(s.charCodeAt(a))) a++;
  return s.slice(a);
}
function lstripSet(s, chars) {
  let a = 0;
  while (a < s.length && chars.includes(s[a])) a++;
  return s.slice(a);
}
function stripSet(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
function pyTruthy(x) {
  if (x === null || x === undefined || x === false) return false;
  if (x === true) return true;
  if (typeof x === 'number') return x !== 0;
  if (typeof x === 'string' || Array.isArray(x)) return x.length > 0;
  if (typeof x === 'object') return Object.keys(x).length > 0;
  return true;
}
function pyOr(a, b) { return pyTruthy(a) ? a : b; }
function isDict(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function pyGet(d, key) {                       // dict.get(key) -> undefined when missing; raises on a non-dict
  if (!isDict(d)) throw new TypeError(`expected a dict, got ${Array.isArray(d) ? 'array' : typeof d}`);
  return Object.hasOwn(d, key) ? d[key] : undefined;
}
function pyStr(s, what) {                      // a Python str is required here; anything else raised in Python
  if (typeof s !== 'string') throw new TypeError(`${what}: expected a string, got ${typeof s}`);
  return s;
}

// ---------------------------------------------------------------------------------------------- tables (step 3)
const t = (activity, kind) => Object.freeze([activity, kind]);
export const NO_MOVE = t('no move', null);
const NEXT = Symbol('NEXT');                   // this segment is preamble -> look at the next one

const CD_LIKE = new Set(['cd', 'set-location', 'sl', 'chdir', 'pushd', 'popd']);
const PREAMBLE = new Set(['for', 'fi', 'done', '}', 'set', 'export', 'source', '.', 'local', 'true', 'false', 'shopt',
  'trap', 'esac', 'case', 'function', '[', '[[', 'test', 'return', 'exit', 'break', 'continue', 'read', 'unset',
  'date', 'get-date', 'which', 'where', 'pwd', 'whoami', 'hostname', 'add-type', 'clear', 'cls', ':']);
const WRAP = new Set(['do', 'then', 'else', 'elif', 'if', 'time', 'env', 'nohup', 'exec', 'command', 'builtin', 'sudo',
  '&', '!', '(', '{']);
const LABEL_ONLY = new Set(['echo', 'printf', 'write-host', 'write-output', ':']);

const V = new Map();                           // verb (lower case) -> (activity, kind)
function v(activity, kind, ...words) { const r = t(activity, kind); for (const w of words) V.set(w.toLowerCase(), r); }
v('read a file', 'fileCabinet', 'cat', 'head', 'tail', 'type', 'more', 'get-content', 'gc', 'awk', 'wc', 'sort',
  'uniq', 'cut', 'jq', 'stat', 'file', 'xxd', 'od',
  'tr', 'sha256sum', 'md5sum', 'sha1sum', 'strings', 'hexdump', 'nl', 'tac', 'pdftotext', 'mutool', 'qpdf',
  'get-item', 'get-itemproperty', 'get-filehash');
v('search contents', 'fileCabinet', 'grep', 'rg', 'findstr', 'select-string', 'sls');
v('list names', 'fileCabinet', 'ls', 'dir', 'find', 'tree', 'get-childitem', 'gci', 'test-path', 'resolve-path');
v('refile / new folder', 'fileCabinet', 'mv', 'move', 'move-item', 'ren', 'rename-item', 'mkdir', 'md', 'new-item');
v('write a file', 'pcDesk', 'tee', 'set-content', 'add-content', 'out-file', 'touch');
v('run a program', 'benchTerminal', 'npm', 'npx', 'node', 'tsx', 'tsc', 'vite', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'py', 'pip', 'pytest', 'cargo', 'rustc', 'go', 'make', 'cmake', 'dotnet', 'java', 'start-process');
v('wait on a run', 'benchTerminal', 'sleep', 'start-sleep', 'timeout', 'wait', 'until', 'while');
v('stop a job', 'benchTerminal', 'kill', 'taskkill', 'stop-process', 'pkill');
v('read an outside document', 'bookshelf', 'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm');
v('send outside', 'postShelf', 'vercel');
v('copy / pack', 'copier', 'cp', 'copy', 'copy-item', 'xcopy', 'robocopy', 'tar', 'zip', 'unzip',
  'compress-archive', 'expand-archive');
v('delete', 'shredder', 'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item');
v('check the machine', 'serverRack', 'tasklist', 'get-process', 'ps', 'top', 'get-ciminstance', 'get-wmiobject',
  'wmic', 'get-counter', 'typeperf', 'nvidia-smi', 'netstat', 'get-nettcpconnection', 'systeminfo', 'df', 'du',
  'get-psdrive', 'get-volume', 'ipconfig', 'ping', 'test-netconnection');
const SH_DIFF = new Set(['diff', 'fc', 'comp', 'cmp', 'compare-object']);

const READ = V.get('cat'), WRITE = t('write a file', 'pcDesk'), RUN = t('run a program', 'benchTerminal');
const FETCH = t('read an outside document', 'bookshelf'), SEND = t('send outside', 'postShelf');
const CMP = t('compare versions', 'lectern');
const HIST_READ = t('read history', 'historyShelf'), HIST_SEARCH = t('search history', 'historyShelf');

const GIT = new Map();
for (const s of ['log', 'show', 'status', 'blame', 'reflog', 'describe', 'branch', 'rev-parse', 'ls-files', 'ls-tree',
  'cat-file', 'shortlog', 'remote']) GIT.set(s, HIST_READ);
GIT.set('grep', HIST_SEARCH);
for (const s of ['add', 'commit', 'tag', 'stash', 'restore', 'checkout', 'switch', 'merge', 'rebase', 'reset',
  'cherry-pick', 'revert', 'mv', 'worktree']) GIT.set(s, t('write history', 'historyShelf'));
for (const s of ['diff', 'difftool']) GIT.set(s, CMP);
GIT.set('push', SEND);
for (const s of ['pull', 'fetch', 'clone']) GIT.set(s, t('receive from outside', 'postShelf'));
for (const s of ['rm', 'clean']) GIT.set(s, t('delete', 'shredder'));
const GIT_OPT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree']);

// ---- P2: git relabels (classify_final.py)
function applyGitRelabels(git) {
  for (const s of ['checkout', 'restore', 'reset', 'switch']) git.set(s, t('restore files', 'pcDesk'));
  git.set('stash', t('set aside (stash)', 'historyShelf'));
  for (const s of ['status', 'branch', 'remote', 'rev-parse']) git.set(s, t('glance at history', 'historyShelf'));
}
applyGitRelabels(GIT);   // [mutation-target:git-relabel]

const GH_READ = new Set(['view', 'list', 'status', 'diff', 'checks']);
const GH_SEND = new Set(['create', 'merge', 'comment', 'edit', 'close', 'review']);
const SHELLS = new Set(['powershell', 'pwsh', 'bash', 'sh', 'cmd']);

// STEP-3 FINAL TOOL MAP: 'check the machine' is done at the bench terminal (step 2 sent it to the server rack).
export const MACHINE_CHECK_KIND = 'benchTerminal';
export const LIBRARY_KINDS = new Set(['bookshelf', 'readingLedge', 'cardCatalog', 'manualsShelf', 'readingTable']);

// ---- P1: precedence, highest first (plan 4.3)
export const PRECEDENCE = Object.freeze(['printer', 'frontDesk', 'meetingTable',
  'benchTerminal',
  'pcDesk',
  'postShelf', 'shredder', 'copier',
  'bookshelf', 'cardCatalog',
  'pigeonholes', 'kanbanBoard', 'manualsShelf', 'inOutBoard',
  'lectern',
  'historyShelf',
  'fileCabinet']);
const RANK = new Map(PRECEDENCE.map((k, i) => [k, i]));
export function rank(kind) { return RANK.has(kind) ? RANK.get(kind) : PRECEDENCE.length + (pyTruthy(kind) ? 0 : 1); }

// ---------------------------------------------------------------------------------------------- regexes
const RE_SEGMENT_SPLIT = /&&|\|\||;|\n|\|/;
const RE_TOKEN = new RegExp(`(?:[^${PY_WS}"']+|"[^"]*"|'[^']*')+`, 'gu');
const RE_PY3 = /^python3(\.\p{Nd}+)?$/u;
const RE_DUP_REDIRECT = /\p{Nd}?>&\p{Nd}/gu;                                   // 2>&1, >&2: not file writes
const RE_FD_REDIRECT = new RegExp(`\\p{Nd}>>?[${PY_WS}]*[^${PY_WS}]+`, 'gu');  // 2>/dev/null, 2>>err.log
const RE_LITERAL = /^(["'][^\n]*|[0-9.-]+|@\(|@\{|\$true|\$false|\$null|[A-Za-z]:[\\/][^\n]*|\/[^\n]*)$/;
const RE_WORD = /[A-Za-z][A-Za-z0-9_.-]*/g;
const RE_FUNC_HEADER = /^[A-Za-z_][\p{L}\p{N}_-]*\(\)$/u;
const RE_ASSIGN = /^\$?[A-Za-z_][A-Za-z0-9_:.]*\+?=([^\n]*)$/;
const RE_PS_VAR = /^\$[A-Za-z_][A-Za-z0-9_:.]*$/;
const RE_SLASH = /[\\/]/;
const RE_GH_METHOD = new RegExp(`(-x|--method)[${PY_WS}]+(post|patch|put|delete)`, 'iu');
const RE_GH_FIELD = new RegExp(`(^|[${PY_WS}])(-f|-F|--field|--raw-field)[${PY_WS}]`, 'u');
const RE_HEREDOC = new RegExp(`<<-?~?[${PY_WS}]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\\1`, 'gu');
const RE_HERESTRING_OPEN = new RegExp(`@(['"])[${PY_WS}]*$`, 'u');
const RE_AGENT_BG_TEXT = /launched|[i\u0131\u0130]n background/iu;            // Python: (?i)launched|in background

// ---------------------------------------------------------------------------------------------- step-3 shell rule
function norm(w) {
  w = stripSet(w, '"\'`(),;').replaceAll('\\', '/');
  w = w.split('/').at(-1).toLowerCase();
  for (const ext of ['.exe', '.cmd', '.bat']) if (w.endsWith(ext)) w = w.slice(0, -ext.length);
  if (RE_PY3.test(w)) w = 'python';
  return w;
}
export function segments(cmd) {
  return pyOr(cmd, '').split(RE_SEGMENT_SPLIT).map(pyStrip).filter((s) => s);
}
export function tokens(seg) { return seg.match(RE_TOKEN) || []; }
function writeRedirect(seg) {
  const s = seg.replace(RE_DUP_REDIRECT, ' ').replace(RE_FD_REDIRECT, ' ');
  return />{1,2}/.test(s);
}
function inner(args) {                         // R2: the command after -Command / -c
  for (let k = 0; k < args.length; k++) {
    const a = args[k].toLowerCase();
    if (a === '-command' || a === '-c') {
      const rest = args.slice(k + 1);
      if (!rest.length) return null;
      const first = rest[0];
      if ('"\''.includes(first.slice(0, 1)) && first.slice(-1) === first.slice(0, 1) && first.length > 1) return first.slice(1, -1);
      return stripSet(rest.join(' '), '"\'');
    }
  }
  return null;
}
function isLiteral(tok) {
  const s = pyStrip(tok);
  return RE_LITERAL.test(s) && !s.startsWith('$(');
}
function firstKnownVerb(seg) {                 // R5: first known verb anywhere in a PowerShell expression
  for (const m of seg.matchAll(RE_WORD)) {
    const w = norm(m[0]);
    if (V.has(w) || SH_DIFF.has(w)) return V.get(w) || CMP;
  }
  return null;
}
function segment(seg, depth) {                 // -> (activity, kind) | NEXT
  const toks = tokens(seg);
  if (!toks.length) return NEXT;
  const head = toks[0], h0 = head.slice(0, 1);
  if ('"\'[@'.includes(h0) || head.startsWith('$(') || ['try', 'try{'].includes(head.toLowerCase())
      || (head.startsWith('(') && head.length > 1)) {
    if ('"\''.includes(h0) && toks.length === 1 && RE_SLASH.test(head)) return RUN;          // R7 quoted path alone
    if ('"\''.includes(h0) && RE_SLASH.test(head) && !firstKnownVerb(seg)) return RUN;       // R7 "C:/x/run.sh" > log
    return firstKnownVerb(seg) || NEXT;
  }
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i];
    if (RE_FUNC_HEADER.test(tok)) { i += 1; continue; }                                      // R5 q()
    const m = RE_ASSIGN.exec(tok);                                                            // X=... / $x=...
    if (m) {
      const val = m[1];
      if (val.startsWith('$(') || val.startsWith('(')) {                                     // R5 X=$(cmd ...)
        return segment([lstripSet(lstripSet(val, '$('), '(')].concat(toks.slice(i + 1)).join(' '), depth);
      }
      i += 1; continue;
    }
    if (RE_PS_VAR.test(tok) && i + 1 < toks.length && (toks[i + 1] === '=' || toks[i + 1] === '+=')) {
      const rest = toks.slice(i + 2);                                                         // $x = <value>
      if (!rest.length || isLiteral(rest[0])) return NEXT;                                    // R5 pure assignment
      return segment(rest.join(' '), depth);
    }
    if (WRAP.has(tok.toLowerCase())) { i += 1; continue; }                                    // R1 keyword / wrapper
    break;
  }
  if (i >= toks.length) return NEXT;
  const w = norm(toks[i]), args = toks.slice(i + 1);
  if (!w) return NEXT;
  if (LABEL_ONLY.has(w) || w === 'cat') {
    if (writeRedirect(seg)) return WRITE;
    if (LABEL_ONLY.has(w)) return NEXT;                                                       // R1 label line
    return READ;
  }
  if (CD_LIKE.has(w) || PREAMBLE.has(w)) return NEXT;                                         // R1
  if (w === 'sed') return args.slice(0, 3).some((a) => a.startsWith('-i') || a === '--in-place') ? WRITE : READ;
  if (w === 'git') {
    let j = 0;
    while (j < args.length && (args[j].startsWith('-') || (j > 0 && GIT_OPT_ARG.has(args[j - 1])))) j += 1;
    const sub = j < args.length ? args[j].toLowerCase() : '';
    if (sub === 'log' && args.slice(j + 1).some((a) => a.startsWith('-S') || a.startsWith('-G'))) return HIST_SEARCH;
    if (sub === 'stash' && j + 1 < args.length && args[j + 1].toLowerCase() === 'list') return HIST_READ;
    return GIT.get(sub) || NO_MOVE;
  }
  if (w === 'gh') {
    const words = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
    if (!words.length) return NO_MOVE;
    if (words[0] === 'api') {
      const joined = args.join(' ');
      return (RE_GH_METHOD.test(joined) || RE_GH_FIELD.test(joined)) ? NO_MOVE : FETCH;
    }
    if (words[0] === 'search') return FETCH;
    if (words[0] === 'release') return SEND;
    const act = words.length > 1 ? words[1] : '';
    if (GH_READ.has(act)) return FETCH;
    if (GH_SEND.has(act)) return SEND;
    return NO_MOVE;
  }
  if (w === 'npm' && args.length && args[0].toLowerCase() === 'publish') return SEND;        // R4
  if (SHELLS.has(w)) {                                                                        // R2
    if (w === 'cmd' && args.some((a) => a.toLowerCase() === '/c')) return RUN;
    if (args.some((a) => a.toLowerCase() === '-file')
        || args.some((a) => { const s = stripSet(a.toLowerCase(), '"\''); return s.endsWith('.ps1') || s.endsWith('.sh'); })) return RUN;
    const inn = inner(args);
    if (inn && depth < 2) return shellRaw(inn, depth + 1);
    return NO_MOVE;
  }
  if (w.endsWith('.ps1') || w.endsWith('.sh')) return RUN;                                     // R7
  if (SH_DIFF.has(w)) return CMP;
  if (V.has(w)) return V.get(w);
  if (RE_SLASH.test(toks[i])) return RUN;                                                     // R7 ./tool, C:/x/y
  return NO_MOVE;                                                                             // unclassified
}

/** The step-3 rule: the first segment that classifies wins. Kept ONLY for the mutation check (as in the reference). */
export function classifyShellFirstSegment(cmd, depth = 0) {
  for (const seg of segments(cmd)) {
    const r = segment(seg, depth);
    if (r !== NEXT) return r;
  }
  return NO_MOVE;
}

// ---------------------------------------------------------------------------------------------- P1: steps + precedence
/** Remove bash heredoc bodies (<<EOF ... EOF, <<-'X' ...) and PowerShell here-string bodies (@' ... '@). */
export function stripHeredocs(cmd) {
  const lines = pyOr(cmd, '').split('\n'), out = [], pending = [];
  for (const ln of lines) {
    if (pending.length) {
      const term = pending[0];
      if (term === "'@" || term === '"@') {
        const ls = pyLstrip(ln);
        if (ls.startsWith(term)) {
          pending.shift();
          const rest = ls.slice(2);
          if (out.length) out[out.length - 1] = out[out.length - 1] + ' ' + rest;
          else out.push(rest);
        }
        continue;
      }
      if (pyStrip(ln) === term) pending.shift();
      continue;
    }
    out.push(ln);
    for (const m of ln.matchAll(RE_HEREDOC)) pending.push(m[2]);
    const m2 = RE_HERESTRING_OPEN.exec(ln);
    if (m2) pending.push(m2[1] + '@');
  }
  return out.join('\n');
}

/** Top-level STEPS (split on && || ; newline outside quotes), each a list of pipeline STAGES (split on a single |
 *  outside quotes). Heredoc / here-string bodies are removed first. Unbalanced quotes -> the step-3 regex split,
 *  one stage per step. */
export function steps(cmd) {
  const text = stripHeredocs(cmd);   // [mutation-target:heredoc]
  const out = [], stages = [];
  let stage = [], q = null, i = 0;
  const endStage = () => { stages.push(pyStrip(stage.join(''))); stage = []; };
  const endStep = () => {
    endStage();
    const st = stages.filter((x) => x);
    if (st.length) out.push(st);
    stages.length = 0;
  };
  while (i < text.length) {
    const c = text[i];
    if (q) {
      stage.push(c);
      if (c === '\\' && q === '"' && i + 1 < text.length) { stage.push(text[i + 1]); i += 2; continue; }
      if (c === q) q = null;
      i += 1; continue;
    }
    if (c === '"' || c === "'") { q = c; stage.push(c); i += 1; continue; }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') { endStep(); i += 2; continue; }
    if (c === ';' || c === '\n') { endStep(); i += 1; continue; }
    if (c === '|') { endStage(); i += 1; continue; }   // [mutation-target:pipe]
    stage.push(c); i += 1;
  }
  if (q !== null) return segments(text).map((x) => [x]);
  endStep();
  return out;
}

function classifyShellPrec(cmd, depth = 0) {
  let best = null;
  for (const stg of steps(cmd)) {
    let r = NEXT;
    for (const seg of stg) {                 // a pipeline is its first stage that classifies (the producer)
      r = segment(seg, depth);
      if (r !== NEXT) break;
    }
    if (r === NEXT) continue;
    let [act, kind] = r;
    if (act === 'check the machine') kind = MACHINE_CHECK_KIND;
    if (best === null || rank(kind) < rank(best[1])) best = t(act, kind);
  }
  return best || NO_MOVE;
}

// The shell rule in force everywhere, including the R2 recursion (-Command / -c), as in the reference's monkeypatch.
function shellRaw(cmd, depth) {
  return classifyShellPrec(cmd, depth);   // [mutation-target:shell-raw]
}

// ---------------------------------------------------------------------------------------------- public API (reference)
/** Bash / PowerShell command -> [activity, kind]; kind null = no move. (classify_final.classify_shell) */
export function classifyShell(cmd) {
  const r = shellRaw(cmd, 0);
  return r[0] === 'check the machine' ? t(r[0], MACHINE_CHECK_KIND) : r;
}

/** One tool call -> [activity, kind]; kind null = no move (stay at the current station). (classify_s3.classify)
 *  curKind = the worker's current station kind (only ToolSearch depends on it). agentResult = the Agent tool's
 *  result text (only the transcript measurement has it). */
export function classify(name, inp, curKind = null, agentResult = '') {
  inp = pyOr(inp, {});
  if (name === 'Bash' || name === 'PowerShell') return classifyShell(pyStr(pyOr(pyGet(inp, 'command'), ''), 'command'));
  if (name === 'Read' || name === 'NotebookRead') return READ;
  if (name === 'Grep') return V.get('grep');
  if (name === 'Glob' || name === 'LSP') return V.get('ls');
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return WRITE;
  if (name === 'WebSearch') return SEARCH_WEB;
  if (name === 'WebFetch' || name === 'ListMcpResourcesTool' || name === 'ReadMcpResourceTool') return FETCH;
  if (name === 'Skill') return PROCEDURE;
  if (name === 'ToolSearch') return LIBRARY_KINDS.has(curKind) ? TOOL_LOOKUP : NO_MOVE;
  if (TASK_TOOLS.has(name)) return TASKS;
  if (name === 'SendMessage' || name === 'PushNotification' || name === 'SendUserFile') return MAIL_SEND;
  if (name === 'Monitor') return t('watch a background job', 'benchTerminal');
  if (name === 'TaskStop') return V.get('kill');
  if (name === 'ListAgents') return t('roster look', 'inOutBoard');
  if (name === 'SubagentHandback') return t('final report', 'printer');
  if (name === 'StructuredOutput') return t('result form', 'frontDesk');
  if (name === 'AskUserQuestion') return t('ask the owner', 'frontDesk');
  if (name === 'Artifact') return SEND;
  if (name === 'Agent') {
    // Background launch: the hook sees PostToolUse status async_launched; in transcripts the input carries
    // run_in_background (bool or the string 'true') and the result text says "launched" / "in background".
    const rib = pyGet(inp, 'run_in_background');
    const bg = rib === true || (typeof rib === 'string' && rib.toLowerCase() === 'true') || agentResultSaysBackground(agentResult);
    return bg ? HELPER_BG : HELPER_FG;
  }
  if (pyTruthy(name) && name.startsWith('mcp__')) {
    const parts = name.split('__');
    const srv = parts[1].toLowerCase(), tool = parts.at(-1).toLowerCase();
    if (['chrome', 'playwright', 'ide'].some((s) => srv.includes(s))) return RUN;
    if (['blender', 'figma', 'roblox'].some((s) => srv.includes(s))) return WRITE;
    if (srv.includes('context7')) return FETCH;
    if (srv.includes('calendar')) return TASKS;
    if (['notion', 'drive'].some((s) => srv.includes(s))) {
      const w = ['create', 'update', 'move', 'duplicate', 'trash', 'share', 'copy', 'upload'].some((k) => tool.includes(k));
      return w ? WRITE : READ;
    }
    if (['gmail', 'slack', 'telegram'].some((s) => srv.includes(s))) {
      const s_ = ['send', 'reply', 'forward', 'draft', 'post'].some((k) => tool.includes(k));
      return s_ ? MAIL_SEND : t('collect mail', 'pigeonholes');
    }
    return NO_MOVE;
  }
  return NO_MOVE;
}
const SEARCH_WEB = t('search the web', 'cardCatalog'), PROCEDURE = t('follow a procedure', 'manualsShelf');
const TOOL_LOOKUP = t('look up a tool', 'manualsShelf'), TASKS = t('plan / track tasks', 'kanbanBoard');
const MAIL_SEND = t('send internal mail', 'pigeonholes');
const HELPER_BG = t('launch own background helper', 'frontDesk'), HELPER_FG = t('call own foreground helper', 'meetingTable');
const TASK_TOOLS = new Set(['TaskCreate', 'TodoWrite', 'CronCreate', 'TaskUpdate', 'CronDelete', 'TaskList', 'TaskGet',
  'CronList', 'Workflow']);
function agentResultSaysBackground(agentResult) {
  const res = pyStr(pyOr(agentResult, ''), 'agentResult');
  return res.includes('async_launched') || RE_AGENT_BG_TEXT.test(res);
}

/** HOOK-TIME rule for an Agent call (PreToolUse, no result yet). As of Claude Code v2.1.198 subagents run in the
 *  background by default (hooks.md:1758), so only an EXPLICIT false is a foreground call (meeting table); true or
 *  omitted = a background launch (front-desk ticket). (classify_final.classify_agent_pre) */
export function classifyAgentPre(inp) {
  const rib = pyGet(pyOr(inp, {}), 'run_in_background');
  const explicitFalse = rib === false || (typeof rib === 'string' && rib.toLowerCase() === 'false');   // [mutation-target:agent-pre]
  return explicitFalse ? HELPER_FG : HELPER_BG;
}

function pickByPrecedence(results) {
  let best = null;
  for (const r of results) {
    if (best === null || rank(r[1]) < rank(best[1])) best = r;   // [mutation-target:batch]
  }
  return best || NO_MOVE;
}

/** calls: [[toolName, toolInput, toolUseId], ...] of ONE assistant message -> [activity, kind] by PRECEDENCE; the
 *  first of equals wins. results: {toolUseId: resultText} (optional). (classify_final.classify_batch) */
export function classifyBatch(calls, curKind = null, results = null) {
  const res = pyOr(results, {});
  return pickByPrecedence(calls.map(([name, inp, tid]) => {
    const r = isDict(res) && typeof tid === 'string' && Object.hasOwn(res, tid) ? res[tid] : '';
    return classify(name, inp, curKind, r);
  }));
}

// ---------------------------------------------------------------------------------------------- hook-time API
// What the hook can know when it fires. It does not know the worker's current station, so:
//  - ToolSearch is reported as ['look up a tool', null]: no move, but the activity tells the observer to apply the
//    library rule itself: classify('ToolSearch', null, station).
//  - Agent uses the hook-time rule (classifyAgentPre), unless the call has resolved and its real status is known
//    (PostToolUse / PostToolBatch carry tool_response.status): 'async_launched' = background, 'completed' = foreground.
export const TOOL_LOOKUP_DEFERRED = t('look up a tool', null);
export function classifyCallAtHook(name, inp, agentStatus = null) {
  if (name === 'Agent') {
    if (agentStatus === 'async_launched') return HELPER_BG;
    if (agentStatus === 'completed') return HELPER_FG;
    return classifyAgentPre(inp);
  }
  if (name === 'ToolSearch') return TOOL_LOOKUP_DEFERRED;
  return classify(name, inp, null, '');
}
/** calls: [[toolName, toolInput, agentStatus|null], ...] of one PostToolBatch -> [activity, kind], same precedence. */
export function classifyBatchAtHook(calls) {
  return pickByPrecedence(calls.map(([name, inp, status]) => classifyCallAtHook(name, inp, status)));
}

// ---------------------------------------------------------------------------------------------- activity ids
// The spool carries a short activity id, never text built from tool input. One id per activity the classifier can
// return (a closed set; scripts/classify-test.mjs checks that every activity seen has an id and the map is 1:1).
const ACTIVITY_IDS = [
  ['no move', 'none'], ['read a file', 'read'], ['search contents', 'search'], ['list names', 'list'],
  ['refile / new folder', 'refile'], ['write a file', 'write'], ['run a program', 'run'], ['wait on a run', 'wait'],
  ['stop a job', 'stop'], ['read an outside document', 'fetch'], ['send outside', 'send'],
  ['receive from outside', 'receive'], ['copy / pack', 'copy'], ['delete', 'delete'], ['check the machine', 'check'],
  ['compare versions', 'diff'], ['read history', 'hist-read'], ['search history', 'hist-search'],
  ['write history', 'hist-write'], ['restore files', 'restore'], ['set aside (stash)', 'stash'],
  ['glance at history', 'glance'], ['search the web', 'websearch'], ['follow a procedure', 'procedure'],
  ['look up a tool', 'toolsearch'], ['plan / track tasks', 'tasks'], ['send internal mail', 'mail-send'],
  ['collect mail', 'mail-collect'], ['watch a background job', 'watch'], ['roster look', 'roster'],
  ['final report', 'report'], ['result form', 'form'], ['ask the owner', 'ask'],
  ['launch own background helper', 'helper-bg'], ['call own foreground helper', 'helper-fg'],
];
export const ACTIVITY_ID = new Map(ACTIVITY_IDS);
export const ACTIVITY_BY_ID = new Map(ACTIVITY_IDS.map(([a, id]) => [id, a]));
export const KINDS = new Set(PRECEDENCE);
