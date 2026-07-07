// ── DocsPage ──────────────────────────────────────────────────────────────────
// Renders universe-sim/structure.md as a navigable documentation page.
// Layout: Left = major section nav, Center = scrollable content, Right = "on this page" sub-nav.
// Inspired by docs.anthropic.com / Claude documentation layout.

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
// @ts-ignore — Vite raw import
import publicMd from '../../structure-public.md?raw'
// @ts-ignore
import fullMd from '../../structure.md?raw'
import { parseToc, parseBlocks, RenderBlock, type TocEntry } from '../lib/markdown'
import { PasswordModal } from './common/PasswordModal'

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

// (The password modal now lives in ./common/PasswordModal and is shared with the
//  office owner unlock, so both look identical.)

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
        <PasswordModal title="ADMIN ACCESS" onSubmit={login} onClose={() => setShowLogin(false)} />
      )}

    </div>
  )
}
