// Owner-request runner: executes owner-APPROVED whitelisted commands, streams
// output over WS, writes results back into the request file, and mails the
// requesting agent. Agents create request files; the SERVER owns every status
// transition after that. Execution triggers ONLY from a live approve call —
// never from file state, so a forged `status: approved` does nothing.
//
// Revertibility (owner decision): runs in the engine repo never touch the main
// checkout — they execute in a dedicated git worktree on a lab branch that can
// be reset (revert) or committed/merged (save) at any time.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import type { Paths, RawRequest } from './store.ts'
import { loadRequests, loadRoster, updateRequestFile, writeMail } from './store.ts'
import type { OwnerRequest, RequestKind, RequestStatus, ServerMsg } from './protocol.ts'

export interface RunnerCommandSpec {
  bin: string
  subcommands?: string[]
  firstArgPattern?: string
  maxArgs?: number
  cwds: string[]
  warn?: string
}

export interface RunnerConfig {
  enabled: boolean
  defaultTimeoutMs: number
  maxTimeoutMs: number
  maxOutputLines: number
  maxOutputBytes: number
  cwds: Record<string, string>
  engineWorktree?: { path: string; branch: string; baseRepo: string }
  commands: RunnerCommandSpec[]
}

export interface RunOutputLine { stream: 'stdout' | 'stderr'; line: string; ts: number }

export interface RunnerEvents {
  broadcast: (msg: ServerMsg) => void
  poke: () => void
  log: (line: string) => void
}

const ARG_PATTERN = /^[A-Za-z0-9_@=:%+.,/\-]+$/
const KINDS = new Set<string>(['run', 'decision', 'access'])
const STATUSES = new Set<string>(['pending', 'approved', 'running', 'done', 'failed', 'denied'])
const RESULT_TAIL_LINES = 60
const RESULT_TAIL_BYTES = 8 * 1024

export function validateRun(cfg: RunnerConfig, repoRoot: string, command: unknown, cwdKey: unknown):
  | { ok: true; entry: RunnerCommandSpec; absCwd: string; argv: string[] }
  | { ok: false; reason: string } {
  if (!Array.isArray(command) || command.length === 0 || !command.every(a => typeof a === 'string' && a.length > 0)) {
    return { ok: false, reason: 'command must be a non-empty array of strings (exact argv)' }
  }
  const argv = command as string[]
  if (typeof cwdKey !== 'string' || !(cwdKey in cfg.cwds)) {
    return { ok: false, reason: `cwd must be one of: ${Object.keys(cfg.cwds).join(', ')}` }
  }
  const bin = argv[0]
  if (/[/\\.\s]/.test(bin)) return { ok: false, reason: 'argv[0] must be a bare binary name' }
  const absCwd = path.resolve(repoRoot, cfg.cwds[cwdKey])
  if (!fs.existsSync(absCwd)) return { ok: false, reason: `cwd does not exist: ${cfg.cwds[cwdKey]}` }

  let lastReason = `no whitelist entry for "${bin}" in ${cwdKey}`
  for (const entry of cfg.commands) {
    if (entry.bin !== bin) continue
    if (!entry.cwds.includes(cwdKey)) { lastReason = `"${bin}" is not allowed in ${cwdKey}`; continue }
    if (entry.subcommands) {
      if (!argv[1] || !entry.subcommands.includes(argv[1])) {
        lastReason = `"${bin} ${argv[1] ?? ''}" not allowed — allowed subcommands: ${entry.subcommands.join(', ')}`
        continue
      }
    }
    if (entry.firstArgPattern) {
      const re = new RegExp(entry.firstArgPattern)
      if (!argv[1] || !re.test(argv[1])) { lastReason = `first argument must match ${entry.firstArgPattern}`; continue }
      const resolved = path.resolve(absCwd, argv[1])
      if (path.relative(absCwd, resolved).startsWith('..')) { lastReason = 'script path escapes cwd'; continue }
      if (!fs.existsSync(resolved)) { lastReason = `script not found: ${argv[1]}`; continue }
    }
    if (argv.length > (entry.maxArgs ?? 16)) { lastReason = `too many arguments (max ${entry.maxArgs ?? 16})`; continue }
    const badArg = argv.slice(1).find(a => !ARG_PATTERN.test(a) || a.includes('..'))
    if (badArg !== undefined) { lastReason = `argument not allowed: ${JSON.stringify(badArg)}`; continue }
    // Even inside the charset, an absolute path or a cargo file-reading/execution
    // flag lets a whitelisted `cargo check` compile an agent-planted Cargo.toml +
    // build.rs (build scripts run at compile time) → arbitrary code execution.
    // Deny absolute paths and the config-bearing flags outright.
    const escapeArg = argv.slice(1).find(a =>
      /^(\/|[A-Za-z]:)/.test(a) ||
      /^--?(manifest-path|config|target-dir|out-dir|Z)(=|$)/i.test(a),
    )
    if (escapeArg !== undefined) { lastReason = `path/config argument not allowed: ${JSON.stringify(escapeArg)}`; continue }
    return { ok: true, entry, absCwd, argv }
  }
  return { ok: false, reason: lastReason }
}

interface ActiveRun {
  id: string
  child: ChildProcess
  lines: RunOutputLine[]
  bytes: number
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  killedReason: string | null
}

export class Runner {
  private queue: string[] = []
  private active: ActiveRun | null = null
  private teamById = new Map<string, string>()

  constructor(
    private paths: Paths,
    private repoRoot: string,
    private cfg: RunnerConfig | undefined,
    private events: RunnerEvents,
  ) {
    for (const a of loadRoster(paths)) this.teamById.set(a.id, a.team)
  }

  /** Decorate a raw file read into the wire shape (whitelist check included). */
  decorate(r: RawRequest): OwnerRequest {
    const kind = (KINDS.has(r.kind) ? r.kind : 'decision') as RequestKind
    const status = (STATUSES.has(r.status) ? r.status : 'pending') as RequestStatus
    let valid = true
    let invalidReason: string | null = null
    let warn: string | null = null
    let runsIn: 'worktree' | 'repo' | null = null
    if (r.parseError) {
      valid = false
      invalidReason = `broken frontmatter (${r.parseError}) — the requesting agent must fix the YAML; unquoted titles containing ": " are the usual cause`
    } else if (r.fmId && r.fmId !== r.id) { valid = false; invalidReason = `frontmatter id "${r.fmId}" does not match filename` }
    if (kind === 'run') {
      if (!this.cfg?.enabled) { valid = false; invalidReason = 'runner disabled in office config' }
      else {
        const v = validateRun(this.cfg, this.repoRoot, r.command, r.cwd)
        if (!v.ok) { valid = false; invalidReason = v.reason }
        else {
          warn = v.entry.warn ?? null
          runsIn = this.usesWorktree(String(r.cwd)) ? 'worktree' : 'repo'
        }
      }
    }
    return {
      id: r.id,
      title: r.title,
      kind,
      requestedBy: r.requestedBy,
      team: this.teamById.get(r.requestedBy) ?? '',
      taskId: r.taskId,
      status,
      command: Array.isArray(r.command) && r.command.every(c => typeof c === 'string') ? r.command as string[] : null,
      cwd: typeof r.cwd === 'string' ? r.cwd : null,
      runsIn,
      valid,
      invalidReason,
      warn,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      resultTail: this.active?.id === r.id ? null : this.readResultTail(r),
      path: r.path,
    }
  }

  list(): OwnerRequest[] {
    return loadRequests(this.paths).map(r => this.decorate(r))
  }

  /** Reset any approved/running leftovers at boot — a crash must not silently re-run. */
  bootRecover() {
    for (const r of loadRequests(this.paths)) {
      if (r.status === 'approved' || r.status === 'running') {
        updateRequestFile(this.paths, r.id, { status: 'pending' },
          `> orchestrator restarted before/during execution on ${new Date().toISOString()} — re-approve to run.`)
        this.events.log(`runner: ${r.id} reset to pending (boot recovery)`)
      }
    }
  }

  approve(id: string): { ok: boolean; error?: string } {
    const r = this.fresh(id)
    if (!r) return { ok: false, error: 'unknown request' }
    // Guard BEFORE any updateRequestFile call — it re-parses the file and would
    // throw on the same broken YAML this flags.
    if (r.parseError) return { ok: false, error: `broken frontmatter: ${r.parseError}` }
    if (r.status !== 'pending') return { ok: false, error: `request is ${r.status}, not pending` }
    if (r.fmId && r.fmId !== r.id) return { ok: false, error: 'frontmatter id mismatch' }

    if (r.kind === 'decision' || r.kind === 'access') {
      updateRequestFile(this.paths, id, { status: 'done', resolved_at: new Date().toISOString() },
        `## Decision\napproved by owner on ${new Date().toISOString()}`)
      this.mailOutcome(r, `${id}: approved`, 'The owner APPROVED this request. Proceed accordingly and log the outcome on the task.')
      this.rebroadcast(id)
      return { ok: true }
    }

    // kind: run — RE-validate against the file as it exists right now.
    if (!this.cfg?.enabled) return { ok: false, error: 'runner disabled' }
    const v = validateRun(this.cfg, this.repoRoot, r.command, r.cwd)
    if (!v.ok) return { ok: false, error: `whitelist rejected: ${v.reason}` }

    updateRequestFile(this.paths, id, { status: 'approved' })
    this.queue.push(id)
    this.rebroadcast(id)
    this.startNext()
    return { ok: true }
  }

  deny(id: string, reason?: string): { ok: boolean; error?: string } {
    const r = this.fresh(id)
    if (!r) return { ok: false, error: 'unknown request' }
    if (r.parseError) return { ok: false, error: `broken frontmatter: ${r.parseError}` }
    if (r.status !== 'pending') return { ok: false, error: `request is ${r.status}, not pending` }
    updateRequestFile(this.paths, id, {
      status: 'denied', resolved_at: new Date().toISOString(), ...(reason ? { denied_reason: reason } : {}),
    }, `## Decision\ndenied by owner on ${new Date().toISOString()}${reason ? ` — ${reason}` : ''}`)
    this.mailOutcome(r, `${id}: denied`, `The owner DENIED this request${reason ? `: ${reason}` : ''}. Adjust your approach; do not re-file the same request unchanged.`)
    this.rebroadcast(id)
    return { ok: true }
  }

  kill(id: string): { ok: boolean; error?: string } {
    if (this.active?.id !== id) return { ok: false, error: 'request is not running' }
    this.active.killedReason = 'killed by owner'
    this.killTree(this.active.child)
    return { ok: true }
  }

  output(id: string): { requestId: string; lines: RunOutputLine[]; running: boolean } | null {
    if (this.active?.id === id) return { requestId: id, lines: [...this.active.lines], running: true }
    return null
  }

  stop() {
    if (this.active) {
      this.active.killedReason = 'office shutdown'
      this.killTree(this.active.child)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private fresh(id: string): RawRequest | null {
    return loadRequests(this.paths).find(r => r.id === id) ?? null
  }

  private rebroadcast(id: string) {
    const r = this.fresh(id)
    if (r) this.events.broadcast({ type: 'REQUEST_UPDATE', request: this.decorate(r) })
  }

  private usesWorktree(cwdKey: string): boolean {
    return cwdKey === 'universe-engine' && !!this.cfg?.engineWorktree
  }

  /** Engine runs execute in the lab worktree so main is never touched. */
  private resolveRunCwd(cwdKey: string, absCwd: string): { cwd: string; env: Record<string, string | undefined> } {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    if (!this.usesWorktree(cwdKey)) return { cwd: absCwd, env }
    const wt = this.cfg!.engineWorktree!
    const wtAbs = path.resolve(this.repoRoot, wt.path)
    const baseAbs = path.resolve(this.repoRoot, wt.baseRepo)
    if (!fs.existsSync(wtAbs)) {
      this.events.log(`runner: creating lab worktree ${wt.path} (branch ${wt.branch})`)
      const branches = execFileSync('git', ['-C', baseAbs, 'branch', '--list', wt.branch], { encoding: 'utf8' }).trim()
      const args = branches
        ? ['-C', baseAbs, 'worktree', 'add', wtAbs, wt.branch]
        : ['-C', baseAbs, 'worktree', 'add', wtAbs, '-b', wt.branch]
      execFileSync('git', args, { encoding: 'utf8' })
    }
    // Share the main repo's target dir: no duplicate multi-GB builds on a 16 GB machine.
    env.CARGO_TARGET_DIR = path.join(baseAbs, 'target')
    return { cwd: wtAbs, env }
  }

  private startNext() {
    if (this.active) return
    const id = this.queue.shift()
    if (!id) return
    const r = this.fresh(id)
    if (!r || r.status !== 'approved') { this.startNext(); return }
    const v = validateRun(this.cfg!, this.repoRoot, r.command, r.cwd)
    if (!v.ok) {
      this.finishFile(r, { failReason: `whitelist rejected at run time: ${v.reason}` })
      this.startNext()
      return
    }

    let cwd: string, env: Record<string, string | undefined>
    try {
      ({ cwd, env } = this.resolveRunCwd(String(r.cwd), v.absCwd))
    } catch (err) {
      this.finishFile(r, { failReason: `worktree setup failed: ${err instanceof Error ? err.message : String(err)}` })
      this.startNext()
      return
    }

    const timeoutMs = Math.min(Math.max(r.timeoutMs ?? this.cfg!.defaultTimeoutMs, 10_000), this.cfg!.maxTimeoutMs)
    updateRequestFile(this.paths, id, { status: 'running' })
    this.events.log(`runner: ▶ ${id} — ${v.argv.join(' ')} (cwd ${path.relative(this.repoRoot, cwd) || '.'}, timeout ${Math.round(timeoutMs / 1000)}s)`)

    const child = spawn(v.argv[0], v.argv.slice(1), { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const active: ActiveRun = {
      id, child, lines: [], bytes: 0, startedAt: Date.now(),
      timer: setTimeout(() => { active.killedReason = `timeout after ${Math.round(timeoutMs / 1000)}s`; this.killTree(child) }, timeoutMs),
      killedReason: null,
    }
    this.active = active
    this.rebroadcast(id)

    const onData = (stream: 'stdout' | 'stderr') => {
      let buf = ''
      return (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          this.pushLine(active, stream, line)
        }
      }
    }
    child.stdout?.on('data', onData('stdout'))
    child.stderr?.on('data', onData('stderr'))

    child.on('close', (code) => {
      clearTimeout(active.timer)
      this.active = null
      const fresh = this.fresh(id)
      if (fresh) {
        this.finishFile(fresh, active.killedReason
          ? { failReason: active.killedReason, lines: active.lines, startedAt: active.startedAt }
          : { exitCode: code ?? -1, lines: active.lines, startedAt: active.startedAt })
      }
      this.startNext()
    })
    child.on('error', (err) => {
      clearTimeout(active.timer)
      this.active = null
      const fresh = this.fresh(id)
      if (fresh) this.finishFile(fresh, { failReason: `spawn failed: ${err.message}`, lines: active.lines, startedAt: active.startedAt })
      this.startNext()
    })
  }

  private pushLine(active: ActiveRun, stream: 'stdout' | 'stderr', line: string) {
    active.bytes += line.length + 1
    active.lines.push({ stream, line, ts: Date.now() })
    if (active.lines.length > this.cfg!.maxOutputLines) active.lines.shift()
    this.events.broadcast({ type: 'RUN_OUTPUT', requestId: active.id, stream, line, ts: Date.now() })
    if (active.bytes > this.cfg!.maxOutputBytes && !active.killedReason) {
      active.killedReason = 'output cap exceeded'
      this.killTree(active.child)
    }
  }

  private killTree(child: ChildProcess) {
    if (!child.pid) return
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already dead */ }
    } else {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already dead */ } }, 5000)
    }
  }

  private finishFile(r: RawRequest, outcome: { exitCode?: number; failReason?: string; lines?: RunOutputLine[]; startedAt?: number }) {
    const ok = outcome.failReason === undefined && outcome.exitCode === 0
    const status = ok ? 'done' : 'failed'
    const durationMs = outcome.startedAt ? Date.now() - outcome.startedAt : null
    const lines = outcome.lines ?? []

    // Full log to disk (already capped by the ring).
    const logsDir = path.join(this.paths.companyDir, 'requests', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const logRel = `company/requests/logs/${r.id}.log`
    fs.writeFileSync(path.join(this.repoRoot, logRel),
      lines.map(l => `[${new Date(l.ts).toISOString()}] [${l.stream}] ${l.line}`).join('\n') + '\n')

    let tail = lines.slice(-RESULT_TAIL_LINES).map(l => l.line).join('\n')
    if (tail.length > RESULT_TAIL_BYTES) tail = tail.slice(-RESULT_TAIL_BYTES)

    const summary = [
      `- status: ${status}${outcome.exitCode !== undefined ? ` (exit ${outcome.exitCode})` : ''}${outcome.failReason ? ` — ${outcome.failReason}` : ''}`,
      ...(durationMs !== null ? [`- duration: ${(durationMs / 1000).toFixed(1)}s`] : []),
      `- full log: ${logRel}`,
      '',
      '```text',
      tail || '(no output)',
      '```',
    ].join('\n')

    updateRequestFile(this.paths, r.id, {
      status,
      resolved_at: new Date().toISOString(),
      ...(outcome.exitCode !== undefined ? { exit_code: outcome.exitCode } : {}),
      ...(durationMs !== null ? { duration_ms: durationMs } : {}),
    }, `## Result\n${summary}`)

    this.events.log(`runner: ${ok ? '✓' : '✗'} ${r.id} ${status}${outcome.exitCode !== undefined ? ` (exit ${outcome.exitCode})` : ''}${outcome.failReason ? ` — ${outcome.failReason}` : ''}`)
    this.mailOutcome(r,
      `${r.id}: ${status}${outcome.exitCode !== undefined ? ` (exit ${outcome.exitCode}` + (durationMs !== null ? `, ${(durationMs / 1000).toFixed(0)}s)` : ')') : ''}`,
      `Your approved run finished: **${status}**${outcome.failReason ? ` (${outcome.failReason})` : ''}.\n\n${summary}\n\nRead the full request file at ${r.path} for details. Act on the result and log it on the task.`)
    this.rebroadcast(r.id)
    this.events.poke()
  }

  private mailOutcome(r: RawRequest, subject: string, body: string) {
    try {
      writeMail(this.paths, { from: 'owner', to: r.requestedBy, subject, kind: 'fyi', taskId: r.taskId, body })
    } catch (err) {
      this.events.log(`runner: failed to mail ${r.requestedBy}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private readResultTail(r: RawRequest): string | null {
    if (r.status !== 'done' && r.status !== 'failed') return null
    try {
      const logFile = path.join(this.paths.companyDir, 'requests', 'logs', `${r.id}.log`)
      if (!fs.existsSync(logFile)) return null
      const text = fs.readFileSync(logFile, 'utf8')
      const lines = text.trimEnd().split('\n').slice(-12).map(l => l.replace(/^\[[^\]]*\] \[[^\]]*\] /, ''))
      return lines.join('\n')
    } catch { return null }
  }
}
