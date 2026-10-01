// Category icons for the workers' capped bubbles (plan §4.8: at most 4 text bubbles office-wide, icons for the rest;
// §2 art workload "about 15 category icons"). This pass draws the ones the vertical slice's activities need.
//
// An icon is a 7×7 pixel map, drawn light-on-dark for the bubble background the office already uses
// (OfficeEngine.ts drawBubble: rgba(8,12,24,0.92)); scripts/worker-office-art-check.ts measures every icon's contrast
// against that background. ACTIVITY_ICON is keyed by the classifier's activity ids (office/observer/classify.mjs
// ACTIVITY_ID: the spool's `a` field), so a bubble never needs text built from tool input (plan §4.10).
import { type Ctx, makeCanvas, px } from './paint.ts'
import { MANILA, MANILA_DARK, PAPER, KRAFT, SLIP_YELLOW, STATUS_WORKING, shade } from './palette.ts'

export const ICON_SIZE = 7
/** The bubble the icons sit in (OfficeEngine.ts drawBubble), composited over the darkest floor. */
export const ICON_BACKGROUND = 'rgba(8,12,24,0.92)'

const W = '#e8ecf2'          // light ink
const G = '#9aa4ac'          // grey ink
const B = '#74c0fc'          // light blue
const BLUE_DK = '#1e4a6e'
const GREEN_LT = '#8ce99a'
const LEDGER_LT = '#4f8a5c'  // ledger green, lifted for a dark background
const SPINE_LT = '#3a6b47'

type Icon = { readonly rows: readonly string[]; readonly ink: Readonly<Record<string, string>> }

const ICONS = {
  /** read a file */
  folder: { rows: ['.......', 'MMM....', 'MMMPPP.', 'DDDDDDD', 'MMMMMMM', 'MMMMMMM', 'MMMMMMM'], ink: { M: MANILA, D: MANILA_DARK, P: PAPER } },
  /** search contents, search history */
  magnifier: { rows: ['.WWW...', 'WLLLW..', 'WLLLW..', 'WLLLW..', '.WWWH..', '.....H.', '......H'], ink: { W, L: BLUE_DK, H: '#c9a25c' } },
  /** list names */
  list: { rows: ['.......', 'B.WWWWW', '.......', 'B.WWWW.', '.......', 'B.WWWWW', '.......'], ink: { B, W } },
  /** refile / new folder */
  refile: { rows: ['....A..', 'AAAAAA.', '....A..', 'MMM....', 'DDDDDDD', 'MMMMMMM', 'MMMMMMM'], ink: { A: W, M: MANILA, D: MANILA_DARK } },
  /** read history */
  ledger: { rows: ['.SGGGG.', '.SGGGG.', '.SYYYY.', '.SGGGG.', '.SYYYY.', '.SGGGG.', '.SGGGG.'], ink: { S: SPINE_LT, G: LEDGER_LT, Y: '#e0b862' } },
  /** write a file, write history */
  pen: { rows: ['.....EE', '....PPE', '...PPP.', '..PPP..', '.PPP...', '.TP....', 'T......'], ink: { E: '#f783ac', P: SLIP_YELLOW, T: '#e8c87a' } },
  /** watch a background job, glance at history */
  eye: { rows: ['.......', '..WWW..', '.WWIWW.', 'WWIKIWW', '.WWIWW.', '..WWW..', '.......'], ink: { W, I: B, K: '#1c2a3a' } },
  /** set aside (stash) */
  box: { rows: ['.......', 'LLLLLLL', 'KKKKKKK', 'KKKKKKK', 'KKPPPKK', 'KKKKKKK', 'KKKKKKK'], ink: { L: shade.kraftHi, K: KRAFT, P: PAPER } },
  /** compare versions */
  diff: { rows: ['PPP.PPP', 'PgP.PgP', 'RRR.PPP', 'PPP.PgP', 'PgP.GGG', 'PPP.PPP', 'PPP.PPP'], ink: { P: PAPER, g: G, R: '#ff6b6b', G: '#51cf66' } },
  /** read an outside document */
  book: { rows: ['.......', 'PPP.PPP', 'PgP.PgP', 'PPPsPPP', 'PgPsPgP', 'PPPsPPP', 'CCCCCCC'], ink: { P: PAPER, g: G, s: '#b8b2a4', C: '#c0583f' } },
  /** search the web */
  globe: { rows: ['..BBB..', '.BLBLB.', 'BLLBLLB', 'BBBBBBB', 'BLLBLLB', '.BLBLB.', '..BBB..'], ink: { B, L: BLUE_DK } },
  /** restore files */
  restore: { rows: ['AA.WW..', 'A....W.', '......W', '......W', 'W.....W', '.W...W.', '..WWW..'], ink: { A: B, W } },
  /** run a program */
  terminal: { rows: ['FFFFFFF', 'F.....F', 'FG....F', 'F.G...F', 'FG.GG.F', 'F.....F', 'FFFFFFF'], ink: { F: G, G: GREEN_LT } },   // the dark bubble is the screen
  /** wait on a run */
  hourglass: { rows: ['WWWWWWW', '.W...W.', '..WSW..', '...W...', '..W.W..', '.WSSSW.', 'WWWWWWW'], ink: { W, S: '#e0b862' } },
  /** stop a job */
  stop: { rows: ['.RRRRR.', 'RRRRRRR', 'RRRRRRR', 'RWWWWWR', 'RRRRRRR', 'RRRRRRR', '.RRRRR.'], ink: { R: '#f03e3e', W } },
  /** check the machine */
  gauge: { rows: ['.......', '..WWW..', '.W...W.', 'W....NW', 'W...N.W', 'W..C..W', 'WWWWWWW'], ink: { W, N: '#ff6b6b', C: W } },
  /** final report */
  printout: { rows: ['PPPPPd.', 'PgggPPd', 'PPPPPPP', 'PggggPP', 'PPPPPPP', 'PgggPPP', 'PPPPPPP'], ink: { P: PAPER, g: G, d: '#b8b2a4' } },
  /** result form */
  form: { rows: ['..SSS..', 'BBSSSBB', 'BPPPPPB', 'BTPggPB', 'BPPPPPB', 'BTPggPB', 'BBBBBBB'], ink: { B: '#b08a5a', S: G, P: PAPER, T: '#2f9e44', g: G } },
  /** ask the owner (the front-desk phone) */
  phone: { rows: ['.WWWWW.', 'WW...WW', 'W.....W', '..RRR..', '.RRRRR.', 'RRRWRRR', 'RRRRRRR'], ink: { W, R: '#ff8787' } },
  /** launch own background helper (a ticket into the IN tray) */
  ticket: { rows: ['.......', 'YYdYYYY', 'YYdYYYY', '.YdYYY.', 'YYdYYYY', 'YYdYYYY', '.......'], ink: { Y: SLIP_YELLOW, d: '#c9a227' } },
  /** roster look (the in/out board) */
  roster: { rows: ['FFFFFFF', 'FWCWWWF', 'FWWWCWF', 'FCWWWWF', 'FWWCWWF', 'FFFFFFF', '.......'], ink: { F: G, W, C: STATUS_WORKING } },
  /** thinking or writing its next step (no event says which) */
  think: { rows: ['.WWWWW.', 'WWWWWWW', 'WKWKWKW', 'WWWWWWW', '.WWWWW.', '..W....', '.W.....'], ink: { W, K: '#1c2a3a' } },
  /** waiting for its own background job (the pager) */
  pager: { rows: ['.DDDDD.', '.DGGGD.', '.DGGGD.', '.DDDDD.', '.DLDLD.', '.DDDDD.', '.......'], ink: { D: '#868e96', G: GREEN_LT, L: W } },
  /** a call failed (PostToolUseFailure) */
  fail: { rows: ['R.....R', '.R...R.', '..R.R..', '...R...', '..R.R..', '.R...R.', 'R.....R'], ink: { R: '#ff6b6b' } },
  /** no events for N minutes */
  quiet: { rows: ['...ZZZZ', '.....Z.', '....Z..', '...ZZZZ', 'ZZZ....', '.Z.....', 'ZZZ....'], ink: { Z: G } },
} as const satisfies Record<string, Icon>

export type IconId = keyof typeof ICONS
export const ICON_IDS = Object.keys(ICONS) as IconId[]

/** Activity id (classify.mjs ACTIVITY_ID values) -> icon, for every activity at a slice object. */
export const ACTIVITY_ICON: Readonly<Record<string, IconId>> = {
  read: 'folder', search: 'magnifier', list: 'list', refile: 'refile',
  'hist-read': 'ledger', 'hist-search': 'magnifier', 'hist-write': 'pen', glance: 'eye', stash: 'box',
  diff: 'diff', fetch: 'book', websearch: 'globe',
  write: 'pen', restore: 'restore',
  run: 'terminal', wait: 'hourglass', stop: 'stop', watch: 'eye', check: 'gauge',
  report: 'printout', form: 'form', ask: 'phone', 'helper-bg': 'ticket', roster: 'roster',
}
/** States that are not tool activities (plan §4.5, §4.6). */
export const LIFECYCLE_ICON = { thinking: 'think', waitingForJob: 'pager', failed: 'fail', quiet: 'quiet' } as const satisfies Record<string, IconId>

/** Draw an icon at (x, y). */
export function drawIcon(g: Ctx, id: IconId, x = 0, y = 0) {
  const icon: Icon = ICONS[id]
  icon.rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = row[i]
      if (c !== '.') px(g, x + i, y + j, 1, 1, icon.ink[c])
    }
  })
}

/** The raw pixel map (the art check validates every row and ink). */
export const iconMap = (id: IconId): Icon => ICONS[id]

const cache = new Map<IconId, HTMLCanvasElement>()
/** The cached 7×7 canvas of an icon. */
export function iconImage(id: IconId): HTMLCanvasElement {
  const hit = cache.get(id)
  if (hit) return hit
  const [c, g] = makeCanvas(ICON_SIZE, ICON_SIZE)
  drawIcon(g, id)
  cache.set(id, c)
  return c
}
