// Top-level REPORTS tab: owner approvals inbox + team reports (readable) +
// finished tasks. List pane left, rendered-markdown reader right.
import { useMemo, useState } from 'react'
import type { OfficeSocket, ReportMeta, TaskSummary } from '../../hooks/useOfficeSocket'
import { MockBanner } from '../common/MockBanner'
import { ApprovalCard } from './ApprovalCard'
import { ReportReader } from './ReportReader'

const MONO = '"IBM Plex Mono", monospace'
const TASK_STATUS_COLORS: Record<string, string> = { done: '#00ff88', archived: '#3a4157' }

function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ color, fontSize: 9, letterSpacing: 2, fontWeight: 700, margin: '14px 0 6px', opacity: 0.9 }}>
      {label}
    </div>
  )
}

function ReportRow({ r, selected, onClick, teamColor }: {
  r: ReportMeta; selected: boolean; onClick: () => void; teamColor: string
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 8px', marginBottom: 4, borderRadius: 3, cursor: 'pointer',
        borderLeft: selected ? '2px solid #00d4ff' : '2px solid transparent',
        background: selected ? 'rgba(0,180,255,0.06)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', gap: 8, fontSize: 9, letterSpacing: 1 }}>
        <span style={{ color: r.status === 'approved' ? '#00ff88' : '#ffd700', fontWeight: 700 }}>
          {r.status === 'approved' ? '✓ APPROVED' : '… DRAFT'}
        </span>
        <span style={{ marginLeft: 'auto', color: teamColor }}>{r.team}</span>
      </div>
      <div style={{ color: '#cfe3ff', fontSize: 11, marginTop: 2 }}>{r.title}</div>
      <div style={{ color: '#3a4157', fontSize: 8, marginTop: 2 }}>{r.date}{r.reviewedBy ? ` · reviewed by ${r.reviewedBy}` : ''}</div>
    </div>
  )
}

function FinishedTaskRow({ t }: { t: TaskSummary }) {
  return (
    <div style={{ padding: '5px 8px', marginBottom: 3, borderRadius: 3, background: 'rgba(8,12,24,0.5)' }}>
      <div style={{ display: 'flex', gap: 8, fontSize: 9, letterSpacing: 1 }}>
        <span style={{ color: TASK_STATUS_COLORS[t.status] ?? '#8a97b8', fontWeight: 700 }}>{t.status.toUpperCase()}</span>
        <span style={{ marginLeft: 'auto', color: '#5c6a8a' }}>{t.team}</span>
      </div>
      <div style={{ color: '#a9c1e8', fontSize: 10, marginTop: 2 }}>{t.title}</div>
      {t.assignee && <div style={{ color: '#3a4157', fontSize: 8 }}>→ {t.assignee}</div>}
    </div>
  )
}

export function ReportsPage({ office, onWatchRun }: {
  office: OfficeSocket
  onWatchRun: (requestId: string) => void
}) {
  const { state } = office
  const [selected, setSelected] = useState<string | null>(null)

  const pending = state.requests.filter(r => r.status === 'pending')
  const inFlight = state.requests.filter(r => r.status === 'approved' || r.status === 'running')
  const settled = state.requests
    .filter(r => r.status === 'done' || r.status === 'failed' || r.status === 'denied')
    .slice(0, 10)

  const teamColor = useMemo(() => {
    const m = new Map(state.teams.map(t => [t.id, t.color]))
    return (id: string) => m.get(id) ?? '#5c6a8a'
  }, [state.teams])

  const reportsByTeam = useMemo(() => {
    const groups = new Map<string, ReportMeta[]>()
    for (const r of state.reports) {
      const g = groups.get(r.team) ?? []
      g.push(r)
      groups.set(r.team, g)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [state.reports])

  const finishedTasks = useMemo(() =>
    state.tasks.filter(t => t.status === 'done' || t.status === 'archived').sort((a, b) => b.updatedAt - a.updatedAt),
  [state.tasks])

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: MONO, color: '#cfe3ff', position: 'relative' }}>
      {state.mock && state.connected && <MockBanner sub="approvals and reports below are scripted demo data" />}

      {/* ── list pane ── */}
      <div style={{
        width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid rgba(0,180,255,0.15)', background: 'rgba(4,8,18,0.92)',
      }}>
        <div style={{ padding: '10px 12px 4px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 9, letterSpacing: 3, color: 'rgba(0,180,255,0.5)' }}>REPORTS &amp; APPROVALS</span>
          {!state.connected && <span style={{ fontSize: 8, color: '#ff4444', letterSpacing: 1 }}>● OFFICE OFFLINE</span>}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 24px' }}>
          {(pending.length > 0 || inFlight.length > 0 || settled.length > 0) && (
            <>
              <SectionHeader label={`OWNER APPROVALS${pending.length ? ` (${pending.length})` : ''}`} color="#ffd700" />
              {[...pending].sort((a, b) => a.createdAt - b.createdAt).map(r =>
                <ApprovalCard key={r.id} req={r} mock={state.mock} onWatch={onWatchRun} />)}
              {inFlight.map(r => <ApprovalCard key={r.id} req={r} mock={state.mock} onWatch={onWatchRun} />)}
              {settled.map(r => <ApprovalCard key={r.id} req={r} mock={state.mock} onWatch={onWatchRun} />)}
            </>
          )}

          {reportsByTeam.map(([team, reports]) => (
            <div key={team}>
              <SectionHeader label={team.toUpperCase()} color={teamColor(team)} />
              {reports.map(r => (
                <ReportRow
                  key={r.path}
                  r={r}
                  teamColor={teamColor(team)}
                  selected={selected === r.path}
                  onClick={() => setSelected(r.path)}
                />
              ))}
            </div>
          ))}
          {state.reports.length === 0 && (
            <div style={{ color: '#3a4157', fontSize: 10, padding: 8 }}>
              No reports yet — the company writes them into company/reports/&lt;team&gt;/.
            </div>
          )}

          {finishedTasks.length > 0 && (
            <>
              <SectionHeader label={`FINISHED TASKS (${finishedTasks.length})`} color="#00ff88" />
              {finishedTasks.map(t => <FinishedTaskRow key={t.id} t={t} />)}
            </>
          )}
        </div>
      </div>

      {/* ── reader pane ── */}
      <ReportReader path={selected} office={office} />
    </div>
  )
}
