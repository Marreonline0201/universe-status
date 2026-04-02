# Universe Sim — Claude Code Instructions

## Agent Status Reporting

All agents MUST report their status to the Railway server so the companion status site shows live activity. Use `curl` directly — it always works regardless of environment:

```bash
# Report active
curl -s -X POST https://questions-production-63a2.up.railway.app/agent \
  -H "Content-Type: application/json" \
  -d '{"agentId":"YOUR_AGENT_ID","status":"active","task":"What you are doing","message":"Optional message for the feed"}'

# Report idle when finished (ALWAYS use this as your final report — clears your card on the status site)
curl -s -X POST https://questions-production-63a2.up.railway.app/agent \
  -H "Content-Type: application/json" \
  -d '{"agentId":"YOUR_AGENT_ID","status":"idle","task":"","message":"Brief summary of what was completed"}'

# Report blocked (triggers Telegram alert to owner)
curl -s -X POST https://questions-production-63a2.up.railway.app/agent \
  -H "Content-Type: application/json" \
  -d '{"agentId":"YOUR_AGENT_ID","status":"blocked","task":"What you need","message":"Why you are blocked"}'

# Directed message to another agent
curl -s -X POST https://questions-production-63a2.up.railway.app/agent \
  -H "Content-Type: application/json" \
  -d '{"agentId":"YOUR_AGENT_ID","status":"active","task":"Current task","message":"Hey physics-prof, need fluid primitives ready","to":"physics-prof"}'
```

**Rules:**
- Call the curl report at the START of your task
- Call it again every time you start a new significant step
- Call it at the END with status "idle" and a summary message — this clears your card on the status site immediately
- Never go more than 2 minutes without reporting (the owner monitors the status site on their phone)

## Waiting for Owner Approval

When you need the owner to approve something before proceeding (e.g. a risky operation, a major architectural decision, a destructive change):

1. Report blocked — this sends a Telegram alert with Approve/Reject buttons:
```bash
curl -s -X POST https://questions-production-63a2.up.railway.app/agent \
  -H "Content-Type: application/json" \
  -d '{"agentId":"YOUR_AGENT_ID","status":"blocked","task":"What you need approved","message":"Describe what you want to do and why"}'
```

2. Poll for the decision (copy this loop exactly):
```bash
echo "Waiting for owner approval via Telegram..."
while true; do
  RESULT=$(curl -s "https://questions-production-63a2.up.railway.app/agent-approval?agentId=YOUR_AGENT_ID")
  if echo "$RESULT" | grep -q '"approved"'; then
    echo "Approved — proceeding."
    break
  elif echo "$RESULT" | grep -q '"rejected"'; then
    echo "Rejected — stopping."
    exit 1
  fi
  sleep 8
done
```

3. After the loop exits with "Approved", resume work and report active again.

**When to use this:** Before git push to main, before deleting files, before large refactors, before anything you're unsure about. When in doubt, ask.

## Agent IDs
`director`, `status-worker`, `gp-agent`, `knowledge-director`, `cqa`, `car`, `ui-worker`, `interaction`, `ai-npc`, `physics-prof`, `chemistry-prof`, `biology-prof`

## See AGENTS.md for full team structure and file ownership.
