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
  /** the EXAMPLE note while the synthetic example plays: amber, so it never reads as the live note */
  exampleText: '#ffe08a',
  exampleBg: 'rgba(38,26,4,0.94)',
  exampleEdge: 'rgba(250,176,5,0.6)',
  /** the Play / Stop example button, Connect log folder, Reconnect */
  buttonText: '#e6eefc',
  buttonBg: 'rgba(22,44,78,0.95)',
  buttonEdge: 'rgba(116,192,252,0.5)',
  /** the LIVE note while the owner's own log is shown: green, never mistaken for the example's amber */
  liveText: '#b8f5c8',
  liveBg: 'rgba(6,34,18,0.94)',
  liveEdge: 'rgba(64,192,112,0.6)',
} as const

/** Every text colour of the tab with the background it sits on: [what, text colour, background]. */
export const WO_TEXT_ON: readonly (readonly [what: string, text: string, background: string])[] = [
  ['room names, error headline', WO.text, WO.sidebarBg],
  ['notes, section titles, finish names, error message', WO.muted, WO.sidebarBg],
  ['map facts line', WO.faint, WO.sidebarBg],
  ['WORKERS chip', WO.chipText, WO.chipBg],
  ['no-live-feed note', WO.bannerText, WO.bannerBg],
  ['example note', WO.exampleText, WO.exampleBg],
  ['example button, Connect log folder, Reconnect', WO.buttonText, WO.buttonBg],
  ['live note', WO.liveText, WO.liveBg],
]
