// One owner-request card: shows EXACTLY what will run before any click, with a
// two-click confirm for both approve and deny.
import { useEffect, useRef, useState } from 'react'
import type { OwnerRequest } from '../../hooks/useOfficeSocket'
import { approveRequest, denyRequest, killRequest } from '../../lib/officeApi'

const KIND_COLORS: Record<string, string> = { run: '#ff6b35', decision: '#00d4ff', access: '#00d4ff' }
const STATUS_COLORS: Record<string, string> = {
  pending: '#ffd700', approved: '#00d4ff', running: '#ff6b35',
  done: '#00ff88', failed: '#ff4444', denied: '#3a4157',
}

function age(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export function ApprovalCard({ req, mock, onWatch }: {
  req: OwnerRequest
  mock: boolean
  onWatch?: (id: string) => void
}) {
  const [confirm, setConfirm] = useState<'none' | 'approve' | 'deny'>('none')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (confirm !== 'none') {
      resetTimer.current = setTimeout(() => setConfirm('none'), 6000)
      return () => { if (resetTimer.current) clearTimeout(resetTimer.current) }
    }
  }, [confirm])
  useEffect(() => { setConfirm('none'); setErr(null) }, [req.status])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try { await fn() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
    setConfirm('none')
  }

  const pending = req.status === 'pending'
  const kindColor = KIND_COLORS[req.kind] ?? '#8a97b8'
  const statusColor = STATUS_COLORS[req.status] ?? '#8a97b8'

  const btn = (label: string, color: string, onClick: () => void, solid = false): React.ReactElement => (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        background: solid ? `${color}26` : 'transparent', border: `1px solid ${color}88`, color,
        fontFamily: 'inherit', fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 1, padding: '4px 10px', borderRadius: 3,
        cursor: busy ? 'wait' : 'pointer', fontWeight: 700,
      }}
    >{label}</button>
  )

  return (
    <div style={{
      border: `1px solid ${pending ? 'rgba(255,215,0,0.4)' : 'rgba(90,110,150,0.25)'}`,
      borderRadius: 4, padding: 10, marginBottom: 8, background: 'rgba(8,12,24,0.7)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1 }}>
        <span style={{ color: kindColor, fontWeight: 700 }}>{req.kind.toUpperCase()}</span>
        <span style={{ color: statusColor, fontWeight: 700 }}>
          {req.status.toUpperCase()}
          {req.status === 'running' && <span style={{ marginLeft: 4, display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: statusColor, animation: 'blockedPulse 1.2s ease-in-out infinite' }} />}
        </span>
        <span style={{ color: '#5c6a8a' }}>{req.requestedBy}{req.team ? ` · ${req.team}` : ''}</span>
        <span style={{ marginLeft: 'auto', color: '#5c6a8a' }}>{age(req.createdAt)}</span>
      </div>

      <div style={{ color: '#cfe3ff', fontSize: 'calc(12px * var(--font-scale, 1))', margin: '6px 0' }}>{req.title}</div>

      {req.command && (
        <pre style={{
          background: '#05070f', borderRadius: 3, padding: 6, fontSize: 'calc(10px * var(--font-scale, 1))', margin: '6px 0',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#a9c1e8',
        }}>
          {`$ ${req.command.join(' ')}`}
          <span style={{ color: '#5c6a8a' }}>{`\ncwd: ${req.cwd}${req.runsIn === 'worktree' ? '  (runs on lab/agent-experiments — main untouched)' : ''}`}</span>
        </pre>
      )}
      {req.warn && <div style={{ color: '#ffd700', fontSize: 'calc(9px * var(--font-scale, 1))', margin: '4px 0' }}>⚠ {req.warn}</div>}
      {!req.valid && <div style={{ color: '#ff8787', fontSize: 'calc(9px * var(--font-scale, 1))', margin: '4px 0' }}>✗ not approvable: {req.invalidReason}</div>}

      {pending && req.valid && confirm === 'none' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {btn('APPROVE', '#00ff88', () => setConfirm('approve'))}
          {btn('DENY', '#ff4444', () => setConfirm('deny'))}
        </div>
      )}
      {pending && confirm === 'approve' && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: '#ffd700', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1, marginBottom: 4 }}>
            {req.kind === 'run'
              ? `CONFIRM — will execute the command above in ${req.cwd}${mock ? ' (MOCK)' : ''}`
              : `CONFIRM — the agent will be told this was approved${mock ? ' (MOCK)' : ''}`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {btn('✓ CONFIRM APPROVE', '#00ff88', () => void act(() => approveRequest(req.id)), true)}
            {btn('CANCEL', '#8a97b8', () => setConfirm('none'))}
          </div>
        </div>
      )}
      {pending && confirm === 'deny' && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: '#ff8787', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1, marginBottom: 4 }}>
            CONFIRM DENY — the agent will be told this was denied{mock ? ' (MOCK)' : ''}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {btn('✗ CONFIRM DENY', '#ff4444', () => void act(() => denyRequest(req.id)), true)}
            {btn('CANCEL', '#8a97b8', () => setConfirm('none'))}
          </div>
        </div>
      )}

      {req.status === 'running' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {onWatch && btn('WATCH LIVE →', '#00d4ff', () => onWatch(req.id))}
          {btn('KILL', '#ff4444', () => void act(() => killRequest(req.id)))}
        </div>
      )}
      {(req.status === 'done' || req.status === 'failed') && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: statusColor }}>
            {req.exitCode !== null ? `exit ${req.exitCode}` : ''}
            {req.durationMs !== null ? ` · ${(req.durationMs / 1000).toFixed(1)}s` : ''}
          </div>
          {req.resultTail && (
            <pre style={{
              background: '#05070f', borderRadius: 3, padding: 6, fontSize: 'calc(9px * var(--font-scale, 1))', margin: '4px 0 0',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#7d92b8', maxHeight: 120, overflowY: 'auto',
            }}>{req.resultTail}</pre>
          )}
        </div>
      )}

      {err && <div style={{ color: '#ff8787', fontSize: 'calc(9px * var(--font-scale, 1))', marginTop: 4 }}>✗ {err}</div>}
    </div>
  )
}
