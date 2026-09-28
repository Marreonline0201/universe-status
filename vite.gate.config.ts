// Dev server for measurement runs (scripts/fluid-gates/*, fluid-bench, parity, smoke):
//   npx vite --config vite.gate.config.ts   (port 5174)
// Identical to vite.config.ts except HMR is off, so an edit elsewhere in the repo can never
// reload a page in the middle of a 60-second measurement (it did — an S1.4 run died at t=40 s).
// The server still watches files, so the NEXT page load always gets the current code.
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'

export default mergeConfig(base, defineConfig({
  server: { port: 5174, strictPort: true, hmr: false },
}))
