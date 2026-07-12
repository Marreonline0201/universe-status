// Reads the company/ filesystem into the runtime model: roster, tasks, mail, reports.
// All functions are synchronous snapshot reads — the watcher decides *when* to re-read.
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { OfficeAgent, OfficeTeam, TaskSummary, ReportMeta, ChatMsg, LabExperiment } from './protocol.ts'

export interface Paths {
  repoRoot: string
  companyDir: string
}

export function resolvePaths(repoRoot: string): Paths {
  return { repoRoot, companyDir: path.join(repoRoot, 'company') }
}

export interface AgentProfile {
  id: string
  name: string
  team: string
  role: string
  model: string
}

export function loadRoster(p: Paths): AgentProfile[] {
  const agentsDir = path.join(p.companyDir, 'agents')
  if (!fs.existsSync(agentsDir)) return []
  return fs.readdirSync(agentsDir)
    .map(id => path.join(agentsDir, id, 'profile.json'))
    .filter(f => fs.existsSync(f))
    .map(f => JSON.parse(fs.readFileSync(f, 'utf8')) as AgentProfile)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function loadTeams(p: Paths): OfficeTeam[] {
  const teamsDir = path.join(p.companyDir, 'teams')
  if (!fs.existsSync(teamsDir)) return []
  return fs.readdirSync(teamsDir).flatMap(id => {
    const charter = path.join(teamsDir, id, 'CHARTER.md')
    if (!fs.existsSync(charter)) return []
    const fm = matter(fs.readFileSync(charter, 'utf8')).data
    return [{ id, name: String(fm.name ?? id), color: String(fm.color ?? '#00d4ff') }]
  }).sort((a, b) => a.id.localeCompare(b.id))
}

export function loadTasks(p: Paths): TaskSummary[] {
  const dir = path.join(p.companyDir, 'tasks')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .flatMap(f => {
      const abs = path.join(dir, f)
      try {
        const fm = matter(fs.readFileSync(abs, 'utf8')).data
        return [{
          id: String(fm.id ?? f.replace(/\.md$/, '')),
          title: String(fm.title ?? f),
          team: String(fm.team ?? ''),
          assignee: fm.assignee ? String(fm.assignee) : null,
          status: String(fm.status ?? 'inbox'),
          priority: String(fm.priority ?? 'normal'),
          createdBy: String(fm.created_by ?? 'user'),
          parent: fm.parent ? String(fm.parent) : null,
          updatedAt: fs.statSync(abs).mtimeMs,
        } satisfies TaskSummary]
      } catch { return [] }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface MailFile {
  file: string // absolute path
  msg: ChatMsg
}

/** Unread mail for one agent (inbox contents). */
export function loadInbox(p: Paths, agentId: string): MailFile[] {
  const dir = path.join(p.companyDir, 'mail', agentId, 'inbox')
  if (!fs.existsSync(dir)) return []
  const archiveDir = path.join(dir, '..', 'archive')
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    // Tombstone: a same-named file in archive/ means this inbox copy is stale
    // (agents archive by copy; a leftover inbox file must not re-activate them).
    .filter(f => !fs.existsSync(path.join(archiveDir, f)))
    .flatMap(f => {
      const abs = path.join(dir, f)
      try {
        const fm = matter(fs.readFileSync(abs, 'utf8')).data
        return [{
          file: abs,
          msg: {
            from: String(fm.from ?? '?'),
            to: String(fm.to ?? agentId),
            subject: String(fm.subject ?? f),
            kind: String(fm.kind ?? 'fyi'),
            taskId: fm.task ? String(fm.task) : null,
            ts: fm.ts ? Date.parse(String(fm.ts)) || fs.statSync(abs).mtimeMs : fs.statSync(abs).mtimeMs,
          } satisfies ChatMsg,
        }]
      } catch { return [] }
    })
    .sort((a, b) => a.msg.ts - b.msg.ts)
}

export function loadReports(p: Paths): ReportMeta[] {
  const dir = path.join(p.companyDir, 'reports')
  if (!fs.existsSync(dir)) return []
  const out: ReportMeta[] = []
  for (const team of fs.readdirSync(dir)) {
    const teamDir = path.join(dir, team)
    if (!fs.statSync(teamDir).isDirectory()) continue
    const scan = (sub: string, defStatus: string) => {
      const d = path.join(teamDir, sub)
      if (!fs.existsSync(d)) return
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.md')) continue
        const abs = path.join(d, f)
        try {
          const fm = matter(fs.readFileSync(abs, 'utf8')).data
          out.push({
            team,
            path: path.relative(p.repoRoot, abs),
            title: String(fm.title ?? f),
            status: String(fm.status ?? defStatus),
            reviewedBy: fm.reviewed_by ? String(fm.reviewed_by) : null,
            date: String(fm.date ?? ''),
          })
        } catch { /* skip unparseable */ }
      }
    }
    scan('.', 'approved')
    scan('drafts', 'draft')
  }
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

export function buildAgents(profiles: AgentProfile[]): OfficeAgent[] {
  return profiles.map(pr => ({ ...pr, status: 'idle' as const, task: null, taskTitle: null }))
}

/** Raw owner-request file as read from disk. The Runner decorates it into an OwnerRequest. */
export interface RawRequest {
  id: string           // filename stem — authoritative
  fmId: string | null  // id claimed in frontmatter (mismatch → invalid)
  title: string
  requestedBy: string
  taskId: string | null
  kind: string
  status: string
  command: unknown     // validated by the runner, not here
  cwd: unknown
  timeoutMs: number | null
  createdAt: number
  resolvedAt: number | null
  exitCode: number | null
  durationMs: number | null
  path: string         // repo-relative
  file: string         // absolute
}

export function loadRequests(p: Paths): RawRequest[] {
  const dir = path.join(p.companyDir, 'requests')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .flatMap(f => {
      const abs = path.join(dir, f)
      try {
        if (!fs.statSync(abs).isFile()) return []
        const fm = matter(fs.readFileSync(abs, 'utf8')).data
        const stem = f.replace(/\.md$/, '')
        return [{
          id: stem,
          fmId: fm.id ? String(fm.id) : null,
          title: String(fm.title ?? stem),
          requestedBy: String(fm.requested_by ?? '?'),
          taskId: fm.task ? String(fm.task) : null,
          kind: String(fm.kind ?? 'decision'),
          status: String(fm.status ?? 'pending'),
          command: fm.command ?? null,
          cwd: fm.cwd ?? null,
          timeoutMs: fm.timeout_ms ? Number(fm.timeout_ms) : null,
          createdAt: fm.created_at ? Date.parse(String(fm.created_at)) || fs.statSync(abs).mtimeMs : fs.statSync(abs).mtimeMs,
          resolvedAt: fm.resolved_at ? Date.parse(String(fm.resolved_at)) || null : null,
          exitCode: fm.exit_code !== undefined && fm.exit_code !== null ? Number(fm.exit_code) : null,
          durationMs: fm.duration_ms !== undefined && fm.duration_ms !== null ? Number(fm.duration_ms) : null,
          path: path.relative(p.repoRoot, abs),
          file: abs,
        } satisfies RawRequest]
      } catch { return [] }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Server-side mail writer (sender: the owner / orchestrator). Same format agents use. */
export function writeMail(p: Paths, m: {
  from: string; to: string; subject: string; kind: string; taskId?: string | null; body: string
}): string {
  // `to` becomes a path segment; a request's `requested_by` is agent-controlled,
  // so reject anything but a roster-id shape to prevent traversal outside company/mail.
  if (!/^[a-z0-9-]+$/.test(m.to)) throw new Error(`invalid mail recipient: ${JSON.stringify(m.to)}`)
  const ts = Math.floor(Date.now() / 1000)
  const slug = m.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mail'
  const dir = path.join(p.companyDir, 'mail', m.to, 'inbox')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${ts}-${m.from}-${slug}.md`)
  const fmLines = [
    '---',
    `from: ${m.from}`,
    `to: ${m.to}`,
    `ts: ${new Date().toISOString()}`,
    `subject: ${JSON.stringify(m.subject)}`,
    ...(m.taskId ? [`task: ${m.taskId}`] : []),
    `kind: ${m.kind}`,
    '---',
  ]
  fs.writeFileSync(file, `${fmLines.join('\n')}\n${m.body}\n`)
  return file
}

/** Server-only request mutation: merge frontmatter patch, optionally append a body section. */
export function updateRequestFile(p: Paths, id: string, patch: Record<string, unknown>, appendSection?: string): boolean {
  const file = path.join(p.companyDir, 'requests', `${id}.md`)
  if (!fs.existsSync(file)) return false
  try {
    const parsed = matter(fs.readFileSync(file, 'utf8'))
    const data = { ...parsed.data, ...patch }
    const body = appendSection ? `${parsed.content.replace(/\s*$/, '')}\n\n${appendSection}\n` : parsed.content
    fs.writeFileSync(file, matter.stringify(body, data))
    return true
  } catch { return false }
}

const FILE_EXT_ALLOW = new Set(['.md', '.json', '.txt', '.csv', '.log'])
const FILE_SIZE_CAP = 512 * 1024

/** Path-traversal-safe reader for company/** files, for GET /api/file. */
export function readCompanyFile(p: Paths, repoRelPath: unknown):
  | { ok: true; path: string; content: string; mtimeMs: number }
  | { ok: false; error: string; code: 400 | 403 | 404 | 413 } {
  if (typeof repoRelPath !== 'string' || repoRelPath.includes('\0')) return { ok: false, error: 'bad path', code: 400 }
  if (/^[a-zA-Z]:/.test(repoRelPath) || repoRelPath.startsWith('/') || repoRelPath.startsWith('\\')) {
    return { ok: false, error: 'absolute paths not allowed', code: 400 }
  }
  const abs = path.resolve(p.repoRoot, repoRelPath)
  const rel = path.relative(p.companyDir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'outside company/', code: 403 }
  if (!FILE_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return { ok: false, error: 'file type not allowed', code: 403 }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: 'not found', code: 404 }
  // Symlink escape: the realpath must still live under the real company dir.
  const real = fs.realpathSync(abs)
  const relReal = path.relative(fs.realpathSync(p.companyDir), real)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return { ok: false, error: 'outside company/', code: 403 }
  const stat = fs.statSync(real)
  if (stat.size > FILE_SIZE_CAP) return { ok: false, error: 'file too large', code: 413 }
  return { ok: true, path: repoRelPath, content: fs.readFileSync(real, 'utf8'), mtimeMs: stat.mtimeMs }
}

const BLOB_EXT_ALLOW: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
}
const BLOB_SIZE_CAP = 2 * 1024 * 1024

/** Path-traversal-safe BINARY reader for company/** images (lab screenshots), for
 *  GET /api/blob. Containment mirrors readCompanyFile exactly; only raster image
 *  extensions are allowed and the stat happens BEFORE the read (no 2MB+ load-then-check). */
export function readCompanyBlob(p: Paths, repoRelPath: unknown):
  | { ok: true; buf: Buffer; contentType: string }
  | { ok: false; error: string; code: 400 | 403 | 404 | 413 } {
  if (typeof repoRelPath !== 'string' || repoRelPath.includes('\0')) return { ok: false, error: 'bad path', code: 400 }
  if (/^[a-zA-Z]:/.test(repoRelPath) || repoRelPath.startsWith('/') || repoRelPath.startsWith('\\')) {
    return { ok: false, error: 'absolute paths not allowed', code: 400 }
  }
  const abs = path.resolve(p.repoRoot, repoRelPath)
  const rel = path.relative(p.companyDir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'outside company/', code: 403 }
  const contentType = BLOB_EXT_ALLOW[path.extname(abs).toLowerCase()]
  if (!contentType) return { ok: false, error: 'file type not allowed', code: 403 }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: 'not found', code: 404 }
  // Symlink escape: the realpath must still live under the real company dir.
  const real = fs.realpathSync(abs)
  const relReal = path.relative(fs.realpathSync(p.companyDir), real)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return { ok: false, error: 'outside company/', code: 403 }
  if (fs.statSync(real).size > BLOB_SIZE_CAP) return { ok: false, error: 'file too large', code: 413 }
  return { ok: true, buf: fs.readFileSync(real), contentType }
}

export function listLab(p: Paths): LabExperiment[] {
  const dir = path.join(p.companyDir, 'lab')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .flatMap(name => {
      const expDir = path.join(dir, name)
      try {
        if (!fs.statSync(expDir).isDirectory()) return []
        const scenario = path.join(expDir, 'scenario.json')
        const notes = path.join(expDir, 'notes.md')
        const files = fs.readdirSync(expDir).map(f => path.join(expDir, f))
        const updatedAt = Math.max(fs.statSync(expDir).mtimeMs, ...files.map(f => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }))
        return [{
          id: name,
          name: name.replace(/[-_]+/g, ' '),
          path: path.relative(p.repoRoot, expDir),
          hasScenario: fs.existsSync(scenario),
          hasNotes: fs.existsSync(notes),
          updatedAt,
        } satisfies LabExperiment]
      } catch { return [] }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Create a task file the same way agents are instructed to. */
export function createTaskFile(p: Paths, opts: {
  title: string; team: string; assignee?: string; brief?: string; priority?: string; createdBy?: string
}): string {
  const ts = Math.floor(Date.now() / 1000)
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'
  const id = `TASK-${ts}-${slug}`
  const file = path.join(p.companyDir, 'tasks', `${id}.md`)
  const body = `---
id: ${id}
title: ${JSON.stringify(opts.title)}
team: ${opts.team}
assignee: ${opts.assignee ?? 'director'}
status: ${opts.assignee ? 'assigned' : 'inbox'}
created_by: ${opts.createdBy ?? 'user'}
created_at: ${new Date().toISOString()}
priority: ${opts.priority ?? 'normal'}
reviewers: [${opts.team && opts.team !== 'company' ? `${opts.team}-reviewer` : ''}]
---
## Brief
${opts.brief ?? opts.title}

## Log
`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return id
}
