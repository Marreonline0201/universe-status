// HTTP helpers against the office orchestrator's control plane (same host/port
// as the WS). Routes are defined in office/server/ws.ts handleHttp.
import type { LabExperiment } from './labTypes'

const WS_URL: string =
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_OFFICE_WS_URL) ?? 'ws://localhost:4571'
export const OFFICE_HTTP = WS_URL.replace(/^ws/, 'http')

function ownerToken(): string {
  try { return sessionStorage.getItem('office-owner-token') ?? '' } catch { return '' }
}

async function req<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const token = ownerToken()
  const headers: Record<string, string> = {}
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

export async function fetchLabExperiments(): Promise<LabExperiment[]> {
  const { experiments } = await req<{ experiments: LabExperiment[] }>('GET', '/api/lab')
  return experiments
}

export async function approveRequest(id: string): Promise<void> {
  await req('POST', '/api/request/approve', { id })
}

export async function denyRequest(id: string, reason?: string): Promise<void> {
  await req('POST', '/api/request/deny', { id, ...(reason ? { reason } : {}) })
}

export async function killRequest(id: string): Promise<void> {
  await req('POST', '/api/request/kill', { id })
}
