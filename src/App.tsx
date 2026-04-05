import { useState } from 'react'
import { useStatusSocket } from './hooks/useStatusSocket'
import { DocsPage } from './components/DocsPage'
import { AgentControlCenter } from './components/AgentControlCenter'
import { ConnectionMap } from './components/ConnectionMap'
import { FluidTest } from './components/FluidTest'

type View = 'docs' | 'connections' | 'agents' | 'fluid'

const VIEWS: { id: View; label: string }[] = [
  { id: 'docs',        label: 'GAME GUIDE' },
  { id: 'connections',  label: 'CONNECTIONS' },
  { id: 'agents',      label: 'AGENT CONTROL' },
  { id: 'fluid',       label: 'FLUID TEST' },
]

export function App() {
  const world = useStatusSocket()
  const [view, setView] = useState<View>('docs')
  const hasBlocked = Object.values(world.agentState.agents).some(a => a.status === 'blocked')

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'hidden',
      animation: 'fadeInUp 0.4s ease-out both',
    }}>

      {/* ── Header / Tab bar ─────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 12px',
        height: 36,
        flexShrink: 0,
        background: 'rgba(4,6,16,0.95)',
        borderBottom: '1px solid rgba(0,180,255,0.1)',
        position: 'relative',
        zIndex: 10,
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--cyan)',
          letterSpacing: 2,
          marginRight: 16,
          opacity: 0.6,
        }}>
          UNIVERSE
        </span>

        {VIEWS.map(v => {
          const isActive = view === v.id
          const showAlert = v.id === 'agents' && hasBlocked
          return (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              style={{
                background: isActive ? 'rgba(0,180,255,0.1)' : 'none',
                border: `1px solid ${isActive ? 'rgba(0,180,255,0.4)' : 'rgba(0,180,255,0.1)'}`,
                borderRadius: 3,
                color: isActive ? '#00d4ff' : 'rgba(100,150,200,0.45)',
                fontSize: 9,
                letterSpacing: 2,
                padding: '3px 14px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.15s',
                position: 'relative',
              }}
            >
              {v.label}
              {showAlert && (
                <span style={{
                  position: 'absolute',
                  top: -4, right: -4,
                  width: 8, height: 8,
                  borderRadius: '50%',
                  background: '#ffb830',
                  boxShadow: '0 0 6px #ffb830',
                  animation: 'blockedPulse 1.2s ease-in-out infinite',
                }} />
              )}
            </button>
          )
        })}

        {/* Connection status */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: world.connected ? 'var(--green)' : '#ff4444',
            boxShadow: world.connected ? '0 0 6px var(--green)' : '0 0 6px #ff4444',
          }} />
          <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>
            {world.connected ? 'CONNECTED' : 'OFFLINE'}
          </span>
        </div>
      </div>

      {/* ── Page content ─────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', zIndex: 5, overflow: 'hidden' }}>
        {view === 'docs' && <DocsPage />}
        {view === 'connections' && <ConnectionMap />}
        {view === 'agents' && (
          <div style={{ height: '100%', background: 'rgba(4,8,18,0.88)' }}>
            <AgentControlCenter agentState={world.agentState} />
          </div>
        )}
        {view === 'fluid' && <FluidTest />}
      </div>
    </div>
  )
}
