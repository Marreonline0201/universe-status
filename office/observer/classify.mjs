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
//   P4  bounded segment nesting: at most MAX_SEGMENT_NEST segment() calls open at once (R5 assignment levels and R2
//       shell levels alike); a segment that would open one more is unclassified (no move). Without it the R5 rule
//       re-tokenised the rest of the segment once per level with no limit: a 10 KB `$a = $a = ...` chain cost the
//       hook 258 MB, and Python stopped only at RecursionError. Real commands open at most 3 (17,497 commands).
// The reference's measurement toggles (CF_* environment variables) are deliberately NOT ported: the shipped
// classifier always has P1 and P2 on. scripts/classify-test.mjs plants the "off" variants as mutants instead.
//
// Python-compatibility (checked against the reference on office/observer/classify-cases.json):
//  - Python's str.strip()/lstrip() and re's \s use str.isspace(); JS's \s and trim() use a different set.
//    PY_WS below is Python's set exactly (29 code points, read from Python 3.13).
//  - Python re's \d and \w use PYTHON's Unicode tables (3.13.7: Unicode 15.1). JS's \p{Nd} / \p{L} follow the JS
//    engine's own Unicode version (Node 25: 16.0; Chrome: whatever it ships), so this file embeds Python's exact
//    tables (PY_D_RANGES, PY_W_RANGES; the fixture's "unicode" section, which scripts/classify-test.mjs compares
//    code point by code point) and never uses \d, \w or \p{...} for them.
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

// ---------------------------------------------------------------------------------------------- Python \d and \w
// Python 3.13.7's re \d and \w (Unicode 15.1) as inclusive hex code-point ranges, generated by running Python's re
// over every code point (scripts/gen-classify-cases.py, fixture section "unicode"). Do not edit by hand.
const PY_D_RANGES =
  '30-39,660-669,6f0-6f9,7c0-7c9,966-96f,9e6-9ef,a66-a6f,ae6-aef,b66-b6f,be6-bef,c66-c6f,ce6-cef,d66-d6f,de6-def,' +
  'e50-e59,ed0-ed9,f20-f29,1040-1049,1090-1099,17e0-17e9,1810-1819,1946-194f,19d0-19d9,1a80-1a89,1a90-1a99,' +
  '1b50-1b59,1bb0-1bb9,1c40-1c49,1c50-1c59,a620-a629,a8d0-a8d9,a900-a909,a9d0-a9d9,a9f0-a9f9,aa50-aa59,abf0-abf9,' +
  'ff10-ff19,104a0-104a9,10d30-10d39,11066-1106f,110f0-110f9,11136-1113f,111d0-111d9,112f0-112f9,11450-11459,' +
  '114d0-114d9,11650-11659,116c0-116c9,11730-11739,118e0-118e9,11950-11959,11c50-11c59,11d50-11d59,11da0-11da9,' +
  '11f50-11f59,16a60-16a69,16ac0-16ac9,16b50-16b59,1d7ce-1d7ff,1e140-1e149,1e2f0-1e2f9,1e4f0-1e4f9,1e950-1e959,' +
  '1fbf0-1fbf9';
const PY_W_RANGES =
  '30-39,41-5a,5f,61-7a,aa,b2-b3,b5,b9-ba,bc-be,c0-d6,d8-f6,f8-2c1,2c6-2d1,2e0-2e4,2ec,2ee,370-374,376-377,' +
  '37a-37d,37f,386,388-38a,38c,38e-3a1,3a3-3f5,3f7-481,48a-52f,531-556,559,560-588,5d0-5ea,5ef-5f2,620-64a,' +
  '660-669,66e-66f,671-6d3,6d5,6e5-6e6,6ee-6fc,6ff,710,712-72f,74d-7a5,7b1,7c0-7ea,7f4-7f5,7fa,800-815,81a,824,' +
  '828,840-858,860-86a,870-887,889-88e,8a0-8c9,904-939,93d,950,958-961,966-96f,971-980,985-98c,98f-990,993-9a8,' +
  '9aa-9b0,9b2,9b6-9b9,9bd,9ce,9dc-9dd,9df-9e1,9e6-9f1,9f4-9f9,9fc,a05-a0a,a0f-a10,a13-a28,a2a-a30,a32-a33,' +
  'a35-a36,a38-a39,a59-a5c,a5e,a66-a6f,a72-a74,a85-a8d,a8f-a91,a93-aa8,aaa-ab0,ab2-ab3,ab5-ab9,abd,ad0,ae0-ae1,' +
  'ae6-aef,af9,b05-b0c,b0f-b10,b13-b28,b2a-b30,b32-b33,b35-b39,b3d,b5c-b5d,b5f-b61,b66-b6f,b71-b77,b83,b85-b8a,' +
  'b8e-b90,b92-b95,b99-b9a,b9c,b9e-b9f,ba3-ba4,ba8-baa,bae-bb9,bd0,be6-bf2,c05-c0c,c0e-c10,c12-c28,c2a-c39,c3d,' +
  'c58-c5a,c5d,c60-c61,c66-c6f,c78-c7e,c80,c85-c8c,c8e-c90,c92-ca8,caa-cb3,cb5-cb9,cbd,cdd-cde,ce0-ce1,ce6-cef,' +
  'cf1-cf2,d04-d0c,d0e-d10,d12-d3a,d3d,d4e,d54-d56,d58-d61,d66-d78,d7a-d7f,d85-d96,d9a-db1,db3-dbb,dbd,dc0-dc6,' +
  'de6-def,e01-e30,e32-e33,e40-e46,e50-e59,e81-e82,e84,e86-e8a,e8c-ea3,ea5,ea7-eb0,eb2-eb3,ebd,ec0-ec4,ec6,' +
  'ed0-ed9,edc-edf,f00,f20-f33,f40-f47,f49-f6c,f88-f8c,1000-102a,103f-1049,1050-1055,105a-105d,1061,1065-1066,' +
  '106e-1070,1075-1081,108e,1090-1099,10a0-10c5,10c7,10cd,10d0-10fa,10fc-1248,124a-124d,1250-1256,1258,125a-125d,' +
  '1260-1288,128a-128d,1290-12b0,12b2-12b5,12b8-12be,12c0,12c2-12c5,12c8-12d6,12d8-1310,1312-1315,1318-135a,' +
  '1369-137c,1380-138f,13a0-13f5,13f8-13fd,1401-166c,166f-167f,1681-169a,16a0-16ea,16ee-16f8,1700-1711,171f-1731,' +
  '1740-1751,1760-176c,176e-1770,1780-17b3,17d7,17dc,17e0-17e9,17f0-17f9,1810-1819,1820-1878,1880-1884,1887-18a8,' +
  '18aa,18b0-18f5,1900-191e,1946-196d,1970-1974,1980-19ab,19b0-19c9,19d0-19da,1a00-1a16,1a20-1a54,1a80-1a89,' +
  '1a90-1a99,1aa7,1b05-1b33,1b45-1b4c,1b50-1b59,1b83-1ba0,1bae-1be5,1c00-1c23,1c40-1c49,1c4d-1c7d,1c80-1c88,' +
  '1c90-1cba,1cbd-1cbf,1ce9-1cec,1cee-1cf3,1cf5-1cf6,1cfa,1d00-1dbf,1e00-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,' +
  '1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-1fbc,1fbe,1fc2-1fc4,1fc6-1fcc,1fd0-1fd3,1fd6-1fdb,1fe0-1fec,' +
  '1ff2-1ff4,1ff6-1ffc,2070-2071,2074-2079,207f-2089,2090-209c,2102,2107,210a-2113,2115,2119-211d,2124,2126,2128,' +
  '212a-212d,212f-2139,213c-213f,2145-2149,214e,2150-2189,2460-249b,24ea-24ff,2776-2793,2c00-2ce4,2ceb-2cee,' +
  '2cf2-2cf3,2cfd,2d00-2d25,2d27,2d2d,2d30-2d67,2d6f,2d80-2d96,2da0-2da6,2da8-2dae,2db0-2db6,2db8-2dbe,2dc0-2dc6,' +
  '2dc8-2dce,2dd0-2dd6,2dd8-2dde,2e2f,3005-3007,3021-3029,3031-3035,3038-303c,3041-3096,309d-309f,30a1-30fa,' +
  '30fc-30ff,3105-312f,3131-318e,3192-3195,31a0-31bf,31f0-31ff,3220-3229,3248-324f,3251-325f,3280-3289,32b1-32bf,' +
  '3400-4dbf,4e00-a48c,a4d0-a4fd,a500-a60c,a610-a62b,a640-a66e,a67f-a69d,a6a0-a6ef,a717-a71f,a722-a788,a78b-a7ca,' +
  'a7d0-a7d1,a7d3,a7d5-a7d9,a7f2-a801,a803-a805,a807-a80a,a80c-a822,a830-a835,a840-a873,a882-a8b3,a8d0-a8d9,' +
  'a8f2-a8f7,a8fb,a8fd-a8fe,a900-a925,a930-a946,a960-a97c,a984-a9b2,a9cf-a9d9,a9e0-a9e4,a9e6-a9fe,aa00-aa28,' +
  'aa40-aa42,aa44-aa4b,aa50-aa59,aa60-aa76,aa7a,aa7e-aaaf,aab1,aab5-aab6,aab9-aabd,aac0,aac2,aadb-aadd,aae0-aaea,' +
  'aaf2-aaf4,ab01-ab06,ab09-ab0e,ab11-ab16,ab20-ab26,ab28-ab2e,ab30-ab5a,ab5c-ab69,ab70-abe2,abf0-abf9,ac00-d7a3,' +
  'd7b0-d7c6,d7cb-d7fb,f900-fa6d,fa70-fad9,fb00-fb06,fb13-fb17,fb1d,fb1f-fb28,fb2a-fb36,fb38-fb3c,fb3e,fb40-fb41,' +
  'fb43-fb44,fb46-fbb1,fbd3-fd3d,fd50-fd8f,fd92-fdc7,fdf0-fdfb,fe70-fe74,fe76-fefc,ff10-ff19,ff21-ff3a,ff41-ff5a,' +
  'ff66-ffbe,ffc2-ffc7,ffca-ffcf,ffd2-ffd7,ffda-ffdc,10000-1000b,1000d-10026,10028-1003a,1003c-1003d,1003f-1004d,' +
  '10050-1005d,10080-100fa,10107-10133,10140-10178,1018a-1018b,10280-1029c,102a0-102d0,102e1-102fb,10300-10323,' +
  '1032d-1034a,10350-10375,10380-1039d,103a0-103c3,103c8-103cf,103d1-103d5,10400-1049d,104a0-104a9,104b0-104d3,' +
  '104d8-104fb,10500-10527,10530-10563,10570-1057a,1057c-1058a,1058c-10592,10594-10595,10597-105a1,105a3-105b1,' +
  '105b3-105b9,105bb-105bc,10600-10736,10740-10755,10760-10767,10780-10785,10787-107b0,107b2-107ba,10800-10805,' +
  '10808,1080a-10835,10837-10838,1083c,1083f-10855,10858-10876,10879-1089e,108a7-108af,108e0-108f2,108f4-108f5,' +
  '108fb-1091b,10920-10939,10980-109b7,109bc-109cf,109d2-10a00,10a10-10a13,10a15-10a17,10a19-10a35,10a40-10a48,' +
  '10a60-10a7e,10a80-10a9f,10ac0-10ac7,10ac9-10ae4,10aeb-10aef,10b00-10b35,10b40-10b55,10b58-10b72,10b78-10b91,' +
  '10ba9-10baf,10c00-10c48,10c80-10cb2,10cc0-10cf2,10cfa-10d23,10d30-10d39,10e60-10e7e,10e80-10ea9,10eb0-10eb1,' +
  '10f00-10f27,10f30-10f45,10f51-10f54,10f70-10f81,10fb0-10fcb,10fe0-10ff6,11003-11037,11052-1106f,11071-11072,' +
  '11075,11083-110af,110d0-110e8,110f0-110f9,11103-11126,11136-1113f,11144,11147,11150-11172,11176,11183-111b2,' +
  '111c1-111c4,111d0-111da,111dc,111e1-111f4,11200-11211,11213-1122b,1123f-11240,11280-11286,11288,1128a-1128d,' +
  '1128f-1129d,1129f-112a8,112b0-112de,112f0-112f9,11305-1130c,1130f-11310,11313-11328,1132a-11330,11332-11333,' +
  '11335-11339,1133d,11350,1135d-11361,11400-11434,11447-1144a,11450-11459,1145f-11461,11480-114af,114c4-114c5,' +
  '114c7,114d0-114d9,11580-115ae,115d8-115db,11600-1162f,11644,11650-11659,11680-116aa,116b8,116c0-116c9,' +
  '11700-1171a,11730-1173b,11740-11746,11800-1182b,118a0-118f2,118ff-11906,11909,1190c-11913,11915-11916,' +
  '11918-1192f,1193f,11941,11950-11959,119a0-119a7,119aa-119d0,119e1,119e3,11a00,11a0b-11a32,11a3a,11a50,' +
  '11a5c-11a89,11a9d,11ab0-11af8,11c00-11c08,11c0a-11c2e,11c40,11c50-11c6c,11c72-11c8f,11d00-11d06,11d08-11d09,' +
  '11d0b-11d30,11d46,11d50-11d59,11d60-11d65,11d67-11d68,11d6a-11d89,11d98,11da0-11da9,11ee0-11ef2,11f02,' +
  '11f04-11f10,11f12-11f33,11f50-11f59,11fb0,11fc0-11fd4,12000-12399,12400-1246e,12480-12543,12f90-12ff0,' +
  '13000-1342f,13441-13446,14400-14646,16800-16a38,16a40-16a5e,16a60-16a69,16a70-16abe,16ac0-16ac9,16ad0-16aed,' +
  '16b00-16b2f,16b40-16b43,16b50-16b59,16b5b-16b61,16b63-16b77,16b7d-16b8f,16e40-16e96,16f00-16f4a,16f50,' +
  '16f93-16f9f,16fe0-16fe1,16fe3,17000-187f7,18800-18cd5,18d00-18d08,1aff0-1aff3,1aff5-1affb,1affd-1affe,' +
  '1b000-1b122,1b132,1b150-1b152,1b155,1b164-1b167,1b170-1b2fb,1bc00-1bc6a,1bc70-1bc7c,1bc80-1bc88,1bc90-1bc99,' +
  '1d2c0-1d2d3,1d2e0-1d2f3,1d360-1d378,1d400-1d454,1d456-1d49c,1d49e-1d49f,1d4a2,1d4a5-1d4a6,1d4a9-1d4ac,' +
  '1d4ae-1d4b9,1d4bb,1d4bd-1d4c3,1d4c5-1d505,1d507-1d50a,1d50d-1d514,1d516-1d51c,1d51e-1d539,1d53b-1d53e,' +
  '1d540-1d544,1d546,1d54a-1d550,1d552-1d6a5,1d6a8-1d6c0,1d6c2-1d6da,1d6dc-1d6fa,1d6fc-1d714,1d716-1d734,' +
  '1d736-1d74e,1d750-1d76e,1d770-1d788,1d78a-1d7a8,1d7aa-1d7c2,1d7c4-1d7cb,1d7ce-1d7ff,1df00-1df1e,1df25-1df2a,' +
  '1e030-1e06d,1e100-1e12c,1e137-1e13d,1e140-1e149,1e14e,1e290-1e2ad,1e2c0-1e2eb,1e2f0-1e2f9,1e4d0-1e4eb,' +
  '1e4f0-1e4f9,1e7e0-1e7e6,1e7e8-1e7eb,1e7ed-1e7ee,1e7f0-1e7fe,1e800-1e8c4,1e8c7-1e8cf,1e900-1e943,1e94b,' +
  '1e950-1e959,1ec71-1ecab,1ecad-1ecaf,1ecb1-1ecb4,1ed01-1ed2d,1ed2f-1ed3d,1ee00-1ee03,1ee05-1ee1f,1ee21-1ee22,' +
  '1ee24,1ee27,1ee29-1ee32,1ee34-1ee37,1ee39,1ee3b,1ee42,1ee47,1ee49,1ee4b,1ee4d-1ee4f,1ee51-1ee52,1ee54,1ee57,' +
  '1ee59,1ee5b,1ee5d,1ee5f,1ee61-1ee62,1ee64,1ee67-1ee6a,1ee6c-1ee72,1ee74-1ee77,1ee79-1ee7c,1ee7e,1ee80-1ee89,' +
  '1ee8b-1ee9b,1eea1-1eea3,1eea5-1eea9,1eeab-1eebb,1f100-1f10c,1fbf0-1fbf9,20000-2a6df,2a700-2b739,2b740-2b81d,' +
  '2b820-2cea1,2ceb0-2ebe0,2ebf0-2ee5d,2f800-2fa1d,30000-3134a,31350-323af';
const classText = (ranges) => ranges.split(',').map((r) => {
  const [a, b] = r.split('-');
  return b === undefined ? `\\u{${a}}` : `\\u{${a}}-\\u{${b}}`;
}).join('');
const PY_D = classText(PY_D_RANGES);   // [mutation-target:py-digit]
const pyWordClass = () => classText(PY_W_RANGES);   // [mutation-target:py-word]
// Building the 749-range \w class at load cost every hook firing about 0.9 MB of working set (A/B against the
// previous hook: 43.7 vs 42.8 MB). Only a token ending in "()" can be a function header, so the \w class and its
// regexes are built on first use (A/B with this: 42.8 vs 42.8 MB).
let reFuncHeader = null, rePyD1 = null, rePyW1 = null;
function isFuncHeader(tok) {                   // Python: re.match(r'^[A-Za-z_][\w-]*\(\)$', tok)
  if (!tok.endsWith('()')) return false;
  reFuncHeader ??= new RegExp(`^[A-Za-z_][${pyWordClass()}\\-]*\\(\\)$`, 'u');
  return reFuncHeader.test(tok);
}
/** Python re's \d and \w on one code point (exported for the code-point-by-code-point parity test). */
export function isPyDigit(ch) { rePyD1 ??= new RegExp(`^[${PY_D}]$`, 'u'); return rePyD1.test(ch); }
export function isPyWord(ch) { rePyW1 ??= new RegExp(`^[${pyWordClass()}]$`, 'u'); return rePyW1.test(ch); }

// ---------------------------------------------------------------------------------------------- regexes
const RE_SEGMENT_SPLIT = /&&|\|\||;|\n|\|/;
const RE_TOKEN = new RegExp(`(?:[^${PY_WS}"']+|"[^"]*"|'[^']*')+`, 'gu');
const RE_PY3 = new RegExp(`^python3(\\.[${PY_D}]+)?$`, 'u');
const RE_DUP_REDIRECT = new RegExp(`[${PY_D}]?>&[${PY_D}]`, 'gu');                    // 2>&1, >&2: not file writes
const RE_FD_REDIRECT = new RegExp(`[${PY_D}]>>?[${PY_WS}]*[^${PY_WS}]+`, 'gu');       // 2>/dev/null, 2>>err.log
const RE_LITERAL = /^(["'][^\n]*|[0-9.-]+|@\(|@\{|\$true|\$false|\$null|[A-Za-z]:[\\/][^\n]*|\/[^\n]*)$/;
const RE_WORD = /[A-Za-z][A-Za-z0-9_.-]*/g;
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
// ---- P4: bounded segment nesting (classify_final.py P4, the same rule and limit). Every segment() call counts the
// segment() calls already open on the stack: the R5 assignment recursion and the R2 shell recursion both open one.
// When MAX_SEGMENT_NEST are open, the segment is unclassified (no move). Memory is then linear in the command.
export const MAX_SEGMENT_NEST = 8;
let openSegments = 0;
function segment(seg, depth) {                 // -> (activity, kind) | NEXT
  if (openSegments >= MAX_SEGMENT_NEST) return NO_MOVE;   // [mutation-target:nest-bound]
  openSegments += 1;
  try { return segmentBody(seg, depth); } finally { openSegments -= 1; }
}
function segmentBody(seg, depth) {
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
    if (isFuncHeader(tok)) { i += 1; continue; }                                              // R5 q()
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
//    library rule itself (resolveAtStation). A batch also carries tsr (batchAtHook): would a ToolSearch call win the
//    batch at a library station.
//  - Agent uses the hook-time rule (classifyAgentPre), unless the call has resolved and its real status is known.
//    Only PostToolUse(Agent) carries it: there tool_response is the structured AgentOutput, whose status is
//    'completed' (foreground), 'async_launched' (background) or 'remote_launched' (handed to a cloud session; the call
//    returns at once, like a background launch). PostToolBatch's tool_response is the tool_result text the model saw,
//    with no status field (hooks.md, PostToolBatch input), so the hook passes no status for a batch's calls.
export const TOOL_LOOKUP_DEFERRED = t('look up a tool', null);
export function classifyCallAtHook(name, inp, agentStatus = null) {
  if (name === 'Agent') {
    if (agentStatus === 'async_launched' || agentStatus === 'remote_launched') return HELPER_BG;
    if (agentStatus === 'completed') return HELPER_FG;
    return classifyAgentPre(inp);
  }
  if (name === 'ToolSearch') return TOOL_LOOKUP_DEFERRED;
  return classify(name, inp, null, '');
}
/** calls: [[toolName, toolInput, agentStatus|null], ...] of one PostToolBatch -> {result: [activity, kind] by
 *  precedence (first of equals wins), tsr: true when a ToolSearch call would win the batch at a LIBRARY station}.
 *  Each call is classified once. */
export function batchAtHook(calls) {
  const items = calls.map(([name, inp, status]) => classifyCallAtHook(name, inp, status));
  const atLibrary = items.map((r, i) => (calls[i][0] === 'ToolSearch' ? TOOL_LOOKUP : r));
  let w = -1;                                    // the winner at a library station (first of equals)
  atLibrary.forEach((r, i) => { if (w < 0 || rank(r[1]) < rank(atLibrary[w][1])) w = i; });
  return { result: pickByPrecedence(items), tsr: w >= 0 && calls[w][0] === 'ToolSearch' };
}
/** calls: as batchAtHook -> [activity, kind] (the batch's category without the tsr bit). */
export function classifyBatchAtHook(calls) { return batchAtHook(calls).result; }

/** OBSERVER side: a spool record's category at the worker's current station -> [activity, kind], equal to the
 *  reference classify / classify_batch with cur_kind = station (scripts/classify-test.mjs checks every fixture batch
 *  and every one-call batch at every station kind). activity = the activity text of the record's a; kind = its k or
 *  null; tsr = its tsr bit (Batch records only); station = the worker's current station kind or null. */
export function resolveAtStation(activity, kind, tsr, station) {
  const deferred = activity === TOOL_LOOKUP_DEFERRED[0] && kind === null;
  if (LIBRARY_KINDS.has(station) && (tsr === true || deferred)) return TOOL_LOOKUP;
  if (deferred) return NO_MOVE;
  return t(activity, kind);
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
