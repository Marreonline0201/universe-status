// WebSocket + HTTP control plane.
//
// Access model (so the office can be safely exposed to the internet as a public
// "watch the AI company" dashboard):
//   • Read-only VIEWING is public: the live pixel office (agent statuses/activity),
//     approved reports, and the lab. This is the showcase.
//   • Every MUTATION (approve/deny/kill/assign/pause/resume) and every PRIVATE read
//     (agent mail, tasks, pending requests, drafts, build logs, agent transcripts)
//     requires the OWNER TOKEN, verified here server-side.
//   • The owner token comes from the OFFICE_OWNER_TOKEN env var. If it is UNSET the
//     office runs LOCAL-ONLY (loopback origins only, no public surface) — so it can
//     never be exposed by accident; you opt in by setting the secret.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMsg, LabExperiment, OwnerRequest, ServerMsg } from './protocol.ts'
import type { RunOutputLine } from './runner.ts'

export interface WsAuth {
  ownerToken: string | null      // null → local-only mode (no public exposure)
  allowedOrigins: string[]       // extra browser origins allowed when public (e.g. the vercel site)
}

export interface WsHandlers {
  snapshot: (owner: boolean) => ServerMsg
  agentDetail: (id: string) => ServerMsg | null
  assign: (body: { title: string; team: string; assignee?: string; brief?: string; priority?: string }) => string
  pause: () => void
  resume: () => void
  status: () => unknown
  requests: () => OwnerRequest[]
  file: (repoRelPath: unknown) => { ok: true; path: string; content: string; mtimeMs: number } | { ok: false; error: string; code: 400 | 403 | 404 | 413 }
  blob: (repoRelPath: unknown) => { ok: true; buf: Buffer; contentType: string } | { ok: false; error: string; code: 400 | 403 | 404 | 413 }
  lab: () => LabExperiment[]
  approveRequest: (id: string, choice?: number, note?: string) => { ok: boolean; error?: string }
  denyRequest: (id: string, reason?: string) => { ok: boolean; error?: string }
  killRequest: (id: string) => { ok: boolean; error?: string }
  runOutput: (id: string) => { requestId: string; lines: RunOutputLine[]; running: boolean } | null
  setUsageLimits: (body: { session: number; weekly: number; allowWhenBlind?: boolean }) => { ok: boolean; error?: string }
  refreshUsage: () => Promise<{ ok: boolean; error?: string }>
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

/** Same-origin: the page making the request was served by THIS server (its Origin
 *  host matches the Host header). Always safe — this is what makes the one-URL
 *  tunnel work (office serves the site, so page + API + WS share an origin). */
function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false
  try { return new URL(origin).host === host } catch { return false }
}

/** Match an allowed-origin entry against an origin. `*` matches ≥1 char of a single
 *  URL label (letters/digits/dashes, NO dots), so a pattern like
 *  `https://universe-status-*-pioneer2026.vercel.app` matches this Vercel team's
 *  per-deploy preview URLs but cannot reach another host or drop the anchor labels.
 *  NOTE: `vercel.app` is a shared domain — always anchor the wildcard to something an
 *  attacker can't forge (the team slug here), never a bare `project*` on `*.vercel.app`.
 *  Patterns without `*` are exact matches. */
function originMatches(pattern: string, origin: string): boolean {
  if (!pattern.includes('*')) return pattern === origin
  const rx = '^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-A-Za-z0-9]+') + '$'
  try { return new RegExp(rx).test(origin) } catch { return false }
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
}

/** Server messages that are safe to send to PUBLIC (non-owner) viewers. Everything
 *  else (mail/tasks/requests/run-output/agent transcripts) is owner-only. */
function isPublicMsg(msg: ServerMsg): boolean {
  switch (msg.type) {
    case 'AGENT_STATUS':
    case 'AGENT_ACTIVITY':
    case 'POOL_STATE':
    case 'OFFICE_SHUTDOWN':
      return true
    case 'REPORT_ADDED':
      return msg.report.status === 'approved' // drafts are private
    default:
      return false // CHAT, TASK_UPDATE, REQUEST_UPDATE, RUN_OUTPUT, AGENT_DETAIL, snapshots
  }
}

/** A company-relative path readable by the public: approved reports (team folder,
 *  NOT drafts/) and anything under the lab. */
export function isPublicFilePath(repoRelPath: unknown): boolean {
  if (typeof repoRelPath !== 'string') return false
  const p = repoRelPath.replace(/\\/g, '/')
  return /^company\/reports\/[^/]+\/[^/]+\.md$/.test(p) || /^company\/lab\//.test(p)
}

function tokenEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

export class OfficeWs {
  private wss: WebSocketServer
  private server: http.Server
  private owners = new WeakSet<WebSocket>()
  // Brute-force throttle for the owner password (memorable secret, internet-facing).
  // Global (behind the tunnel every request carries ngrok's edge IP, so per-IP is moot).
  private failWindowStart = 0
  private failCount = 0
  private throttleUntil = 0

  constructor(
    private port: number,
    private handlers: WsHandlers,
    private auth: WsAuth,
    private staticDir: string | null,
    private log: (l: string) => void,
  ) {
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info: { origin?: string; req: http.IncomingMessage }) =>
        this.originAllowed(info.origin || undefined, info.req.headers.host),
    })

    this.wss.on('connection', (ws) => {
      // Every connection starts PUBLIC (curated snapshot). A HELLO carrying the
      // valid owner token upgrades it to the full feed.
      ws.send(JSON.stringify(this.handlers.snapshot(false)))
      ws.on('message', (raw) => {
        let msg: ClientMsg
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.type === 'HELLO') {
          const owner = this.ownerAttempt(msg.token)
          if (owner) this.owners.add(ws); else this.owners.delete(ws)
          ws.send(JSON.stringify(this.handlers.snapshot(owner)))
        }
        if (msg.type === 'GET_AGENT_DETAIL') {
          if (!this.owners.has(ws)) return // transcripts are owner-only
          const detail = this.handlers.agentDetail(msg.id)
          if (detail) ws.send(JSON.stringify(detail))
        }
      })
    })
  }

  /** Local-only mode: loopback origins only. Public mode: loopback + same-origin
   *  (the office is serving the page) + explicitly configured origins. An allowed
   *  origin may contain `*`, which matches one URL label (letters/digits/dashes, no
   *  dots) — so `https://universe-status*.vercel.app` covers both the production
   *  alias and every per-deploy preview URL without allowing another domain. */
  private originAllowed(origin: string | undefined, host?: string): boolean {
    if (isLoopbackOrigin(origin)) return true
    if (!this.auth.ownerToken) return false // no token set → never accept non-local origins
    if (isSameOrigin(origin, host)) return true
    if (!origin) return false
    return this.auth.allowedOrigins.some(p => originMatches(p, origin))
  }

  private checkToken(token: string | undefined): boolean {
    if (!this.auth.ownerToken) return true  // local-only mode: everyone reaching us is the local owner
    return typeof token === 'string' && token.length > 0 && tokenEq(token, this.auth.ownerToken)
  }

  /** checkToken + brute-force throttle. After 8 wrong non-empty passwords within a
   *  60s window, owner upgrades are refused for a 60s cooldown. Empty tokens (public
   *  viewers) and successes never count against the limit. */
  private ownerAttempt(token: string | undefined): boolean {
    const now = Date.now()
    if (now < this.throttleUntil) return false          // locked out
    if (this.checkToken(token)) { this.failCount = 0; return true }
    if (typeof token === 'string' && token.length > 0) { // a genuine wrong password
      if (now - this.failWindowStart > 60_000) { this.failWindowStart = now; this.failCount = 0 }
      if (++this.failCount >= 8) { this.throttleUntil = now + 60_000; this.failCount = 0 }
    }
    return false
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      // Always bind loopback only. Internet exposure is done via a tunnel that
      // connects to 127.0.0.1 locally — the office itself never listens publicly.
      this.server.listen(this.port, '127.0.0.1', () => {
        this.log(`office listening on ws://localhost:${this.port}${this.auth.ownerToken ? ' (public read + owner-token write)' : ' (local-only)'}`)
        resolve()
      })
    })
  }

  broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg)
    const pub = isPublicMsg(msg)
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      if (pub || this.owners.has(client)) client.send(data)
    }
  }

  close() {
    this.broadcast({ type: 'OFFICE_SHUTDOWN' })
    for (const client of this.wss.clients) client.close()
    this.server.close()
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const [route, query] = (req.url ?? '').split('?')
    const params = new URLSearchParams(query ?? '')
    const origin = req.headers.origin
    const host = req.headers.host
    // Static site: serve the built SPA for non-/api GETs (so one tunnel to this
    // port exposes the whole app on a single origin). No origin check needed to
    // fetch the page itself — the API/WS below still enforce it.
    if (this.staticDir && req.method === 'GET' && !route.startsWith('/api/')) {
      return this.serveStatic(route, res)
    }
    const cors: Record<string, string> = origin && this.originAllowed(origin, host)
      ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...cors })
      res.end(JSON.stringify(body))
    }
    if (!this.originAllowed(origin, host)) return json(403, { error: 'forbidden origin' })
    if (req.method === 'OPTIONS' && route.startsWith('/api/')) {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,x-office-token,ngrok-skip-browser-warning',
      })
      return res.end()
    }
    const owner = this.ownerAttempt(req.headers['x-office-token'] as string | undefined)
    const requireOwner = () => { json(401, { error: 'owner token required' }); return false as const }
    const readBody = (handler: (body: Record<string, unknown>) => void) => {
      let raw = ''
      req.on('data', d => { raw += d })
      req.on('end', () => {
        try { handler(JSON.parse(raw || '{}')) } catch (err) { json(400, { error: String(err) }) }
      })
    }

    // ── Public reads ──
    if (req.method === 'GET' && route === '/api/status') return json(200, this.handlers.status())
    if (req.method === 'GET' && route === '/api/lab') return json(200, { experiments: this.handlers.lab() })
    if (req.method === 'GET' && route === '/api/file') {
      const path = params.get('path') ?? undefined
      if (!owner && !isPublicFilePath(path)) return requireOwner()
      const result = this.handlers.file(path)
      return result.ok ? json(200, result) : json(result.code, { error: result.error })
    }

    // ── Owner-only reads ──
    if (req.method === 'GET' && route === '/api/requests') {
      if (!owner) return requireOwner()
      return json(200, { requests: this.handlers.requests() })
    }
    if (req.method === 'GET' && route === '/api/blob') {
      // Binary company images (lab screenshots). Owner-only by design: the sole consumer
      // is the approval card, an owner-only surface — no reason to expose a public binary
      // endpoint on the tunnel. NOTE: the json() helper isn't used here, so CORS headers
      // must be spread into writeHead manually.
      if (!owner) return requireOwner()
      const result = this.handlers.blob(params.get('path') ?? undefined)
      if (!result.ok) return json(result.code, { error: result.error })
      res.writeHead(200, {
        'Content-Type': result.contentType,
        'Content-Length': result.buf.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300',
        ...cors,
      })
      return res.end(result.buf)
    }
    if (req.method === 'GET' && route === '/api/run-output') {
      if (!owner) return requireOwner()
      const out = this.handlers.runOutput(params.get('id') ?? '')
      return out ? json(200, out) : json(404, { error: 'no live output for that id' })
    }

    // ── Owner-only mutations ──
    if (req.method === 'POST' && (route === '/api/pause' || route === '/api/resume')) {
      if (!owner) return requireOwner()
      route === '/api/pause' ? this.handlers.pause() : this.handlers.resume()
      return json(200, { ok: true })
    }
    if (req.method === 'POST' && route === '/api/usage/refresh') {
      if (!owner) return requireOwner()
      void this.handlers.refreshUsage()
        .then(r => json(r.ok ? 200 : 503, r))
        .catch(err => json(500, { ok: false, error: String(err) }))
      return
    }
    if (req.method === 'POST' && route === '/api/settings') {
      if (!owner) return requireOwner()
      return readBody(body => {
        const result = this.handlers.setUsageLimits({
          session: Number(body.session),
          weekly: Number(body.weekly),
          ...(typeof body.allowWhenBlind === 'boolean' ? { allowWhenBlind: body.allowWhenBlind } : {}),
        })
        result.ok ? json(200, { ok: true }) : json(400, { error: result.error ?? 'invalid' })
      })
    }
    if (req.method === 'POST' && route === '/api/assign') {
      if (!owner) return requireOwner()
      return readBody(body => {
        if (!body.title || !body.team) return json(400, { error: 'title and team are required' })
        const id = this.handlers.assign(body as Parameters<WsHandlers['assign']>[0])
        json(200, { ok: true, id })
      })
    }
    if (req.method === 'POST' && (route === '/api/request/approve' || route === '/api/request/deny' || route === '/api/request/kill')) {
      if (!owner) return requireOwner()
      return readBody(body => {
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id) return json(400, { error: 'id is required' })
        const result = route === '/api/request/approve'
          ? this.handlers.approveRequest(id,
              typeof body.choice === 'number' && Number.isInteger(body.choice) ? body.choice : undefined,
              typeof body.note === 'string' ? body.note : undefined)
          : route === '/api/request/deny' ? this.handlers.denyRequest(id, typeof body.reason === 'string' ? body.reason : undefined)
          : this.handlers.killRequest(id)
        result.ok ? json(200, { ok: true }) : json(409, { error: result.error ?? 'rejected' })
      })
    }
    json(404, { error: 'unknown endpoint' })
  }

  /** Serve a file from the static dir; SPA fallback to index.html. Path-traversal
   *  safe: prefix-boundary + symlink (realpath) containment against the root. */
  private serveStatic(route: string, res: http.ServerResponse) {
    const root = path.resolve(this.staticDir!)
    let rel: string
    try { rel = decodeURIComponent(route.replace(/^\/+/, '')) || 'index.html' }
    catch { res.writeHead(400); return res.end('bad path') }
    let abs = path.resolve(root, rel)
    // realpath resolves symlinks; a non-existent path throws → keep the resolved
    // path, which is still boundary-checked below before any SPA fallback.
    try { abs = fs.realpathSync(abs) } catch { /* non-existent — checked, then fallback */ }
    // `root + sep` (not a bare prefix) so a sibling like `dist-ssr` can't pass.
    if (abs !== root && !abs.startsWith(root + path.sep)) { res.writeHead(403); return res.end('forbidden') }
    let file = abs
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html') // SPA fallback
    try {
      const body = fs.readFileSync(file)
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  }
}
