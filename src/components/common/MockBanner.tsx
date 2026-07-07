// Shared mock-mode banner (clone of the PixelOffice inline banner, which stays
// untouched). Scripted demo data must never be mistaken for real agents.
export function MockBanner({ sub }: { sub: string }) {
  return (
    <div style={{
      position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
      zIndex: 10, pointerEvents: 'none', padding: '8px 18px', borderRadius: 4,
      background: 'rgba(120,10,10,0.92)', border: '2px solid #ff4444',
      color: '#ffdddd', fontSize: 13, fontWeight: 700, letterSpacing: 2, textAlign: 'center',
    }}>
      ⚠ MOCK MODE — scripted demo, real agents are NOT running
      <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: 1, marginTop: 3, color: '#ff9999' }}>
        {sub}
      </div>
    </div>
  )
}
