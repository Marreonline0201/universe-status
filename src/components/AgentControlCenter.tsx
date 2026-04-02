// ── AgentControlCenter ──────────────────────────────────────────────────────────
// 2D scene visualization of the Claude agent hierarchy.
// The Director character walks to whichever agent it last communicated with.
// Speech bubbles show the live message. Blocked agents trigger an approval alert.

import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { AgentState, AgentMessage } from '../hooks/useStatusSocket'

// ── Agent metadata + scene positions (x/y as 0–1 normalized) ─────────────────

interface AgentMeta {
  icon: string
  label: string
  color: string
  x: number   // 0–1 of scene width
  y: number   // 0–1 of scene height
  level: 1 | 2 | 3
  parent: string | null
}

const AGENTS: Record<string, AgentMeta> = {
  'director':           { icon: '👑', label: 'DIRECTOR',       color: '#ffd700', x: 0.50, y: 0.07, level: 1, parent: null },
  'status-worker':      { icon: '🖥', label: 'STATUS',         color: '#60cdcc', x: 0.14, y: 0.42, level: 2, parent: 'director' },
  'gp-agent':           { icon: '🎮', label: 'PLAYTESTER',       color: '#a78bfa', x: 0.50, y: 0.42, level: 2, parent: 'director' },
  'knowledge-director': { icon: '📚', label: 'KNOWLEDGE',      color: '#f472b6', x: 0.86, y: 0.42, level: 2, parent: 'director' },
  'cqa':                { icon: '🔍', label: 'CQA',            color: '#94a3b8', x: 0.06, y: 0.80, level: 3, parent: 'director' },
  'car':                { icon: '📊', label: 'CAR',            color: '#94a3b8', x: 0.20, y: 0.80, level: 3, parent: 'director' },
  'ui-worker':          { icon: '🎨', label: 'UI',             color: '#fb923c', x: 0.36, y: 0.80, level: 3, parent: 'gp-agent' },
  'interaction':        { icon: '🕹', label: 'INTERACTION',    color: '#fb923c', x: 0.50, y: 0.80, level: 3, parent: 'gp-agent' },
  'ai-npc':             { icon: '🤖', label: 'AI NPC',         color: '#fb923c', x: 0.64, y: 0.80, level: 3, parent: 'gp-agent' },
  'physics-prof':       { icon: '⚡', label: 'PHYSICS',        color: '#3bbfff', x: 0.74, y: 0.80, level: 3, parent: 'knowledge-director' },
  'chemistry-prof':     { icon: '⚗',  label: 'CHEMISTRY',      color: '#ff9b3c', x: 0.84, y: 0.80, level: 3, parent: 'knowledge-director' },
  'biology-prof':       { icon: '🧬', label: 'BIOLOGY',        color: '#4cdd88', x: 0.94, y: 0.80, level: 3, parent: 'knowledge-director' },
}

const NODE_R = 18  // node circle radius px
void 0 // DIR_R = 14 reserved for future use

// ── Director SVG character ────────────────────────────────────────────────────

function DirectorFigure({ walking, active }: { walking: boolean; active: boolean }) {
  const opacity = active ? 1 : 0.18
  const glow    = active ? 'drop-shadow(0 0 5px #ffd700)' : 'none'
  return (
    <svg width="22" height="32" viewBox="0 0 22 32" style={{
      filter: glow,
      opacity,
      transition: 'opacity 0.6s ease',
      animation: active ? (walking ? 'dirWalk 0.35s linear infinite alternate' : 'dirIdle 2s ease-in-out infinite') : 'none',
    }}>
      {/* Crown */}
      <polygon points="3,7 5,3 7,6 11,1 15,6 17,3 19,7 3,7" fill="#ffd700" />
      {/* Head */}
      <circle cx="11" cy="11" r="4" fill="#ffd700" />
      {/* Eyes */}
      <circle cx="9.5" cy="10.5" r="0.8" fill="#0a0e1a" />
      <circle cx="12.5" cy="10.5" r="0.8" fill="#0a0e1a" />
      {/* Body */}
      <rect x="8" y="15" width="6" height="8" rx="2" fill="#ffd700" opacity="0.9" />
      {/* Left arm */}
      <line x1="8" y1="17" x2={walking ? "3" : "4"} y2={walking ? "22" : "21"} stroke="#ffd700" strokeWidth="2" strokeLinecap="round" />
      {/* Right arm */}
      <line x1="14" y1="17" x2={walking ? "19" : "18"} y2={walking ? "21" : "22"} stroke="#ffd700" strokeWidth="2" strokeLinecap="round" />
      {/* Left leg */}
      <line x1="9.5" y1="23" x2={walking ? "7" : "8"} y2="31" stroke="#ffd700" strokeWidth="2" strokeLinecap="round" />
      {/* Right leg */}
      <line x1="12.5" y1="23" x2={walking ? "15" : "14"} y2="31" stroke="#ffd700" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// ── Speech bubble ─────────────────────────────────────────────────────────────

function SpeechBubble({ text, fromId, toId }: { text: string; fromId: string; toId: string | null }) {
  const fromMeta = AGENTS[fromId]
  const toMeta   = toId ? AGENTS[toId] : null
  const color    = toMeta?.color ?? fromMeta?.color ?? '#aaa'
  // Flip bubble below the node for agents near the top edge (y < 0.2)
  const flipBelow = (fromMeta?.y ?? 0.5) < 0.2

  return (
    <div style={{
      position: 'absolute',
      ...(flipBelow ? { top: '110%' } : { bottom: '110%' }),
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(4,8,20,0.96)',
      border: `1px solid ${color}`,
      borderRadius: 6,
      padding: '6px 12px',
      fontSize: 11,
      color: 'rgba(220,235,255,0.9)',
      whiteSpace: 'normal',
      width: 220,
      wordBreak: 'break-word',
      lineHeight: 1.5,
      zIndex: 20,
      pointerEvents: 'none',
      boxShadow: `0 0 8px ${color}44`,
      animation: 'bubblePop 0.2s ease-out',
    }}>
      {toId && (
        <span style={{ color, marginRight: 4, fontSize: 10 }}>
          → {AGENTS[toId]?.label ?? toId}:
        </span>
      )}
      {text}
      {/* Tail — points down when above node, up when below */}
      <div style={{
        position: 'absolute',
        ...(flipBelow ? { top: -5 } : { bottom: -5 }),
        left: '50%',
        transform: 'translateX(-50%)',
        width: 8, height: 5,
        clipPath: flipBelow ? 'polygon(50% 0%, 0 100%, 100% 100%)' : 'polygon(50% 100%, 0 0, 100% 0)',
        background: color,
      }} />
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props { agentState: AgentState }

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 520
const SIDEBAR_DEFAULT = 300

export function AgentControlCenter({ agentState }: Props) {
  const sceneRef    = useRef<HTMLDivElement>(null)
  const lastTsRef   = useRef<number>(0)
  const dragRef     = useRef<{ active: boolean; startX: number; startW: number }>({ active: false, startX: 0, startW: SIDEBAR_DEFAULT })
  const [sidebarW, setSidebarW] = useState(SIDEBAR_DEFAULT)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { active: true, startX: e.clientX, startW: sidebarW }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [sidebarW])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current.active) return
      const delta = dragRef.current.startX - e.clientX  // dragging left = bigger sidebar
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragRef.current.startW + delta))
      setSidebarW(next)
    }
    function onUp() {
      if (!dragRef.current.active) return
      dragRef.current.active = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // Director walks to the target of the latest message
  const [dirPos, setDirPos]     = useState({ x: AGENTS['director'].x, y: AGENTS['director'].y })
  const [walking, setWalking]   = useState(false)
  const [bubble, setBubble]     = useState<{ text: string; from: string; to: string | null } | null>(null)
  const [approvals, setApprovals] = useState<string[]>([])

  // Detect new messages → move Director
  useEffect(() => {
    const latest = agentState.messages[0]
    if (!latest || latest.ts === lastTsRef.current) return
    lastTsRef.current = latest.ts

    // Determine where to walk: prefer the "other party" in the conversation
    const target = latest.from === 'director'
      ? (latest.to ?? 'director')
      : latest.from

    const targetMeta = AGENTS[target]
    if (targetMeta) {
      setWalking(true)
      setDirPos({ x: targetMeta.x, y: targetMeta.y })
      setTimeout(() => setWalking(false), 1200)
    }

    setBubble({ text: latest.text, from: latest.from, to: latest.to })
    const clearBubble = setTimeout(() => setBubble(null), 5000)
    return () => clearTimeout(clearBubble)
  }, [agentState.messages])

  // Track blocked agents for approval alerts
  useEffect(() => {
    const blocked = Object.entries(agentState.agents)
      .filter(([_, e]) => e.status === 'blocked')
      .map(([id]) => id)
    setApprovals(blocked)
  }, [agentState.agents])

  const agentIds = Object.keys(AGENTS)

  return (
    <>
      <style>{`
        @keyframes dirWalk {
          from { transform: translate(-50%, -100%) rotate(-4deg); }
          to   { transform: translate(-50%, -100%) rotate(4deg); }
        }
        @keyframes dirIdle {
          0%,100% { transform: translate(-50%, -100%) translateY(0); }
          50%      { transform: translate(-50%, -100%) translateY(-2px); }
        }
        @keyframes bubblePop {
          from { opacity: 0; transform: translateX(-50%) scale(0.85); }
          to   { opacity: 1; transform: translateX(-50%) scale(1); }
        }
        @keyframes nodeGlow {
          0%,100% { box-shadow: 0 0 6px currentColor; }
          50%      { box-shadow: 0 0 14px currentColor; }
        }
        @keyframes blockedPulse {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.5; }
        }
      `}</style>

      <div style={{
        display: 'flex',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}>

        {/* ── Approval banner ─────────────────────────────────────────────── */}
        {approvals.length > 0 && (
          <div style={{
            position: 'absolute',
            top: 6, left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 30,
            background: 'rgba(255,160,0,0.15)',
            border: '1px solid rgba(255,160,0,0.6)',
            borderRadius: 4,
            padding: '4px 14px',
            fontSize: 11,
            color: '#ffb830',
            letterSpacing: 1.5,
            animation: 'blockedPulse 1.2s ease-in-out infinite',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            ⚠ APPROVAL NEEDED — {approvals.map(id => AGENTS[id]?.label ?? id).join(', ')}
          </div>
        )}

        {/* ── 2D Scene ────────────────────────────────────────────────────── */}
        <div ref={sceneRef} style={{
          flex: 1,
          minWidth: 0,
          position: 'relative',
          overflow: 'hidden',
        }}>

          {/* Subtle floor grid */}
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `
              linear-gradient(rgba(0,180,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0,180,255,0.03) 1px, transparent 1px)
            `,
            backgroundSize: '32px 32px',
            pointerEvents: 'none',
          }} />

          {/* SVG hierarchy lines */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            <defs>
              <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="3" refY="2" orient="auto">
                <polygon points="0 0, 6 2, 0 4" fill="rgba(0,180,255,0.18)" />
              </marker>
            </defs>
            {agentIds.filter(id => AGENTS[id].parent).map(id => {
              const a = AGENTS[id]
              const p = AGENTS[a.parent!]
              return (
                <line
                  key={id}
                  x1={`${p.x * 100}%`} y1={`${p.y * 100}%`}
                  x2={`${a.x * 100}%`} y2={`${a.y * 100}%`}
                  stroke="rgba(0,180,255,0.12)"
                  strokeWidth={a.level === 2 ? 1.5 : 1}
                  strokeDasharray={a.level === 3 ? '4,3' : '0'}
                  markerEnd="url(#arrowhead)"
                />
              )
            })}
          </svg>

          {/* Agent nodes */}
          {agentIds.map(id => {
            const meta   = AGENTS[id]
            const entry  = agentState.agents[id] ?? { status: 'idle', task: '', lastSeen: 0 }
            const isActive  = entry.status === 'active'
            const isBlocked = entry.status === 'blocked'
            const isDone    = entry.status === 'done'
            const isBubbleTarget = bubble && (bubble.to === id || (bubble.from === id && !bubble.to))

            const ringColor = isBlocked ? '#ffb830'
              : isActive ? meta.color
              : isDone   ? '#4466aa'
              : 'rgba(0,180,255,0.12)'

            return (
              <div key={id} style={{
                position: 'absolute',
                left: `${meta.x * 100}%`,
                top:  `${meta.y * 100}%`,
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
              }}>
                {/* Bubble above node */}
                {isBubbleTarget && bubble && (
                  <SpeechBubble text={bubble.text} fromId={bubble.from} toId={bubble.to} />
                )}

                {/* Circle */}
                <div style={{
                  width:  NODE_R * 2,
                  height: NODE_R * 2,
                  borderRadius: '50%',
                  background: isActive ? `${meta.color}18` : 'rgba(4,8,20,0.85)',
                  border: `${isActive || isBlocked ? 2 : 1}px solid ${ringColor}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: meta.level === 1 ? 18 : meta.level === 2 ? 15 : 12,
                  color: ringColor,
                  transition: 'border-color 0.4s, background 0.4s',
                  animation: isActive ? 'nodeGlow 2s ease-in-out infinite' : 'none',
                  position: 'relative',
                }}>
                  {meta.icon}
                </div>

                {/* Label */}
                <div style={{
                  fontSize: 10,
                  letterSpacing: 0.8,
                  color: isActive ? meta.color : isBlocked ? '#ffb830' : 'rgba(80,120,180,0.5)',
                  whiteSpace: 'nowrap',
                  transition: 'color 0.4s',
                  fontWeight: isActive ? 600 : 400,
                }}>
                  {meta.label}
                </div>

                {/* Task tooltip if active */}
                {isActive && entry.task && (
                  <div style={{
                    fontSize: 10,
                    color: 'rgba(160,200,240,0.65)',
                    maxWidth: 130,
                    textAlign: 'center',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical' as any,
                  }}>
                    {entry.task}
                  </div>
                )}
              </div>
            )
          })}

          {/* ── Walking Director character ──────────────────────────────── */}
          <div style={{
            position: 'absolute',
            left: `${dirPos.x * 100}%`,
            top:  `${dirPos.y * 100}%`,
            transition: 'left 1.1s cubic-bezier(0.4,0,0.2,1), top 1.1s cubic-bezier(0.4,0,0.2,1)',
            zIndex: 15,
            pointerEvents: 'none',
          }}>
            <DirectorFigure walking={walking} active={(agentState.agents['director']?.status ?? 'idle') === 'active'} />
          </div>

          {/* Label bottom-left */}
          <div style={{
            position: 'absolute', bottom: 6, left: 10,
            fontSize: 10, letterSpacing: 2,
            color: 'rgba(0,180,255,0.2)',
          }}>
            AGENT CONTROL CENTER
          </div>
        </div>

        {/* ── Drag handle ─────────────────────────────────────────────────── */}
        <div
          onMouseDown={onDragStart}
          style={{
            width: 6,
            flexShrink: 0,
            cursor: 'col-resize',
            background: 'transparent',
            borderLeft: '1px solid rgba(0,180,255,0.08)',
            transition: 'background 0.15s',
            zIndex: 10,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,180,255,0.12)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        />

        {/* ── Message feed (right strip) ──────────────────────────────────── */}
        <div style={{
          width: sidebarW,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(2,5,14,0.5)',
          overflow: 'hidden',
        }}>
          <div style={{
            fontSize: 10, letterSpacing: 2,
            color: 'rgba(0,180,255,0.3)',
            padding: '6px 12px 5px',
            borderBottom: '1px solid rgba(0,180,255,0.06)',
            flexShrink: 0,
          }}>
            MESSAGE FEED
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0' }}>
            {agentState.messages.length === 0 ? (
              <div style={{ fontSize: 11, color: 'rgba(80,110,150,0.3)', padding: '10px 12px', fontStyle: 'italic' }}>
                No messages yet.
              </div>
            ) : agentState.messages.filter((msg: AgentMessage) => {
              // Hide heartbeats from agents that are now idle or done
              if (!msg.heartbeat) return true
              const entry = agentState.agents[msg.from]
              return entry && entry.status !== 'idle' && entry.status !== 'done'
            }).map((msg: AgentMessage, i: number) => {
              const fromMeta = AGENTS[msg.from]
              const toMeta   = msg.to ? AGENTS[msg.to] : null
              const isDirected = !!msg.to
              return (
                <div key={i} style={{
                  padding: '5px 10px',
                  borderBottom: '1px solid rgba(0,180,255,0.04)',
                  opacity: msg.heartbeat ? Math.max(0.2, 0.45 - i * 0.03) : Math.max(0.3, 1 - i * 0.05),
                }}>
                  <div style={{ fontSize: 10, color: isDirected ? '#ffb830' : 'rgba(100,140,180,0.5)', marginBottom: 2 }}>
                    <span style={{ color: fromMeta?.color ?? '#aaa' }}>{fromMeta?.label ?? msg.from}</span>
                    {isDirected && (
                      <>
                        <span style={{ color: 'rgba(120,160,200,0.4)' }}> → </span>
                        <span style={{ color: toMeta?.color ?? '#aaa' }}>{toMeta?.label ?? msg.to}</span>
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: msg.heartbeat ? 'rgba(120,160,200,0.45)' : isDirected ? 'rgba(255,200,100,0.8)' : 'rgba(170,200,230,0.65)', lineHeight: 1.45, wordBreak: 'break-word', fontStyle: msg.heartbeat ? 'italic' : 'normal' }}>
                    {msg.text}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

      </div>
    </>
  )
}
