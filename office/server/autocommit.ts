// Auto-commit agent output to a dedicated local branch (user decision).
// Uses git plumbing with a temporary index so the user's working tree, index,
// and checked-out branch are never touched. Never pushes.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TRACKED = ['company', '.claude/agent-memory']

export class AutoCommitter {
  private indexFile: string
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private repoRoot: string, private branch: string, private log: (l: string) => void) {
    this.indexFile = path.join(repoRoot, 'office', 'state', 'autocommit.index')
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true })
  }

  private git(args: string[], env: Record<string, string> = {}): string {
    return execFileSync('git', args, {
      cwd: this.repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // keep expected failures (e.g. missing branch probe) off the console
    }).trim()
  }

  start(intervalMs: number) {
    this.timer = setInterval(() => this.commit(), intervalMs)
    this.commit()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.commit() // final flush on shutdown
  }

  commit() {
    try {
      const ref = `refs/heads/${this.branch}`
      let parent: string | null = null
      try { parent = this.git(['rev-parse', '--verify', ref]) } catch { parent = null }
      if (!parent) {
        // Branch starts from the current HEAD so diffs are readable against the code.
        parent = this.git(['rev-parse', 'HEAD'])
        this.git(['update-ref', ref, parent])
      }

      const env = { GIT_INDEX_FILE: this.indexFile }
      // Start from the branch's tree, then overlay the live office output paths.
      this.git(['read-tree', parent], env)
      for (const dir of TRACKED) {
        if (fs.existsSync(path.join(this.repoRoot, dir))) {
          this.git(['add', '-A', '--force', '--', dir], env)
        }
      }
      const tree = this.git(['write-tree'], env)
      const parentTree = this.git(['rev-parse', `${parent}^{tree}`])
      if (tree === parentTree) return // nothing changed

      const msg = `office: agent output ${new Date().toISOString()}`
      const commit = this.git(['commit-tree', tree, '-p', parent, '-m', msg])
      this.git(['update-ref', ref, commit, parent])
      this.log(`⎇ auto-committed agent output to ${this.branch} (${commit.slice(0, 8)})`)
    } catch (err) {
      this.log(`⎇ auto-commit failed: ${String(err).slice(0, 200)}`)
    }
  }
}
