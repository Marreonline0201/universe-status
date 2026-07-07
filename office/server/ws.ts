// WebSocket + HTTP control plane. The website connects over WS; the office CLI
// uses the HTTP endpoints (assign/pause/resume/status) against the running server.
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMsg, LabExperiment, OwnerRequest, ServerMsg } from './protocol.ts'
import type { RunOutputLine } from './runner.ts'

export interface WsHandlers {
  snapshot: () => ServerMsg
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

/** Absent Origin (CLI, curl) or a local page. Company data must not be readable
 *  cross-origin: CORS doesn't protect WS at all, and ACAO:* would let any
 *  webpage the owner visits exfiltrate reports/requests via the browser. */
function isLocalOrigin(origin: string | undefined): boolean {
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

export class OfficeWs {
  private wss: WebSocketServer
  private server: http.Server

  constructor(private port: number, private handlers: WsHandlers, private log: (l: string) => void) {
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info: { origin?: string }) => isLocalOrigin(info.origin || undefined),
    })

    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify(this.handlers.snapshot()))
      ws.on('message', (raw) => {
        let msg: ClientMsg
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.type === 'HELLO') ws.send(JSON.stringify(this.handlers.snapshot()))
        if (msg.type === 'GET_AGENT_DETAIL') {
          const detail = this.handlers.agentDetail(msg.id)
          if (detail) ws.send(JSON.stringify(detail))
        }
      })
    })
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      // Loopback only: the control plane can approve command execution — it must
      // never be reachable from the network.
      this.server.listen(this.port, '127.0.0.1', () => {
        this.log(`office listening on ws://localhost:${this.port}`)
        resolve()
      })
    })
  }

  broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg)
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data)
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
    // Echo the validated local origin — never ACAO:* — so foreign pages cannot
    // read company data through the owner's browser. Foreign origins get 403
    // on EVERY route (reads included; reports/requests/mail are private).
    const cors: Record<string, string> = origin && isLocalOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...cors })
      res.end(JSON.stringify(body))
    }
    if (!isLocalOrigin(origin)) return json(403, { error: 'forbidden origin' })
    // Browser preflight for JSON POSTs from the Vite origin.
    if (req.method === 'OPTIONS' && route.startsWith('/api/')) {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      return res.end()
    }
    const readBody = (handler: (body: Record<string, unknown>) => void) => {
      let raw = ''
      req.on('data', d => { raw += d })
      req.on('end', () => {
        try { handler(JSON.parse(raw || '{}')) } catch (err) { json(400, { error: String(err) }) }
      })
    }

    if (req.method === 'GET' && route === '/api/status') return json(200, this.handlers.status())
    if (req.method === 'GET' && route === '/api/requests') return json(200, { requests: this.handlers.requests() })
    if (req.method === 'GET' && route === '/api/lab') return json(200, { experiments: this.handlers.lab() })
    if (req.method === 'GET' && route === '/api/file') {
      const result = this.handlers.file(params.get('path') ?? undefined)
      return result.ok ? json(200, result) : json(result.code, { error: result.error })
    }
    if (req.method === 'GET' && route === '/api/run-output') {
      const out = this.handlers.runOutput(params.get('id') ?? '')
      return out ? json(200, out) : json(404, { error: 'no live output for that id' })
    }
    if (req.method === 'POST' && (route === '/api/pause' || route === '/api/resume')) {
      route === '/api/pause' ? this.handlers.pause() : this.handlers.resume()
      return json(200, { ok: true })
    }
    if (req.method === 'POST' && route === '/api/assign') {
      return readBody(body => {
        if (!body.title || !body.team) return json(400, { error: 'title and team are required' })
        const id = this.handlers.assign(body as Parameters<WsHandlers['assign']>[0])
        json(200, { ok: true, id })
      })
    }
    if (req.method === 'POST' && (route === '/api/request/approve' || route === '/api/request/deny' || route === '/api/request/kill')) {
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
