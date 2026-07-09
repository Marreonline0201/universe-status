// A thin draggable gutter for resizing a flanking panel. Drives an `onDrag(delta)`
// callback with the horizontal mouse delta; `side` flips the sign so a right-hand
// panel widens when you drag its left edge. Window-level listeners keep the drag
// alive even when the cursor leaves the 6px handle. Shared by DocsPage + PixelOffice.
import { useCallback, useRef, useState } from 'react'

export function ResizeHandle({ onDrag, side }: { onDrag: (delta: number) => void; side: 'left' | 'right' }) {
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
