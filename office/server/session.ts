// Spawns and supervises one Claude Code CLI activation for an agent.
// Subscription auth only: API-key env vars are stripped from the child env.
// stdout stream-json events are translated into office activity callbacks.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Paths } from './store.ts'
import type { AgentProfile } from './store.ts'

export interface ActivationEvents {
  onStatus: (status: 'working' | 'reading' | 'typing' | 'talking' | 'blocked') => void
  onActivity: (kind: 'tool_use' | 'text' | 'thinking' | 'turn_end', tool?: string, detail?: string) => void
  onTranscript: (line: string) => void
  onEnd: (result: { ok: boolean; sessionId: string | null; wroteFiles: boolean; wroteMemory: boolean; contextTokens: number | null; limitHit: boolean; error?: string }) => void
}

/** Matches the CLI's refusal text when the subscription limit is exhausted. */
const LIMIT_ERROR = /usage limit|limit reached|rate.?limit|out of usage|hit your .*limit/i

export interface ActivationConfig {
  maxTurns: number
  timeoutMs: number
  fableFallbackModel?: string
  allowedTools: string
}

const READ_TOOLS = /^(Read|Grep|Glob|WebFetch|WebSearch)$/
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/

export class Activation {
  private child: ChildProcess | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private wroteFiles = false
  private wroteMemory = false          // did this activation write its own MEMORY.md?
  private maxContextTokens = 0         // peak per-turn context (= what --resume would replay)
  private sessionId: string | null = null
  private ended = false
  private limitHit = false

  constructor(
    private paths: Paths,
    private agent: AgentProfile,
    private prompt: string,
    private resumeSessionId: string | null,
    private events: ActivationEvents,
    private cfg: ActivationConfig,
  ) {}

  start() {
    const agentMd = path.join(this.paths.companyDir, 'agents', this.agent.id, 'AGENT.md')
    const systemPrompt = fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : `You are agent ${this.agent.id}.`

    const args = [
      '-p', this.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.agent.model,
      '--append-system-prompt', systemPrompt,
      '--allowedTools', this.cfg.allowedTools,
      '--disallowedTools', 'Bash',
      '--settings', path.join(this.paths.repoRoot, 'office/config/agent-settings.json'),
      '--max-turns', String(this.cfg.maxTurns),
    ]
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId)

    const env: NodeJS.ProcessEnv = { ...process.env, OFFICE_AGENT_ID: this.agent.id }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN

    this.child = spawn('claude', args, { cwd: this.paths.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.events.onStatus('working')

    this.timer = setTimeout(() => this.kill('timeout'), this.cfg.timeoutMs)

    let buf = ''
    this.child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) this.handleEvent(line)
      }
    })
    let stderr = ''
    this.child.stderr!.on('data', (d: Buffer) => { stderr += d.toString().slice(0, 2000) })

    this.child.on('close', (code) => {
      if (this.timer) clearTimeout(this.timer)
      if (this.ended) return
      this.ended = true
      const ok = code === 0
      // Retry once on the fallback model if fable is unavailable on this plan.
      if (!ok && this.cfg.fableFallbackModel && /model/i.test(stderr) && this.agent.model.includes('fable')) {
        this.events.onTranscript(`[office] ${this.agent.model} unavailable — retrying on ${this.cfg.fableFallbackModel}`)
        this.agent = { ...this.agent, model: this.cfg.fableFallbackModel }
        this.cfg = { ...this.cfg, fableFallbackModel: undefined }
        this.ended = false
        this.start()
        return
      }
      if (!ok && LIMIT_ERROR.test(stderr)) this.limitHit = true
      this.events.onEnd({ ok, sessionId: this.sessionId, wroteFiles: this.wroteFiles, wroteMemory: this.wroteMemory, contextTokens: this.maxContextTokens || null, limitHit: this.limitHit, error: ok ? undefined : stderr.slice(0, 500) })
    })
    this.child.on('error', (err) => {
      if (this.timer) clearTimeout(this.timer)
      if (this.ended) return
      this.ended = true
      this.events.onEnd({ ok: false, sessionId: this.sessionId, wroteFiles: this.wroteFiles, wroteMemory: this.wroteMemory, contextTokens: this.maxContextTokens || null, limitHit: this.limitHit, error: String(err) })
    })
  }

  private handleEvent(line: string) {
    let ev: any
    try { ev = JSON.parse(line) } catch { return }

    if (ev.type === 'system' && ev.subtype === 'init') {
      this.sessionId = ev.session_id ?? null
      return
    }
    if (ev.type === 'assistant') {
      // Track peak context size: the largest per-turn prompt is what --resume replays next time.
      const u = ev.message?.usage
      if (u) this.maxContextTokens = Math.max(this.maxContextTokens,
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
      const content = ev.message?.content ?? []
      for (const block of content) {
        if (block.type === 'tool_use') {
          const tool = String(block.name ?? '')
          // Agent-tool dispatches carry their payload in description/subagent_type, not a path.
          const target = block.input?.file_path ?? block.input?.pattern ?? block.input?.url
            ?? block.input?.description ?? block.input?.subagent_type ?? ''
          if (WRITE_TOOLS.test(tool)) {
            this.wroteFiles = true; this.events.onStatus('typing')
            // Note when the agent saves its own notepad — a session reset is only safe after this.
            const fp = String(block.input?.file_path ?? '').replace(/\\/g, '/')
            if (fp.includes(`.claude/agent-memory/${this.agent.id}/MEMORY.md`)) this.wroteMemory = true
          }
          else if (READ_TOOLS.test(tool)) this.events.onStatus('reading')
          this.events.onActivity('tool_use', tool, String(target).slice(0, 120))
          this.events.onTranscript(`[${tool}] ${String(target).slice(0, 160)}`)
        } else if (block.type === 'text' && block.text) {
          this.events.onStatus('talking')
          this.events.onActivity('text', undefined, String(block.text).slice(0, 160))
          this.events.onTranscript(String(block.text).slice(0, 400))
        } else if (block.type === 'thinking') {
          // Headless Opus emits thinking blocks with EMPTY text (display=omitted) — the
          // event still marks WHEN the agent reasons, so the sprite shows 💭 instead of
          // looking frozen. If a future CLI exposes summaries, the text flows through.
          this.events.onActivity('thinking', undefined, String(block.thinking ?? '').slice(0, 120))
          this.events.onTranscript('[thinking]')
        }
      }
      return
    }
    if (ev.type === 'result') {
      this.sessionId = ev.session_id ?? this.sessionId
      if (ev.is_error && typeof ev.result === 'string' && LIMIT_ERROR.test(ev.result)) this.limitHit = true
      this.events.onActivity('turn_end')
      this.events.onTranscript(`[turn end] ${ev.subtype ?? ''} ${ev.is_error ? 'ERROR' : ''}`.trim())
    }
  }

  kill(reason: string) {
    if (this.child && !this.ended) {
      this.events.onTranscript(`[office] killed: ${reason}`)
      this.child.kill('SIGTERM')
      setTimeout(() => { try { this.child?.kill('SIGKILL') } catch { /* gone */ } }, 5_000).unref()
    }
  }
}

/** Persisted map agentId → CLI session id, so --resume keeps continuity. */
export class SessionStore {
  private file: string
  private map: Record<string, string> = {}
  constructor(repoRoot: string) {
    this.file = path.join(repoRoot, 'office', 'state', 'sessions.json')
    try { this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.map = {} }
  }
  get(agentId: string): string | null { return this.map[agentId] ?? null }
  set(agentId: string, sessionId: string) {
    this.map[agentId] = sessionId
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2))
  }
  clear(agentId: string) {
    delete this.map[agentId]
    try { fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2)) } catch { /* best effort */ }
  }
}
