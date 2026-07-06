// Spike: prove we can read the subscription usage window from this machine.
// Prints ONLY utilization percentages and reset times — never the token.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const credPath = path.join(os.homedir(), '.claude', '.credentials.json')
const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'))
const creds = raw.claudeAiOauth ?? raw.default ?? raw
const token = creds.accessToken ?? creds.access_token
if (!token) {
  console.error('no accessToken in credentials file')
  process.exit(2)
}
console.log('token expiresAt:', creds.expiresAt ? new Date(creds.expiresAt).toISOString() : 'n/a')

const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
  headers: {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
  },
  signal: AbortSignal.timeout(15_000),
})
console.log('status:', res.status)
if (res.status !== 200) {
  console.error('body (first 300 chars):', (await res.text()).slice(0, 300))
  process.exit(1)
}
const json = await res.json()
console.log('five_hour:', JSON.stringify(json.five_hour))
console.log('seven_day:', JSON.stringify(json.seven_day))
