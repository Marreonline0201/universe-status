// Authenticated image: fetches a company/** binary through /api/blob (owner token +
// ngrok-skip headers, which a plain <img src> cannot carry) and renders it via an
// object URL. Click opens the full-size image in a new tab. company/-relative paths
// ONLY — external URLs are never rendered (agent-authored content must not be able
// to beacon out from the owner's browser).
import { useEffect, useState } from 'react'
import { fetchCompanyBlob } from '../../lib/officeApi'

export function BlobImage({ path, maxHeight = 180 }: { path: string; maxHeight?: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false
    setUrl(null)
    setErr(false)
    fetchCompanyBlob(path)
      .then(blob => {
        if (cancelled) return
        revoked = URL.createObjectURL(blob)
        setUrl(revoked)
      })
      .catch(() => { if (!cancelled) setErr(true) })
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [path])

  if (err) {
    return (
      <div style={{
        border: '1px dashed rgba(120,140,180,0.4)', borderRadius: 3, padding: '10px 12px',
        color: '#5c6a8a', fontSize: 'calc(9px * var(--font-scale, 1))',
      }}>
        ✗ image unavailable: {path.split('/').pop()}
      </div>
    )
  }
  if (!url) {
    return (
      <div style={{
        border: '1px solid rgba(90,110,150,0.25)', borderRadius: 3, height: 90, width: 160,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#3a4157', fontSize: 'calc(9px * var(--font-scale, 1))',
      }}>
        loading…
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={path.split('/').pop() ?? 'lab frame'}
      title={`${path} — click to open full size`}
      onClick={() => window.open(url, '_blank', 'noopener')}
      style={{
        maxHeight, maxWidth: '100%', borderRadius: 3, cursor: 'zoom-in',
        border: '1px solid rgba(90,110,150,0.35)', display: 'block',
      }}
    />
  )
}
