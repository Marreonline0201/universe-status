// ── DocsPage ──────────────────────────────────────────────────────────────────
// Renders universe-sim/structure.md as a navigable documentation page.
// Layout: Left = major section nav, Center = scrollable content, Right = "on this page" sub-nav.
// Inspired by docs.anthropic.com / Claude documentation layout.

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
// Fetch structure.md from GitHub at runtime (no filesystem dependency)
const GITHUB_RAW = 'https://raw.githubusercontent.com/Marreonline0201/universe-sim/master'
let _cachedPublic: string | null = null
let _cachedFull: string | null = null

async function fetchMd(url: string): Promise<string> {
  const r = await fetch(url); return r.ok ? r.text() : '# Failed to load'
}

function useMdFromGithub(authed: boolean) {
  const [pub, setPub] = useState(_cachedPublic ?? '')
  const [full, setFull] = useState(_cachedFull ?? '')
  const [loading, setLoading] = useState(!_cachedPublic)
  useEffect(() => {
    if (_cachedPublic) { setPub(_cachedPublic); setLoading(false); return }
    fetchMd(`${GITHUB_RAW}/structure-public.md`).then(m => { _cachedPublic = m; setPub(m); setLoading(false) })
  }, [])
  useEffect(() => {
    if (!authed) return
    if (_cachedFull) { setFull(_cachedFull); return }
    fetchMd(`${GITHUB_RAW}/structure.md`).then(m => { _cachedFull = m; setFull(m) })
  }, [authed])
  return { pub, full, loading }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Simple password gate: public visitors see structure-public.md,
// authenticated users see the full structure.md.
// Password is checked against a SHA-256 hash stored as a constant.
// The hash is not reversible — the password itself is never in the source.

const AUTH_HASH = '71c5d021bf39c2415b06aa46954a525709c33850e9120e1a0ee4d5c851cfd69f' // SHA-256
const AUTH_KEY = 'universe-docs-auth'

async function hashPassword(pw: string): Promise<string> {
  const data = new TextEncoder().encode(pw)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function useAuth() {
  const [authed, setAuthed] = useState(() => {
    try { return localStorage.getItem(AUTH_KEY) === 'true' } catch { return false }
  })

  const login = useCallback(async (pw: string): Promise<boolean> => {
    const h = await hashPassword(pw)
    if (h === AUTH_HASH) {
      setAuthed(true)
      try { localStorage.setItem(AUTH_KEY, 'true') } catch {}
      return true
    }
    return false
  }, [])

  const logout = useCallback(() => {
    setAuthed(false)
    try { localStorage.removeItem(AUTH_KEY) } catch {}
  }, [])

  return { authed, login, logout }
}

// ── Login Modal ───────────────────────────────────────────────────────────────

function LoginModal({ onLogin, onClose }: { onLogin: (pw: string) => Promise<boolean>; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(false)
    const ok = await onLogin(pw)
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
          fontSize: 10, letterSpacing: 3, color: 'rgba(0,180,255,0.4)',
          marginBottom: 16,
        }}>
          ADMIN ACCESS
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
            borderRadius: 4, fontSize: 13,
            color: 'rgba(220,240,255,0.9)',
            fontFamily: 'inherit', outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {error && (
          <div style={{ fontSize: 10, color: 'rgba(255,80,80,0.7)', marginTop: 6 }}>
            Incorrect password
          </div>
        )}
        <button type="submit" disabled={loading || !pw} style={{
          marginTop: 14, width: '100%', padding: '7px 0',
          background: pw ? 'rgba(0,180,255,0.15)' : 'rgba(0,180,255,0.05)',
          border: '1px solid rgba(0,180,255,0.3)',
          borderRadius: 4, color: '#00d4ff',
          fontSize: 10, letterSpacing: 2,
          fontFamily: 'inherit', cursor: pw ? 'pointer' : 'default',
        }}>
          {loading ? 'CHECKING...' : 'UNLOCK'}
        </button>
      </form>
    </div>
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TocEntry {
  id: string
  text: string
  level: 2 | 3 | 4 | 5
}

type Block =
  | { type: 'h1' | 'h2' | 'h3' | 'h4' | 'h5'; text: string; id: string }
  | { type: 'hr' }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'paragraph'; text: string }

// ── Utilities ─────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Parse all headings for the full ToC — generates unique IDs for duplicates */
function parseToc(md: string): TocEntry[] {
  const entries: TocEntry[] = []
  const idCounts = new Map<string, number>()

  function uniqueId(text: string): string {
    const base = slugify(text)
    const count = idCounts.get(base) ?? 0
    idCounts.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }

  for (const line of md.split('\n')) {
    const h2 = line.match(/^## (.+)$/)
    const h3 = line.match(/^### (.+)$/)
    const h4 = line.match(/^#### (.+)$/)
    const h5 = line.match(/^##### (.+)$/)
    if (h2) entries.push({ level: 2, text: h2[1].replace(/\*\*/g, ''), id: uniqueId(h2[1]) })
    else if (h3) entries.push({ level: 3, text: h3[1].replace(/\*\*/g, ''), id: uniqueId(h3[1]) })
    else if (h4) entries.push({ level: 4, text: h4[1].replace(/\*\*/g, ''), id: uniqueId(h4[1]) })
    else if (h5) entries.push({ level: 5, text: h5[1].replace(/\*\*/g, ''), id: uniqueId(h5[1]) })
  }
  return entries
}

// ── Markdown block parser ─────────────────────────────────────────────────────

function parseBlocks(md: string): Block[] {
  const lines = md.split('\n')
  const blocks: Block[] = []
  let i = 0
  const idCounts = new Map<string, number>()

  function uniqueId(text: string): string {
    const base = slugify(text)
    const count = idCounts.get(base) ?? 0
    idCounts.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }

  while (i < lines.length) {
    const line = lines[i]

    // Blank line — skip
    if (line.trim() === '') { i++; continue }

    // H5 before H4/H3/H2/H1 (most specific first)
    const h5m = line.match(/^##### (.+)$/)
    if (h5m) { blocks.push({ type: 'h5', text: h5m[1], id: uniqueId(h5m[1]) }); i++; continue }
    const h4m = line.match(/^#### (.+)$/)
    if (h4m) { blocks.push({ type: 'h4', text: h4m[1], id: uniqueId(h4m[1]) }); i++; continue }
    const h3m = line.match(/^### (.+)$/)
    if (h3m) { blocks.push({ type: 'h3', text: h3m[1], id: uniqueId(h3m[1]) }); i++; continue }
    const h2m = line.match(/^## (.+)$/)
    if (h2m) { blocks.push({ type: 'h2', text: h2m[1], id: uniqueId(h2m[1]) }); i++; continue }
    const h1m = line.match(/^# (.+)$/)
    if (h1m) { blocks.push({ type: 'h1', text: h1m[1], id: uniqueId(h1m[1]) }); i++; continue }

    // Horizontal rule
    if (line.match(/^---+$/)) { blocks.push({ type: 'hr' }); i++; continue }

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      i++
      const codeLines: string[] = []
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // closing ```
      blocks.push({ type: 'code', lang, lines: codeLines })
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const bqLines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        bqLines.push(lines[i].slice(2))
        i++
      }
      blocks.push({ type: 'blockquote', lines: bqLines })
      continue
    }

    // Table
    if (line.startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      if (tableLines.length >= 2) {
        const parseRow = (row: string) =>
          row.split('|').filter(Boolean).map(s => s.trim())
        const headers = parseRow(tableLines[0])
        // skip separator row (index 1: |----|
        const rows = tableLines.slice(2).map(parseRow)
        blocks.push({ type: 'table', headers, rows })
      }
      continue
    }

    // Unordered list
    if (line.match(/^[ \t]*[-*+] /)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^[ \t]*[-*+] /)) {
        const indent = lines[i].match(/^([ \t]*)/)![1].length
        const text = lines[i].replace(/^[ \t]*[-*+] /, '')
        items.push(indent > 0 ? `\u00a0\u00a0\u00a0\u00a0${text}` : text)
        i++
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    // Ordered list
    if (line.match(/^\d+\. /)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^\d+\. /)) {
        items.push(lines[i].replace(/^\d+\. /, ''))
        i++
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    // Paragraph — accumulate consecutive non-block lines
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^#{1,5} /) &&
      !lines[i].startsWith('|') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('> ') &&
      !lines[i].match(/^[ \t]*[-*+] /) &&
      !lines[i].match(/^\d+\. /) &&
      !lines[i].match(/^---+$/)
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') })
    }
  }

  return blocks
}

// ── Inline renderer ───────────────────────────────────────────────────────────

type InlineToken = { type: 'text' | 'bold' | 'code' | 'italic' | 'link'; content: string; href?: string }

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let i = 0
  while (i < text.length) {
    // Link [text](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket)
          const href = text.slice(closeBracket + 2, closeParen)
          tokens.push({ type: 'link', content: linkText, href })
          i = closeParen + 1
          continue
        }
      }
    }
    // Bold **...**
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end !== -1) {
        tokens.push({ type: 'bold', content: text.slice(i + 2, end) })
        i = end + 2
        continue
      }
    }
    // Inline code `...`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1) {
        tokens.push({ type: 'code', content: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    // Italic *...*
    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1)
      if (end !== -1 && text[end + 1] !== '*') {
        tokens.push({ type: 'italic', content: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    // Regular text — accumulate
    const last = tokens[tokens.length - 1]
    if (last?.type === 'text') last.content += text[i]
    else tokens.push({ type: 'text', content: text[i] })
    i++
  }
  return tokens
}

function Inline({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeInline(text), [text])
  return (
    <>
      {tokens.map((t, idx) => {
        if (t.type === 'link')   return <a key={idx} href={t.href} style={{ color: '#00d4ff', textDecoration: 'none', borderBottom: '1px solid rgba(0,212,255,0.3)' }} onClick={e => { if (t.href?.startsWith('#')) { e.preventDefault(); const el = document.getElementById(t.href.slice(1)); if (el) el.scrollIntoView({ behavior: 'smooth' }) }}}>{t.content}</a>
        if (t.type === 'bold')   return <strong key={idx} style={{ color: '#e8f4ff', fontWeight: 600 }}>{t.content}</strong>
        if (t.type === 'code')   return <code key={idx} style={INLINE_CODE}>{t.content}</code>
        if (t.type === 'italic') return <em key={idx} style={{ color: 'rgba(180,210,255,0.8)', fontStyle: 'italic' }}>{t.content}</em>
        return <React.Fragment key={idx}>{t.content}</React.Fragment>
      })}
    </>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const INLINE_CODE: React.CSSProperties = {
  background: 'rgba(0,180,255,0.1)',
  color: '#7dd3fc',
  padding: '1px 6px',
  borderRadius: 3,
  fontSize: '0.88em',
  fontFamily: 'inherit',
}

// ── Smart Code Block Renderer ──────────────────────────────────────────────
// Detects tables and comments inside code blocks and renders them nicely.

function CodeBlockContent({ lines }: { lines: string[] }) {
  const groups: { type: 'comment' | 'table' | 'code'; lines: string[] }[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trimStart()

    // Detect markdown pipe table inside code block
    if (trimmed.startsWith('|') && trimmed.includes('|', 1)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      const parseRow = (row: string) => row.split('|').map(s => s.trim()).filter(Boolean)
      const isSep = (row: string) => /^[\s|:\-─]+$/.test(row)
      const headers = tableLines.length >= 2 ? parseRow(tableLines[0]) : []
      const dataStart = tableLines.findIndex((_, li) => li > 0 && !isSep(tableLines[li]))
      const dataRows = tableLines.slice(dataStart < 0 ? 2 : dataStart).filter(l => !isSep(l)).map(parseRow)

      if (headers.length > 0 && dataRows.length > 0) {
        groups.push({ type: 'table', lines: [JSON.stringify({ headers, rows: dataRows })] })
      } else {
        groups.push({ type: 'code', lines: tableLines })
      }
      continue
    }

    // Detect comment lines — but check for tables inside comments
    if (trimmed.startsWith('//')) {
      const commentLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('//')) {
        commentLines.push(lines[i])
        i++
      }

      // Check if comment lines contain a box-drawing or pipe table
      // Strip // prefix and look for lines containing │ (box-drawing pipe)
      const stripped = commentLines.map(l => l.trimStart().replace(/^\/\/\s?/, ''))

      // Find table boundaries by looking for lines with │ (data) or ┌├└─ (borders)
      // Use character code check for reliability: │ = U+2502, ┌ = U+250C, └ = U+2514
      const hasBoxChar = (l: string) => {
        const t = l.trim()
        for (let ci = 0; ci < Math.min(t.length, 3); ci++) {
          const c = t.charCodeAt(ci)
          // Box drawing range: U+2500 to U+257F
          if (c >= 0x2500 && c <= 0x257F) return true
        }
        return false
      }
      const isBoxBorder = (l: string) => {
        const t = l.trim()
        if (t.length === 0) return false
        const c = t.charCodeAt(0)
        // ┌ = 250C, ├ = 251C, └ = 2514, ╭ = 256D, ╰ = 2570
        return c === 0x250C || c === 0x251C || c === 0x2514 || c === 0x256D || c === 0x2570
      }
      const isBoxData = (l: string) => {
        const t = l.trim()
        if (t.length === 0) return false
        return t.charCodeAt(0) === 0x2502 // │ = U+2502
      }

      const tableStartIdx = stripped.findIndex(l => hasBoxChar(l))
      let tableEndIdx = -1
      for (let ti = stripped.length - 1; ti >= 0; ti--) {
        if (hasBoxChar(stripped[ti])) { tableEndIdx = ti; break }
      }

      if (tableStartIdx !== -1 && tableEndIdx > tableStartIdx) {
        const beforeTable = commentLines.slice(0, tableStartIdx)
        const tableSection = stripped.slice(tableStartIdx, tableEndIdx + 1)
        const afterTable = commentLines.slice(tableEndIdx + 1)

        if (beforeTable.length > 0) groups.push({ type: 'comment', lines: beforeTable })

        // Parse box-drawing table with multi-line cell support
        const extractCells = (l: string): string[] => {
          // Replace all box-drawing characters with |
          let cleaned = ''
          for (let ci = 0; ci < l.length; ci++) {
            const c = l.charCodeAt(ci)
            cleaned += (c >= 0x2500 && c <= 0x257F) ? '|' : l[ci]
          }
          // Split by | and filter
          return cleaned.split('|').map(s => s.trim()).filter(s => s.length > 0)
        }

        // Group data lines into logical rows
        // Rule: a new row starts when EITHER:
        //   a) A border line (┌├└) appears, OR
        //   b) The first cell of the data line is non-empty (new entity)
        // A continuation line has an empty first cell (multi-line cell)
        const logicalRows: string[][] = []
        let currentCells: string[] = []

        for (const line of tableSection) {
          if (isBoxBorder(line)) {
            if (currentCells.length > 0) {
              logicalRows.push(currentCells)
              currentCells = []
            }
            continue
          }
          if (isBoxData(line)) {
            const cells = extractCells(line)
            const firstCellEmpty = cells.length > 0 && cells[0].trim() === ''
            if (currentCells.length === 0) {
              // First data line after a border
              currentCells = cells
            } else if (firstCellEmpty) {
              // Continuation: first cell is empty → merge with current row
              for (let ci = 0; ci < cells.length && ci < currentCells.length; ci++) {
                if (cells[ci]) {
                  currentCells[ci] = currentCells[ci]
                    ? currentCells[ci] + ' ' + cells[ci]
                    : cells[ci]
                }
              }
            } else {
              // New row: first cell has content
              logicalRows.push(currentCells)
              currentCells = cells
            }
          }
        }
        if (currentCells.length > 0) logicalRows.push(currentCells)

        if (logicalRows.length >= 2) {
          const headers = logicalRows[0]
          const rows = logicalRows.slice(1)
          groups.push({ type: 'table', lines: [JSON.stringify({ headers, rows })] })
        } else {
          groups.push({ type: 'comment', lines: commentLines.slice(tableStartIdx, tableEndIdx + 1) })
        }

        if (afterTable.length > 0) groups.push({ type: 'comment', lines: afterTable })
      } else {
        groups.push({ type: 'comment', lines: commentLines })
      }
      continue
    }

    // Blank line — just push as code
    if (trimmed === '') {
      groups.push({ type: 'code', lines: [lines[i]] })
      i++
      continue
    }

    // Regular code line
    const codeLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trimStart() !== '' &&
      !lines[i].trimStart().startsWith('//') &&
      !(lines[i].trimStart().startsWith('|') && lines[i].trimStart().includes('|', 1))
    ) {
      codeLines.push(lines[i])
      i++
    }
    if (codeLines.length > 0) groups.push({ type: 'code', lines: codeLines })
  }

  return (
    <div>
      {groups.map((group, gi) => {
        if (group.type === 'comment') {
          return (
            <div key={gi} style={{ margin: '4px 0' }}>
              {group.lines.map((line, li) => {
                const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
                const content = line.trimStart().replace(/^\/\/\s?/, '')
                const isHeader = /^[═─╌]/.test(content) || /^[A-Z][A-Z _]+[═─╌:]/.test(content.trim())
                const isEmpty = content.trim() === '' || /^[═─╌\s]+$/.test(content)

                if (isEmpty) return <div key={li} style={{ height: 6 }} />

                if (isHeader) {
                  return (
                    <div key={li} style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
                      color: 'rgba(0,200,255,0.55)', marginTop: 12, marginBottom: 4,
                      paddingLeft: Math.max(0, indent / 2 - 1) * 8,
                    }}>
                      {content.replace(/[═─╌]/g, '').trim()}
                    </div>
                  )
                }

                return (
                  <p key={li} style={{
                    margin: '1px 0', fontSize: 11.5, lineHeight: 1.75,
                    color: 'rgba(165,200,240,0.72)',
                    paddingLeft: Math.max(0, indent / 2 - 1) * 8,
                    fontFamily: 'inherit',
                  }}>
                    <Inline text={content} />
                  </p>
                )
              })}
            </div>
          )
        }

        if (group.type === 'table') {
          try {
            const { headers, rows } = JSON.parse(group.lines[0])
            return (
              <div key={gi} style={{
                overflowX: 'auto', margin: '12px 0',
                borderRadius: 6,
                border: '1px solid rgba(0,180,255,0.12)',
              }}>
                <table style={{
                  borderCollapse: 'collapse', fontSize: 11.5, lineHeight: 1.65,
                  minWidth: '100%',
                }}>
                  <thead>
                    <tr>
                      {(headers as string[]).map((h: string, hi: number) => (
                        <th key={hi} style={{
                          padding: '8px 14px', textAlign: 'left',
                          color: '#7dd3fc', fontSize: 10.5, letterSpacing: 0.8,
                          fontWeight: 600,
                          background: 'rgba(0,30,70,0.5)',
                          borderBottom: '1px solid rgba(0,180,255,0.15)',
                          borderRight: hi < (headers as string[]).length - 1 ? '1px solid rgba(0,180,255,0.06)' : 'none',
                        }}>
                          <Inline text={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(rows as string[][]).map((row: string[], ri: number) => (
                      <tr key={ri} style={{
                        background: ri % 2 === 0 ? 'transparent' : 'rgba(0,20,50,0.25)',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,60,120,0.2)'}
                      onMouseLeave={e => e.currentTarget.style.background = ri % 2 === 0 ? 'transparent' : 'rgba(0,20,50,0.25)'}
                      >
                        {row.map((cell: string, ci: number) => (
                          <td key={ci} style={{
                            padding: '6px 14px',
                            borderBottom: '1px solid rgba(0,180,255,0.05)',
                            borderRight: ci < row.length - 1 ? '1px solid rgba(0,180,255,0.04)' : 'none',
                            color: ci === 0 ? 'rgba(210,235,255,0.85)' : 'rgba(180,210,240,0.7)',
                            fontWeight: ci === 0 ? 500 : 400,
                            verticalAlign: 'top',
                          }}>
                            <Inline text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          } catch {
            return <pre key={gi} style={{ margin: 0, fontSize: 11, lineHeight: 1.7, color: 'rgba(200,230,255,0.8)', whiteSpace: 'pre', fontFamily: 'inherit' }}>{group.lines.join('\n')}</pre>
          }
        }

        return (
          <pre key={gi} style={{
            margin: 0, fontSize: 11, lineHeight: 1.7,
            color: 'rgba(200,230,255,0.8)',
            whiteSpace: 'pre', fontFamily: 'inherit',
          }}>
            {group.lines.join('\n')}
          </pre>
        )
      })}
    </div>
  )
}

// ── Block renderer ────────────────────────────────────────────────────────────

function RenderBlock({ block, idx }: { block: Block; idx: number }) {
  switch (block.type) {

    case 'h1':
      return (
        <h1 id={block.id} key={idx} style={{
          fontSize: 20, fontWeight: 700, color: '#e8f4ff',
          marginTop: 32, marginBottom: 12,
          paddingBottom: 10,
          borderBottom: '1px solid rgba(0,180,255,0.2)',
          letterSpacing: 0.5,
        }}>
          <Inline text={block.text} />
        </h1>
      )

    case 'h2':
      return (
        <h2 id={block.id} key={idx} style={{
          fontSize: 15, fontWeight: 700, color: '#00d4ff',
          marginTop: 40, marginBottom: 10,
          paddingBottom: 8,
          borderBottom: '1px solid rgba(0,180,255,0.15)',
          letterSpacing: 1.5,
          textTransform: 'uppercase',
        }}>
          <Inline text={block.text} />
        </h2>
      )

    case 'h3':
      return (
        <h3 id={block.id} key={idx} style={{
          fontSize: 12, fontWeight: 700, color: 'rgba(150,210,255,0.9)',
          marginTop: 28, marginBottom: 8,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
        }}>
          <Inline text={block.text} />
        </h3>
      )

    case 'h4':
      return (
        <h4 id={block.id} key={idx} style={{
          fontSize: 11, fontWeight: 600, color: 'rgba(100,180,255,0.75)',
          marginTop: 20, marginBottom: 6,
          letterSpacing: 1,
          textTransform: 'uppercase',
        }}>
          <Inline text={block.text} />
        </h4>
      )

    case 'h5':
      return (
        <h5 id={block.id} key={idx} style={{
          fontSize: 10, fontWeight: 600, color: 'rgba(80,150,220,0.65)',
          marginTop: 16, marginBottom: 4,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          paddingLeft: 12,
          borderLeft: '2px solid rgba(0,180,255,0.15)',
        }}>
          <Inline text={block.text} />
        </h5>
      )

    case 'hr':
      return (
        <hr key={idx} style={{
          border: 'none',
          borderTop: '1px solid rgba(0,180,255,0.12)',
          margin: '28px 0',
        }} />
      )

    case 'code':
      return (
        <div key={idx} style={{
          background: 'rgba(0,10,30,0.7)',
          border: '1px solid rgba(0,180,255,0.12)',
          borderRadius: 5,
          padding: '14px 16px',
          margin: '12px 0',
          overflowX: 'auto',
        }}>
          {block.lang && (
            <div style={{
              fontSize: 9, letterSpacing: 2, color: 'rgba(0,180,255,0.35)',
              marginBottom: 8, textTransform: 'uppercase',
            }}>
              {block.lang}
            </div>
          )}
          <CodeBlockContent lines={block.lines} />
        </div>
      )

    case 'table':
      return (
        <div key={idx} style={{ overflowX: 'auto', margin: '14px 0' }}>
          <table style={{
            borderCollapse: 'collapse',
            fontSize: 11, lineHeight: 1.6,
            minWidth: '100%',
          }}>
            <thead>
              <tr>
                {block.headers.map((h, hi) => (
                  <th key={hi} style={{
                    padding: '6px 14px',
                    textAlign: 'left',
                    color: '#00d4ff',
                    fontSize: 10,
                    letterSpacing: 1,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    background: 'rgba(0,40,80,0.4)',
                    border: '1px solid rgba(0,180,255,0.12)',
                    whiteSpace: 'nowrap',
                  }}>
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} style={{
                  background: ri % 2 === 0 ? 'transparent' : 'rgba(0,30,60,0.2)',
                }}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{
                      padding: '5px 14px',
                      border: '1px solid rgba(0,180,255,0.08)',
                      color: 'rgba(190,220,255,0.75)',
                      verticalAlign: 'top',
                    }}>
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'list':
      return (
        <ul key={idx} style={{
          margin: '8px 0',
          paddingLeft: 0,
          listStyle: 'none',
        }}>
          {block.items.map((item, ii) => (
            <li key={ii} style={{
              display: 'flex',
              gap: 10,
              padding: '3px 0',
              fontSize: 12,
              color: 'rgba(180,210,255,0.72)',
              lineHeight: 1.7,
            }}>
              <span style={{
                color: 'rgba(0,180,255,0.5)',
                flexShrink: 0,
                marginTop: 1,
                fontSize: block.ordered ? 11 : 14,
              }}>
                {block.ordered ? `${ii + 1}.` : '·'}
              </span>
              <span><Inline text={item} /></span>
            </li>
          ))}
        </ul>
      )

    case 'blockquote':
      return (
        <div key={idx} style={{
          borderLeft: '2px solid rgba(0,180,255,0.3)',
          paddingLeft: 16,
          margin: '12px 0',
          background: 'rgba(0,50,100,0.12)',
          borderRadius: '0 4px 4px 0',
          padding: '10px 14px 10px 16px',
        }}>
          {block.lines.map((line, li) => (
            <p key={li} style={{
              margin: '4px 0',
              fontSize: 12,
              color: 'rgba(160,200,240,0.8)',
              lineHeight: 1.7,
              fontStyle: 'italic',
            }}>
              <Inline text={line} />
            </p>
          ))}
        </div>
      )

    case 'paragraph':
      return (
        <p key={idx} style={{
          margin: '8px 0',
          fontSize: 12,
          color: 'rgba(180,210,255,0.72)',
          lineHeight: 1.8,
        }}>
          {block.text.split('\n').map((line, li, arr) => (
            <React.Fragment key={li}>
              <Inline text={line} />
              {li < arr.length - 1 && <br />}
            </React.Fragment>
          ))}
        </p>
      )

    default:
      return null
  }
}

// ── Resize Handle ─────────────────────────────────────────────────────────────

function ResizeHandle({ onDrag, side }: { onDrag: (delta: number) => void; side: 'left' | 'right' }) {
  const dragging = useRef(false)
  const lastX = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastX.current = e.clientX
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = ev.clientX - lastX.current
      lastX.current = ev.clientX
      onDrag(side === 'left' ? delta : -delta)
    }

    const onMouseUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [onDrag, side])

  const [hovered, setHovered] = useState(false)

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 6,
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 20,
      }}
    >
      <div style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 2,
        width: hovered ? 2 : 1,
        background: hovered ? 'rgba(0,180,255,0.5)' : 'rgba(0,180,255,0.1)',
        transition: 'all 0.15s',
        borderRadius: 1,
      }} />
    </div>
  )
}

// ── Build section hierarchy for left nav ──────────────────────────────────────

interface SectionGroup {
  entry: TocEntry               // the h2 section
  children: TocEntry[]          // h3 items under it
}

function buildSectionGroups(toc: TocEntry[]): SectionGroup[] {
  const groups: SectionGroup[] = []
  let current: SectionGroup | null = null

  for (const entry of toc) {
    if (entry.level === 2) {
      current = { entry, children: [] }
      groups.push(current)
    } else if (entry.level === 3 && current) {
      current.children.push(entry)
    }
  }
  return groups
}

/** Get the "on this page" items: h3/h4/h5 headings under the active h2 */
function getPageHeadings(toc: TocEntry[], activeH2Id: string): TocEntry[] {
  const items: TocEntry[] = []
  let inSection = false

  for (const entry of toc) {
    if (entry.level === 2) {
      inSection = entry.id === activeH2Id
      continue
    }
    if (inSection) {
      if (entry.level === 3 || entry.level === 4 || entry.level === 5) {
        items.push(entry)
      }
    }
  }

  // Add parent context to duplicate-text entries so "The Principle" becomes
  // "The Principle (Emergent Material…)" in the sidebar
  const textCounts = new Map<string, number>()
  for (const item of items) textCounts.set(item.text, (textCounts.get(item.text) ?? 0) + 1)

  if ([...textCounts.values()].some(c => c > 1)) {
    let currentH3 = ''
    for (const item of items) {
      if (item.level === 3) { currentH3 = item.text; continue }
      if ((textCounts.get(item.text) ?? 0) > 1 && currentH3) {
        // Truncate parent name to keep it short
        const short = currentH3.length > 20 ? currentH3.slice(0, 20) + '...' : currentH3
        item.text = `${item.text} (${short})`
      }
    }
  }

  return items
}

// ── Main component ────────────────────────────────────────────────────────────

export function DocsPage() {
  const { authed, login, logout } = useAuth()
  const [showLogin, setShowLogin] = useState(false)
  const [activeH2, setActiveH2]     = useState<string>('')
  const [activeHeading, setActiveHeading] = useState<string>('')
  const [search,   setSearch]       = useState('')
  const [leftExpanded, setLeftExpanded] = useState<string | null>(null)
  const [leftWidth, setLeftWidth]   = useState(220)
  const [rightWidth, setRightWidth] = useState(200)
  const contentRef                  = useRef<HTMLDivElement>(null)

  const { pub: publicMd, full: fullMd } = useMdFromGithub(authed)
  const rawMd = authed ? fullMd : publicMd

  const onLeftDrag = useCallback((delta: number) => {
    setLeftWidth(w => Math.max(140, Math.min(450, w + delta)))
  }, [])

  const onRightDrag = useCallback((delta: number) => {
    setRightWidth(w => Math.max(120, Math.min(400, w + delta)))
  }, [])

  const toc    = useMemo(() => parseToc(rawMd),    [rawMd])
  const blocks = useMemo(() => parseBlocks(rawMd), [rawMd])
  const groups = useMemo(() => buildSectionGroups(toc), [toc])

  // Track active section by scroll position
  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    function onScroll() {
      const headings = el!.querySelectorAll('h2[id], h3[id], h4[id], h5[id]')
      let currentH2 = ''
      let currentAny = ''
      for (const h of Array.from(headings)) {
        const rect = h.getBoundingClientRect()
        const containerTop = el!.getBoundingClientRect().top
        if (rect.top - containerTop <= 40) {
          currentAny = h.id
          if (h.tagName === 'H2') currentH2 = h.id
        }
      }
      // If we haven't passed any h2 yet, find the first h2 from the top
      if (!currentH2 && toc.length > 0) {
        const firstH2 = toc.find(t => t.level === 2)
        if (firstH2) currentH2 = firstH2.id
      }
      setActiveH2(currentH2)
      setActiveHeading(currentAny)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // initial
    return () => el.removeEventListener('scroll', onScroll)
  }, [toc])

  // Auto-expand active section in left nav
  useEffect(() => {
    if (activeH2) setLeftExpanded(activeH2)
  }, [activeH2])

  // Scroll to heading when ToC item clicked
  const scrollTo = useCallback((id: string) => {
    const container = contentRef.current
    const el = container?.querySelector(`#${CSS.escape(id)}`)
    if (!el || !container) return
    // Calculate offset within the scroll container, not the viewport
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const offsetTop = elRect.top - containerRect.top + container.scrollTop
    container.scrollTo({ top: offsetTop - 16, behavior: 'smooth' }) // 16px padding from top
  }, [])

  // Right sidebar: headings under active h2
  const pageHeadings = useMemo(() => getPageHeadings(toc, activeH2), [toc, activeH2])

  // Filter left nav by search
  const filteredGroups = useMemo(() => {
    if (!search) return groups
    const q = search.toLowerCase()
    return groups.filter(g =>
      g.entry.text.toLowerCase().includes(q) ||
      g.children.some(c => c.text.toLowerCase().includes(q))
    ).map(g => ({
      ...g,
      children: g.children.filter(c =>
        c.text.toLowerCase().includes(q) || g.entry.text.toLowerCase().includes(q)
      ),
    }))
  }, [groups, search])

  return (
    <div style={{
      display: 'flex',
      height: '100%',
      overflow: 'hidden',
      background: 'rgba(4,8,18,0.95)',
    }}>

      {/* ── Left: Section navigation ─────────────────────────────────────── */}
      <div style={{
        width: leftWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Search box */}
        <div style={{
          padding: '10px 12px 8px',
          borderBottom: '1px solid rgba(0,180,255,0.08)',
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: 9, letterSpacing: 3,
            color: 'rgba(0,180,255,0.35)',
            marginBottom: 8,
          }}>
            GAME GUIDE
          </div>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(0,20,50,0.5)',
              border: '1px solid rgba(0,180,255,0.15)',
              borderRadius: 3,
              padding: '5px 8px',
              fontSize: 11,
              color: 'rgba(200,230,255,0.8)',
              fontFamily: 'inherit',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Section groups */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {filteredGroups.map(group => {
            const isActiveGroup = activeH2 === group.entry.id
            const isExpanded = leftExpanded === group.entry.id || !!search

            return (
              <div key={group.entry.id}>
                {/* H2 section header */}
                <button
                  onClick={() => {
                    scrollTo(group.entry.id)
                    setLeftExpanded(isExpanded && !isActiveGroup ? null : group.entry.id)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                    padding: '7px 12px',
                    background: isActiveGroup ? 'rgba(0,180,255,0.06)' : 'transparent',
                    border: 'none',
                    borderLeft: `2px solid ${isActiveGroup ? '#00d4ff' : 'transparent'}`,
                    color: isActiveGroup ? '#00d4ff' : 'rgba(160,200,255,0.6)',
                    fontSize: 11,
                    fontFamily: 'inherit',
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                    lineHeight: 1.4,
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => {
                    if (!isActiveGroup) {
                      e.currentTarget.style.color = 'rgba(200,230,255,0.85)'
                      e.currentTarget.style.background = 'rgba(0,180,255,0.03)'
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActiveGroup) {
                      e.currentTarget.style.color = 'rgba(160,200,255,0.6)'
                      e.currentTarget.style.background = 'transparent'
                    }
                  }}
                >
                  {/* Expand arrow */}
                  {group.children.length > 0 && (
                    <span style={{
                      fontSize: 8,
                      color: 'rgba(0,180,255,0.3)',
                      transition: 'transform 0.15s',
                      transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      flexShrink: 0,
                      width: 10,
                      textAlign: 'center',
                    }}>
                      ▶
                    </span>
                  )}
                  {group.children.length === 0 && <span style={{ width: 10, flexShrink: 0 }} />}
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {group.entry.text}
                  </span>
                </button>

                {/* H3 children (expandable) */}
                {isExpanded && group.children.length > 0 && (
                  <div style={{
                    overflow: 'hidden',
                  }}>
                    {group.children.map(child => {
                      const isActiveChild = activeH2 === group.entry.id && activeHeading === child.id
                      return (
                        <button
                          key={child.id}
                          onClick={() => scrollTo(child.id)}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '4px 12px 4px 30px',
                            background: isActiveChild ? 'rgba(0,180,255,0.04)' : 'transparent',
                            border: 'none',
                            color: isActiveChild ? 'rgba(0,212,255,0.8)' : 'rgba(110,155,210,0.45)',
                            fontSize: 10,
                            fontFamily: 'inherit',
                            fontWeight: 400,
                            cursor: 'pointer',
                            textAlign: 'left',
                            lineHeight: 1.5,
                            transition: 'color 0.1s',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          onMouseEnter={e => {
                            if (!isActiveChild) e.currentTarget.style.color = 'rgba(180,210,255,0.7)'
                          }}
                          onMouseLeave={e => {
                            if (!isActiveChild) e.currentTarget.style.color = 'rgba(110,155,210,0.45)'
                          }}
                        >
                          {child.text}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid rgba(0,180,255,0.08)',
          fontSize: 9,
          color: 'rgba(0,180,255,0.25)',
          letterSpacing: 1,
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>{groups.length} SECTIONS</span>
          {authed ? (
            <button
              onClick={logout}
              title="Switch to public view"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(0,255,136,0.4)', fontSize: 9, fontFamily: 'inherit',
                letterSpacing: 1, padding: '2px 6px',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'rgba(0,255,136,0.8)'}
              onMouseLeave={e => e.currentTarget.style.color = 'rgba(0,255,136,0.4)'}
            >
              FULL ✓
            </button>
          ) : (
            <button
              onClick={() => setShowLogin(true)}
              title="Admin login for full document"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(0,180,255,0.25)', fontSize: 9, fontFamily: 'inherit',
                letterSpacing: 1, padding: '2px 6px',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'rgba(0,180,255,0.6)'}
              onMouseLeave={e => e.currentTarget.style.color = 'rgba(0,180,255,0.25)'}
            >
              PUBLIC
            </button>
          )}
        </div>
      </div>

      {/* ── Left resize handle ──────────────────────────────────────────── */}
      <ResizeHandle onDrag={onLeftDrag} side="left" />

      {/* ── Center: Main content ─────────────────────────────────────────── */}
      <div
        ref={contentRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '32px 48px 80px',
          minWidth: 0,
        }}
      >
        {blocks.map((block, idx) => (
          <RenderBlock key={idx} block={block} idx={idx} />
        ))}
      </div>

      {/* ── Right resize handle ─────────────────────────────────────────── */}
      <ResizeHandle onDrag={onRightDrag} side="right" />

      {/* ── Right: "On this page" sub-nav ────────────────────────────────── */}
      <div style={{
        width: rightWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '14px 14px 8px',
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: 9, letterSpacing: 2,
            color: 'rgba(0,180,255,0.3)',
            marginBottom: 4,
          }}>
            ON THIS PAGE
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 12px' }}>
          {pageHeadings.length === 0 && (
            <div style={{
              padding: '8px 14px',
              fontSize: 10,
              color: 'rgba(80,120,180,0.3)',
              fontStyle: 'italic',
            }}>
              No subsections
            </div>
          )}
          {pageHeadings.map(entry => {
            const isActive = activeHeading === entry.id
            const indent = entry.level === 3 ? 14 : entry.level === 4 ? 26 : 38
            return (
              <button
                key={entry.id}
                onClick={() => scrollTo(entry.id)}
                title={entry.text}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: `3px ${14}px 3px ${indent}px`,
                  background: 'transparent',
                  border: 'none',
                  borderLeft: `1.5px solid ${isActive ? 'rgba(0,180,255,0.5)' : 'transparent'}`,
                  color: isActive ? 'rgba(0,212,255,0.85)' : entry.level === 3
                    ? 'rgba(140,180,220,0.5)'
                    : 'rgba(100,140,190,0.35)',
                  fontSize: entry.level === 3 ? 10 : 9,
                  fontFamily: 'inherit',
                  fontWeight: isActive ? 500 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  lineHeight: 1.6,
                  transition: 'all 0.1s',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                onMouseEnter={e => {
                  if (!isActive) e.currentTarget.style.color = 'rgba(180,210,255,0.75)'
                }}
                onMouseLeave={e => {
                  if (!isActive) e.currentTarget.style.color = entry.level === 3
                    ? 'rgba(140,180,220,0.5)'
                    : 'rgba(100,140,190,0.35)'
                }}
              >
                {entry.text}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Login modal ──────────────────────────────────────────────── */}
      {showLogin && (
        <LoginModal onLogin={login} onClose={() => setShowLogin(false)} />
      )}

    </div>
  )
}
