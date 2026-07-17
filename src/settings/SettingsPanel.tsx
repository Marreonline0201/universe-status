// The website Settings panel. Two things:
//  1. Font size — a personal, client-side scale that applies to every section at once.
//  2. Agent usage limits — the office's nap thresholds (% of the 5-hour / 7-day
//     subscription windows). Owner-only; saved + applied on the office server.
// Overlay mirrors common/PasswordModal.
import { useEffect, useState } from 'react'
import { useSettings, FONT_MIN, FONT_MAX } from './SettingsContext'
import { setUsageLimits } from '../lib/officeApi'
import type { OfficeSocket } from '../hooks/useOfficeSocket'

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, color: 'rgba(0,180,255,0.5)', marginBottom: 6,
}
const numInput: React.CSSProperties = {
  width: 72, padding: '5px 7px', background: 'rgba(0,20,50,0.6)',
  border: '1px solid rgba(0,180,255,0.2)', borderRadius: 4, fontSize: 'calc(13px * var(--font-scale, 1))',
  color: 'rgba(220,240,255,0.9)', fontFamily: 'inherit', outline: 'none',
}

export function SettingsPanel({ onClose, office }: { onClose: () => void; office: OfficeSocket }) {
  const { scale, setScale, reset } = useSettings()
  const pct = Math.round(scale * 100)

  const owner = office.state.owner
  const connected = office.state.connected
  const pool = office.state.pool
  const [sMax, setSMax] = useState(pool.sessionThresholdPct)
  const [wMax, setWMax] = useState(pool.weeklyThresholdPct)
  const [blindOk, setBlindOk] = useState(pool.allowWhenBlind)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Re-sync the inputs whenever the office broadcasts new thresholds (e.g. after a save).
  useEffect(() => {
    setSMax(pool.sessionThresholdPct); setWMax(pool.weeklyThresholdPct); setBlindOk(pool.allowWhenBlind)
  }, [pool.sessionThresholdPct, pool.weeklyThresholdPct, pool.allowWhenBlind])

  const dirty = sMax !== pool.sessionThresholdPct || wMax !== pool.weeklyThresholdPct || blindOk !== pool.allowWhenBlind
  const save = async () => {
    setSaving(true); setSaveErr(null); setSaved(false)
    try { await setUsageLimits(sMax, wMax, blindOk); setSaved(true) }
    catch (e) { setSaveErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  const usageNow = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: 'rgba(8,14,28,0.96)', border: '1px solid rgba(0,180,255,0.2)',
        borderRadius: 8, padding: '24px 28px', width: 380,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)', fontFamily: 'inherit',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 3, color: 'rgba(0,180,255,0.5)' }}>SETTINGS</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'rgba(100,150,200,0.6)',
            fontSize: 'calc(14px * var(--font-scale, 1))', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1,
          }}>✕</button>
        </div>

        {/* ── Font size (personal) ── */}
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>TEXT SIZE — ALL SECTIONS</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range" min={FONT_MIN} max={FONT_MAX} step={0.05} value={scale}
              onChange={e => setScale(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#00d4ff', cursor: 'pointer' }}
            />
            <span style={{ fontSize: 'calc(13px * var(--font-scale, 1))', color: '#00d4ff', minWidth: 44, textAlign: 'right' }}>{pct}%</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
            <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)' }}>Scales text everywhere.</span>
            <button onClick={reset} style={{
              background: 'none', border: 'none', color: 'rgba(255,120,120,0.7)',
              fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1, cursor: 'pointer', fontFamily: 'inherit', padding: 0,
            }}>reset</button>
          </div>
        </div>

        <div style={{ height: 1, background: 'rgba(0,180,255,0.12)', margin: '18px 0' }} />

        {/* ── Agent usage limits (office-side, owner-only) ── */}
        <div>
          <label style={labelStyle}>AGENT USAGE LIMITS</label>
          <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)', marginBottom: 12, lineHeight: 1.5 }}>
            How much of your subscription the agents may use before the office naps (and resumes when the window resets).
          </div>

          <div style={{ display: 'flex', gap: 20, marginBottom: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)' }}>SESSION MAX % (5-hour)</span>
              <input type="number" min={10} max={100} step={1} value={sMax} disabled={!owner || !connected}
                onChange={e => { setSMax(Number(e.target.value)); setSaved(false) }} style={{ ...numInput, opacity: owner && connected ? 1 : 0.5 }} />
              <span style={{ fontSize: 'calc(8px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.4)' }}>now {usageNow(pool.usagePct)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)' }}>WEEKLY MAX % (7-day)</span>
              <input type="number" min={10} max={100} step={1} value={wMax} disabled={!owner || !connected}
                onChange={e => { setWMax(Number(e.target.value)); setSaved(false) }} style={{ ...numInput, opacity: owner && connected ? 1 : 0.5 }} />
              <span style={{ fontSize: 'calc(8px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.4)' }}>now {usageNow(pool.weeklyPct)}</span>
            </div>
          </div>

          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12,
            cursor: owner && connected ? 'pointer' : 'default', opacity: owner && connected ? 1 : 0.5,
          }}>
            <input
              type="checkbox" checked={blindOk} disabled={!owner || !connected}
              onChange={e => { setBlindOk(e.target.checked); setSaved(false) }}
              style={{ accentColor: '#ff6b35', marginTop: 2 }}
            />
            <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.6)', lineHeight: 1.5 }}>
              <span style={{ color: 'rgba(255,150,100,0.9)' }}>Allow agents while usage is unknown.</span>{' '}
              When Anthropic's usage endpoint is down, the office normally holds new agent sessions
              (an unverified window is a billing risk). Tick this ONLY if extra-usage billing is
              disabled in your Anthropic console — then sessions refuse at the limit instead of charging money.
            </span>
          </label>

          {!connected && (
            <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(255,170,80,0.7)' }}>Office offline — can't change limits.</div>
          )}
          {connected && !owner && (
            <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)' }}>Unlock as owner in the Agent Office to change these.</div>
          )}
          {connected && owner && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={save} disabled={!dirty || saving} style={{
                padding: '6px 16px',
                background: dirty && !saving ? 'rgba(0,180,255,0.15)' : 'rgba(0,180,255,0.05)',
                border: '1px solid rgba(0,180,255,0.3)', borderRadius: 4, color: '#00d4ff',
                fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 2, fontFamily: 'inherit',
                cursor: dirty && !saving ? 'pointer' : 'default',
              }}>{saving ? 'SAVING…' : 'SAVE LIMITS'}</button>
              {saved && !dirty && <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: '#00ff88' }}>✓ applied live</span>}
              {saveErr && <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: '#ff8787' }}>{saveErr}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
