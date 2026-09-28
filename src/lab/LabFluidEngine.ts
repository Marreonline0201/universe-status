// The LABORATORY page's engine is the shared FluidEngine (src/fluid-engine/FluidEngine.ts),
// the same one FLUID TEST runs — kept under its old names so the lab components are unchanged.
export { FluidEngine as LabFluidEngine } from '../fluid-engine/FluidEngine'
export type { FluidStats as LabStats, FluidMetricsSample as LabMetricsSample } from '../fluid-engine/FluidEngine'
