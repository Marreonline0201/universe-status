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
  lab: () => LabExperiment[]
  approveRequest: (id: string) => { ok: boolean; error?: string }
  denyRequest: (id: string, reason?: string) => { ok: boolean; error?: string }
  killRequest: (id: string) => { ok: boolean; error?: string }
  runOutput: (id: string) => { requestId: string; lines: RunOutputLine[]; running: boolean } | null
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
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

  constructor(private port: number, private handlers: WsHandlers, private auth: WsAuth, private log: (l: string) => void) {
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info: { origin?: string }) => this.originAllowed(info.origin || undefined),
    })

    this.wss.on('connection', (ws) => {
      // Every connection starts PUBLIC (curated snapshot). A HELLO carrying the
      // valid owner token upgrades it to the full feed.
      ws.send(JSON.stringify(this.handlers.snapshot(false)))
      ws.on('message', (raw) => {
        let msg: ClientMsg
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.type === 'HELLO') {
          const owner = this.checkToken(msg.token)
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

  /** Local-only mode: loopback origins only. Public mode: loopback + configured origins. */
  private originAllowed(origin: string | undefined): boolean {
    if (isLoopbackOrigin(origin)) return true
    if (!this.auth.ownerToken) return false // no token set → never accept non-local origins
    return !!origin && this.auth.allowedOrigins.includes(origin)
  }

  private checkToken(token: string | undefined): boolean {
    if (!this.auth.ownerToken) return true  // local-only mode: everyone reaching us is the local owner
    return typeof token === 'string' && token.length > 0 && tokenEq(token, this.auth.ownerToken)
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
    const cors: Record<string, string> = origin && this.originAllowed(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...cors })
      res.end(JSON.stringify(body))
    }
    if (!this.originAllowed(origin)) return json(403, { error: 'forbidden origin' })
    if (req.method === 'OPTIONS' && route.startsWith('/api/')) {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,x-office-token',
      })
      return res.end()
    }
    const owner = this.checkToken(req.headers['x-office-token'] as string | undefined)
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
        const result = route === '/api/request/approve' ? this.handlers.approveRequest(id)
          : route === '/api/request/deny' ? this.handlers.denyRequest(id, typeof body.reason === 'string' ? body.reason : undefined)
          : this.handlers.killRequest(id)
        result.ok ? json(200, { ok: true }) : json(409, { error: result.error ?? 'rejected' })
      })
    }
    json(404, { error: 'unknown endpoint' })
  }
}
