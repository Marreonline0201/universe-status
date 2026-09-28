// loadTs.mjs — import the REAL src/*.ts modules into Node for the fluid gates.
//
// Why: the app sources use extensionless relative imports ('./PropertyCalculator') and TS-only syntax, which Node's
// ESM loader (even with type stripping) cannot resolve. Instead of copying formulas into the gate (which would test a
// copy, not the code), we bundle the actual modules with rolldown — the bundler vite 8 already ships in node_modules —
// into ONE self-contained ESM file in the OS temp dir (never inside the repo), then import it.
//
// Usage:
//   import { loadTsModules } from './lib/loadTs.mjs'
//   const { materialData, liquidGate } = await loadTsModules({
//     materialData: 'src/composition/materialData.ts', liquidGate: 'src/composition/liquidGate.ts' })
// Every named module shares one bundle, so cross-module state and identities are the same as in the app.

import { rolldown } from 'rolldown'
import { writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export async function loadTsModules(map) {
  const outDir = join(tmpdir(), 'universe-status-fluid-gates')
  await mkdir(outDir, { recursive: true })
  const stamp = `${process.pid}-${Date.now()}`
  const entry = join(outDir, `entry-${stamp}.mjs`)
  const lines = Object.entries(map).map(([name, rel]) =>
    `export * as ${name} from ${JSON.stringify(resolve(REPO, rel).replaceAll('\\', '/'))}`)
  await writeFile(entry, lines.join('\n') + '\n')

  const bundle = await rolldown({ input: entry, platform: 'node', logLevel: 'warn' })
  const { output } = await bundle.generate({ format: 'esm' })
  await bundle.close()
  const chunk = output.find(o => o.type === 'chunk' && o.isEntry)
  if (!chunk) throw new Error('loadTs: rolldown produced no entry chunk')
  const outFile = join(outDir, `bundle-${stamp}.mjs`)
  await writeFile(outFile, chunk.code)
  return import(pathToFileURL(outFile).href)
}

export { REPO }
