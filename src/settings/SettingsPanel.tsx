// The website Settings panel — a font-size scale that applies to every section at
// once, plus user-set min/max limits. Overlay mirrors common/PasswordModal.
import { useSettings, HARD_MIN, HARD_MAX } from './SettingsContext'

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, color: 'rgba(0,180,255,0.5)', marginBottom: 6,
}
const numInput: React.CSSProperties = {
  width: 64, padding: '4px 6px', background: 'rgba(0,20,50,0.6)',
  border: '1px solid rgba(0,180,255,0.2)', borderRadius: 4, fontSize: 'calc(12px * var(--font-scale, 1))',
  color: 'rgba(220,240,255,0.9)', fontFamily: 'inherit', outline: 'none',
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { scale, min, max, setScale, setMin, setMax, reset } = useSettings()
  const pct = Math.round(scale * 100)

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
        borderRadius: 8, padding: '24px 28px', width: 340,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)', fontFamily: 'inherit',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18,
        }}>
          <span style={{ fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 3, color: 'rgba(0,180,255,0.5)' }}>SETTINGS · FONT SIZE</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'rgba(100,150,200,0.6)',
            fontSize: 'calc(14px * var(--font-scale, 1))', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1,
          }}>✕</button>
        </div>

        {/* Master scale */}
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>TEXT SIZE — ALL SECTIONS</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range" min={min} max={max} step={0.05} value={scale}
              onChange={e => setScale(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#00d4ff', cursor: 'pointer' }}
            />
            <span style={{ fontSize: 'calc(13px * var(--font-scale, 1))', color: '#00d4ff', minWidth: 44, textAlign: 'right' }}>{pct}%</span>
          </div>
          <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)', marginTop: 4 }}>
            Scales text everywhere (Agent Office, Reports, Laboratory, Game Guide, Connections, Fluid Test).
          </div>
        </div>

        {/* Limits */}
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>LIMITS (how small / large it can go)</label>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)' }}>MIN ×</span>
              <input type="number" min={HARD_MIN} max={HARD_MAX} step={0.1} value={min}
                onChange={e => setMin(Number(e.target.value))} style={numInput} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)' }}>MAX ×</span>
              <input type="number" min={HARD_MIN} max={HARD_MAX} step={0.1} value={max}
                onChange={e => setMax(Number(e.target.value))} style={numInput} />
            </div>
            <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.4)', flex: 1, lineHeight: 1.5 }}>
              Allowed range {HARD_MIN}×–{HARD_MAX}×.
            </div>
          </div>
        </div>

        <button onClick={reset} style={{
          width: '100%', padding: '7px 0', background: 'rgba(255,60,60,0.1)',
          border: '1px solid rgba(255,60,60,0.3)', borderRadius: 4, color: '#ff6666',
          fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 2, fontFamily: 'inherit', cursor: 'pointer',
        }}>RESET TO DEFAULT</button>
      </div>
    </div>
  )
}
