// WebSocket + HTTP control plane. The website connects over WS; the office CLI
// uses the HTTP endpoints (assign/pause/resume/status) against the running server.
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMsg, ServerMsg } from './protocol.ts'

export interface WsHandlers {
  snapshot: () => ServerMsg
  agentDetail: (id: string) => ServerMsg | null
  assign: (body: { title: string; team: string; assignee?: string; brief?: string; priority?: string }) => string
  pause: () => void
  resume: () => void
  status: () => unknown
}

export class OfficeWs {
  private wss: WebSocketServer
  private server: http.Server

  constructor(private port: number, private handlers: WsHandlers, private log: (l: string) => void) {
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ server: this.server })

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
      this.server.listen(this.port, () => {
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
    const url = req.url ?? ''
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url === '/api/status') return json(200, this.handlers.status())
    if (req.method === 'POST' && (url === '/api/pause' || url === '/api/resume')) {
      url === '/api/pause' ? this.handlers.pause() : this.handlers.resume()
      return json(200, { ok: true })
    }
    if (req.method === 'POST' && url === '/api/assign') {
      let raw = ''
      req.on('data', d => { raw += d })
      req.on('end', () => {
        try {
          const body = JSON.parse(raw)
          if (!body.title || !body.team) return json(400, { error: 'title and team are required' })
          const id = this.handlers.assign(body)
          json(200, { ok: true, id })
        } catch (err) { json(400, { error: String(err) }) }
      })
      return
    }
    json(404, { error: 'unknown endpoint' })
  }
}
