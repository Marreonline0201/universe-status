// Installs the worker-office spool hook (worker-office plan sections 5.2 and 5.4).
//
//   node office/observer/install-hook.mjs              install or update, then self-check the installed copy
//   node office/observer/install-hook.mjs --no-check   install or update only
//
// Copies classify.mjs and spool-hook.mjs from this folder to <home>/bin/ and creates <home>/spool/. It also applies the
// spool's retention (plan section 5.2: day files more than 7 days old are deleted, as the hook does when it starts a
// new day file); only events-YYYY-MM-DD.jsonl names in <home>/spool/ are touched.
// <home> = UNIVERSE_OFFICE_HOME (absolute path) or C:/Users/ddogr/.universe-office.
//  - Idempotent: a file whose bytes already match is left alone ("unchanged").
//  - Atomic per file: each copy is written to a temp name and renamed over the old one, so a hook that fires during
//    an update loads either the old file or the new one, never half of one. The classifier goes first; a hook that
//    pairs with the other version still runs (it only loses its kind / activity fields).
//  - It NEVER edits Claude Code settings. Run it BEFORE the hook entries are added, or every tool call would start
//    a node process that fails on a missing file.
//  - The self-check runs the INSTALLED hook once, on a synthetic PreToolUse payload, with its spool redirected to a
//    throwaway temp folder (the real spool is not touched), and requires: exit 0, nothing on stdout or stderr,
//    exactly one record with the expected category, the agent id without its "agent-" prefix, the agent type, and
//    exactly the keys v ts sid ev aid at k a tu in that order: no run, although the payload's transcript_path has the
//    own-transcript shape the stage-0 hook read a run from (lead ruling F1, 2026-10-01), and no cost fields dur cpu
//    rss, which the stage-0 hook wrote on every record (lead ruling F2) — so a PASS also shows that the installed
//    hook is this version.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HOME = process.env.UNIVERSE_OFFICE_HOME || 'C:/Users/ddogr/.universe-office';
const SRC = dirname(fileURLToPath(import.meta.url));
const BIN = join(HOME, 'bin');
const SPOOL = join(HOME, 'spool');
const FILES = ['classify.mjs', 'spool-hook.mjs'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; } catch (e) {
      if (i >= 20 || !e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      sleep(100);                                    // a scanner or a starting hook holds the file for a moment
    }
  }
}

// the spool's retention: the hook's own rule (spool-hook.mjs prune), at install time
const KEEP_DAYS = 7;
const DAY_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const pad2 = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function prune() {
  const d = new Date();
  const cutoff = dayStamp(new Date(d.getFullYear(), d.getMonth(), d.getDate() - KEEP_DAYS, 12));
  const gone = [];
  for (const name of readdirSync(SPOOL)) {
    const m = DAY_FILE.exec(name);
    if (m && m[1] < cutoff) { try { unlinkSync(join(SPOOL, name)); gone.push(name); } catch { /* in use: next time */ } }
  }
  return gone;
}

function install() {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(SPOOL, { recursive: true });
  for (const f of readdirSync(BIN)) {               // leftovers of an interrupted install (our own names only)
    if (FILES.some((n) => f.startsWith(`${n}.tmp-`))) unlinkSync(join(BIN, f));
  }
  const rows = [];
  for (const f of FILES) {
    const src = readFileSync(join(SRC, f));
    const dst = join(BIN, f);
    const old = existsSync(dst) ? readFileSync(dst) : null;
    if (old && old.equals(src)) { rows.push([f, 'unchanged', sha(src)]); continue; }
    const tmp = `${dst}.tmp-${process.pid}`;
    writeFileSync(tmp, src);
    renameWithRetry(tmp, dst);
    if (!readFileSync(dst).equals(src)) throw new Error(`installed bytes differ from the source: ${dst}`);
    rows.push([f, old ? 'updated' : 'installed', sha(src)]);
  }
  return rows;
}

function selfCheck() {
  const tmp = mkdtempSync(join(tmpdir(), 'wo-install-check-'));
  const env = { ...process.env, UNIVERSE_OFFICE_HOME: tmp };
  delete env.OFFICE_AGENT_ID;
  const payload = JSON.stringify({
    session_id: 'install-check', hook_event_name: 'PreToolUse', agent_id: 'agent-installcheck', agent_type: 'install-check',
    tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 'toolu_install_check',
    transcript_path: 'C:/install-check/subagents/workflows/wf_installcheck/agent-installcheck.jsonl',
  });
  const problems = [];
  try {
    const r = spawnSync(process.execPath, [join(BIN, 'spool-hook.mjs')], { input: payload, env, timeout: 30000, windowsHide: true });
    if (r.error) problems.push(`could not run the hook: ${r.error.message}`);
    if (r.status !== 0) problems.push(`exit code ${r.status}`);
    if (r.stdout && r.stdout.length) problems.push(`stdout not empty (${r.stdout.length} bytes)`);
    if (r.stderr && r.stderr.length) problems.push(`stderr not empty (${r.stderr.length} bytes)`);
    const spool = join(tmp, 'spool');
    const files = existsSync(spool) ? readdirSync(spool) : [];
    const lines = files.flatMap((f) => readFileSync(join(spool, f), 'utf8').split('\n').filter(Boolean));
    if (lines.length !== 1) problems.push(`expected 1 spool line, found ${lines.length}`);
    else {
      const rec = JSON.parse(lines[0]);
      if (Object.keys(rec).join(' ') !== 'v ts sid ev aid at k a tu' || rec.ev !== 'PreToolUse' || rec.aid !== 'installcheck'
          || rec.at !== 'install-check' || rec.k !== 'historyShelf' || rec.a !== 'glance') {
        problems.push(`unexpected record ${lines[0]}`);
      }
    }
    for (const f of files) unlinkSync(join(spool, f));
    if (existsSync(spool)) rmdirSync(spool);
  } finally {
    try { rmdirSync(tmp); } catch { /* leave an empty-or-not temp folder rather than delete recursively */ }
  }
  return problems;
}

const rows = install();
const pruned = prune();
console.log(`worker-office hook installed in ${BIN} (spool: ${SPOOL})`);
console.log(`  spool retention: ${KEEP_DAYS} days; ${pruned.length} older day file(s) deleted`);
for (const [f, state, h] of rows) console.log(`  ${f.padEnd(16)} ${state.padEnd(10)} sha256 ${h.slice(0, 16)}`);
if (!process.argv.includes('--no-check')) {
  const problems = selfCheck();
  if (problems.length) {
    console.log('self-check FAILED:');
    for (const p of problems) console.log('  ' + p);
    process.exitCode = 1;
  } else {
    console.log('self-check PASS: the installed hook ran silently, exited 0 and wrote one categorised record (temp spool)');
  }
}
