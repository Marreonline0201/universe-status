// Colours of the WORKER OFFICE tab's DOM: the room key, the overlay over the map and the error note. (The canvas art
// keeps its own palette in src/worker-office/render.)
//
// Every TEXT colour meets WCAG 2.x AA, 4.5:1, on its background in the WORST case. The backgrounds are translucent,
// so scripts/worker-office-render-check.ts composites each one over pure white as well as over the app's near-black
// and checks both; it also checks that WorkerOffice.tsx has no colour of its own. The old office palette's #5c6a8a
// (3.70:1) and #3a4157 (1.98:1) failed AA.
export const WO = {
  /** room names, the error headline */
  text: '#cfe3ff',
  /** notes, section titles, finish names, the error message */
  muted: '#8a97b8',
  /** the map facts line under the room key */
  faint: '#7d8bab',
  sidebarBg: 'rgba(4,8,18,0.92)',
  sidebarRule: 'rgba(0,180,255,0.15)',
  swatchEdge: 'rgba(255,255,255,0.18)',
  chipText: '#9aa6c2',
  chipBg: 'rgba(8,12,24,0.85)',
  chipEdge: 'rgba(154,166,194,0.27)',
  bannerText: '#cfd8e8',
  bannerBg: 'rgba(14,20,34,0.9)',
  bannerEdge: 'rgba(138,151,184,0.45)',
} as const

/** Every text colour of the tab with the background it sits on: [what, text colour, background]. */
export const WO_TEXT_ON: readonly (readonly [what: string, text: string, background: string])[] = [
  ['room names, error headline', WO.text, WO.sidebarBg],
  ['notes, section titles, finish names, error message', WO.muted, WO.sidebarBg],
  ['map facts line', WO.faint, WO.sidebarBg],
  ['WORKERS chip', WO.chipText, WO.chipBg],
  ['no-live-feed note', WO.bannerText, WO.bannerBg],
]
