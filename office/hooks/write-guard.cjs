#!/usr/bin/env node
// PreToolUse hook: the hard safety boundary for office agents.
// Denies Write/Edit outside company/** and the agent's own memory dir.
// Passed to each agent session via `--settings office/config/agent-settings.json`
// (never via the repo's .claude/settings.json — the user's own sessions must not be restricted).
//
// Contract (Claude Code hooks API): JSON on stdin, decision JSON on stdout.
const path = require('node:path')

let raw = ''
process.stdin.on('data', d => { raw += d })
process.stdin.on('end', () => {
  let input
  try { input = JSON.parse(raw) } catch { return allow() } // malformed input → don't break the session
  const tool = input.tool_name || ''
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return allow()

  const target = input.tool_input?.file_path || input.tool_input?.notebook_path || ''
  if (!target) return deny(`${tool} without a file path is not allowed for office agents.`)

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  const rel = path.relative(projectDir, path.resolve(projectDir, target))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return deny(`Writes outside the repo are forbidden (got: ${target}).`)
  }

  const agentId = process.env.OFFICE_AGENT_ID || ''
  const allowed =
    rel === 'company' || rel.startsWith(`company${path.sep}`) ||
    (agentId && rel.startsWith(path.join('.claude', 'agent-memory', agentId) + path.sep)) ||
    (agentId && rel === path.join('.claude', 'agent-memory', agentId))
  if (!allowed) {
    return deny(
      `Office agents may only write under company/ or .claude/agent-memory/${agentId || '<your-id>'}/. ` +
      `Attempted: ${rel}. Put reports in company/reports/<team>/drafts/, mail in company/mail/<agent>/inbox/.`
    )
  }
  allow()
})

function allow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'within office write boundary' },
  }))
  process.exit(0)
}
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }))
  process.exit(0)
}
