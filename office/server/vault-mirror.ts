// Mirrors company/reports/** into the user's Obsidian vault so all research
// output lands in the second brain automatically (user decision 2026-07-07).
// The orchestrator does the copying — agents stay confined to company/ by the
// write-guard hook; they never need to know the vault exists.
import fs from 'node:fs'
import path from 'node:path'
import type { Paths } from './store.ts'

const README = `# Research — Agent Office output (auto-mirrored)

This folder is written by the **Agent Office orchestrator** (\`universe-status/office/\`).
Every research report the company produces — drafts and approved, from
\`company/reports/**\` — is copied here the moment it is written or updated.

- **Source of truth**: \`universe-status/company/reports/\` (auto-committed to the local \`agent-office\` branch).
- **Do not edit these copies** — the mirror overwrites them whenever the original changes. Edit the original instead.
- Layout: \`<team>/<report>.md\` (approved) and \`<team>/drafts/<report>.md\` (in review).
- Report quality bar: \`universe-status/company/REPORT_STANDARDS.md\`.
`

export class VaultMirror {
  constructor(
    private paths: Paths,
    private vaultDir: string,
    private log: (l: string) => void,
  ) {}

  /** Boot-time catch-up: copy every existing report into the vault. */
  sweep() {
    const reportsDir = path.join(this.paths.companyDir, 'reports')
    if (!fs.existsSync(reportsDir)) return
    try {
      this.ensureReadme()
      let copied = 0
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(abs)
          else if (entry.name.endsWith('.md') && this.copy(abs)) copied++
        }
      }
      walk(reportsDir)
      this.log(`vault: mirror ready at ${this.vaultDir}${copied ? ` (${copied} report(s) synced)` : ''}`)
    } catch (err) {
      this.log(`vault: sweep failed: ${String(err).slice(0, 200)}`)
    }
  }

  /** Mirror one report file (called by the watcher on add/change). */
  mirrorFile(absFile: string) {
    try {
      this.ensureReadme()
      if (this.copy(absFile)) {
        this.log(`vault: ${path.relative(this.paths.repoRoot, absFile)} → mirrored`)
      }
    } catch (err) {
      this.log(`vault: mirror failed for ${path.basename(absFile)}: ${String(err).slice(0, 200)}`)
    }
  }

  /** Copy preserving the reports/-relative layout. Returns true if written. */
  private copy(absFile: string): boolean {
    const reportsDir = path.join(this.paths.companyDir, 'reports')
    const rel = path.relative(reportsDir, absFile)
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.md')) return false
    const dest = path.join(this.vaultDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    // Skip identical content so Obsidian/OneDrive don't see phantom updates.
    try {
      if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === fs.readFileSync(absFile, 'utf8')) return false
    } catch { /* unreadable dest → overwrite */ }
    fs.copyFileSync(absFile, dest)
    return true
  }

  private ensureReadme() {
    fs.mkdirSync(this.vaultDir, { recursive: true })
    const readme = path.join(this.vaultDir, 'README.md')
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, README)
  }
}
