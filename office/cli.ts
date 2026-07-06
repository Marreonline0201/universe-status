#!/usr/bin/env tsx
// Office CLI:
//   office start                     — run the orchestrator (agents live while this runs)
//   office mock                      — run with scripted activity (UI development)
//   office assign --team fluid --title "..." [--assignee id] [--brief file] [--priority high]
//   office pause | resume | status   — control a running orchestrator
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOffice, loadConfig } from './server/index.ts'
import { resolvePaths, createTaskFile } from './server/store.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = loadConfig(repoRoot)
const [cmd, ...rest] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}

async function api(method: string, route: string, body?: unknown) {
  const res = await fetch(`http://localhost:${cfg.port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

switch (cmd) {
  case 'start':
    await startOffice()
    break
  case 'mock':
    await startOffice({ mock: true })
    break
  case 'assign': {
    const title = flag('title')
    const team = flag('team')
    if (!title || !team) {
      console.error('usage: office assign --team <team> --title "..." [--assignee <id>] [--brief <file>] [--priority high]')
      process.exit(1)
    }
    const brief = flag('brief') ? fs.readFileSync(flag('brief')!, 'utf8') : undefined
    const body = { title, team, assignee: flag('assignee'), brief, priority: flag('priority') }
    try {
      console.log(await api('POST', '/api/assign', body))
    } catch {
      // Orchestrator not running: write the task file directly; it's picked up on next boot.
      const id = createTaskFile(resolvePaths(repoRoot), { ...body, createdBy: 'user' })
      console.log({ ok: true, id, note: 'orchestrator offline — task file written, will be picked up on next `office start`' })
    }
    break
  }
  case 'pause':
  case 'resume':
    console.log(await api('POST', `/api/${cmd}`))
    break
  case 'status':
    console.log(JSON.stringify(await api('GET', '/api/status'), null, 2))
    break
  default:
    console.log('commands: start | mock | assign | pause | resume | status')
    process.exit(cmd ? 1 : 0)
}
