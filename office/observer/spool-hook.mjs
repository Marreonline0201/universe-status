// Worker-office spool hook (worker-office plan section 5.2).
//
// Claude Code runs this as an async command hook on SubagentStart, SubagentStop, PreToolUse, PostToolBatch,
// PostToolUse (Agent|Workflow|SubagentHandback), PostToolUseFailure, Stop and SessionEnd. On every firing it:
//   1. exits at once when OFFICE_AGENT_ID is set (the old office fleet's own sessions; same guard as
//      session-office-up.ps1);
//   2. reads all of stdin;
//   3. parses it; on failure (empty, malformed, not an object, over 32 MB, more than MAX_VALUES values, stdin not
//      closed within 5 s) it writes {v,ts,ev:"parse_error"} plus the per-record cost fields (dur cpu rss) and nothing
//      else. The value cap bounds memory, which grows with the NUMBER of JSON values (about 120-300 bytes each), not
//      only with bytes: 1M empty objects are 2.9 MB of stdin and took ~340 MB. The values are the '{' '[' ',' bytes
//      outside strings (one per object or array, one per extra member or element), counted in one pass before the
//      parse; a payload over the cap is never parsed;
//   4. classifies the tool call with classify.mjs: only a category (object kind + activity id) leaves the process.
//      A Bash / PowerShell command longer than MAX_CLASSIFY_COMMAND is not classified (the record has no k / a);
//      the classifier's memory is linear in the command, and this caps it (longest real command: 22,835 chars);
//   5. appends ONE allowlisted JSON line, in a single write, to <home>/spool/events-YYYY-MM-DD.jsonl
//      (YYYY-MM-DD = the local date of ts);
//   6. prints NOTHING to stdout or stderr and ALWAYS exits 0. An async hook's output would be handed to the model
//      on its next turn, so the observer must not speak.
//
// Record allowlist (v1; extended 2026-10-01 for worker-office step 4 stage 0 with at on tool events, run on
// SubagentStart / PreToolUse, tus, dur, cpu, rss, and agent- stripped from ids), in this key order:
//   v ts sid ev aid at k a tsr tu tus bg to st ch tid run err intr n bt r dur cpu rss
// Never written: tool_input, tool_response (beyond the checked status / ids / error flag below), prompts,
// descriptions, last_assistant_message, error text, paths (transcript_path, agent_transcript_path, cwd: only the run
// token below is taken from a path), commands, URLs, tool names, background_tasks description/command/name.
// Every written value is checked, not just its key:
//   k, a        closed sets from classify.mjs (KINDS, ACTIVITY_ID)
//   tsr         true when a ToolSearch call would win this batch at a library station (PostToolBatch only); the
//               observer applies the library rule with classify.mjs resolveAtStation
//   ev          a closed set of event names, else "other"
//   st          PostToolUse(Agent|Workflow) tool_response.status, read only from the structured tool_response
//               OBJECT: a closed set (Agent: completed, async_launched, remote_launched; Workflow: async_launched,
//               remote_launched); any other string status is written as "other"
//   err         true when a Workflow's tool_response.error is a non-empty string (the script failed its syntax
//               check and never runs); the error text is never written
//   r, bt.type, bt.status   a short identifier token (letters, digits, _ -; max 32), else dropped; the documented
//               labels "cloud session" and "MCP task" are written as cloud-session and mcp-task
//   sid, aid, ch, tid, run, bt.id   ids: every leading "agent-" is stripped first, so agent-agent-x is x (plan
//               5.2; probe 3 found none in the payloads, so this changes nothing seen so far), then the id is written
//               raw when it is [A-Za-z0-9_.:-]{1,64}, else as "#" + 12 hex characters of sha256(the stripped id), so
//               it is never confused with a raw id, cannot carry text, and still joins across fields and events
//   at          agent_type, on SubagentStart, SubagentStop and the tool events (PreToolUse, PostToolBatch,
//               PostToolUse, PostToolUseFailure) when the payload has it: [A-Za-z0-9_.:-]{1,64} or "" (internal
//               agents), else dropped. Recorded to tell workflow agents apart; never displayed (plan D9)
//   run         PostToolUse(Workflow): tool_response.runId (an id, as above). SubagentStart and PreToolUse: the
//               workflow run of the agent's OWN transcript: when agent_transcript_path or transcript_path ends in the
//               consecutive parts  subagents / workflows / wf_<id> / agent-<agent_id>.jsonl  (either separator, / or
//               \; the file's id and this payload's agent_id compared without their "agent-" prefixes; wf_<id> =
//               "wf_" + 1..61 of [A-Za-z0-9_-]), ONLY the wf_<id> part is written. Any other path writes nothing; no
//               other part of a path is ever written (plan probes 1 and 5: this links an agent to its run, and a retry
//               to the run it replaces). The DOCUMENTED payloads carry no such path on these events (hooks.md:
//               SubagentStart has agent_id and agent_type, agent_transcript_path is on SubagentStop only, and a
//               subagent's tool events carry the parent's transcript_path), and live this run has never been written:
//               step-4 review finding 1, the lead's ruling pending
//   tu          10 hex characters of sha256(tool_use_id)
//   tus         PostToolBatch: the tu of each call of the batch, in call order (a call without a tool_use_id is
//               skipped), cut from the end so that the line stays within 4,096 bytes (plan probes 2 and 10: a Pre
//               and its Batch pair exactly)
//   ts          ms since the epoch at which this hook process started (performance.timeOrigin)
//   dur cpu rss on EVERY record (parse_error included), integers: dur = ms from this process's start to the write
//               (performance.now()); cpu = its CPU time so far (process.cpuUsage() user + system, ms); rss = its peak
//               working set (process.resourceUsage().maxRSS, MB). Plan probe 8 (the cost of one firing) and probe 7
//               (the size of the reorder window's wall-clock flush)
// SubagentStop's bt describes the PARENT session's background tasks (hooks.md SubagentStop input), never the
// stopping subagent's own.
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
const MAX_VALUES = 100_000;       // '{' '[' ',' outside strings; more is not parsed (memory: see step 3 above)
const STDIN_DEADLINE_MS = 5000;
const MAX_LINE = 4096;            // bytes incl. the newline; only tus and bt can be cut to fit
const MAX_BT = 50;
const MAX_CLASSIFY_COMMAND = 65536;   // chars; longer shell commands are not classified (no k / a)
const TU_BYTES = 13;              // one more tus entry: "0123456789" and its comma
const MAX_TUS = Math.floor(MAX_LINE / TU_BYTES);   // more entries than this can never fit: never hashed
const MAX_PATH = 32768;           // chars; a longer transcript path is not looked at

if (process.env.OFFICE_AGENT_ID) quit();
const HOME = process.env.UNIVERSE_OFFICE_HOME || DEFAULT_HOME;

// Load the classifier while stdin is still arriving. A missing or broken classify.mjs only costs the k/a fields.
const classifierP = import(new URL('./classify.mjs', import.meta.url).href).catch(() => null);

// ---------------------------------------------------------------------------------------------- value checks
const RE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const RE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// A workflow agent's own transcript: .../subagents/workflows/wf_<id>/agent-<agent_id>.jsonl (either separator).
const RE_RUN_PATH = /(?:^|[\\/])subagents[\\/]workflows[\\/](wf_[A-Za-z0-9_-]{1,61})[\\/]agent-([A-Za-z0-9_.:-]{1,64})\.jsonl$/;
// The record's shape follows the event, so ev is a closed set: the plan's eight events, the optional extras of
// plan 5.5 (PermissionRequest, StopFailure) and a few well-known ones. Anything else is written as "other".
const EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'SessionEnd', 'PermissionRequest', 'StopFailure', 'SessionStart', 'UserPromptSubmit', 'Notification', 'PreCompact']);
// The events whose record carries agent_type (at): the subagent's start and stop, and its tool events.
const AT_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure']);
const STATUSES = new Map([['Agent', new Set(['completed', 'async_launched', 'remote_launched'])],   // AgentOutput
  ['Workflow', new Set(['async_launched', 'remote_launched'])]]);                                  // WorkflowOutput
const BT_LABELS = new Map([['cloud session', 'cloud-session'], ['MCP task', 'mcp-task']]);         // hooks.md Stop input
const isDict = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (o, k) => (isDict(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const stripAgent = (s) => s.replace(/^(?:agent-)+/, '');
/** An id field: the id without any leading "agent-", raw when it is a plain id, else "#" + 12 hex of its hash. */
const idOut = (x) => {
  if (typeof x !== 'string' || x.length === 0) return undefined;
  const s = stripAgent(x);
  return RE_ID.test(s) ? s : '#' + sha(s).slice(0, 12);
};
const token = (x) => (typeof x === 'string' && RE_TOKEN.test(x) ? x : undefined);
const btLabel = (x) => (typeof x === 'string' && BT_LABELS.has(x) ? BT_LABELS.get(x) : token(x));
const agentType = (x) => (x === '' ? '' : (typeof x === 'string' && RE_ID.test(x) ? x : undefined));
const toolUseHash = (x) => (typeof x === 'string' && x.length > 0 ? sha(x).slice(0, 10) : undefined);
const isShell = (name) => name === 'Bash' || name === 'PowerShell';
/** A Bash / PowerShell call whose command is too long to classify. */
const tooLong = (name, input) => isShell(name) && typeof own(input, 'command') === 'string'
  && own(input, 'command').length > MAX_CLASSIFY_COMMAND;

/** The workflow run (wf_<id>) of this agent's own transcript path, else undefined (see the header). Only the token
 *  is returned; the path itself never leaves this function. */
function runFromPath(ev) {
  const id = own(ev, 'agent_id');
  if (typeof id !== 'string' || id.length === 0) return undefined;   // the main thread is in no workflow
  const aid = stripAgent(id);
  for (const key of ['agent_transcript_path', 'transcript_path']) {
    const p = own(ev, key);
    if (typeof p !== 'string' || p.length > MAX_PATH) continue;
    const m = RE_RUN_PATH.exec(p);
    if (m && stripAgent(m[2]) === aid) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------- record
function setCategory(rec, C, name, input, agentStatus) {
  if (!C || tooLong(name, input)) return;
  try {
    const [act, kind] = C.classifyCallAtHook(name, input, agentStatus);
    if (kind !== null && C.KINDS.has(kind)) rec.k = kind;
    const id = C.ACTIVITY_ID.get(act);
    if (id) rec.a = id;
  } catch { /* the reference raises here too (malformed tool_input): no category */ }
}

// PostToolBatch: tool_response is the tool_result text the model saw (hooks.md, PostToolBatch input), not the
// structured output, so nothing is read from it: an Agent call in a batch is classified by the hook-time rule.
function setBatchCategory(rec, C, calls) {
  if (!C) return;
  try {
    const list = calls.map((c) => {
      if (!isDict(c)) throw new TypeError('tool call is not an object');
      const name = own(c, 'tool_name'), input = own(c, 'tool_input');
      if (tooLong(name, input)) throw new RangeError('command too long to classify');
      return [name, input, null];
    });
    const { result: [act, kind], tsr } = C.batchAtHook(list);
    if (kind !== null && C.KINDS.has(kind)) rec.k = kind;
    const id = C.ACTIVITY_ID.get(act);
    if (id) rec.a = id;
    if (tsr === true) rec.tsr = true;
  } catch { /* the reference raises for a malformed call; a too-long command: no category */ }
}

function setToolUse(rec, ev) {
  const tu = toolUseHash(own(ev, 'tool_use_id'));
  if (tu !== undefined) rec.tu = tu;
}

/** tus: each call's tool_use_id hash, in call order; append() cuts it from the end to fit the line. */
function setToolUses(rec, calls) {
  const out = [];
  for (const c of calls) {
    if (out.length >= MAX_TUS) break;
    const tu = isDict(c) ? toolUseHash(own(c, 'tool_use_id')) : undefined;
    if (tu !== undefined) out.push(tu);
  }
  rec.tus = out;
}

function setRun(rec, ev) {
  const run = runFromPath(ev);
  if (run !== undefined) rec.run = run;
}

function setBackgroundTasks(rec, tasks) {
  if (!Array.isArray(tasks)) return;                               // absent = task registry not reachable
  const out = [];
  for (const t of tasks) {
    if (out.length >= MAX_BT) break;
    if (!isDict(t)) continue;
    const e = {};
    const id = idOut(own(t, 'id')), type = btLabel(own(t, 'type')), status = btLabel(own(t, 'status'));
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
  const sid = idOut(own(ev, 'session_id'));
  if (sid !== undefined) rec.sid = sid;
  const name = own(ev, 'hook_event_name');
  const evName = typeof name === 'string' && EVENTS.has(name) ? name : 'other';
  rec.ev = evName;
  const aid = idOut(own(ev, 'agent_id'));
  if (aid !== undefined) rec.aid = aid;
  if (AT_EVENTS.has(evName)) {
    const at = agentType(own(ev, 'agent_type'));
    if (at !== undefined) rec.at = at;
  }

  switch (evName) {
    case 'SubagentStart':
      setRun(rec, ev);
      break;
    case 'SubagentStop':
      setBackgroundTasks(rec, own(ev, 'background_tasks'));         // the PARENT's tasks
      break;
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
      setRun(rec, ev);
      break;
    }
    case 'PostToolUse': {
      // Only the structured tool_response OBJECT (AgentOutput / WorkflowOutput) is read; a string response is text,
      // never parsed. Status, ids and the error flag are the only things taken from it.
      const toolName = own(ev, 'tool_name');
      const known = STATUSES.get(toolName);
      const resp = known && isDict(own(ev, 'tool_response')) ? own(ev, 'tool_response') : null;
      const raw = resp ? own(resp, 'status') : undefined;
      const status = typeof raw === 'string' ? (known.has(raw) ? raw : 'other') : undefined;
      const agentStatus = toolName === 'Agent' && status !== undefined && status !== 'other' ? status : null;
      setCategory(rec, C, toolName, own(ev, 'tool_input'), agentStatus);
      setToolUse(rec, ev);
      if (status !== undefined) rec.st = status;
      if (resp) {
        const ch = toolName === 'Agent' ? idOut(own(resp, 'agentId')) : undefined;
        if (ch !== undefined) rec.ch = ch;
        const tid = idOut(own(resp, 'taskId'));                    // remote_launched Agent; every Workflow
        if (tid !== undefined) rec.tid = tid;
        const run = toolName === 'Workflow' ? idOut(own(resp, 'runId')) : undefined;
        if (run !== undefined) rec.run = run;
        const err = own(resp, 'error');
        if (toolName === 'Workflow' && typeof err === 'string' && err.length > 0) rec.err = true;
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
        setToolUses(rec, calls);
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
/** The per-record cost fields (dur cpu rss), last in key order, taken just before the line is built. */
function measure(rec) {
  try {
    rec.dur = Math.round(performance.now());
    const u = process.cpuUsage();
    rec.cpu = Math.round((u.user + u.system) / 1000);
    rec.rss = Math.round(process.resourceUsage().maxRSS / 1024);
  } catch { /* the record goes without them */ }
}
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
  measure(rec);
  let line = JSON.stringify(rec);
  while (line.length + 1 > MAX_LINE) {                             // cut tus (a Batch), else bt (a stop), from the end
    if (Array.isArray(rec.tus) && rec.tus.length) {
      rec.tus.length = Math.max(0, rec.tus.length - Math.ceil((line.length + 1 - MAX_LINE) / TU_BYTES));
    } else if (Array.isArray(rec.bt) && rec.bt.length) {
      rec.bt.pop();
    } else return;                                                 // unreachable: every other field is bounded
    line = JSON.stringify(rec);
  }
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

/** The values of step 3: the '{' '[' ',' bytes outside strings, counted up to the first one over MAX_VALUES. The
 *  bytes " \ { [ , never occur inside a UTF-8 multi-byte sequence. */
function overValueCap(buf) {
  let inString = false, escaped = false, values = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (b === 0x5c) escaped = true;                         // a backslash escapes the next byte
      else if (b === 0x22) inString = false;                       // the closing quote
    } else if (b === 0x22) inString = true;
    else if ((b === 0x7b || b === 0x5b || b === 0x2c) && ++values > MAX_VALUES) return true;   // { [ ,
  }
  return false;
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
process.stdin.on('end', () => {
  if (tooBig) { finish(null); return; }
  const buf = Buffer.concat(chunks, size);
  // each counted value is one byte, so a stdin of at most MAX_VALUES bytes is never over the cap: only a longer one
  // is scanned (one pass, about 50 ms for 32 MB)
  finish(size > MAX_VALUES && overValueCap(buf) ? null : buf);
});
process.stdin.on('error', () => finish(null));
