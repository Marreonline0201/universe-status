import { useState, useEffect, useRef } from 'react'
import type { FormEvent } from 'react'

/** Shared password modal — the GAME GUIDE login box, reused for the office owner
 *  unlock so both surfaces look and feel identical. Presentational only: `onSubmit`
 *  decides acceptance (the docs compare a client-side hash; the office verifies the
 *  password server-side). Returns `true` to close on success, `false` to show the
 *  "Incorrect password" error and clear the field. */
export function PasswordModal({ title, onSubmit, onClose }: {
  title: string
  onSubmit: (pw: string) => Promise<boolean>
  onClose: () => void
}) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(false)
    const ok = await onSubmit(pw)
    setLoading(false)
    if (ok) onClose()
    else { setError(true); setPw('') }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()} style={{
        background: 'rgba(8,14,28,0.96)',
        border: '1px solid rgba(0,180,255,0.2)',
        borderRadius: 8, padding: '28px 32px', width: 320,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{
          fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 3, color: 'rgba(0,180,255,0.4)',
          marginBottom: 16,
        }}>
          {title}
        </div>
        <input
          ref={inputRef}
          type="password"
          placeholder="Password"
          value={pw}
          onChange={e => { setPw(e.target.value); setError(false) }}
          style={{
            width: '100%', padding: '8px 12px',
            background: 'rgba(0,20,50,0.6)',
            border: `1px solid ${error ? 'rgba(255,80,80,0.5)' : 'rgba(0,180,255,0.2)'}`,
            borderRadius: 4, fontSize: 'calc(13px * var(--font-scale, 1))',
            color: 'rgba(220,240,255,0.9)',
            fontFamily: 'inherit', outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {error && (
          <div style={{ fontSize: 'calc(10px * var(--font-scale, 1))', color: 'rgba(255,80,80,0.7)', marginTop: 6 }}>
            Incorrect password
          </div>
        )}
        <button type="submit" disabled={loading || !pw} style={{
          marginTop: 14, width: '100%', padding: '7px 0',
          background: pw ? 'rgba(0,180,255,0.15)' : 'rgba(0,180,255,0.05)',
          border: '1px solid rgba(0,180,255,0.3)',
          borderRadius: 4, color: '#00d4ff',
          fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 2,
          fontFamily: 'inherit', cursor: pw ? 'pointer' : 'default',
        }}>
          {loading ? 'CHECKING...' : 'UNLOCK'}
        </button>
      </form>
    </div>
  )
}
