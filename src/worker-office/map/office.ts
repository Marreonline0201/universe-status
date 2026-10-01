// The page's one copy of the worker office: the map and its pre-render, each built on first use and kept for the
// life of the page (plan §5.3: built once, even with zero workers; not rebuilt on a tab switch).
// The floorplan is bundled as text (Vite `?raw`) and parsed here; loadMap() and prerenderOffice() are the same
// functions the Node checks call, which read the file from disk instead.
import floorplanText from '../data/floorplan.json?raw'
import { loadMap, type OfficeMap } from './loadMap'
import { prerenderOffice, type OfficeScene } from '../render/prerender'

let map: OfficeMap | null = null
let scene: OfficeScene | null = null

export function getOfficeMap(): OfficeMap {
  if (!map) map = loadMap(JSON.parse(floorplanText) as unknown)
  return map
}

export function getOfficeScene(): OfficeScene {
  if (!scene) scene = prerenderOffice(getOfficeMap())
  return scene
}
