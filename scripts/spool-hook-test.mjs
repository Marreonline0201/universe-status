// Tests for the worker-office spool hook (office/observer/spool-hook.mjs) and its installer.
//
//   node scripts/spool-hook-test.mjs [--keep]
//
// Everything runs against a temp UNIVERSE_OFFICE_HOME: the suite installs the hook there with install-hook.mjs and
// fires the INSTALLED copy (<temp>/home/bin/spool-hook.mjs), the way Claude Code will. The real home
// (C:/Users/ddogr/.universe-office) must be exactly as before afterwards (checked). One hook process at a time,
// except the concurrency test (8 at once, after a free-RAM check).
// Checked for every firing: exit code 0, stdout and stderr empty, the exact number of new spool lines, keys a subset
// of the allowlist (in allowlist order), every value's format and length, ts inside the spawn window.
// Privacy: every free-text field of every payload carries the marker ZZCANARYZZ (inside commands, paths, URLs,
// prompts, responses, error text, background-task descriptions/commands/names, session_crons, cwd, transcript
// paths, unknown extra fields, MCP tool names), and id-shaped fields carry it only in a form that is not a valid id.
// The marker must appear nowhere in the spool bytes.
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir, freemem } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// WO_OBSERVER_DIR: test the observer files of another folder (used to run this suite against planted hook mutants).
const OBS = process.env.WO_OBSERVER_DIR ? resolve(process.env.WO_OBSERVER_DIR) : join(ROOT, 'office', 'observer');
const REAL_HOME = 'C:/Users/ddogr/.universe-office';
const KEEP = process.argv.includes('--keep');
const C = await import(pathToFileURL(join(OBS, 'classify.mjs')).href);
const FIXTURE = JSON.parse(readFileSync(join(OBS, 'classify-cases.json'), 'utf8'));

let checks = 0, failures = 0, firings = 0;
const ok = (cond, what) => { checks += 1; if (!cond) { failures += 1; console.log('  FAIL', what); } return cond; };
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
ok(hookSrc.includes(`const DEFAULT_HOME = '${REAL_HOME}';`), 'the hook default home is the folder this suite guards');
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
const ALLOWED = ['v', 'ts', 'sid', 'ev', 'aid', 'at', 'k', 'a', 'tu', 'bg', 'to', 'st', 'ch', 'run', 'sz', 'intr', 'n', 'bt', 'r'];
const EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'SessionEnd', 'PermissionRequest', 'StopFailure', 'SessionStart', 'UserPromptSubmit', 'Notification', 'PreCompact',
  'other', 'parse_error']);
const RE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const RE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

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
  for (const k of ['sid', 'aid', 'ch', 'run']) if (k in rec) ok(RE_ID.test(rec[k]), `${what}: ${k} format "${rec[k]}"`);
  for (const k of ['aid', 'ch']) if (k in rec) ok(!rec[k].startsWith('agent-'), `${what}: ${k} has no agent- prefix`);
  if ('at' in rec) ok(rec.at === '' || RE_ID.test(rec.at), `${what}: at format`);
  if ('k' in rec) ok(C.KINDS.has(rec.k), `${what}: k in the closed kind set`);
  if ('a' in rec) ok(C.ACTIVITY_BY_ID.has(rec.a), `${what}: a in the closed activity-id set`);
  if ('tu' in rec) ok(/^[0-9a-f]{10}$/.test(rec.tu), `${what}: tu is 10 hex`);
  if ('bg' in rec) ok(rec.bg === true, `${what}: bg is true when present`);
  if ('to' in rec) ok(Number.isInteger(rec.to) && rec.to >= 1 && rec.to <= 86400, `${what}: to in seconds`);
  for (const k of ['st', 'r']) if (k in rec) ok(RE_TOKEN.test(rec[k]), `${what}: ${k} token`);
  if ('intr' in rec) ok(typeof rec.intr === 'boolean', `${what}: intr boolean`);
  if ('n' in rec) ok(Number.isInteger(rec.n) && rec.n >= 0, `${what}: n integer`);
  if ('bt' in rec) {
    ok(Array.isArray(rec.bt) && rec.bt.length <= 50, `${what}: bt has at most 50 entries`);
    for (const e of rec.bt || []) {
      ok(Object.keys(e).every((k) => ['id', 'type', 'status'].includes(k)), `${what}: bt entry keys ${Object.keys(e)}`);
      if ('id' in e) ok(RE_ID.test(e.id), `${what}: bt id format`);
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
/** The record minus v/ts must equal `want` exactly (no missing and no extra fields). */
function exact(rec, want, what) {
  if (!rec) return ok(false, `${what}: no record`);
  const { v, ts, ...rest } = rec;                                  // eslint-disable-line no-unused-vars
  return ok(isDeepStrictEqual(rest, want), `${what}:\n       got  ${JSON.stringify(rest)}\n       want ${JSON.stringify(want)}`);
}

// ------------------------------------------------------------------------------------------------ payloads
const MARK = 'ZZCANARYZZ';
const txt = (f) => `${MARK}-${f} secret text with spaces`;
const path = (f) => `C:/Users/ddogr/${MARK}/${f}/id_rsa`;
const url = (f) => `https://${MARK}.example.com/${f}?token=sk-${MARK}`;
const cmd = (f) => `cat ${path(f)} && curl -s "${url(f)}" > C:/${MARK}/out.txt`;
const SID = 'f3b1c2d4-0000-4000-8000-00000000c0de';
const COMMON = {
  session_id: SID, transcript_path: path('transcript'), cwd: path('cwd'), permission_mode: 'default',
  prompt_id: `${MARK} prompt id`, effort: 'high', scratchpad_dir: path('scratch'), extra_unknown_field: txt('extra'),
  prompt: txt('prompt'), description: txt('description'),
};
const SUB = { agent_id: 'agent-a1b2c3', agent_type: 'Explore' };
const bashInput = (command, more = {}) => ({ command, description: txt('desc'), ...more });

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
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'a1b2c3', at: 'Explore' }, 'SubagentStart record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash',
    tool_input: bashInput(`git status && npm test -- --grep ${MARK} > C:/${MARK}/o.txt`, { timeout: 120000, run_in_background: true }),
    tool_use_id: `toolu_01${MARK}pre` }, 'PreToolUse Bash in a helper');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', k: 'benchTerminal', a: 'run', tu: h10(`toolu_01${MARK}pre`), bg: true, to: 120 }, 'PreToolUse Bash record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path('read') }, tool_use_id: 'toolu_read1' }, 'PreToolUse Read, main thread');
  exact(rec, { sid: SID, ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: h10('toolu_read1') }, 'PreToolUse Read record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'PowerShell',
    tool_input: { command: `Get-Content ${path('ps')}`, timeout: 1500, run_in_background: 'TRUE' }, tool_use_id: 'toolu_ps1' }, 'PreToolUse PowerShell');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', k: 'fileCabinet', a: 'read', tu: h10('toolu_ps1'), bg: true, to: 2 }, 'PowerShell record (ms -> s, rounded up)');

  for (const [inp, k, a, what] of [
    [{ prompt: txt('agent-prompt'), description: txt('agent-desc'), subagent_type: 'general-purpose' }, 'frontDesk', 'helper-bg', 'Agent, flag omitted = background'],
    [{ prompt: txt('agent-prompt'), run_in_background: true }, 'frontDesk', 'helper-bg', 'Agent, background'],
    [{ prompt: txt('agent-prompt'), run_in_background: false }, 'meetingTable', 'helper-fg', 'Agent, explicit foreground'],
  ]) {
    [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Agent', tool_input: inp, tool_use_id: 'toolu_ag' }, `PreToolUse ${what}`);
    exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', k, a, tu: h10('toolu_ag') }, `PreToolUse ${what} record`);
  }
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'ToolSearch', tool_input: { query: txt('q') }, tool_use_id: 'toolu_ts' }, 'PreToolUse ToolSearch');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', a: 'toolsearch', tu: h10('toolu_ts') }, 'ToolSearch: no kind, the observer applies the library rule');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: `${MARK}@x.com`, body: txt('mail') }, tool_use_id: 'toolu_m' }, 'PreToolUse MCP mail');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', k: 'pigeonholes', a: 'mail-send', tu: h10('toolu_m') }, 'MCP mail record');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: `mcp__${MARK}__frob`, tool_input: { x: txt('x') }, tool_use_id: 'toolu_u' }, 'PreToolUse unknown MCP tool');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', a: 'none', tu: h10('toolu_u') }, 'unknown tool: no move, tool name not written');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: `${MARK} not a dict`, tool_use_id: 'toolu_bad' }, 'PreToolUse malformed tool_input');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', tu: h10('toolu_bad') }, 'malformed tool_input: record without a category');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash',
    tool_input: bashInput('sleep 5', { timeout: 'x', run_in_background: false }), tool_use_id: 'toolu_s' }, 'PreToolUse odd timeout');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', k: 'benchTerminal', a: 'wait', tu: h10('toolu_s') }, 'non-numeric timeout and explicit false: no to, no bg');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', ...SUB, tool_name: 'Bash', tool_input: bashInput('ls', { timeout: 1e12 }), tool_use_id: 'toolu_l' }, 'PreToolUse absurd timeout');
  exact(rec, { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', k: 'fileCabinet', a: 'list', tu: h10('toolu_l') }, 'timeout over a day is dropped');

  const big = 'x'.repeat(200_000) + MARK;
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
    { tool_name: 'Read', tool_input: { file_path: path('b1') }, tool_use_id: 't1', tool_response: big },
    { tool_name: 'Bash', tool_input: bashInput(`npm test ${MARK}`), tool_use_id: 't2', tool_response: JSON.stringify({ stdout: txt('stdout'), stderr: txt('stderr') }) },
    { tool_name: 'Grep', tool_input: { pattern: txt('pattern'), path: path('g') }, tool_use_id: 't3', tool_response: { filenames: [path('f')] } },
  ] }, 'PostToolBatch (3 calls)');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', k: 'benchTerminal', a: 'run', n: 3 }, 'Batch: precedence picks the run');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
    { tool_name: 'Edit', tool_input: { file_path: path('e'), old_string: txt('o'), new_string: txt('n') }, tool_use_id: 't4', tool_response: txt('edit') },
    { tool_name: 'Agent', tool_input: { prompt: txt('p') }, tool_use_id: 't5',
      tool_response: JSON.stringify({ status: 'completed', agentId: 'agent-x1', content: [{ type: 'text', text: txt('report') }] }) },
  ] }, 'PostToolBatch with a finished foreground Agent');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', k: 'meetingTable', a: 'helper-fg', n: 2 }, 'Batch: the real Agent status (completed) beats the default');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [
    { tool_name: 'Agent', tool_input: { prompt: txt('p'), run_in_background: false }, tool_use_id: 't6',
      tool_response: { status: 'async_launched', agentId: 'agent-x2', prompt: txt('p2'), outputFile: path('of') } },
    { tool_name: 'Read', tool_input: { file_path: path('r') }, tool_use_id: 't7', tool_response: txt('r') },
  ] }, 'PostToolBatch with a background launch');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', k: 'frontDesk', a: 'helper-bg', n: 2 }, 'Batch: async_launched beats the explicit flag');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [{ tool_name: 'Read', tool_input: {}, tool_use_id: 't8', tool_response: txt('r') }] }, 'PostToolBatch single call');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', k: 'fileCabinet', a: 'read', n: 1 }, 'Batch of one');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [`${MARK} not a call`, { tool_name: 'Read' }] }, 'PostToolBatch malformed call');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', n: 2 }, 'Batch with a malformed call: count only');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB, tool_calls: [] }, 'PostToolBatch empty');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', a: 'none', n: 0 }, 'empty Batch');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolBatch', ...SUB }, 'PostToolBatch without tool_calls');
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3' }, 'Batch without tool_calls');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', ...SUB, tool_name: 'Agent', tool_input: { prompt: txt('p'), description: txt('d') },
    tool_use_id: 'toolu_ag', duration_ms: 12, tool_response: { status: 'async_launched', agentId: 'agent-c0ffee', description: txt('rd'),
      prompt: txt('rp'), outputFile: path('out'), resolvedModel: `${MARK}-model` } }, 'PostToolUse Agent launched');
  exact(rec, { sid: SID, ev: 'PostToolUse', aid: 'a1b2c3', k: 'frontDesk', a: 'helper-bg', tu: h10('toolu_ag'), st: 'async_launched', ch: 'c0ffee' }, 'Post Agent async record');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: txt('p') }, tool_use_id: 'toolu_ag2',
    tool_response: { status: 'completed', agentId: 'c0ffe2', content: [{ type: 'text', text: txt('report') }], totalDurationMs: 5, totalToolUseCount: 3 } }, 'PostToolUse Agent completed');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'meetingTable', a: 'helper-fg', tu: h10('toolu_ag2'), st: 'completed', ch: 'c0ffe2' }, 'Post Agent completed record');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_use_id: 'toolu_ag3',
    tool_response: JSON.stringify({ status: 'async_launched', agentId: `agent-${MARK}/../x y` }) }, 'PostToolUse Agent, serialized response, bad child id');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'frontDesk', a: 'helper-bg', tu: h10('toolu_ag3'), st: 'async_launched' }, 'a child id that is not an id is dropped');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', ...SUB, tool_name: 'Workflow', tool_input: { script: txt('script') }, tool_use_id: 'toolu_wf',
    tool_response: { runId: 'wf_42', workflowName: txt('wf'), transcriptDir: path('td') } }, 'PostToolUse Workflow');
  exact(rec, { sid: SID, ev: 'PostToolUse', aid: 'a1b2c3', k: 'kanbanBoard', a: 'tasks', tu: h10('toolu_wf'), run: 'wf_42' }, 'Post Workflow record');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', tool_name: 'Workflow', tool_input: {}, tool_use_id: 'toolu_wf2',
    tool_response: { runId: `C:/${MARK}/run`, transcriptDir: path('td2') } }, 'PostToolUse Workflow, bad runId');
  exact(rec, { sid: SID, ev: 'PostToolUse', k: 'kanbanBoard', a: 'tasks', tu: h10('toolu_wf2') }, 'a runId that is not an id is dropped');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUse', ...SUB, tool_name: 'SubagentHandback', tool_input: { report: txt('report') },
    tool_use_id: 'toolu_hb', tool_response: txt('hb') }, 'PostToolUse SubagentHandback');
  exact(rec, { sid: SID, ev: 'PostToolUse', aid: 'a1b2c3', k: 'printer', a: 'report', tu: h10('toolu_hb') }, 'Post handback record');

  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PostToolUseFailure', ...SUB, tool_name: 'Bash', tool_input: bashInput('npm test'),
    tool_use_id: 'toolu_f1', error: `Exit code 1\n${txt('error-output')} at ${path('stack')}`, is_interrupt: false, duration_ms: 100 }, 'PostToolUseFailure');
  exact(rec, { sid: SID, ev: 'PostToolUseFailure', aid: 'a1b2c3', k: 'benchTerminal', a: 'run', tu: h10('toolu_f1'), intr: false }, 'Failure record');
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
  ];
  const tasksOut = [{ id: 'b1x9', type: 'shell', status: 'running' }, { type: 'subagent', status: 'completed' },
    { id: 'wf_7', type: 'workflow', status: 'running' }, { id: 'm1', type: 'monitor', status: 'running' }, { id: 'x9' }];
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStop', agent_id: 'agent-a1b2c3', agent_type: 'workflow-subagent', stop_hook_active: false,
    agent_transcript_path: path('atp'), last_assistant_message: txt('lam'), background_tasks: tasksIn,
    session_crons: [{ id: 'c1', schedule: '*/5 * * * *', prompt: txt('cron') }] }, 'SubagentStop');
  exact(rec, { sid: SID, ev: 'SubagentStop', aid: 'a1b2c3', at: 'workflow-subagent', bt: tasksOut }, 'SubagentStop record');
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
  exact(rec, { sid: SID, ev: 'other', aid: 'a1b2c3' }, 'unknown event name -> other');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: `PreToolUse ${MARK}` }, 'event name with junk');
  exact(rec, { sid: SID, ev: 'other' }, 'event name with junk -> other');
  [rec] = fireExpect(HOME, { session_id: SID }, 'no event name');
  exact(rec, { sid: SID, ev: 'other' }, 'missing event name -> other');

  section('field limits');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', session_id: 's'.repeat(10000), agent_id: 'agent-' + 'a'.repeat(65), agent_type: 'T'.repeat(65) }, 'oversized ids');
  exact(rec, { ev: 'SubagentStart' }, 'ids over 64 characters are dropped');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', agent_id: 'agent-' + 'a'.repeat(64), agent_type: 'feature-dev:code-reviewer' }, '64-character id');
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'a'.repeat(64), at: 'feature-dev:code-reviewer' }, 'a 64-character id is kept');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', session_id: `${MARK}/session id`, agent_id: `agent-C:/${MARK}/x y`, agent_type: `${MARK} type/x` }, 'path-like ids');
  exact(rec, { ev: 'SubagentStart' }, 'ids with path or space characters are dropped');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 'u'.repeat(100000) }, 'huge tool_use_id');
  exact(rec, { sid: SID, ev: 'PreToolUse', k: 'fileCabinet', a: 'read', tu: h10('u'.repeat(100000)) }, 'tu stays 10 hex');
  [rec] = fireExpect(HOME, { ...COMMON, hook_event_name: 'SubagentStart', agent_id: 'abc-no-prefix' }, 'id without the agent- prefix');
  exact(rec, { sid: SID, ev: 'SubagentStart', aid: 'abc-no-prefix' }, 'an id without the prefix is kept as is');

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
  exact(rec, { sid: SID, ev: 'PostToolBatch', aid: 'a1b2c3', k: 'fileCabinet', a: 'read', n: 1 }, '1 MB payload is classified');
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
  const noCat = { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3', tu: h10('toolu_fp'), to: 60 };
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
    const want = { sid: SID, ev: 'PreToolUse', aid: 'a1b2c3' };
    if (c.py[1] !== null) want.k = c.py[1];
    want.a = C.ACTIVITY_ID.get(c.py[0]);
    want.tu = h10('toolu_fx');
    exact(r2, want, `fixture ${JSON.stringify(c.cmd)} -> ${c.py}`);
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
        for (const needle of ['secret', 'id_rsa', 'token', 'example.com', 'http', 'c:/', 'c:\\', '/users/', ' && ', 'curl']) {
          ok(!low.includes(needle), `${basename(h)}/${f}: "${needle}" must not appear`);
        }
      }
    }
    console.log(`  scanned ${lines} lines / ${bytes} bytes of spool`);
    ok(lines > 100, 'privacy scan covered the whole suite');
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
