// Tests for the worker-office spool hook (office/observer/spool-hook.mjs) and its installer.
//
//   node scripts/spool-hook-test.mjs [--keep]
//
// Everything runs against a temp UNIVERSE_OFFICE_HOME: the suite installs the hook there with install-hook.mjs and
// fires the INSTALLED copy (<temp>/home/bin/spool-hook.mjs), the way Claude Code will. The real home
// (.universe-office in the user's home folder, os.homedir()) must be exactly as before afterwards (checked). One hook process at a time,
// except the concurrency test (8 at once, after a free-RAM check).
// Checked for every firing: exit code 0, stdout and stderr empty, the exact number of new spool lines, keys a subset
// of the allowlist (in allowlist order), every value's format and length, ts inside the spawn window.
// Privacy: every free-text field of every payload carries the marker ZZCANARYZZ (inside commands, paths, URLs,
// prompts, responses, error text, background-task descriptions/commands/names/types, session_crons, cwd, transcript
// paths, unknown extra fields, MCP tool names, token-shaped values inside STRING tool responses), and id-shaped
// fields carry it only in a form that is not a valid id (written hashed). The marker must appear nowhere in the spool.
// Memory: the hook runs with a --import preload that writes the process's peak working set (maxRSS) to a temp file
// on exit; chained assignments and a command at the classification cap must stay near a `git status` firing.
// Step 4 stage 0 (2026-10-01; checks labelled "S4"): ids without the agent- prefix (every leading one: agent-agent-x
// is x, review finding 4); at on the tool events; tus on PostToolBatch (ordered, paired with Pre's tu, cut to fit 4,096
// bytes); the value cap (review finding 3: more than MAX_VALUES '{' '[' ',' outside strings is a parse_error, exact at
// the boundary, never tripped by a string, its escapes handled both ways; in the memory section, tiny objects over the
// cap stay near the baseline). The S4 checks are then run against planted mutants of the hook, and each mutant must
// fail them. The lead's rulings on the stage-0 review (2026-10-01; checks labelled "F1" / "F2"): no record carries run
// (F1: every event gives the same record with and without transcript_path / agent_transcript_path set to a planted
// path in the own-transcript shape the stage-0 hook read a run from, and no part of that path; a Workflow's runId is
// not written; the hook's code names no path field), and no record carries dur / cpu / rss (F2: they grew with the
// payload's size; the same event with 0 B and 4 MB of tool input, a 4 MB tool response or 4 MB of garbage gives the
// same line apart from ts). validate() checks that no line carries run, dur, cpu or rss, on every line of the suite.
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir, freemem, homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// WO_OBSERVER_DIR: test the observer CODE of another folder (classify.mjs, spool-hook.mjs, install-hook.mjs) against
// this repo's fixture: used to run this suite against planted hook mutants and against an older hook.
const OBS = process.env.WO_OBSERVER_DIR ? resolve(process.env.WO_OBSERVER_DIR) : join(ROOT, 'office', 'observer');
const REAL_HOME = join(homedir(), '.universe-office');
const KEEP = process.argv.includes('--keep');
const C = await import(pathToFileURL(join(OBS, 'classify.mjs')).href);
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'office', 'observer', 'classify-cases.json'), 'utf8'));

let checks = 0, failures = 0, firings = 0;
// While `sink` is set (a run against a planted mutant), checks are counted into it instead of the suite's totals.
let sink = null;
const ok = (cond, what) => {
  if (sink) { sink.checks += 1; if (!cond) { sink.failures += 1; sink.fails.push(what); } return cond; }
  checks += 1; if (!cond) { failures += 1; console.log('  FAIL', what); } return cond;
};
const section = (name) => console.log(`-- ${name}`);
const h10 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ guards
function realHomeSnapshot() {
  if (!existsSync(REAL_HOME)) return { exists: false };
  return { exists: true, mtimeMs: statSync(REAL_HOME).mtimeMs, entries: readdirSync(REAL_HOME).sort().join('|') };
}
const realBefore = realHomeSnapshot();
const hookSrc = readFileSync(join(OBS, 'spool-hook.mjs'), 'utf8');
ok(hookSrc.includes("const DEFAULT_HOME = join(homedir(), '.universe-office');") && REAL_HOME === join(homedir(), '.universe-office'),
  'the hook default home is the folder this suite guards (both .universe-office in os.homedir())');
async function waitForRam(minGb, what) {
  for (let i = 0; i < 24; i++) {
    const gb = freemem() / 2 ** 30;
    if (gb >= minGb) return gb;
    console.log(`  waiting for free RAM before ${what}: ${gb.toFixed(2)} GB < ${minGb} GB`);
    await sleep(5000);
  }
  throw new Error(`free RAM stayed below ${minGb} GB; not running ${what}`);
}

const TMP = mkdtempSync(join(tmpdir(), 'wo-spool-test-'));
const HOME = join(TMP, 'home');
function childEnv(home, extra = {}) {
  if (!resolve(home).startsWith(resolve(TMP))) throw new Error(`refusing to run a hook against ${home}`);
  const env = { ...process.env, UNIVERSE_OFFICE_HOME: home };
  delete env.OFFICE_AGENT_ID;
  return Object.assign(env, extra);
}

// ------------------------------------------------------------------------------------------------ spool + firing
const ALLOWED = ['v', 'ts', 'sid', 'ev', 'aid', 'at', 'k', 'a', 'tsr', 'tu', 'tus', 'bg', 'to', 'st', 'ch', 'tid', 'err', 'sz',
  'intr', 'n', 'bt', 'r'];
/** Keys that left the allowlist on the lead's rulings of 2026-10-01: run (F1) and the cost fields dur cpu rss (F2). */
const GONE = [['run', 'F1'], ['dur', 'F2'], ['cpu', 'F2'], ['rss', 'F2']];
const AT_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure']);
const RE_TU = /^[0-9a-f]{10}$/;
const EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'SessionEnd', 'PermissionRequest', 'StopFailure', 'SessionStart', 'UserPromptSubmit', 'Notification', 'PreCompact',
  'other', 'parse_error']);
const RE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const RE_HASHED_ID = /^#[0-9a-f]{12}$/;
const isIdOut = (x) => typeof x === 'string' && (RE_ID.test(x) || RE_HASHED_ID.test(x));
const RE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const ST = new Set(['completed', 'async_launched', 'remote_launched', 'other']);
/** What the hook writes for an id that is not a plain id: '#' + 12 hex of sha256(the id without any 'agent-' prefix:
 *  every leading 'agent-' is stripped, review finding 4). */
const hid = (s) => '#' + createHash('sha256').update(s.replace(/^(?:agent-)+/, ''), 'utf8').digest('hex').slice(0, 12);
/** The hook's value cap: more '{' '[' ',' outside strings than this and the stdin is not parsed (parse_error). */
const MAX_VALUES = 100_000;
/** Independent of the hook's byte scan: the number of '{', '[' and ',' that JSON.stringify(x) writes outside strings,
 *  counted on the VALUE (one per object or array, one comma between members or elements). */
function structural(x) {
  if (x === null || typeof x !== 'object') return 0;
  const vs = Array.isArray(x) ? x : Object.values(x);
  let n = 1 + Math.max(0, vs.length - 1);
  for (const v of vs) n += structural(v);
  return n;
}

function spoolLines(home) {
  const dir = join(home, 'spool');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const lines = [];
  for (const f of readdirSync(dir).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    ok(text === '' || text.endsWith('\n'), `${f}: the file ends with a complete line`);
    lines.push(...text.split('\n').filter((l) => l.length));
  }
  return lines;
}
const seen = new Map();                         // home -> number of lines already consumed
function newLines(home) {
  const all = spoolLines(home);
  const from = seen.get(home) || 0;
  seen.set(home, all.length);
  return all.slice(from);
}

function fire(home, input, extraEnv) {
  firings += 1;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(home, 'bin', 'spool-hook.mjs')], {
    input, env: childEnv(home, extraEnv), timeout: 30000, windowsHide: true, maxBuffer: 1 << 20,
  });
  return { ...r, t0, t1: Date.now() };
}
function assertSilent(r, what) {
  ok(!r.error, `${what}: spawn error ${r.error && r.error.message}`);
  ok(r.status === 0, `${what}: exit code ${r.status} (signal ${r.signal})`);
  ok(r.stdout && r.stdout.length === 0, `${what}: stdout must be empty, got ${r.stdout && r.stdout.length} bytes`);
  ok(r.stderr && r.stderr.length === 0, `${what}: stderr must be empty, got: ${r.stderr && r.stderr.toString().slice(0, 300)}`);
}

/** Format and length checks of one spool line. */
function validate(line, what, r) {
  ok(line.length + 1 <= 4096, `${what}: line is ${line.length + 1} bytes (max 4096)`);
  ok(/^[\x20-\x7e]*$/.test(line), `${what}: line is printable ASCII`);
  let rec;
  try { rec = JSON.parse(line); } catch { ok(false, `${what}: line is not JSON: ${line.slice(0, 120)}`); return null; }
  const keys = Object.keys(rec);
  ok(keys.every((k) => ALLOWED.includes(k)), `${what}: keys ${keys} must be a subset of the allowlist`);
  const idx = keys.map((k) => ALLOWED.indexOf(k));
  ok(idx.every((x, i) => i === 0 || x > idx[i - 1]), `${what}: keys in allowlist order (${keys})`);
  ok(!('sz' in rec), `${what}: no size bucket (owner decision D11 is open)`);
  ok(rec.v === 1, `${what}: v = 1`);
  ok(Number.isInteger(rec.ts) && (!r || (rec.ts >= r.t0 - 50 && rec.ts <= r.t1)), `${what}: ts ${rec.ts} inside the spawn window`);
  ok(EVENTS.has(rec.ev), `${what}: ev "${rec.ev}" is a known event, other or parse_error`);
  for (const k of ['sid', 'aid', 'ch', 'tid']) if (k in rec) ok(isIdOut(rec[k]), `${what}: ${k} format "${rec[k]}"`);
  for (const k of ['sid', 'aid', 'ch', 'tid']) if (k in rec) ok(!String(rec[k]).startsWith('agent-'), `${what}: ${k} carries no agent- prefix`);
  for (const e of Array.isArray(rec.bt) ? rec.bt : []) if (e && 'id' in e) ok(!String(e.id).startsWith('agent-'), `${what}: bt.id carries no agent- prefix`);
  if ('at' in rec) ok((rec.at === '' || RE_ID.test(rec.at)) && AT_EVENTS.has(rec.ev), `${what}: at format, on a subagent start / stop or a tool event only`);
  // the lead's rulings of 2026-10-01, on EVERY line: no run (F1: no path is read, a Workflow's runId is not written)
  // and no cost field (F2: dur / cpu / rss grew with the payload's size, a size side channel against decision D11)
  for (const [k, ruling] of GONE) ok(!(k in rec), `${what}: ${ruling} no ${k} key on any record (${ruling === 'F1' ? 'run' : 'cost field'}: lead ruling ${ruling})`);
  if ('tus' in rec) {
    ok(rec.ev === 'PostToolBatch' && Array.isArray(rec.tus) && rec.tus.every((x) => typeof x === 'string' && RE_TU.test(x)),
      `${what}: tus is a list of 10-hex hashes, on a PostToolBatch only`);
    ok(Number.isInteger(rec.n) && Array.isArray(rec.tus) && rec.tus.length <= rec.n, `${what}: tus has at most n entries`);
  }
  if ('k' in rec) ok(C.KINDS.has(rec.k), `${what}: k in the closed kind set`);
  if ('a' in rec) ok(C.ACTIVITY_BY_ID.has(rec.a), `${what}: a in the closed activity-id set`);
  if ('tsr' in rec) ok(rec.tsr === true && rec.ev === 'PostToolBatch', `${what}: tsr is true when present, on a Batch only`);
  if ('tu' in rec) ok(/^[0-9a-f]{10}$/.test(rec.tu), `${what}: tu is 10 hex`);
  if ('bg' in rec) ok(rec.bg === true, `${what}: bg is true when present`);
  if ('to' in rec) ok(Number.isInteger(rec.to) && rec.to >= 1 && rec.to <= 86400, `${what}: to in seconds`);
  if ('st' in rec) ok(ST.has(rec.st), `${what}: st "${rec.st}" in the closed status set`);
  if ('err' in rec) ok(rec.err === true, `${what}: err is true when present`);
  if ('r' in rec) ok(RE_TOKEN.test(rec.r), `${what}: r token`);
  if ('intr' in rec) ok(typeof rec.intr === 'boolean', `${what}: intr boolean`);
  if ('n' in rec) ok(Number.isInteger(rec.n) && rec.n >= 0, `${what}: n integer`);
  if ('bt' in rec) {
    ok(Array.isArray(rec.bt) && rec.bt.length <= 50, `${what}: bt has at most 50 entries`);
    for (const e of rec.bt || []) {
      ok(Object.keys(e).every((k) => ['id', 'type', 'status'].includes(k)), `${what}: bt entry keys ${Object.keys(e)}`);
      if ('id' in e) ok(isIdOut(e.id), `${what}: bt id format`);
      for (const k of ['type', 'status']) if (k in e) ok(RE_TOKEN.test(e[k]), `${what}: bt ${k} token`);
    }
  }
  return rec;
}

/** Fire one payload into `home`; require silence, exactly `expectLines` new lines; return the parsed records. */
function fireExpect(home, input, what, expectLines = 1, extraEnv) {
  const r = fire(home, typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input), extraEnv);
  assertSilent(r, what);
  const lines = newLines(home);
  ok(lines.length === expectLines, `${what}: expected ${expectLines} new spool line(s), got ${lines.length}`);
  return lines.map((l) => validate(l, what, r));
}
/** The record minus v / ts must equal `want` exactly (no missing and no extra fields: a run or a cost field fails it). */
function exact(rec, want, what) {
  if (!rec) return ok(false, `${what}: no record`);
  const { v, ts, ...rest } = rec;                                  // eslint-disable-line no-unused-vars
  return ok(isDeepStrictEqual(rest, want), `${what}:\n       got  ${JSON.stringify(rest)}\n       want ${JSON.stringify(want)}`);
}

// ------------------------------------------------------------------------------------------------ payloads
const MARK = 'ZZCANARYZZ';
const txt = (f) => `${MARK}-${f} secret text with spaces`;
const path = (f) => `C:/Users/someone/${MARK}/${f}/id_rsa`;
const url = (f) => `https://${MARK}.example.com/${f}?token=sk-${MARK}`;
const cmd = (f) => `cat ${path(f)} && curl -s "${url(f)}" > C:/${MARK}/out.txt`;
const SID = 'f3b1c2d4-0000-4000-8000-00000000c0de';
const COMMON = {
  session_id: SID, transcript_path: path('transcript'), cwd: path('cwd'), permission_mode: 'default',
  prompt_id: `${MARK} prompt id`, effort: 'high', scratchpad_dir: path('scratch'), extra_unknown_field: txt('extra'),
  prompt: txt('prompt'), description: txt('description'),
};
const SUB = { agent_id: 'agent-a1b2c3', agent_type: 'Explore' };
const AID = 'a1b2c3';                           // ids are written without the agent- prefix (plan 5.2; step 4 stage 0)
const AT = SUB.agent_type;                      // at: on the subagent's start / stop and on its tool events
const bashInput = (command, more = {}) => ({ command, description: txt('desc'), ...more });

// ------------------------------------------------------------------------------------------------ step 4 stage 0 (S4)
// Run on the installed hook (all must pass), on an older hook (WO_OBSERVER_DIR) and, group by group, on the planted
// mutants below (each mutant must fail its group). groups: ids, at, tus, cap, and the lead's rulings of 2026-10-01:
// norun (F1), nosize (F2) (null = all).
const WA = { agent_id: 'a1b2c3', agent_type: 'workflow-subagent' };
/** Fire one payload (an object, sent as JSON; or raw stdin, a string or a Buffer); require silence and exactly one new
 *  line; return {rec, line} (the raw line for byte checks). */
function fireOne(home, payload, what) {
  const r = fire(home, typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  assertSilent(r, what);
  const lines = newLines(home);
  ok(lines.length === 1, `${what}: expected 1 new spool line, got ${lines.length}`);
  return lines.length === 1 ? { rec: validate(lines[0], what, r), line: lines[0] } : { rec: null, line: '' };
}
/** Two spool lines are the same apart from ts (the hook's start time): the same bytes after the leading v and ts. */
const sameApartFromTs = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0
  && a.replace(/^\{"v":1,"ts":\d+,/, '') === b.replace(/^\{"v":1,"ts":\d+,/, '');

function s4Checks(home, groups = null) {
  const want = (g) => groups === null || groups.has(g);
  let rec, line;
  if (want('ids')) {
    // plan 5.2: ids without the agent- prefix (aid, ch, bt.id); a non-plain id is still hashed (prefix-normalised)
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'SubagentStart', agent_id: 'agent-a7f1', agent_type: 'workflow-subagent' }, 'S4 fire: Start, a prefixed id'));
    exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'a7f1', at: 'workflow-subagent' }, 'S4 ids: aid without the agent- prefix');
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_use_id: 'u1',
      tool_response: { status: 'async_launched', agentId: 'agent-a7f2', prompt: txt('p') } }, 'S4 fire: Post(Agent), a prefixed child id'));
    exact(rec, { sid: SID, ev: 'PostToolUse', k: 'frontDesk', a: 'helper-bg', tu: h10('u1'), st: 'async_launched', ch: 'a7f2' }, 'S4 ids: ch without the agent- prefix');
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'Stop', background_tasks: [{ id: 'agent-a7f3', type: 'subagent', status: 'running', description: txt('d') },
      { id: `agent-${MARK} x`, type: 'subagent', status: 'running' }] }, 'S4 fire: Stop, prefixed task ids'));
    exact(rec, { sid: SID, ev: 'Stop', bt: [{ id: 'a7f3', type: 'subagent', status: 'running' }, { id: hid(`${MARK} x`), type: 'subagent', status: 'running' }] },
      'S4 ids: bt.id without the prefix; a non-plain id still hashed');
    // EVERY leading agent- is stripped (review finding 4: one strip wrote agent-agent-x as agent-x), in every id field
    ({ rec } = fireOne(home, { ...COMMON, session_id: 'agent-agent-s9', hook_event_name: 'PostToolUse', agent_id: 'agent-agent-a7f4', agent_type: 'general-purpose',
      tool_name: 'Agent', tool_input: {}, tool_use_id: 'u12', tool_response: { status: 'async_launched', agentId: 'agent-agent-agent-a7f5' } }, 'S4 fire: Post(Agent), doubly prefixed ids'));
    exact(rec, { sid: 's9', ev: 'PostToolUse', aid: 'a7f4', at: 'general-purpose', k: 'frontDesk', a: 'helper-bg', tu: h10('u12'), st: 'async_launched', ch: 'a7f5' },
      'S4 ids: agent-agent-x is written x (sid, aid, ch; a triple prefix too)');
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Workflow', tool_input: {}, tool_use_id: 'u13',
      tool_response: { status: 'async_launched', taskId: 'agent-agent-w5', runId: 'agent-agent-wf_9' } }, 'S4 fire: Post(Workflow), doubly prefixed ids'));
    exact(rec, { sid: SID, ev: 'PostToolUse', k: 'kanbanBoard', a: 'tasks', tu: h10('u13'), st: 'async_launched', tid: 'w5' },
      'S4 ids: tid without any agent- prefix (the runId is not written: lead ruling F1)');
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'Stop', background_tasks: [{ id: 'agent-agent-a7f6', type: 'subagent', status: 'running' },
      { id: 'agent-agent-', type: 'subagent', status: 'running' }, { id: `agent-agent-${MARK} y`, type: 'subagent', status: 'running' }] }, 'S4 fire: Stop, doubly prefixed task ids'));
    exact(rec, { sid: SID, ev: 'Stop', bt: [{ id: 'a7f6', type: 'subagent', status: 'running' }, { id: hid('agent-agent-'), type: 'subagent', status: 'running' },
      { id: hid(`${MARK} y`), type: 'subagent', status: 'running' }] },
    'S4 ids: bt.id without any prefix; agent-agent- alone is the empty id, hashed (never written as agent-); a non-plain id hashed after the strip');
  }
  if (want('at')) {
    // at on every tool event of a subagent (recorded, never shown); a call without agent_type has none, '' stays '',
    // free text is dropped — each paired with the same call carrying a valid type, so it also fails on the old hook
    for (const [ev, extra, rest] of [
      ['PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'u2' }, { k: 'fileCabinet', a: 'read', tu: h10('u2') }],
      ['PostToolBatch', { tool_calls: [{ tool_name: 'Read', tool_input: {}, tool_use_id: 'u3', tool_response: txt('r') }] }, { k: 'fileCabinet', a: 'read', tus: [h10('u3')], n: 1 }],
      ['PostToolUse', { tool_name: 'SubagentHandback', tool_input: { report: txt('rep') }, tool_use_id: 'u4', tool_response: txt('hb') }, { k: 'printer', a: 'report', tu: h10('u4') }],
      ['PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'u5', error: txt('e'), is_interrupt: false }, { k: 'benchTerminal', a: 'run', tu: h10('u5'), intr: false }],
    ]) {
      ({ rec } = fireOne(home, { ...COMMON, hook_event_name: ev, ...WA, ...extra }, `S4 fire: ${ev} in a workflow agent`));
      exact(rec, { sid: SID, ev, aid: 'a1b2c3', at: 'workflow-subagent', ...rest }, `S4 at: ${ev} carries the agent type`);
    }
    const atOf = (agentType) => {
      const p = { ...COMMON, hook_event_name: 'PreToolUse', agent_id: 'a1b2c3', tool_name: 'Read', tool_input: {}, tool_use_id: 'u7' };
      if (agentType !== undefined) p.agent_type = agentType;
      const { rec: x } = fireOne(home, p, `S4 fire: Pre with agent_type ${JSON.stringify(agentType)}`);
      return x === null ? 'no record' : ('at' in x ? x.at : null);
    };
    const got = [atOf('general-purpose'), atOf(undefined), atOf(''), atOf(`${MARK} free text`), atOf('a'.repeat(65))];
    ok(isDeepStrictEqual(got, ['general-purpose', null, '', null, null]),
      `S4 at on a tool event: a valid type is written, none / free text / over 64 chars give none, '' stays '' | got ${JSON.stringify(got)}`);
  }
  if (want('norun')) {
    // F1 (the lead's ruling of 2026-10-01): the SubagentStart and PreToolUse payloads carry no own-transcript path (live,
    // 0 of 513 records had a run, 3 of 3 workflow Starts included), so the hook reads no path and NO record carries
    // run: not from a path, and not from a Workflow's tool_response.runId either. Every event is fired without the path
    // fields, then with transcript_path / agent_transcript_path set to a PLANTED path in the own-transcript shape the
    // stage-0 hook took a run from (.../subagents/workflows/wf_<id>/agent-<agent_id>.jsonl, the file's id = the
    // payload's agent_id; Windows and POSIX separators). Each record must be exactly the expected one (no run), the same
    // line apart from ts with and without the paths (nothing in it depends on them), and hold no part of the path.
    const PM = 'ZZPATHMARKZZ';
    const planted = {
      win: (id) => `C:\\Users\\${PM}-user\\.claude\\projects\\C--${PM}-proj\\${PM}-session\\subagents\\workflows\\wf_${PM}-run\\agent-${id}.jsonl`,
      posix: (id) => `/home/${PM}-user/.claude/projects/-home-${PM}-proj/${PM}-session/subagents/workflows/wf_${PM}-run/agent-${id}.jsonl`,
    };
    const noPaths = (p) => { const q = { ...p }; delete q.transcript_path; delete q.agent_transcript_path; return q; };
    const sub = { aid: 'a1b2c3', at: 'workflow-subagent' };
    const pre = { hook_event_name: 'PreToolUse', ...WA, tool_name: 'Read', tool_input: { file_path: path('f1') }, tool_use_id: 'n1' };
    const preRec = { sid: SID, ev: 'PreToolUse', ...sub, k: 'fileCabinet', a: 'read', tu: h10('n1') };
    const mainPre = { ...pre };
    delete mainPre.agent_id;
    delete mainPre.agent_type;
    for (const [what, payload, wantRec] of [
      ['SubagentStart', { hook_event_name: 'SubagentStart', ...WA }, { sid: SID, ev: 'SubagentStart', ...sub }],
      ['PreToolUse', pre, preRec],
      ['PreToolUse, agent_id agent-agent-a1b2c3', { ...pre, agent_id: 'agent-agent-a1b2c3' }, preRec],
      ['PreToolUse on the main thread (no agent_id)', mainPre, { sid: SID, ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: h10('n1') }],
      ['SubagentStop', { hook_event_name: 'SubagentStop', ...WA, background_tasks: [], last_assistant_message: txt('l') }, { sid: SID, ev: 'SubagentStop', ...sub, bt: [] }],
      ['PostToolBatch', { hook_event_name: 'PostToolBatch', ...WA, tool_calls: [{ tool_name: 'Read', tool_input: {}, tool_use_id: 'n2', tool_response: txt('r') }] },
        { sid: SID, ev: 'PostToolBatch', ...sub, k: 'fileCabinet', a: 'read', tus: [h10('n2')], n: 1 }],
      ['PostToolUse(SubagentHandback)', { hook_event_name: 'PostToolUse', ...WA, tool_name: 'SubagentHandback', tool_input: { report: txt('rep') }, tool_use_id: 'n3',
        tool_response: txt('hb') }, { sid: SID, ev: 'PostToolUse', ...sub, k: 'printer', a: 'report', tu: h10('n3') }],
      ['PostToolUse(Workflow), runId wf_42', { hook_event_name: 'PostToolUse', ...WA, tool_name: 'Workflow', tool_input: { script: txt('s') }, tool_use_id: 'n4',
        tool_response: { status: 'async_launched', taskId: 'w9', runId: 'wf_42' } },
      { sid: SID, ev: 'PostToolUse', ...sub, k: 'kanbanBoard', a: 'tasks', tu: h10('n4'), st: 'async_launched', tid: 'w9' }],
      ['PostToolUse(Workflow), a runId that is not an id', { hook_event_name: 'PostToolUse', tool_name: 'Workflow', tool_input: {}, tool_use_id: 'n5',
        tool_response: { status: 'async_launched', taskId: 'w8', runId: `C:/${PM}/run` } },
      { sid: SID, ev: 'PostToolUse', k: 'kanbanBoard', a: 'tasks', tu: h10('n5'), st: 'async_launched', tid: 'w8' }],
      ['PostToolUseFailure', { hook_event_name: 'PostToolUseFailure', ...WA, tool_name: 'Read', tool_input: {}, tool_use_id: 'n6', error: txt('e'), is_interrupt: true },
        { sid: SID, ev: 'PostToolUseFailure', ...sub, k: 'fileCabinet', a: 'read', tu: h10('n6'), intr: true }],
      ['Stop', { hook_event_name: 'Stop', background_tasks: [] }, { sid: SID, ev: 'Stop', bt: [] }],
      ['SessionEnd', { hook_event_name: 'SessionEnd', reason: 'other' }, { sid: SID, ev: 'SessionEnd', r: 'other' }],
      ['an unknown event', { hook_event_name: 'FutureEventName', ...WA }, { sid: SID, ev: 'other', aid: 'a1b2c3' }],
    ]) {
      const fileId = typeof payload.agent_id === 'string' ? payload.agent_id : WA.agent_id;   // the agent's OWN transcript
      const base = noPaths({ ...COMMON, ...payload });
      const without = fireOne(home, base, `F1 fire: ${what}, no path fields`);
      exact(without.rec, wantRec, `F1 no run: ${what}, without the path fields: exactly the expected record`);
      for (const [how, fields] of [
        ['both path fields, Windows separators', { transcript_path: planted.win(fileId), agent_transcript_path: planted.win(fileId) }],
        ['transcript_path only, POSIX separators', { transcript_path: planted.posix(fileId) }],
        ['agent_transcript_path only, POSIX separators', { agent_transcript_path: planted.posix(fileId) }],
      ]) {
        const x = fireOne(home, { ...base, ...fields }, `F1 fire: ${what}, ${how}`);
        // a part: every piece of the path between separators (3 characters or more), the marker, a separator itself
        const parts = [...new Set(Object.values(fields).flatMap((p) => p.split(/[\\/]/)))].filter((s) => s.length >= 3);
        const leaked = parts.filter((s) => x.line.includes(s)).length + (x.line.includes(PM) ? 1 : 0) + (/[\\/]/.test(x.line) ? 1 : 0);
        const same = x.rec !== null && sameApartFromTs(x.line, without.line);
        ok(x.rec !== null && !('run' in x.rec) && same && leaked === 0,
          `F1 no run: ${what}, ${how}: no run, the same line as without the paths apart from ts, no part of the path | run ${x.rec ? (x.rec.run ?? 'none') : 'no record'}, same ${same}, path parts in the line ${leaked}`);
      }
    }
    // ...and the hook's code names no path field (the stage-0 hook named both transcript fields to read its run token)
    const code = readFileSync(join(home, 'bin', 'spool-hook.mjs'), 'utf8');
    const named = code.match(/['"`](?:agent_transcript_path|transcript_path|cwd)['"`]|\.(?:agent_)?transcript_path\b/g) || [];
    ok(named.length === 0, `F1 no run: the hook's code names no path field, quoted or as a property, so it reads none | found ${named.length}: ${named.join(' ')}`);
  }
  if (want('tus')) {
    // tus: each call's tu, in order; the same hash as the call's Pre tu (so a Pre and its Batch pair exactly)
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'PostToolBatch', ...WA, tool_calls: ['p1', 'p2', 'p3'].map((id, i) => ({
      tool_name: ['Read', 'Grep', 'Glob'][i], tool_input: { pattern: txt('g') }, tool_use_id: id, tool_response: txt('r') })) }, 'S4 fire: Batch of three'));
    exact(rec, { sid: SID, ev: 'PostToolBatch', ...{ aid: 'a1b2c3', at: 'workflow-subagent' }, k: 'fileCabinet', a: 'read', tus: [h10('p1'), h10('p2'), h10('p3')], n: 3 },
      'S4 tus: the three hashes in call order');
    const { rec: pre } = fireOne(home, { ...COMMON, hook_event_name: 'PreToolUse', ...WA, tool_name: 'Grep', tool_input: {}, tool_use_id: 'p2' }, 'S4 fire: Pre of the second call');
    ok(pre !== null && rec !== null && Array.isArray(rec.tus) && pre.tu === rec.tus[1], `S4 tus: the Pre tu of call 2 is tus[1] | ${pre && pre.tu} vs ${rec && rec.tus && rec.tus[1]}`);
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'PostToolBatch', ...WA, tool_calls: [
      { tool_name: 'Read', tool_input: {}, tool_use_id: 'q1' }, `${MARK} not a call`, { tool_name: 'Read', tool_input: {} },
      { tool_name: 'Read', tool_input: {}, tool_use_id: '' }, { tool_name: 'Read', tool_input: {}, tool_use_id: 42 }, { tool_name: 'Read', tool_input: {}, tool_use_id: `q2 ${MARK}` }] },
    'S4 fire: Batch with calls lacking an id'));
    exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', at: 'workflow-subagent', tus: [h10('q1'), h10(`q2 ${MARK}`)], n: 6 },
      'S4 tus: a call that is not an object, or has no string tool_use_id, is skipped (the count n still counts it)');
    // the cap: 1,000 calls and 64-character ids: the line stays within 4,096 bytes (newline included), tus is an ordered
    // prefix of the hashes, and one more entry would not have fit
    const ids = Array.from({ length: 1000 }, (_, i) => `toolu_cap_${String(i).padStart(4, '0')}_${MARK}`);
    ({ rec, line } = fireOne(home, { ...COMMON, session_id: 's'.repeat(64), hook_event_name: 'PostToolBatch', agent_id: 'b'.repeat(64), agent_type: 't'.repeat(64),
      tool_calls: ids.map((id) => ({ tool_name: 'Read', tool_input: {}, tool_use_id: id, tool_response: txt('r') })) }, 'S4 fire: Batch of 1,000 calls'));
    const all = ids.map(h10);
    const tus = rec && Array.isArray(rec.tus) ? rec.tus : [];
    ok(rec !== null && line.length + 1 <= 4096 && tus.length >= 250 && isDeepStrictEqual(tus, all.slice(0, tus.length)) && line.length + 1 + 13 > 4096 && rec.n === 1000,
      `S4 tus capped: the line within 4,096 bytes, an ordered prefix of at least 250 hashes, one more would not fit, n = 1000 | line ${line.length + 1} bytes, ${tus.length} hashes`);
  }
  if (want('nosize')) {
    // F2 (the lead's ruling of 2026-10-01): the cost fields dur / cpu / rss grew with the size of the payload (a 4 MB
    // Write: rss 56 MB vs 39), a size side channel against owner decision D11 (no size bucket), so no record carries
    // them, and a record's bytes must not grow with the payload: the same event with 0 B and with 4 MB of tool input
    // (a Write's content, an Agent's prompt), of tool response, or of garbage (a parse_error) gives the same keys in the
    // same order and the same values apart from ts, so the same bytes. Bash / PowerShell are left out on purpose: a
    // command over 65,536 characters is not classified (no k / a), a size threshold the hook keeps by design (step 4).
    const FOUR_MB = 4 * 1024 * 1024;
    const big = `${MARK} `.repeat(Math.ceil(FOUR_MB / (MARK.length + 1))).slice(0, FOUR_MB);
    const sameSize = (a, b, what) => {
      const sameKeys = a.rec !== null && b.rec !== null && isDeepStrictEqual(Object.keys(a.rec), Object.keys(b.rec));
      const sameValues = a.rec !== null && b.rec !== null && isDeepStrictEqual({ ...a.rec, ts: 0 }, { ...b.rec, ts: 0 });
      const sameBytes = sameApartFromTs(a.line, b.line);
      const costs = [a.rec, b.rec].filter((x) => x !== null && ['dur', 'cpu', 'rss'].some((k) => k in x)).length;
      ok(sameKeys && sameValues && sameBytes && costs === 0,
        `F2 size: ${what}, 0 B vs 4 MB: no dur / cpu / rss, the same keys in the same order, the same values and bytes apart from ts | records with a cost field ${costs}, keys ${sameKeys}, values ${sameValues}, bytes ${sameBytes} (${a.line.length} vs ${b.line.length})`);
    };
    for (const [what, mk] of [
      ['PreToolUse(Write), its content', (s) => ({ hook_event_name: 'PreToolUse', ...WA, tool_name: 'Write', tool_input: { file_path: path('w'), content: s },
        tool_use_id: 'z1' })],
      ['PostToolUseFailure(Write), its content', (s) => ({ hook_event_name: 'PostToolUseFailure', ...WA, tool_name: 'Write', tool_input: { file_path: path('w'), content: s },
        tool_use_id: 'z2', error: txt('e'), is_interrupt: false })],
      ['PostToolBatch, a Write call\'s content', (s) => ({ hook_event_name: 'PostToolBatch', ...WA, tool_calls: [{ tool_name: 'Write',
        tool_input: { file_path: path('w'), content: s }, tool_use_id: 'z3', tool_response: txt('r') }] })],
      ['PostToolUse(Agent), its prompt', (s) => ({ hook_event_name: 'PostToolUse', ...WA, tool_name: 'Agent', tool_input: { prompt: s, run_in_background: true },
        tool_use_id: 'z4', tool_response: { status: 'async_launched', agentId: 'agent-a7f9' } })],
      ['PostToolBatch, a Read call\'s tool_response', (s) => ({ hook_event_name: 'PostToolBatch', ...WA, tool_calls: [{ tool_name: 'Read',
        tool_input: { file_path: path('r') }, tool_use_id: 'z5', tool_response: s }] })],
    ]) {
      const a = fireOne(home, { ...COMMON, ...mk('') }, `F2 fire: ${what}, 0 B`);
      const b = fireOne(home, { ...COMMON, ...mk(big) }, `F2 fire: ${what}, 4 MB`);
      sameSize(a, b, what);
    }
    const a = fireOne(home, '', 'F2 fire: parse_error, an empty stdin');
    const b = fireOne(home, big, 'F2 fire: parse_error, 4 MB of garbage');
    ok(a.rec !== null && a.rec.ev === 'parse_error' && isDeepStrictEqual(Object.keys(a.rec), ['v', 'ts', 'ev']),
      `F2 size: a parse_error record is v, ts, ev and nothing else | ${a.rec ? Object.keys(a.rec) : 'no record'}`);
    sameSize(a, b, 'parse_error, an empty stdin vs 4 MB of garbage');
  }
  if (want('cap')) {
    // the value cap (review finding 3): memory grows with the NUMBER of JSON values, not only with bytes (1M empty
    // objects are 2.9 MB of stdin and ~340 MB of memory), so a stdin with more than MAX_VALUES '{' '[' ',' outside
    // strings is not parsed: a parse_error record, as over 32 MB. Each payload's count is computed on the value
    // (structural(), not the hook's byte scan).
    const calls = [0, 1, 2].map((i) => ({ tool_name: 'Read', tool_input: {}, tool_use_id: `v${i}`, tool_response: txt('r') }));
    const batchRec = { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', at: 'workflow-subagent', k: 'fileCabinet', a: 'read', tus: [h10('v0'), h10('v1'), h10('v2')], n: 3 };
    /** A Batch of the 3 calls with an unread `pad` array as its LAST member, sized so that the count is exactly `count`. */
    const withCount = (count, before = {}) => {
      const p = { ...COMMON, hook_event_name: 'PostToolBatch', ...WA, tool_calls: calls, ...before, pad: [] };
      p.pad = new Array(Math.max(1, count - structural(p) + 1)).fill(0);
      ok(structural(p) === count, `S4 cap: the payload's count is ${structural(p)}, want ${count}`);
      return p;
    };
    ({ rec } = fireOne(home, withCount(MAX_VALUES), 'S4 fire: a Batch with exactly MAX_VALUES values'));
    exact(rec, batchRec, `S4 cap: ${MAX_VALUES} values are parsed (the cap is inclusive)`);
    ({ rec } = fireOne(home, withCount(MAX_VALUES + 1), 'S4 fire: one value over the cap'));
    exact(rec, { ev: 'parse_error' }, `S4 cap: ${MAX_VALUES + 1} values: a parse_error record, nothing parsed`);
    // { [ , inside strings are never values: a 1.2 MB tool response made of 1.2 million of them is parsed. It spans
    // many stdin chunks (about 64 KB each), so a scan done chunk by chunk would also have to carry its string state
    const one = { ...batchRec, tus: [h10('v0')], n: 1 };
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'PostToolBatch', ...WA, tool_calls: [{ ...calls[0], tool_response: '{[,'.repeat(400_000) }] },
      'S4 fire: 1.2 MB of { [ , inside a string'));
    exact(rec, one, 'S4 cap: 1.2 million { [ , inside a string are not values');
    // an escaped quote does not end a string: x\" and then 200,000 braces, all inside the string
    ({ rec } = fireOne(home, { ...COMMON, hook_event_name: 'PostToolBatch', ...WA, tool_calls: [{ ...calls[0], tool_response: `x"${'{'.repeat(200_000)}` }] },
      'S4 fire: an escaped quote, then braces'));
    exact(rec, one, 'S4 cap: after \\" the string goes on (the 200,000 braces inside it are not values)');
    // ...but an escaped BACKSLASH does not escape the quote after it: a string ending in \ (written "x\\") is closed, so
    // the values after it count; its twin at the cap is parsed
    ({ rec } = fireOne(home, withCount(MAX_VALUES + 1, { note: 'x\\' }), 'S4 fire: a string ending in a backslash, then one value over the cap'));
    exact(rec, { ev: 'parse_error' }, 'S4 cap: a string ending in \\ is closed by its quote, so the values after it count (parse_error)');
    ({ rec } = fireOne(home, withCount(MAX_VALUES, { note: 'x\\' }), 'S4 fire: a string ending in a backslash, at the cap'));
    exact(rec, batchRec, 'S4 cap: ...and the same payload at the cap is parsed');
  }
}

// The S4 mutants: [group, name, [[exact target text in spool-hook.mjs, replacement], ...]]; each target exactly once.
const HOOK_MUTANTS = [
  ['at', 'at only on SubagentStart / SubagentStop (the old rule)', [[
    "const AT_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure']);",
    "const AT_EVENTS = new Set(['SubagentStart', 'SubagentStop']);"]]],
  ['ids', 'ids keep the agent- prefix (the old rule)', [[
    "  const s = stripAgent(x);\n  return RE_ID.test(s) ? s : '#' + sha(s).slice(0, 12);", "  return RE_ID.test(x) ? x : '#' + sha(stripAgent(x)).slice(0, 12);"]]],
  ['ids', 'only the first agent- prefix stripped (the stage-0 stripAgent; review finding 4)', [[
    "const stripAgent = (s) => s.replace(/^(?:agent-)+/, '');", "const stripAgent = (s) => (s.startsWith('agent-') ? s.slice(6) : s);"]]],
  ['tus', 'tus never cut (an over-long Batch line is dropped)', [[
    '    if (Array.isArray(rec.tus) && rec.tus.length) {\n      rec.tus.length = Math.max(0, rec.tus.length - Math.ceil((line.length + 1 - MAX_LINE) / TU_BYTES));\n    } else if (Array.isArray(rec.bt) && rec.bt.length) {',
    '    if (Array.isArray(rec.bt) && rec.bt.length) {']]],
  ['tus', 'tus not hashed (the raw tool_use_ids)', [[
    "    const tu = isDict(c) ? toolUseHash(own(c, 'tool_use_id')) : undefined;", "    const tu = isDict(c) ? own(c, 'tool_use_id') : undefined;"]]],
  ['tus', 'tus in reverse call order', [['  rec.tus = out;\n', '  rec.tus = out.reverse();\n']]],
  // the value cap (review finding 3)
  ['cap', 'no value cap (the stage-0 hook)', [['  finish(size > MAX_VALUES && overValueCap(buf) ? null : buf);', '  finish(buf);']]],
  ['cap', 'the cap exclusive (a payload of exactly MAX_VALUES values refused)', [['&& ++values > MAX_VALUES) return true;', '&& ++values >= MAX_VALUES) return true;']]],
  ['cap', 'the scan skipped below 1 MB (a wrong shortcut: only a stdin of at most MAX_VALUES bytes is safe to skip)', [[
    '  finish(size > MAX_VALUES && overValueCap(buf) ? null : buf);', '  finish(size > 1048576 && overValueCap(buf) ? null : buf);']]],
  ['cap', '{ [ , inside strings counted (no string state)', [['    if (inString) {\n', '    if (false) {\n']]],
  ['cap', 'backslash escapes ignored (\\" ends the string)', [['      else if (b === 0x5c) escaped = true;                         // a backslash escapes the next byte\n', '']]],
  ['cap', 'a quote after a backslash BYTE always taken as escaped (the previous byte, not the escape state: "x\\\\" never closes)', [[
    '      if (escaped) escaped = false;\n      else if (b === 0x5c) escaped = true;                         // a backslash escapes the next byte\n      else if (b === 0x22) inString = false;                       // the closing quote\n',
    '      if (b === 0x22 && buf[i - 1] !== 0x5c) inString = false;\n']]],
];

// ------------------------------------------------------------------------------------------------ run
try {
  section('install into a temp home (twice: idempotent)');
  for (const round of [1, 2]) {
    const r = spawnSync(process.execPath, [join(OBS, 'install-hook.mjs')], { env: childEnv(HOME), timeout: 60000, windowsHide: true });
    const out = r.stdout.toString();
    ok(r.status === 0, `install round ${round}: exit 0 (stderr: ${r.stderr.toString().slice(0, 300)})`);
    const want = round === 1 ? 'installed' : 'unchanged';
    const states = [...out.matchAll(/^ {2}(classify|spool-hook)\.mjs +(\w+) /gm)].map((m) => `${m[1]}:${m[2]}`).sort();
    ok(isDeepStrictEqual(states, [`classify:${want}`, `spool-hook:${want}`]), `install round ${round}: both files ${want} (${states})\n${out}`);
    ok(out.includes('self-check PASS'), `install round ${round}: self-check passes`);
  }
  ok(isDeepStrictEqual(readdirSync(join(HOME, 'bin')).sort(), ['classify.mjs', 'spool-hook.mjs']), 'bin holds exactly the two files');
  for (const f of ['classify.mjs', 'spool-hook.mjs']) {
    ok(readFileSync(join(HOME, 'bin', f)).equals(readFileSync(join(OBS, f))), `installed ${f} is byte-identical to the repo copy`);
  }
  ok(statSync(join(HOME, 'spool')).isDirectory() && readdirSync(join(HOME, 'spool')).length === 0, 'spool folder exists and is empty');

  section('every event type of plan 4.1');
  let [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', ...SUB }, 'SubagentStart');
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: AID, at: 'Explore' }, 'SubagentStart record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash',
    tool_input: bashInput(`git status && npm test -- --grep ${MARK} > C:/${MARK}/o.txt`, { timeout: 120000, run_in_background: true }),
    tool_use_id: `toolu_01${MARK}pre` }, 'PreToolUse Bash in a helper');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, k: 'benchTerminal', a: 'run', tu: h10(`toolu_01${MARK}pre`), bg: true, to: 120 }, 'PreToolUse Bash record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path('read') }, tool_use_id: 'toolu_read1' }, 'PreToolUse Read, main thread');
  exact(rec, { sid: SID, ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: h10('toolu_read1') }, 'PreToolUse Read record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'PowerShell',
    tool_input: { command: `Get-Content ${path('ps')}`, timeout: 1500, run_in_background: 'TRUE' }, tool_use_id: 'toolu_ps1' }, 'PreToolUse PowerShell');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, k: 'fileCabinet', a: 'read', tu: h10('toolu_ps1'), bg: true, to: 2 }, 'PowerShell record (ms -> s, rounded up)');

  for (const [inp, k, a, what] of [
    [{ prompt: txt('agent-prompt'), description: txt('agent-desc'), subagent_type: 'general-purpose' }, 'frontDesk', 'helper-bg', 'Agent, flag omitted = background'],
    [{ prompt: txt('agent-prompt'), run_in_background: true }, 'frontDesk', 'helper-bg', 'Agent, background'],
    [{ prompt: txt('agent-prompt'), run_in_background: false }, 'meetingTable', 'helper-fg', 'Agent, explicit foreground'],
  ]) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Agent', tool_input: inp, tool_use_id: 'toolu_ag' }, `PreToolUse ${what}`);
    exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, k, a, tu: h10('toolu_ag') }, `PreToolUse ${what} record`);
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'ToolSearch', tool_input: { query: txt('q') }, tool_use_id: 'toolu_ts' }, 'PreToolUse ToolSearch');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, a: 'toolsearch', tu: h10('toolu_ts') }, 'ToolSearch: no kind, the observer applies the library rule');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: `${MARK}@x.com`, body: txt('mail') }, tool_use_id: 'toolu_m' }, 'PreToolUse MCP mail');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, k: 'pigeonholes', a: 'mail-send', tu: h10('toolu_m') }, 'MCP mail record');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: `mcp__${MARK}__frob`, tool_input: { x: txt('x') }, tool_use_id: 'toolu_u' }, 'PreToolUse unknown MCP tool');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, a: 'none', tu: h10('toolu_u') }, 'unknown tool: no move, tool name not written');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: `${MARK} not a dict`, tool_use_id: 'toolu_bad' }, 'PreToolUse malformed tool_input');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, tu: h10('toolu_bad') }, 'malformed tool_input: record without a category');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash',
    tool_input: bashInput('sleep 5', { timeout: 'x', run_in_background: false }), tool_use_id: 'toolu_s' }, 'PreToolUse odd timeout');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, k: 'benchTerminal', a: 'wait', tu: h10('toolu_s') }, 'non-numeric timeout and explicit false: no to, no bg');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: bashInput('ls', { timeout: 1e12 }), tool_use_id: 'toolu_l' }, 'PreToolUse absurd timeout');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, k: 'fileCabinet', a: 'list', tu: h10('toolu_l') }, 'timeout over a day is dropped');

  const big = 'x'.repeat(200_000) + MARK;
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
    { tool_name: 'Read', tool_input: { file_path: path('b1') }, tool_use_id: 't1', tool_response: big },
    { tool_name: 'Bash', tool_input: bashInput(`npm test ${MARK}`), tool_use_id: 't2', tool_response: JSON.stringify({ stdout: txt('stdout'), stderr: txt('stderr') }) },
    { tool_name: 'Grep', tool_input: { pattern: txt('pattern'), path: path('g') }, tool_use_id: 't3', tool_response: { filenames: [path('f')] } },
  ] }, 'PostToolBatch (3 calls)');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, k: 'benchTerminal', a: 'run', tus: [h10('t1'), h10('t2'), h10('t3')], n: 3 }, 'Batch: precedence picks the run');
  // A batch's tool_response is the tool_result TEXT the model saw (hooks.md, PostToolBatch input), not AgentOutput:
  // nothing in it may change the category. An Agent call in a batch is always classified by the hook-time rule.
  const agentText = [
    ['JSON-looking report text', JSON.stringify({ status: 'completed', agentId: 'agent-x1', content: [{ type: 'text', text: txt('report') }] })],
    ['JSON report + agentId/usage trailer', `${JSON.stringify({ status: 'completed', summary: txt('s') })}\nagentId: a4d2c8f1e0b3a297\n<usage>total_tokens: 1</usage>`],
    ['content-block array', [{ type: 'text', text: `${txt('t')} status: completed` }]],
    ['an object (not documented for batches)', { status: 'completed', agentId: 'agent-x3' }],
  ];
  for (const [what, resp] of agentText) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
      { tool_name: 'Edit', tool_input: { file_path: path('e'), old_string: txt('o'), new_string: txt('n') }, tool_use_id: 't4', tool_response: txt('edit') },
      { tool_name: 'Agent', tool_input: { prompt: txt('p') }, tool_use_id: 't5', tool_response: resp },
    ] }, `PostToolBatch Agent (flag omitted), response = ${what}`);
    exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, k: 'frontDesk', a: 'helper-bg', tus: [h10('t4'), h10('t5')], n: 2 }, `Batch Agent, ${what}: the hook-time rule (omitted = background)`);
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
    { tool_name: 'Agent', tool_input: { prompt: txt('p'), run_in_background: false }, tool_use_id: 't6',
      tool_response: JSON.stringify({ status: 'async_launched', agentId: 'agent-x2', prompt: txt('p2'), outputFile: path('of') }) },
    { tool_name: 'Read', tool_input: { file_path: path('r') }, tool_use_id: 't7', tool_response: txt('r') },
  ] }, 'PostToolBatch Agent, explicit foreground, response text says async_launched');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, k: 'meetingTable', a: 'helper-fg', tus: [h10('t6'), h10('t7')], n: 2 }, 'Batch: the explicit flag decides, never the response text');
  // tsr: would a ToolSearch call win the batch at a library station (the observer re-applies the library rule)
  for (const [names, k, a, tsr] of [
    [['ToolSearch', 'Read'], 'fileCabinet', 'read', true], [['Read', 'ToolSearch'], 'fileCabinet', 'read', true],
    [['ToolSearch'], undefined, 'toolsearch', true], [['Skill', 'ToolSearch'], 'manualsShelf', 'procedure', false],
    [['ToolSearch', 'Skill'], 'manualsShelf', 'procedure', true], [['ToolSearch', 'WebSearch'], 'cardCatalog', 'websearch', false],
  ]) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB,
      tool_calls: names.map((nm, i) => ({ tool_name: nm, tool_input: { query: txt('q') }, tool_use_id: `ts${i}`, tool_response: txt('r') })) },
    `PostToolBatch ${names.join(' + ')}`);
    const want = { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT };
    if (k) want.k = k;
    want.a = a;
    if (tsr) want.tsr = true;
    want.tus = names.map((_, i) => h10(`ts${i}`));
    want.n = names.length;
    exact(rec, want, `Batch ${names.join(' + ')}: tsr ${tsr}`);
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [{ tool_name: 'Read', tool_input: {}, tool_use_id: 't8', tool_response: txt('r') }] }, 'PostToolBatch single call');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, k: 'fileCabinet', a: 'read', tus: [h10('t8')], n: 1 }, 'Batch of one');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [`${MARK} not a call`, { tool_name: 'Read' }] }, 'PostToolBatch malformed call');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, tus: [], n: 2 }, 'Batch with a malformed call: count only (and no tool_use_id to hash)');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [] }, 'PostToolBatch empty');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, a: 'none', tus: [], n: 0 }, 'empty Batch');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB }, 'PostToolBatch without tool_calls');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT }, 'Batch without tool_calls');
  // F11 (lead ruling 2026-10-01), through the INSTALLED classifier: a roster look never hides a real call in its batch
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
    { tool_name: 'Read', tool_input: { file_path: path('f11') }, tool_use_id: 'f1', tool_response: txt('r') },
    { tool_name: 'ListAgents', tool_input: {}, tool_use_id: 'f2', tool_response: txt('roster') }] }, 'PostToolBatch Read + ListAgents');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, k: 'fileCabinet', a: 'read', tus: [h10('f1'), h10('f2')], n: 2 },
    'F11: Read + ListAgents is a read at the cabinets (the roster look ranks below every station)');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'ListAgents', tool_input: {}, tool_use_id: 'f3' }, 'PreToolUse ListAgents');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, k: 'inOutBoard', a: 'roster', tu: h10('f3') }, 'F11: ListAgents alone is still inOutBoard (a STAY at the observer)');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', ...SUB, tool_name: 'Agent', tool_input: { prompt: txt('p'), description: txt('d') },
    tool_use_id: 'toolu_ag', duration_ms: 12, tool_response: { status: 'async_launched', agentId: 'agent-c0ffee', description: txt('rd'),
      prompt: txt('rp'), outputFile: path('out'), resolvedModel: `${MARK}-model` } }, 'PostToolUse Agent launched');
  exact(rec, { sid: SID, ev: 'PostToolUse', aid: AID, at: AT, k: 'frontDesk', a: 'helper-bg', tu: h10('toolu_ag'), st: 'async_launched', ch: 'c0ffee' }, 'Post Agent async record (the child id without its agent- prefix)');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: txt('p') }, tool_use_id: 'toolu_ag2',
    tool_response: { status: 'completed', agentId: 'c0ffe2', content: [{ type: 'text', text: txt('report') }], totalDurationMs: 5, totalToolUseCount: 3 } }, 'PostToolUse Agent completed');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'meetingTable', a: 'helper-fg', tu: h10('toolu_ag2'), st: 'completed', ch: 'c0ffe2' }, 'Post Agent completed record');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_use_id: 'toolu_ag3',
    tool_response: { status: 'async_launched', agentId: `agent-${MARK}/../x y` } }, 'PostToolUse Agent, child id that is not an id');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'frontDesk', a: 'helper-bg', tu: h10('toolu_ag3'), st: 'async_launched', ch: hid(`agent-${MARK}/../x y`) }, 'a child id that is not an id is hashed');
  // A STRING tool_response is text: never parsed, so no status or id from it (it could be any text, even a key).
  const keyLike = `sk-ant-api03-${MARK}-abcdefghijklmnop`;
  for (const [tool, resp] of [['Agent', { status: `${MARK}status`, agentId: keyLike }], ['Agent', { status: 'completed', agentId: keyLike, taskId: keyLike }],
    ['Workflow', { status: 'async_launched', runId: keyLike, taskId: keyLike, error: txt('e') }]]) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { run_in_background: false }, tool_use_id: 'toolu_str',
      tool_response: JSON.stringify(resp) }, `PostToolUse ${tool}, response is a JSON string`);
    exact(rec, { sid: SID, ev: 'PostToolUse', ...(tool === 'Agent' ? { k: 'meetingTable', a: 'helper-fg' } : { k: 'kanbanBoard', a: 'tasks' }), tu: h10('toolu_str') },
      `${tool} string response: no st / ch / tid / run / err, category from the input only`);
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { run_in_background: false }, tool_use_id: 'toolu_rl',
    tool_response: { status: 'remote_launched', taskId: 'r9t8', sessionUrl: url('session'), description: txt('d'), prompt: txt('p'), outputFile: path('o') } },
  'PostToolUse Agent remote_launched');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'frontDesk', a: 'helper-bg', tu: h10('toolu_rl'), st: 'remote_launched', tid: 'r9t8' },
    'Agent remote_launched: returned at once to a cloud session (background, whatever the flag), with its task id');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_use_id: 'toolu_unk',
    tool_response: { status: `${MARK} new status`, agentId: 'agent-z9' } }, 'PostToolUse Agent, undocumented status');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'frontDesk', a: 'helper-bg', tu: h10('toolu_unk'), st: 'other', ch: 'z9' }, 'an undocumented status is written as other');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', ...SUB, tool_name: 'Workflow', tool_input: { script: txt('script') }, tool_use_id: 'toolu_wf',
    tool_response: { status: 'async_launched', taskId: 'w7k2m9', taskType: 'local_workflow', runId: 'wf_42', workflowName: txt('wf'),
      summary: txt('sum'), transcriptDir: path('td'), scriptPath: path('sp'), warning: txt('warn') } }, 'PostToolUse Workflow');
  exact(rec, { sid: SID, ev: 'PostToolUse', aid: AID, at: AT, k: 'kanbanBoard', a: 'tasks', tu: h10('toolu_wf'), st: 'async_launched', tid: 'w7k2m9' },
    'Post Workflow record (the runId is not written: lead ruling F1)');
  for (const [error, err, what] of [[`SyntaxError: ${txt('e')}`, true, 'syntax error'], ['', false, 'empty error'], [42, false, 'non-string error']]) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Workflow', tool_input: { script: txt('s') }, tool_use_id: 'toolu_wfe',
      tool_response: { status: 'async_launched', taskId: 'w7k2m9', taskType: 'local_workflow', runId: 'run_5f3a', error } }, `PostToolUse Workflow, ${what}`);
    exact(rec, { sid: SID, ev: 'PostToolUse', k: 'kanbanBoard', a: 'tasks', tu: h10('toolu_wfe'), st: 'async_launched', tid: 'w7k2m9', ...(err ? { err: true } : {}) },
      `Workflow ${what}: err ${err} (the text is never written)`);
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Workflow', tool_input: {}, tool_use_id: 'toolu_wfr',
    tool_response: { status: 'remote_launched', taskId: `${MARK} task/id`, taskType: 'remote_agent', sessionUrl: url('wf') } }, 'PostToolUse Workflow remote_launched');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'kanbanBoard', a: 'tasks', tu: h10('toolu_wfr'), st: 'remote_launched', tid: hid(`${MARK} task/id`) },
    'Workflow remote_launched: no runId; a task id that is not an id is hashed');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', ...SUB, tool_name: 'SubagentHandback', tool_input: { report: txt('report') },
    tool_use_id: 'toolu_hb', tool_response: txt('hb') }, 'PostToolUse SubagentHandback');
  exact(rec, { sid: SID, ev: 'PostToolUse', aid: AID, at: AT, k: 'printer', a: 'report', tu: h10('toolu_hb') }, 'Post handback record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUseFailure', ...SUB, tool_name: 'Bash', tool_input: bashInput('npm test'),
    tool_use_id: 'toolu_f1', error: `Exit code 1\n${txt('error-output')} at ${path('stack')}`, is_interrupt: false, duration_ms: 100 }, 'PostToolUseFailure');
  exact(rec, { sid: SID, ev: 'PostToolUseFailure', aid: AID, at: AT, k: 'benchTerminal', a: 'run', tu: h10('toolu_f1'), intr: false }, 'Failure record');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: path('x') }, tool_use_id: 'toolu_f2',
    error: txt('interrupted'), is_interrupt: true }, 'PostToolUseFailure interrupt');
  exact(rec, { sid: SID, ev: 'PostToolUseFailure', k: 'pcDesk', a: 'write', tu: h10('toolu_f2'), intr: true }, 'Failure interrupt record');

  const tasksIn = [
    { id: 'b1x9', type: 'shell', status: 'running', description: txt('btd'), command: cmd('btc') },
    { id: `${MARK} bad id/with space`, type: 'subagent', status: 'completed', agent_type: txt('bat'), description: txt('d2') },
    { id: 'wf_7', type: 'workflow', status: 'running', name: txt('btn') },
    { id: 'm1', type: 'monitor', status: 'running', server: txt('srv'), tool: txt('tool') },
    `${MARK} not an object`,
    { id: 'x9', type: `${MARK} type`, status: `${MARK}/status` },
    { id: 'c7', type: 'cloud session', status: 'running', description: txt('cloud') },
    { id: 'p3', type: 'MCP task', status: 'running', server: txt('srv'), tool: txt('tool') },
    { id: 't2', type: 'teammate', status: 'running', description: txt('tm') },
    { id: 'r1', type: 'local_bash', status: 'pending' },
  ];
  const tasksOut = [{ id: 'b1x9', type: 'shell', status: 'running' }, { id: hid(`${MARK} bad id/with space`), type: 'subagent', status: 'completed' },
    { id: 'wf_7', type: 'workflow', status: 'running' }, { id: 'm1', type: 'monitor', status: 'running' }, { id: 'x9' },
    { id: 'c7', type: 'cloud-session', status: 'running' }, { id: 'p3', type: 'mcp-task', status: 'running' },
    { id: 't2', type: 'teammate', status: 'running' }, { id: 'r1', type: 'local_bash', status: 'pending' }];
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStop', agent_id: 'agent-a1b2c3', agent_type: 'workflow-subagent', stop_hook_active: false,
    agent_transcript_path: path('atp'), last_assistant_message: txt('lam'), background_tasks: tasksIn,
    session_crons: [{ id: 'c1', schedule: '*/5 * * * *', prompt: txt('cron') }] }, 'SubagentStop');
  exact(rec, { sid: SID, ev: 'SubagentStop', aid: AID, at: 'workflow-subagent', bt: tasksOut },
    'SubagentStop record (the documented labels "cloud session" / "MCP task" kept; a free-text type still dropped; a bad id hashed)');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStop', agent_type: '', last_assistant_message: txt('lam2') }, 'SubagentStop of an internal agent');
  exact(rec, { sid: SID, ev: 'SubagentStop', at: '' }, 'internal agent: empty agent_type kept, no background_tasks field');

  const many = Array.from({ length: 60 }, (_, i) => ({ id: `task${i}`, type: 'shell', status: 'running', command: cmd(`many${i}`), description: txt(`m${i}`) }));
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: txt('stop-lam'), background_tasks: many,
    session_crons: [{ prompt: txt('cron2') }] }, 'Stop with 60 tasks');
  exact(rec, { sid: SID, ev: 'Stop', bt: many.slice(0, 50).map(({ id, type, status }) => ({ id, type, status })) }, 'Stop: at most 50 tasks, id/type/status only');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'Stop', last_assistant_message: txt('x') }, 'Stop without background_tasks');
  exact(rec, { sid: SID, ev: 'Stop' }, 'Stop without the task registry: no bt');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'Stop', background_tasks: [] }, 'Stop with no tasks');
  exact(rec, { sid: SID, ev: 'Stop', bt: [] }, 'Stop with an empty task list: bt = []');

  for (const [reason, want] of [['prompt_input_exit', 'prompt_input_exit'], ['clear', 'clear'], ['resume', 'resume'],
    ['bypass_permissions_disabled', 'bypass_permissions_disabled'], [`${MARK} reason with space`, undefined], [42, undefined]]) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SessionEnd', reason }, `SessionEnd ${reason}`);
    exact(rec, want === undefined ? { sid: SID, ev: 'SessionEnd' } : { sid: SID, ev: 'SessionEnd', r: want }, `SessionEnd ${reason} record`);
  }

  section('other events, odd names');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'UserPromptSubmit' }, 'UserPromptSubmit');
  exact(rec, { sid: SID, ev: 'UserPromptSubmit' }, 'a known event outside the plan: no fields beyond the common ones');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'FutureEventName', ...SUB }, 'unknown event');
  exact(rec, { sid: SID, ev: 'other', aid: AID }, 'unknown event name -> other');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: `PreToolUse ${MARK}` }, 'event name with junk');
  exact(rec, { sid: SID, ev: 'other' }, 'event name with junk -> other');
  [rec] = fireExpect(HOME, { session_id: SID }, 'no event name');
  exact(rec, { sid: SID, ev: 'other' }, 'missing event name -> other');

  section('field limits');
  // An id that is not a plain id is HASHED, never dropped: a dropped agent_id would make a helper's call look like
  // the main thread's. Any agent- prefix is stripped before both the plain-id test and the hash, so every form of one
  // id is written the same way (key(id) below: a written id is already its own join key).
  const key = (id) => (id.startsWith('#') ? id : hid(id));
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', session_id: 's'.repeat(10000), agent_id: 'agent-' + 'a'.repeat(65), agent_type: 'T'.repeat(65) }, 'oversized ids');
  exact(rec, { sid: hid('s'.repeat(10000)), ev: 'SubagentStart', aid: hid('a'.repeat(65)) }, 'ids over 64 characters are hashed (agent_type over 64 is dropped)');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', agent_id: 'a'.repeat(64), agent_type: 'feature-dev:code-reviewer' }, '64-character id');
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'a'.repeat(64), at: 'feature-dev:code-reviewer' }, 'a 64-character id is kept raw');
  const raw64 = rec && rec.aid;
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', agent_id: 'agent-' + 'a'.repeat(64) }, '64-character id with the agent- prefix (70 chars)');
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'a'.repeat(64) }, 'the prefix is stripped BEFORE the plain-id test: the 64 characters left are written raw');
  ok(rec && raw64 && rec.aid === raw64 && key(rec.aid) === key(raw64), 'the prefixed form and the raw form are the same id');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', session_id: `${MARK}/session id`, agent_id: `agent-C:/${MARK}/x y`, agent_type: `${MARK} type/x` }, 'path-like ids');
  exact(rec, { sid: hid(`${MARK}/session id`), ev: 'SubagentStart', aid: hid(`agent-C:/${MARK}/x y`) }, 'ids with path or space characters are hashed');
  for (const id of ['x@host', 'team/worker-1', 'a'.repeat(65), 'agent-' + 'b'.repeat(65)]) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', agent_id: id, agent_type: 'general-purpose', tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' }, tool_use_id: 'toolu_lid' }, `PreToolUse in a helper whose agent_id is ${JSON.stringify(id.slice(0, 20))}...`);
    exact(rec, { sid: SID, ev: 'PreToolUse', aid: hid(id), at: 'general-purpose', k: 'shredder', a: 'delete', tu: h10('toolu_lid') }, 'the call keeps a (hashed) aid: not mistaken for the main thread');
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', agent_id: '', tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_eid' }, 'empty agent_id');
  exact(rec, { sid: SID, ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: h10('toolu_eid') }, 'an empty agent_id is absent (no id to hash)');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 'u'.repeat(100000) }, 'huge tool_use_id');
  exact(rec, { sid: SID, ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: h10('u'.repeat(100000)) }, 'tu stays 10 hex');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', agent_id: 'abc-no-prefix' }, 'id without the agent- prefix');
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'abc-no-prefix' }, 'an id without the prefix is kept as is');
  // the docs' own examples (hooks.md SubagentStart agent-abc123, SubagentStop def456, Post(Agent) a4d2c8f1e0b3a297):
  // the agent- prefix is stripped (plan 5.2; probe 3 found none in the real payloads), the rest written as given
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', agent_id: 'agent-abc123', agent_type: 'Explore' }, 'docs example SubagentStart id');
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'abc123', at: 'Explore' }, 'S4: the agent- prefix is stripped (plan 5.2)');

  section('step 4 stage 0 (S4): ids without agent-, at on tool events, tus, the value cap; F1: no run, no path read; F2: no cost fields, no growth with size');
  s4Checks(HOME);

  section('classification cap: shell commands over 65,536 characters are not classified');
  for (const [len, classified] of [[65536, true], [65537, false]]) {
    const command = 'ls ' + 'a'.repeat(len - 3);
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_cap' }, `Pre, ${len}-char command`);
    exact(rec, { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, ...(classified ? { k: 'fileCabinet', a: 'list' } : {}), tu: h10('toolu_cap') },
      `${len} chars: ${classified ? 'classified' : 'no k / a'}`);
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
    { tool_name: 'Bash', tool_input: { command: 'node a.js ' + 'x'.repeat(65536) }, tool_use_id: 'c1', tool_response: txt('r') },
    { tool_name: 'Read', tool_input: {}, tool_use_id: 'c2', tool_response: txt('r') }] }, 'Batch with an over-cap command');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, tus: [h10('c1'), h10('c2')], n: 2 }, 'a batch holding an over-cap command has no category (count and hashes only)');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUseFailure', ...SUB, tool_name: 'PowerShell', tool_input: { command: 'Get-Content ' + 'f'.repeat(70000) },
    tool_use_id: 'toolu_capf', is_interrupt: false }, 'Failure with an over-cap command');
  exact(rec, { sid: SID, ev: 'PostToolUseFailure', aid: AID, at: AT, tu: h10('toolu_capf'), intr: false }, 'over-cap PowerShell command: no category');

  section('malformed, empty and large stdin');
  const parseErr = (input, what) => {
    const [r2] = fireExpect(HOME, input, what);
    exact(r2, { ev: 'parse_error' }, `${what}: parse_error record only`);
  };
  parseErr('', 'empty stdin');
  parseErr('   \n\t', 'whitespace stdin');
  parseErr('{"session_id":', 'truncated JSON');
  parseErr('null', 'JSON null');
  parseErr('[]', 'JSON array');
  parseErr(`"${MARK} a string"`, 'JSON string');
  parseErr('42', 'JSON number');
  parseErr(`${MARK} garbage {`, 'garbage');
  parseErr(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256)), 'binary bytes');
  parseErr(Buffer.alloc(1 << 20, 0x5a), '1 MB of garbage');
  [rec] = fireExpect(HOME, '\ufeff' + JSON.stringify({ ...COMMON, hook_event_name: 'SessionEnd', reason: 'other' }), 'UTF-8 BOM before valid JSON');
  exact(rec, { sid: SID, ev: 'SessionEnd', r: 'other' }, 'BOM is tolerated');
  const oneMb = JSON.stringify({ ...COMMON, hook_event_name: 'PostToolBatch', ...SUB,
    tool_calls: [{ tool_name: 'Read', tool_input: { file_path: path('big') }, tool_use_id: 'tb', tool_response: `${MARK} `.repeat(95_000) }] });
  ok(oneMb.length > 1_000_000, `the large payload is over 1 MB (${oneMb.length} bytes)`);
  [rec] = fireExpect(HOME, oneMb, '1 MB valid payload');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: AID, at: AT, k: 'fileCabinet', a: 'read', tus: [h10('tb')], n: 1 }, '1 MB payload is classified');
  await waitForRam(1.0, 'the 33 MB stdin test');
  const huge = Buffer.alloc(33 * 1024 * 1024, 0x20);
  Buffer.from(JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' })).copy(huge, 0);
  parseErr(huge, '33 MB stdin (over the 32 MB cap)');

  section('OFFICE_AGENT_ID guard');
  fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 'g1' }, 'OFFICE_AGENT_ID set', 0, { OFFICE_AGENT_ID: 'physics-fable-1' });
  fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 'g2' }, 'OFFICE_AGENT_ID empty (= unset, like the PowerShell guard)', 1, { OFFICE_AGENT_ID: '' });

  section('stdin that never closes (5 s deadline)');
  {
    firings += 1;
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(HOME, 'bin', 'spool-hook.mjs')], { env: childEnv(HOME), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = 0, err = '';
    child.stdout.on('data', (d) => { out += d.length; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.write('{"hook_event_name":"PreToolUse"');            // never ended
    const code = await new Promise((res) => child.on('close', (c) => res(c)));
    const ms = Date.now() - t0;
    child.stdin.destroy();
    ok(code === 0 && out === 0 && err === '', `open stdin: exit ${code}, stdout ${out} bytes, stderr "${err.slice(0, 200)}"`);
    ok(ms >= 4500 && ms < 15000, `open stdin: the hook gave up after the deadline (${ms} ms)`);
    const lines = newLines(HOME);
    ok(lines.length === 1, `open stdin: one line (got ${lines.length})`);
    if (lines.length === 1) exact(validate(lines[0], 'open stdin', { t0, t1: Date.now() }), { ev: 'parse_error' }, 'open stdin: parse_error record');
  }

  section('failure paths: missing / broken classifier, spool path is a file, no spool folder');
  const homeOf = (name, files) => {
    const h = join(TMP, name);
    mkdirSync(join(h, 'bin'), { recursive: true });
    for (const [f, content] of files) {
      if (content === null) copyFileSync(join(HOME, 'bin', f), join(h, 'bin', f));
      else writeFileSync(join(h, 'bin', f), content);
    }
    return h;
  };
  const prePayload = { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: bashInput('npm test', { timeout: 60000 }), tool_use_id: 'toolu_fp' };
  const noCat = { sid: SID, ev: 'PreToolUse', aid: AID, at: AT, tu: h10('toolu_fp'), to: 60 };
  const H_MISSING = homeOf('home-no-classifier', [['spool-hook.mjs', null]]);
  [rec] = fireExpect(H_MISSING, prePayload, 'classify.mjs missing');
  exact(rec, noCat, 'classify.mjs missing: record without a category');
  const H_BROKEN = homeOf('home-broken-classifier', [['spool-hook.mjs', null], ['classify.mjs', 'export const = ;\n']]);
  [rec] = fireExpect(H_BROKEN, prePayload, 'classify.mjs with a syntax error');
  exact(rec, noCat, 'broken classify.mjs: record without a category');
  const H_THROWS = homeOf('home-throwing-classifier', [['spool-hook.mjs', null], ['classify.mjs', 'throw new Error("boom");\n']]);
  [rec] = fireExpect(H_THROWS, prePayload, 'classify.mjs that throws on load');
  exact(rec, noCat, 'throwing classify.mjs: record without a category');
  const H_FILE = homeOf('home-spool-is-a-file', [['spool-hook.mjs', null], ['classify.mjs', null]]);
  writeFileSync(join(H_FILE, 'spool'), 'not a folder');
  fireExpect(H_FILE, prePayload, 'spool path is a file', 0);
  ok(readFileSync(join(H_FILE, 'spool'), 'utf8') === 'not a folder', 'spool path is a file: left untouched');
  const H_FRESH = homeOf('home-without-spool', [['spool-hook.mjs', null], ['classify.mjs', null]]);
  [rec] = fireExpect(H_FRESH, prePayload, 'no spool folder yet');
  exact(rec, { ...noCat, k: 'benchTerminal', a: 'run' }, 'no spool folder: the hook creates it');

  section('hook-level classifier parity (the self-test commands, through the installed process)');
  for (const c of FIXTURE.shell) {
    const [r2] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: { command: c.cmd }, tool_use_id: 'toolu_fx' }, `fixture ${JSON.stringify(c.cmd)}`);
    const want = { sid: SID, ev: 'PreToolUse', aid: AID, at: AT };
    if (c.py[1] !== null) want.k = c.py[1];
    want.a = C.ACTIVITY_ID.get(c.py[0]);
    want.tu = h10('toolu_fx');
    exact(r2, want, `fixture ${JSON.stringify(c.cmd)} -> ${c.py}`);
  }
  for (const c of FIXTURE.nest.filter((x) => x.k <= 64 && x.k >= FIXTURE.maxSegmentNest - 1)) {   // P4 at the limit
    const command = c.pre.repeat(c.k) + c.mid + c.post.repeat(c.k);
    const [r2] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_nx' }, `nest ${JSON.stringify(c.pre)} x ${c.k}`);
    const want = { sid: SID, ev: 'PreToolUse', aid: AID, at: AT };
    if (c.py[1] !== null) want.k = c.py[1];
    want.a = C.ACTIVITY_ID.get(c.py[0]);
    want.tu = h10('toolu_nx');
    exact(r2, want, `nest ${JSON.stringify(c.pre)} x ${c.k} -> ${c.py}`);
  }

  section('memory: peak working set of one firing vs a `git status` firing (--import preload writes maxRSS on exit)');
  await waitForRam(1.0, 'the memory test');
  {
    const preload = join(TMP, 'maxrss-preload.mjs');
    writeFileSync(preload, [
      "import { writeFileSync } from 'node:fs';",
      'const out = process.env.WO_MAXRSS_OUT;',
      "if (out) process.on('exit', () => { try { writeFileSync(out, String(process.resourceUsage().maxRSS)); } catch { /* none */ } });",
      ''].join('\n'));
    /** Fire one payload under the preload: -> {mb: peak working set in MB, rec}. The child's JS heap is capped at
     *  512 MB so that a hook WITHOUT a bound (an older hook: the classifier's nesting bound, the value cap) dies instead
     *  of taking the machine's memory: a 64 KB chain would need gigabytes. */
    const measurePayload = (payload, what) => {
      firings += 1;
      const out = join(TMP, `maxrss-${firings}.txt`);
      const t0 = Date.now();
      const r = spawnSync(process.execPath, ['--max-old-space-size=512', '--import', pathToFileURL(preload).href, join(HOME, 'bin', 'spool-hook.mjs')], {
        input: JSON.stringify(payload), env: childEnv(HOME, { WO_MAXRSS_OUT: out }), timeout: 120000, windowsHide: true, maxBuffer: 1 << 20 });
      assertSilent(r, what);
      const lines = newLines(HOME);
      ok(lines.length === 1, `${what}: one new spool line (got ${lines.length})`);
      const rec = lines.length === 1 ? validate(lines[0], what, { t0, t1: Date.now() }) : null;
      const kb = existsSync(out) ? Number(readFileSync(out, 'utf8')) : NaN;
      ok(Number.isFinite(kb) && kb > 10_000, `${what}: maxRSS was recorded (${kb} KB)`);
      return { mb: kb / 1024, rec };
    };
    /** One PreToolUse Bash with `command`. */
    const measure = (command, what) => measurePayload({ ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_mem' }, what);
    const bases = [1, 2, 3].map((i) => measure('git status', `baseline git status #${i}`).mb).sort((x, y) => x - y);
    const base = bases[1];                                          // the median of three
    console.log(`  baseline (git status): ${bases.map((x) => x.toFixed(1)).join(' / ')} MB, median ${base.toFixed(1)} MB`);
    const chain = (pre, n, mid) => pre.repeat(n) + mid;
    let bounded = true;
    for (const [what, command, maxUp, a] of [
      ['10 KB `$a = ` chain (2000 levels)', chain('$a = ', 2000, 'x'), 12, 'none'],
      ['10 KB `a=$( ` chain (2000 levels)', chain('a=$( ', 2000, 'x'), 12, 'none'],
      ['64 KB `$a = ` chain at the cap', chain('$a = ', 13106, 'rm x'), 24, 'none'],
      ['64 KB ordinary command at the cap', 'ls ' + 'ab '.repeat(21844), 24, 'list'],
      ['1 MB command over the cap (not classified)', 'ls ' + 'ab '.repeat(349525), 24, undefined],
    ]) {
      if (!bounded && command.length > 20000) { ok(false, `${what}: not run (a 10 KB chain already broke the bound)`); continue; }
      const { mb, rec } = measure(command, what);
      if (command.length <= 20000 && !(mb - base <= maxUp)) bounded = false;
      console.log(`  ${what}: ${command.length} chars, peak ${mb.toFixed(1)} MB (+${(mb - base).toFixed(1)} MB)`);
      ok(mb - base <= maxUp, `${what}: peak ${mb.toFixed(1)} MB is at most ${maxUp} MB above the git status baseline ${base.toFixed(1)} MB`);
      ok(rec && rec.a === a, `${what}: activity ${rec && rec.a} (want ${a})`);
    }
    // the value cap (review finding 3): memory grows with the number of JSON values (~300 bytes per empty call), which
    // the 32 MB byte cap does not bound. A Batch of tiny calls over the cap is refused before it is parsed; one at the
    // cap is the most a payload of tiny objects can cost
    const tiny = (n) => ({ ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: Array.from({ length: n }, () => ({})) });
    const atCap = Math.floor((MAX_VALUES - structural(tiny(0)) + 1) / 2);
    ok(structural(tiny(atCap)) <= MAX_VALUES && structural(tiny(atCap + 1)) > MAX_VALUES, `memory: ${atCap} empty calls is the largest Batch of them under the value cap`);
    for (const [what, n, maxUp, ev] of [
      [`200,000 empty calls (${(JSON.stringify(tiny(200_000)).length / 1048576).toFixed(2)} MB, over the value cap)`, 200_000, 24, 'parse_error'],
      [`${atCap} empty calls (at the value cap)`, atCap, 48, 'PostToolBatch'],
    ]) {
      const { mb, rec } = measurePayload(tiny(n), what);
      console.log(`  ${what}: peak ${mb.toFixed(1)} MB (+${(mb - base).toFixed(1)} MB)`);
      ok(mb - base <= maxUp, `${what}: peak ${mb.toFixed(1)} MB is at most ${maxUp} MB above the git status baseline ${base.toFixed(1)} MB`);
      ok(rec && rec.ev === ev && (ev === 'parse_error' || rec.n === n), `${what}: record ${rec && rec.ev} n ${rec && rec.n} (want ${ev}${ev === 'parse_error' ? '' : ` n ${n}`})`);
    }
  }

  section('concurrency: 8 hooks at once, one of them a maximum-size Stop line');
  await waitForRam(0.8, 'the concurrency test');
  {
    const longTasks = Array.from({ length: 50 }, (_, i) => ({ id: `${String(i).padStart(2, '0')}${'i'.repeat(62)}`, type: 't'.repeat(32), status: 's'.repeat(32), command: cmd(`c${i}`) }));
    const payloads = Array.from({ length: 7 }, (_, i) => ({ ...COMMON, session_id: `conc-${i}`, hook_event_name: 'PreToolUse', ...SUB,
      tool_name: 'Bash', tool_input: bashInput(`node job${i}.js`), tool_use_id: `toolu_c${i}` }));
    payloads.push({ ...COMMON, session_id: 'conc-7', hook_event_name: 'Stop', background_tasks: longTasks, last_assistant_message: txt('conc') });
    const t0 = Date.now();
    const results = await Promise.all(payloads.map((p) => new Promise((res) => {
      firings += 1;
      const child = spawn(process.execPath, [join(HOME, 'bin', 'spool-hook.mjs')], { env: childEnv(HOME), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = 0, err = '';
      child.stdout.on('data', (d) => { out += d.length; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => res({ code, out, err }));
      child.stdin.end(JSON.stringify(p));
    })));
    const t1 = Date.now();
    results.forEach((x, i) => ok(x.code === 0 && x.out === 0 && x.err === '', `concurrent hook ${i}: exit ${x.code}, stdout ${x.out}, stderr "${x.err.slice(0, 200)}"`));
    const lines = newLines(HOME);
    ok(lines.length === 8, `concurrency: 8 new lines (got ${lines.length})`);
    const recs = lines.map((l, i) => validate(l, `concurrent line ${i}`, { t0, t1 }));
    const sids = recs.filter(Boolean).map((x) => x.sid).sort();
    ok(isDeepStrictEqual(sids, Array.from({ length: 8 }, (_, i) => `conc-${i}`)), `concurrency: every hook's line is there exactly once (${sids})`);
    const stop = recs.find((x) => x && x.sid === 'conc-7');
    ok(stop && stop.bt.length > 0 && stop.bt.length < 50, `concurrency: the oversized Stop line was trimmed to fit (bt ${stop && stop.bt.length})`);
    ok(lines.every((l) => l.length + 1 <= 4096), 'concurrency: every line within 4096 bytes');
    ok(Math.max(...lines.map((l) => l.length)) > 3000, 'concurrency: the Stop line is genuinely large (> 3000 bytes)');
  }

  section('S4 mutants: each planted mutant of the hook must fail its group of S4 checks');
  {
    const src = readFileSync(join(OBS, 'spool-hook.mjs'), 'utf8');
    let caughtN = 0;
    for (const [i, [group, name, edits]] of HOOK_MUTANTS.entries()) {
      let mutated = src, applied = true;
      for (const [target, replacement] of edits) {
        const hits = mutated.split(target).length - 1;
        if (hits !== 1) { ok(false, `MUTANT ${name}: target found ${hits} times (must be exactly 1): ${target.slice(0, 80)}`); applied = false; break; }
        mutated = mutated.replace(target, () => replacement);
      }
      if (!applied) continue;
      const mh = join(TMP, `mutant-${i}`);
      mkdirSync(join(mh, 'bin'), { recursive: true });
      copyFileSync(join(HOME, 'bin', 'classify.mjs'), join(mh, 'bin', 'classify.mjs'));
      writeFileSync(join(mh, 'bin', 'spool-hook.mjs'), mutated);
      const parsed = spawnSync(process.execPath, ['--check', join(mh, 'bin', 'spool-hook.mjs')], { windowsHide: true, timeout: 30000 });
      if (!ok(parsed.status === 0, `MUTANT ${name}: the mutated hook parses (node --check)`)) continue;
      sink = { checks: 0, failures: 0, fails: [] };
      try { s4Checks(mh, new Set([group])); } catch (e) { sink.failures += 1; sink.fails.push(`threw ${e && e.message}`); }
      const s = sink;
      sink = null;
      const caught = s.failures > 0;
      if (caught) caughtN += 1;
      console.log(`  MUTANT [${group}] ${name}: ${caught ? 'CAUGHT' : 'NOT CAUGHT'} (${s.failures} of ${s.checks} checks fail${caught ? '; first: ' + s.fails[0].split('\n')[0].slice(0, 150) : ''})`);
      ok(caught, `MUTANT [${group}] ${name}: caught by the S4 ${group} checks`);
    }
    console.log(`  S4 mutants caught: ${caughtN} of ${HOOK_MUTANTS.length}`);
  }

  section('privacy: the marker is nowhere in any spool byte');
  {
    const homes = [HOME, H_MISSING, H_BROKEN, H_THROWS, H_FRESH];
    let bytes = 0, lines = 0;
    for (const h of homes) {
      const dir = join(h, 'spool');
      for (const f of readdirSync(dir)) {
        const raw = readFileSync(join(dir, f));
        bytes += raw.length;
        lines += raw.toString('latin1').split('\n').filter(Boolean).length;
        const low = raw.toString('latin1').toLowerCase();
        ok(!low.includes(MARK.toLowerCase()), `${basename(h)}/${f}: marker must not appear`);
        for (const needle of ['secret', 'id_rsa', 'token', 'example.com', 'http', 'c:/', 'c:\\', '/users/', ' && ', 'curl', 'zzpathmarkzz']) {
          ok(!low.includes(needle), `${basename(h)}/${f}: "${needle}" must not appear`);
        }
      }
    }
    console.log(`  scanned ${lines} lines / ${bytes} bytes of spool`);
    ok(lines > 100, 'privacy scan covered the whole suite');
  }

  section('spool retention (plan 5.2: 7 days): pruned only when a firing starts a new day file, and at install');
  {
    const RH = join(TMP, 'retention-home');
    const inst = () => spawnSync(process.execPath, [join(OBS, 'install-hook.mjs')], { env: childEnv(RH), timeout: 60000, windowsHide: true });
    const r0 = inst();
    ok(r0.status === 0, `retention: install into its own temp home (exit ${r0.status})`);
    const sp = join(RH, 'spool');
    const pad2 = (n) => String(n).padStart(2, '0');
    const dayOf = (offset) => { const d = new Date(); const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 12); return `events-${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}.jsonl`; };
    const plant = (name) => writeFileSync(join(sp, name), '{"v":1,"ts":0,"ev":"other"}\n');
    const old = [dayOf(-30), dayOf(-8)], kept = [dayOf(-7), dayOf(-1), 'notes.txt', 'events-notes.jsonl'];
    for (const n of [...old, ...kept]) plant(n);
    const today = dayOf(0);
    ok(!existsSync(join(sp, today)), 'retention: no day file for today yet');
    const payload = (tu) => JSON.stringify({ session_id: 's-retention', hook_event_name: 'PreToolUse', agent_id: 'agent-retention', agent_type: 'workflow-subagent', tool_name: 'Read', tool_input: { file_path: 'x.ts' }, tool_use_id: tu });
    const r1 = fire(RH, payload('toolu_ret1'));
    assertSilent(r1, 'retention: the firing that starts the day file');
    const after1 = readdirSync(sp);
    ok(existsSync(join(sp, today)), 'retention: the firing created today\'s day file');
    ok(old.every((n) => !after1.includes(n)), `retention: the day files more than 7 days old are deleted when the day file starts (left: ${old.filter((n) => after1.includes(n)).join(', ') || 'none'})`);
    ok(kept.every((n) => after1.includes(n)), `retention: 7 days back, yesterday and every other name are kept (missing: ${kept.filter((n) => !after1.includes(n)).join(', ') || 'none'})`);
    const late = dayOf(-9);
    plant(late);
    const r2 = fire(RH, payload('toolu_ret2'));
    assertSilent(r2, 'retention: an ordinary firing');
    ok(existsSync(join(sp, late)), 'retention: an ordinary firing (the day file exists) deletes nothing');
    const r3 = inst();
    ok(r3.status === 0 && !existsSync(join(sp, late)) && kept.every((n) => existsSync(join(sp, n))) && existsSync(join(sp, today)),
      `retention: install-hook prunes too (the 9-day-old file ${existsSync(join(sp, late)) ? 'is still there' : 'is gone'}, the others kept; exit ${r3.status})`);
  }

  section('temp home layout');
  ok(isDeepStrictEqual(readdirSync(HOME).sort(), ['bin', 'spool']), `home holds only bin/ and spool/ (${readdirSync(HOME)})`);
  ok(isDeepStrictEqual(readdirSync(join(HOME, 'bin')).sort(), ['classify.mjs', 'spool-hook.mjs']), 'bin/ holds only the two hook files');
  ok(readdirSync(join(HOME, 'spool')).every((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)), `spool/ holds only events-YYYY-MM-DD.jsonl (${readdirSync(join(HOME, 'spool'))})`);
} catch (e) {
  failures += 1;
  console.log('  FAIL (exception)', e && e.stack);
} finally {
  const realAfter = realHomeSnapshot();
  ok(isDeepStrictEqual(realAfter, realBefore), `the real home ${REAL_HOME} is unchanged (${JSON.stringify(realBefore)} -> ${JSON.stringify(realAfter)})`);
  if (KEEP) console.log(`kept ${TMP}`);
  else if (basename(TMP).startsWith('wo-spool-test-') && resolve(TMP).startsWith(resolve(tmpdir()))) rmSync(TMP, { recursive: true, force: true });
}
console.log(`${firings} hook firings, ${checks} checks, ${failures} failed`);
console.log(failures ? 'SPOOL HOOK TEST: FAIL' : 'SPOOL HOOK TEST: PASS');
process.exitCode = failures ? 1 : 0;
