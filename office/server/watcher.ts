// Watches company/ and turns file events into scheduler pokes + website broadcasts.
import path from 'node:path'
import fs from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import matter from 'gray-matter'
import type { Paths } from './store.ts'
import type { ChatMsg, ReportMeta, TaskSummary } from './protocol.ts'

export interface WatcherEvents {
  onMail: (msg: ChatMsg) => void
  onTask: (task: TaskSummary) => void
  onReport: (report: ReportMeta) => void
  /** Raw report file path on add AND change — drives the vault mirror. */
  onReportFile?: (absFile: string) => void
  /** Owner-request file added/changed — id is the filename stem. */
  onRequest?: (id: string) => void
  /** Lab artifact (any extension) added/changed — repo-relative path. */
  onLab?: (repoRelPath: string) => void
  poke: () => void
}

export function startWatcher(p: Paths, events: WatcherEvents): FSWatcher {
  const watcher = chokidar.watch(p.companyDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })

  watcher.on('add', file => handle(file, true))
  watcher.on('change', file => handle(file, false))

  function handle(file: string, isNew: boolean) {
    const rel = path.relative(p.companyDir, file)
    const parts = rel.split(path.sep)
    // Lab artifacts fire for ANY extension (scenario.json, notes.md, data files).
    if (parts[0] === 'lab') {
      events.onLab?.(path.relative(p.repoRoot, file))
      events.poke()
      return
    }
    if (!rel.endsWith('.md')) return
    try {
      if (parts[0] === 'mail' && parts[2] === 'inbox' && isNew) {
        const fm = matter(fs.readFileSync(file, 'utf8')).data
        events.onMail({
          from: String(fm.from ?? '?'),
          to: String(fm.to ?? parts[1]),
          subject: String(fm.subject ?? path.basename(file)),
          kind: String(fm.kind ?? 'fyi'),
          taskId: fm.task ? String(fm.task) : null,
          ts: Date.now(),
        })
      } else if (parts[0] === 'tasks') {
        const fm = matter(fs.readFileSync(file, 'utf8')).data
        events.onTask({
          id: String(fm.id ?? path.basename(file, '.md')),
          title: String(fm.title ?? path.basename(file)),
          team: String(fm.team ?? ''),
          assignee: fm.assignee ? String(fm.assignee) : null,
          status: String(fm.status ?? 'inbox'),
          priority: String(fm.priority ?? 'normal'),
          createdBy: String(fm.created_by ?? 'user'),
          parent: fm.parent ? String(fm.parent) : null,
          updatedAt: Date.now(),
        })
      } else if (parts[0] === 'requests' && parts[1] !== 'logs' && parts.length === 2) {
        events.onRequest?.(path.basename(file, '.md'))
      } else if (parts[0] === 'reports' && parts[2] !== undefined) {
        // add AND change: a reviewer flipping status draft→approved is a change,
        // and both the site and the vault mirror must follow it.
        events.onReportFile?.(file)
        const fm = matter(fs.readFileSync(file, 'utf8')).data
        events.onReport({
          team: parts[1],
          path: path.relative(p.repoRoot, file),
          title: String(fm.title ?? path.basename(file)),
          status: String(fm.status ?? (parts[2] === 'drafts' ? 'draft' : 'approved')),
          reviewedBy: fm.reviewed_by ? String(fm.reviewed_by) : null,
          date: String(fm.date ?? new Date().toISOString().slice(0, 10)),
        })
      }
    } catch { /* unparseable file mid-write — the awaitWriteFinish retry will re-fire */ }
    events.poke()
  }

  return watcher
}
