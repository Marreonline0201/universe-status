// Right pane of the REPORTS page: fetches a company/ markdown file and renders
// it with the shared markdown engine, frontmatter as a header card.
import { useEffect, useRef, useState } from 'react'
import type { OfficeSocket } from '../../hooks/useOfficeSocket'
import { fetchCompanyFile } from '../../lib/officeApi'
import { Markdown, stripFrontmatter } from '../../lib/markdown'

const STATUS_COLORS: Record<string, string> = { approved: '#00ff88', draft: '#ffd700' }

export function ReportReader({ path, office }: { path: string | null; office: OfficeSocket }) {
  const [body, setBody] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const cache = useRef(new Map<string, string>())

  // Reviewers rewrite reports (draft → approved): drop the cache entry on change.
  useEffect(() => office.subscribe(msg => {
    if (msg.type === 'REPORT_ADDED') cache.current.delete(msg.report.path)
    // Windows paths arrive with backslashes from the watcher; normalize both sides.
    if (msg.type === 'REPORT_ADDED' && path && msg.report.path.replace(/\\/g, '/') === path.replace(/\\/g, '/')) {
      setNonce(n => n + 1)
    }
  }), [office, path])

  useEffect(() => {
    if (!path) { setBody(null); setErr(null); return }
    let cancelled = false
    setErr(null)
    const cached = cache.current.get(path)
    if (cached !== undefined && nonce === 0) {
      const { meta: m, body: b } = stripFrontmatter(cached)
      setMeta(m); setBody(b)
      return
    }
    setBody(null)
    fetchCompanyFile(path.replace(/\\/g, '/'))
      .then(text => {
        if (cancelled) return
        cache.current.set(path, text)
        const { meta: m, body: b } = stripFrontmatter(text)
        setMeta(m); setBody(b)
      })
      .catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [path, nonce])

  if (!path) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a4157', fontSize: 'calc(12px * var(--font-scale, 1))', letterSpacing: 2 }}>
        SELECT A REPORT TO READ
      </div>
    )
  }
  if (err) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <div style={{ color: '#ff8787', fontSize: 'calc(11px * var(--font-scale, 1))' }}>✗ {err}</div>
        <button
          onClick={() => setNonce(n => n + 1)}
          style={{ background: 'transparent', border: '1px solid #00d4ff88', color: '#00d4ff', fontFamily: 'inherit', fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 1, padding: '4px 12px', borderRadius: 3, cursor: 'pointer' }}
        >RETRY</button>
      </div>
    )
  }
  if (body === null) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5c6a8a', fontSize: 'calc(11px * var(--font-scale, 1))', letterSpacing: 2 }}>LOADING…</div>
  }

  const status = (meta.status ?? '').toLowerCase()
  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <div style={{ padding: '20px 40px 0' }}>
        <div style={{ color: '#e8f4ff', fontSize: 'calc(15px * var(--font-scale, 1))', fontWeight: 600 }}>{meta.title ?? path}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1, flexWrap: 'wrap' }}>
          {status && <span style={{ color: STATUS_COLORS[status] ?? '#8a97b8', fontWeight: 700 }}>{status === 'approved' ? '✓ APPROVED' : status.toUpperCase()}</span>}
          {meta.team && <span style={{ color: '#8a97b8' }}>{meta.team}</span>}
          {meta.authors && <span style={{ color: '#8a97b8' }}>by {meta.authors.replace(/[[\]]/g, '')}</span>}
          {meta.reviewed_by && <span style={{ color: '#8a97b8' }}>reviewed by {meta.reviewed_by}</span>}
          {meta.date && <span style={{ color: '#5c6a8a' }}>{meta.date}</span>}
        </div>
        <div style={{ color: '#3a4157', fontSize: 'calc(9px * var(--font-scale, 1))', marginTop: 4 }}>{path}</div>
        <div style={{ borderBottom: '1px solid rgba(0,180,255,0.15)', marginTop: 12 }} />
      </div>
      <div style={{ padding: '16px 40px 80px' }}>
        <Markdown md={body} />
      </div>
    </div>
  )
}
