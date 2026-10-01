// Worker-office spool hook (worker-office plan section 5.2).
//
// Claude Code runs this as an async command hook on SubagentStart, SubagentStop, PreToolUse, PostToolBatch,
// PostToolUse (Agent|Workflow|SubagentHandback), PostToolUseFailure, Stop and SessionEnd. On every firing it:
//   1. exits at once when OFFICE_AGENT_ID is set (the old office fleet's own sessions; same guard as
//      session-office-up.ps1);
//   2. reads all of stdin;
//   3. parses it; on failure (empty, malformed, not an object, over 32 MB, stdin not closed within 5 s) it writes
//      {v,ts,ev:"parse_error"} and nothing else;
//   4. classifies the tool call with classify.mjs: only a category (object kind + activity id) leaves the process;
//   5. appends ONE allowlisted JSON line, in a single write, to <home>/spool/events-YYYY-MM-DD.jsonl
//      (YYYY-MM-DD = the local date of ts);
//   6. prints NOTHING to stdout or stderr and ALWAYS exits 0. An async hook's output would be handed to the model
//      on its next turn, so the observer must not speak.
//
// Record allowlist (v1): v ts sid ev aid at k a tu bg to st ch run intr n bt r. Never written: tool_input,
// tool_response, prompts, descriptions, last_assistant_message, error text, paths, commands, URLs, tool names,
// background_tasks description/command/name. Every written value is checked, not just its key:
//   k, a        closed sets from classify.mjs (KINDS, ACTIVITY_ID)
//   ev          a closed set of event names, else "other"
//   st, r, bt.type, bt.status   a short identifier token (letters, digits, _ -; max 32), else dropped
//   sid, aid, at, ch, run, bt.id    [A-Za-z0-9_.:-]{1,64}, else dropped (at may also be "" for internal agents)
//   tu          10 hex characters of sha256(tool_use_id)
//   ts          ms since the epoch at which this hook process started (performance.timeOrigin)
// aid and ch have any "agent-" prefix removed, so a child's ch joins its own aid. bt ids are kept raw (probe 5).
//
// <home> = UNIVERSE_OFFICE_HOME (absolute path; tests) or C:/Users/ddogr/.universe-office. The installed copy
// lives in <home>/bin/ next to classify.mjs (office/observer/install-hook.mjs puts both there).
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// ---- silence and exit 0, before anything else can go wrong
process.emitWarning = () => {};
const quit = () => process.exit(0);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);

const VERSION = 1;
const TS = Math.floor(Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now());
const DEFAULT_HOME = 'C:/Users/ddogr/.universe-office';
const MAX_STDIN = 32 * 1024 * 1024;
const STDIN_DEADLINE_MS = 5000;
const MAX_LINE = 4096;            // bytes incl. the newline; only bt can be trimmed to fit
const MAX_BT = 50;

if (process.env.OFFICE_AGENT_ID) quit();
const HOME = process.env.UNIVERSE_OFFICE_HOME || DEFAULT_HOME;

// Load the classifier while stdin is still arriving. A missing or broken classify.mjs only costs the k/a fields.
const classifierP = import(new URL('./classify.mjs', import.meta.url).href).catch(() => null);

// ---------------------------------------------------------------------------------------------- value checks
const RE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const RE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// The record's shape follows the event, so ev is a closed set: the plan's eight events, the optional extras of
// plan 5.5 (PermissionRequest, StopFailure) and a few well-known ones. Anything else is written as "other".
const EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'SessionEnd', 'PermissionRequest', 'StopFailure', 'SessionStart', 'UserPromptSubmit', 'Notification', 'PreCompact']);
const isDict = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (o, k) => (isDict(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const idField = (x) => (typeof x === 'string' && RE_ID.test(x) ? x : undefined);
const token = (x) => (typeof x === 'string' && RE_TOKEN.test(x) ? x : undefined);
const agentId = (x) => (typeof x === 'string' ? idField(x.startsWith('agent-') ? x.slice(6) : x) : undefined);
const agentType = (x) => (x === '' ? '' : idField(x));
const toolUseHash = (x) => (typeof x === 'string' && x.length > 0
  ? createHash('sha256').update(x, 'utf8').digest('hex').slice(0, 10) : undefined);
const isShell = (name) => name === 'Bash' || name === 'PowerShell';

/** tool_response as an object: PostToolUse sends one; PostToolBatch may send it serialized. Never written. */
function responseObject(resp) {
  if (isDict(resp)) return resp;
  if (typeof resp === 'string' && resp.length <= 1_000_000 && /^\s*\{/.test(resp)) {
    try { const o = JSON.parse(resp); return isDict(o) ? o : null; } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- record
function setCategory(rec, C, name, input, agentStatus) {
  if (!C) return;
  try {
    const [act, kind] = C.classifyCallAtHook(name, input, agentStatus);
    if (kind !== null && C.KINDS.has(kind)) rec.k = kind;
    const id = C.ACTIVITY_ID.get(act);
    if (id) rec.a = id;
  } catch { /* the reference raises here too (malformed tool_input): no category */ }
}

function setBatchCategory(rec, C, calls) {
  if (!C) return;
  try {
    const list = calls.map((c) => {
      if (!isDict(c)) throw new TypeError('tool call is not an object');
      const name = own(c, 'tool_name');
      const status = name === 'Agent' ? token(own(responseObject(own(c, 'tool_response')), 'status')) ?? null : null;
      return [name, own(c, 'tool_input'), status];
    });
    const [act, kind] = C.classifyBatchAtHook(list);
    if (kind !== null && C.KINDS.has(kind)) rec.k = kind;
    const id = C.ACTIVITY_ID.get(act);
    if (id) rec.a = id;
  } catch { /* the reference raises for a malformed call: no category */ }
}

function setToolUse(rec, ev) {
  const tu = toolUseHash(own(ev, 'tool_use_id'));
  if (tu !== undefined) rec.tu = tu;
}

function setBackgroundTasks(rec, tasks) {
  if (!Array.isArray(tasks)) return;                               // absent = task registry not reachable
  const out = [];
  for (const t of tasks) {
    if (out.length >= MAX_BT) break;
    if (!isDict(t)) continue;
    const e = {};
    const id = idField(own(t, 'id')), type = token(own(t, 'type')), status = token(own(t, 'status'));
    if (id !== undefined) e.id = id;
    if (type !== undefined) e.type = type;
    if (status !== undefined) e.status = status;
    if (id !== undefined || type !== undefined || status !== undefined) out.push(e);
  }
  rec.bt = out;                                                    // [] = registry reachable, no tasks
}

/** One spool record from one parsed hook payload. Key order = the allowlist order. */
function buildRecord(ev, C) {
  const rec = { v: VERSION, ts: TS };
  const sid = idField(own(ev, 'session_id'));
  if (sid !== undefined) rec.sid = sid;
  const name = own(ev, 'hook_event_name');
  const evName = typeof name === 'string' && EVENTS.has(name) ? name : 'other';
  rec.ev = evName;
  const aid = agentId(own(ev, 'agent_id'));
  if (aid !== undefined) rec.aid = aid;

  switch (evName) {
    case 'SubagentStart':
    case 'SubagentStop': {
      const at = agentType(own(ev, 'agent_type'));
      if (at !== undefined) rec.at = at;
      if (evName === 'SubagentStop') setBackgroundTasks(rec, own(ev, 'background_tasks'));
      break;
    }
    case 'PreToolUse': {
      const toolName = own(ev, 'tool_name'), input = own(ev, 'tool_input');
      setCategory(rec, C, toolName, input, null);
      setToolUse(rec, ev);
      if (isShell(toolName) && isDict(input)) {
        const rib = own(input, 'run_in_background');
        if (rib === true || (typeof rib === 'string' && rib.toLowerCase() === 'true')) rec.bg = true;
        const ms = own(input, 'timeout');                          // the Bash / PowerShell timeout is in ms
        if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= 86_400_000) rec.to = Math.ceil(ms / 1000);
      }
      break;
    }
    case 'PostToolUse': {
      const toolName = own(ev, 'tool_name');
      const resp = toolName === 'Agent' || toolName === 'Workflow' ? responseObject(own(ev, 'tool_response')) : null;
      const status = resp ? token(own(resp, 'status')) : undefined;
      setCategory(rec, C, toolName, own(ev, 'tool_input'), toolName === 'Agent' ? status ?? null : null);
      setToolUse(rec, ev);
      if (status !== undefined) rec.st = status;
      if (toolName === 'Agent') {
        const ch = agentId(own(resp, 'agentId'));
        if (ch !== undefined) rec.ch = ch;
      }
      if (toolName === 'Workflow') {
        const run = idField(own(resp, 'runId'));
        if (run !== undefined) rec.run = run;
      }
      break;
    }
    case 'PostToolUseFailure': {
      setCategory(rec, C, own(ev, 'tool_name'), own(ev, 'tool_input'), null);
      setToolUse(rec, ev);
      const intr = own(ev, 'is_interrupt');
      if (typeof intr === 'boolean') rec.intr = intr;
      break;
    }
    case 'PostToolBatch': {
      const calls = own(ev, 'tool_calls');
      if (Array.isArray(calls)) {
        setBatchCategory(rec, C, calls);
        rec.n = calls.length;
      }
      break;
    }
    case 'Stop':
      setBackgroundTasks(rec, own(ev, 'background_tasks'));
      break;
    case 'SessionEnd': {
      const r = token(own(ev, 'reason'));
      if (r !== undefined) rec.r = r;
      break;
    }
    default:
      break;
  }
  return rec;
}

// ---------------------------------------------------------------------------------------------- spool
const pad = (n) => String(n).padStart(2, '0');
function dayStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function writeOnce(file, buf) {
  const fd = openSync(file, 'a');                                  // O_APPEND: the OS places each write at the end
  try { writeSync(fd, buf, 0, buf.length); } finally { closeSync(fd); }
}
function append(rec) {
  let line = JSON.stringify(rec);
  while (line.length + 1 > MAX_LINE && Array.isArray(rec.bt) && rec.bt.length) {
    rec.bt.pop();
    line = JSON.stringify(rec);
  }
  if (line.length + 1 > MAX_LINE) return;                          // unreachable: every other field is bounded
  const buf = Buffer.from(line + '\n', 'utf8');                    // ASCII by construction
  const dir = join(HOME, 'spool');
  const file = join(dir, `events-${dayStamp(rec.ts)}.jsonl`);
  try {
    writeOnce(file, buf);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      try { mkdirSync(dir, { recursive: true }); writeOnce(file, buf); } catch { /* give up silently */ }
    }
  }
}

// ---------------------------------------------------------------------------------------------- main
let done = false;
async function finish(buf) {
  if (done) return;
  done = true;
  try {
    let ev = null;
    if (buf) {
      try {
        let s = buf.toString('utf8');
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
        ev = JSON.parse(s);
      } catch { ev = null; }
    }
    if (!isDict(ev)) append({ v: VERSION, ts: TS, ev: 'parse_error' });
    else append(buildRecord(ev, await classifierP));
  } catch { /* never let anything escape */ }
  quit();
}

const chunks = [];
let size = 0, tooBig = false;
const deadline = setTimeout(() => finish(null), STDIN_DEADLINE_MS);
deadline.unref();
process.stdin.on('data', (c) => {
  if (tooBig) return;
  size += c.length;
  if (size > MAX_STDIN) { tooBig = true; chunks.length = 0; } else chunks.push(c);
});
process.stdin.on('end', () => finish(tooBig ? null : Buffer.concat(chunks, size)));
process.stdin.on('error', () => finish(null));
