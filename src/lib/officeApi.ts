// HTTP helpers against the office orchestrator's control plane (same host/port
// as the WS). Routes are defined in office/server/ws.ts handleHttp.
import type { LabExperiment } from './labTypes'

// Mirror useOfficeSocket's resolution: env override → localhost dev → same origin
// when served by the office through the tunnel → else the permanent tunnel (Vercel).
const OFFICE_TUNNEL_HOST = 'graves-ladies-condone.ngrok-free.dev'
function officeHttp(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_OFFICE_WS_URL
  if (env) return env.replace(/^ws/, 'http')
  if (typeof window === 'undefined') return 'http://localhost:4571'
  const { hostname, origin } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:4571'
  if (hostname === OFFICE_TUNNEL_HOST) return origin // office serves the page directly
  return 'https://' + OFFICE_TUNNEL_HOST // hosted elsewhere (Vercel) → the permanent tunnel
}
export const OFFICE_HTTP = officeHttp()

function ownerToken(): string {
  try { return sessionStorage.getItem('office-owner-token') ?? '' } catch { return '' }
}

async function req<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const token = ownerToken()
  const headers: Record<string, string> = { 'ngrok-skip-browser-warning': 'true' } // never hit the free-ngrok interstitial on data calls
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers['x-office-token'] = token // owner: reach private files + mutations
  const res = await fetch(`${OFFICE_HTTP}${route}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`)
  return json as T
}

export async function fetchCompanyFile(path: string): Promise<string> {
  const { content } = await req<{ content: string }>('GET', `/api/file?path=${encodeURIComponent(path)}`)
  return content
}

/** Owner-only: fetch a binary company file (lab screenshots) as a Blob. A plain <img src>
    can't carry the owner token or the ngrok-skip header, so images go through fetch →
    object URL instead (see BlobImage). */
export async function fetchCompanyBlob(path: string): Promise<Blob> {
  const token = ownerToken()
  const headers: Record<string, string> = { 'ngrok-skip-browser-warning': 'true' }
  if (token) headers['x-office-token'] = token
  const res = await fetch(`${OFFICE_HTTP}/api/blob?path=${encodeURIComponent(path)}`, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.blob()
}

export async function fetchLabExperiments(): Promise<LabExperiment[]> {
  const { experiments } = await req<{ experiments: LabExperiment[] }>('GET', '/api/lab')
  return experiments
}

/** choice: 1-based option index — REQUIRED by the server when the request offers
    options; note: optional free-text the agent receives with the decision. */
export async function approveRequest(id: string, choice?: number, note?: string): Promise<void> {
  await req('POST', '/api/request/approve', {
    id,
    ...(typeof choice === 'number' ? { choice } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
  })
}

export async function denyRequest(id: string, reason?: string): Promise<void> {
  await req('POST', '/api/request/deny', { id, ...(reason ? { reason } : {}) })
}

export async function killRequest(id: string): Promise<void> {
  await req('POST', '/api/request/kill', { id })
}

/** Owner-only: set the office's usage nap thresholds (% of the 5-hour / 7-day windows)
    and optionally whether spawning is allowed while the usage monitor is blind. */
export async function setUsageLimits(session: number, weekly: number, allowWhenBlind?: boolean): Promise<void> {
  await req('POST', '/api/settings', { session, weekly, ...(typeof allowWhenBlind === 'boolean' ? { allowWhenBlind } : {}) })
}

/** Owner-only: resume the office — clears a manual pause AND a usage hard-stop lock. */
export async function resumeOffice(): Promise<void> {
  await req('POST', '/api/resume')
}

/** Owner-only: force an immediate usage re-check (bypasses the 429 backoff;
    server-side debounced to one per 10s). Fresh numbers arrive via the WS pool
    broadcast; throws with the server's reason when the endpoint is still down. */
export async function refreshUsage(): Promise<void> {
  await req('POST', '/api/usage/refresh')
}
