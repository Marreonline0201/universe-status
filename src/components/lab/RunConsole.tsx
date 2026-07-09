// Live console for approved real runs: streams RUN_OUTPUT for one request id,
// stick-to-bottom autoscroll.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { OfficeSocket } from '../../hooks/useOfficeSocket'

const STATUS_COLORS: Record<string, string> = {
  pending: '#ffd700', approved: '#00d4ff', running: '#ff6b35',
  done: '#00ff88', failed: '#ff4444', denied: '#3a4157',
}

export function RunConsole({ office, requestId }: { office: OfficeSocket; requestId: string | null }) {
  const { state } = office
  const [collapsed, setCollapsed] = useState(false)
  const [stuck, setStuck] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Default to the most recent running run when nothing is focused.
  const effectiveId = useMemo(() => {
    if (requestId) return requestId
    const running = state.requests.find(r => r.kind === 'run' && (r.status === 'running' || r.status === 'approved'))
    if (running) return running.id
    const withOutput = Object.keys(state.runOutput)
    return withOutput.length ? withOutput[withOutput.length - 1] : null
  }, [requestId, state.requests, state.runOutput])

  const req = state.requests.find(r => r.id === effectiveId) ?? null
  const lines = (effectiveId ? state.runOutput[effectiveId] : undefined) ?? []

  useEffect(() => {
    const el = scrollRef.current
    if (el && stuck) el.scrollTop = el.scrollHeight
  }, [lines.length, stuck, collapsed])

  return (
    <div style={{ borderTop: '1px solid rgba(0,180,255,0.15)', display: 'flex', flexDirection: 'column', height: collapsed ? 28 : 220, flexShrink: 0 }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          height: 28, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px',
          cursor: 'pointer', background: 'rgba(4,8,18,0.9)', userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, color: 'rgba(0,180,255,0.5)' }}>{collapsed ? '▸' : '▾'} LIVE CONSOLE</span>
        {req && (
          <>
            <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: STATUS_COLORS[req.status] ?? '#8a97b8', fontWeight: 700, letterSpacing: 1 }}>
              {req.status.toUpperCase()}
              {req.status === 'running' && <span style={{ marginLeft: 4, display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: '#ff6b35', animation: 'blockedPulse 1.2s ease-in-out infinite' }} />}
            </span>
            <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: '#8a97b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{req.title}</span>
          </>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 'calc(8px * var(--font-scale, 1))', color: '#3a4157' }}>{lines.length} lines</span>
        {!stuck && !collapsed && (
          <span
            onClick={(e) => { e.stopPropagation(); setStuck(true) }}
            style={{ fontSize: 'calc(8px * var(--font-scale, 1))', color: '#00d4ff', border: '1px solid #00d4ff55', borderRadius: 3, padding: '1px 6px', cursor: 'pointer' }}
          >▼ LATEST</span>
        )}
      </div>
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            setStuck(el.scrollTop + el.clientHeight >= el.scrollHeight - 8)
          }}
          style={{ flex: 1, overflowY: 'auto', background: '#05070f', padding: '6px 10px', fontSize: 'calc(10px * var(--font-scale, 1))', lineHeight: 1.5 }}
        >
          {lines.length === 0 && (
            <div style={{ color: '#3a4157' }}>
              No run output. Approve a run request on the REPORTS tab to watch it live here.
            </div>
          )}
          {lines.map((l, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              <span style={{ color: '#3a4157' }}>{new Date(l.ts).toLocaleTimeString([], { hour12: false })} </span>
              <span style={{ color: l.stream === 'stderr' ? '#c9a06a' : '#a9c1e8' }}>{l.line}</span>
            </div>
          ))}
          {req && (req.status === 'done' || req.status === 'failed') && (
            <div style={{ marginTop: 4, color: req.status === 'done' ? '#00ff88' : '#ff4444', fontSize: 'calc(9px * var(--font-scale, 1))', fontWeight: 700 }}>
              — {req.status}{req.exitCode !== null ? ` · exit ${req.exitCode}` : ''}{req.durationMs !== null ? ` · ${(req.durationMs / 1000).toFixed(1)}s` : ''} —
            </div>
          )}
        </div>
      )}
    </div>
  )
}
