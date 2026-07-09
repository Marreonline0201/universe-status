// ── Markdown engine ───────────────────────────────────────────────────────────
// Hand-rolled markdown parser + renderers, extracted verbatim from DocsPage.tsx.
// Shared module: parse a markdown string into blocks and render them.

/* eslint-disable react-refresh/only-export-components -- shared module exports both components and parser functions by design */

import React, { useMemo } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TocEntry {
  id: string
  text: string
  level: 2 | 3 | 4 | 5
}

export type Block =
  | { type: 'h1' | 'h2' | 'h3' | 'h4' | 'h5'; text: string; id: string }
  | { type: 'hr' }
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'paragraph'; text: string }

// ── Utilities ─────────────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Parse all headings for the full ToC — generates unique IDs for duplicates */
export function parseToc(md: string): TocEntry[] {
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

export function parseBlocks(md: string): Block[] {
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

export function Inline({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeInline(text), [text])
  return (
    <>
      {tokens.map((t, idx) => {
        if (t.type === 'link') {
          // Scheme allowlist: reports/notes are agent-authored — never render a
          // javascript:/data: href (React does not block those in href).
          const safeHref = /^(https?:|mailto:|#|\/)/i.test(t.href ?? '') ? t.href : undefined
          return <a key={idx} href={safeHref} rel="noopener noreferrer" style={{ color: '#00d4ff', textDecoration: 'none', borderBottom: '1px solid rgba(0,212,255,0.3)' }} onClick={e => { if (safeHref?.startsWith('#')) { e.preventDefault(); const el = document.getElementById(safeHref.slice(1)); if (el) el.scrollIntoView({ behavior: 'smooth' }) }}}>{t.content}</a>
        }
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
                      fontSize: 'calc(10px * var(--font-scale, 1))', fontWeight: 700, letterSpacing: 1.5,
                      color: 'rgba(0,200,255,0.55)', marginTop: 12, marginBottom: 4,
                      paddingLeft: Math.max(0, indent / 2 - 1) * 8,
                    }}>
                      {content.replace(/[═─╌]/g, '').trim()}
                    </div>
                  )
                }

                return (
                  <p key={li} style={{
                    margin: '1px 0', fontSize: 'calc(11.5px * var(--font-scale, 1))', lineHeight: 1.75,
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
                  borderCollapse: 'collapse', fontSize: 'calc(11.5px * var(--font-scale, 1))', lineHeight: 1.65,
                  minWidth: '100%',
                }}>
                  <thead>
                    <tr>
                      {(headers as string[]).map((h: string, hi: number) => (
                        <th key={hi} style={{
                          padding: '8px 14px', textAlign: 'left',
                          color: '#7dd3fc', fontSize: 'calc(10.5px * var(--font-scale, 1))', letterSpacing: 0.8,
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
            return <pre key={gi} style={{ margin: 0, fontSize: 'calc(11px * var(--font-scale, 1))', lineHeight: 1.7, color: 'rgba(200,230,255,0.8)', whiteSpace: 'pre', fontFamily: 'inherit' }}>{group.lines.join('\n')}</pre>
          }
        }

        return (
          <pre key={gi} style={{
            margin: 0, fontSize: 'calc(11px * var(--font-scale, 1))', lineHeight: 1.7,
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

export function RenderBlock({ block, idx }: { block: Block; idx: number }) {
  switch (block.type) {

    case 'h1':
      return (
        <h1 id={block.id} key={idx} style={{
          fontSize: 'calc(20px * var(--font-scale, 1))', fontWeight: 700, color: '#e8f4ff',
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
          fontSize: 'calc(15px * var(--font-scale, 1))', fontWeight: 700, color: '#00d4ff',
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
          fontSize: 'calc(12px * var(--font-scale, 1))', fontWeight: 700, color: 'rgba(150,210,255,0.9)',
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
          fontSize: 'calc(11px * var(--font-scale, 1))', fontWeight: 600, color: 'rgba(100,180,255,0.75)',
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
          fontSize: 'calc(10px * var(--font-scale, 1))', fontWeight: 600, color: 'rgba(80,150,220,0.65)',
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
              fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, color: 'rgba(0,180,255,0.35)',
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
            fontSize: 'calc(11px * var(--font-scale, 1))', lineHeight: 1.6,
            minWidth: '100%',
          }}>
            <thead>
              <tr>
                {block.headers.map((h, hi) => (
                  <th key={hi} style={{
                    padding: '6px 14px',
                    textAlign: 'left',
                    color: '#00d4ff',
                    fontSize: 'calc(10px * var(--font-scale, 1))',
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
              fontSize: 'calc(12px * var(--font-scale, 1))',
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
              fontSize: 'calc(12px * var(--font-scale, 1))',
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
          fontSize: 'calc(12px * var(--font-scale, 1))',
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

// ── High-level helpers ────────────────────────────────────────────────────────

/** Render a full markdown string as a sequence of blocks. */
export function Markdown({ md }: { md: string }) {
  const blocks = useMemo(() => parseBlocks(md), [md])
  return <>{blocks.map((b, i) => <RenderBlock key={i} block={b} idx={i} />)}</>
}

/**
 * Strip YAML-style frontmatter from a markdown string.
 * Parses flat `key: value` pairs only — arrays/nested YAML keep the raw string value.
 */
export function stripFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  if (!md.startsWith('---\n')) return { meta: {}, body: md }
  const lines = md.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break }
  }
  if (end === -1) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }
  return { meta, body: lines.slice(end + 1).join('\n') }
}
