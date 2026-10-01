// The page's one copy of the worker office: the map, its places and its pre-render, each built on first use and kept for the
// life of the page (plan §5.3: built once, even with zero workers; not rebuilt on a tab switch).
// The floorplan is bundled as text (Vite `?raw`) and parsed here; loadMap() and prerenderOffice() are the same
// functions the Node checks call, which read the file from disk instead.
import floorplanText from '../data/floorplan.json?raw'
import { loadMap, type OfficeMap } from './loadMap.ts'
import { buildPlaceLayout, type PlaceLayout } from './places.ts'
import { prerenderOffice, type OfficeScene } from '../render/prerender.ts'

let map: OfficeMap | null = null
let layout: PlaceLayout | null = null
let scene: OfficeScene | null = null

export function getOfficeMap(): OfficeMap {
  if (!map) map = loadMap(JSON.parse(floorplanText) as unknown)
  return map
}

/** The places of the map (plan §6.3), built once; each reservation book (PlaceBook) is made from it. */
export function getPlaceLayout(): PlaceLayout {
  if (!layout) layout = buildPlaceLayout(getOfficeMap())
  return layout
}

export function getOfficeScene(): OfficeScene {
  if (!scene) scene = prerenderOffice(getOfficeMap())
  return scene
}
