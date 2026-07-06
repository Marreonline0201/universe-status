// Reads the company/ filesystem into the runtime model: roster, tasks, mail, reports.
// All functions are synchronous snapshot reads — the watcher decides *when* to re-read.
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { OfficeAgent, OfficeTeam, TaskSummary, ReportMeta, ChatMsg } from './protocol.ts'

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
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
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
