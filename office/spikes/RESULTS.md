# M0 spike results

Run 2026-07-06 (claude CLI 2.1.201, node 22, remote Linux container, subscription auth, API-key env stripped):

| # | Spike | Result | Detail |
|---|-------|--------|--------|
| 1 | `claude-fable-5` on subscription CLI | PASS | reply "OK", cost fields present |
| 2 | 3 concurrent `claude -p` sessions, shared cwd | PASS | 3/3 in 6.2s |
| 3 | `--resume` round-trip continuity | PASS | codeword recalled |
| 4 | PreToolUse write-guard boundary | PASS | 6/6 unit cases (E2E via `RUN_E2E=1 node office/spikes/04-write-guard.mjs`) |

Re-run everything with `npm --prefix office run spikes` (spends a few small model calls).
Fallback if spike 1 ever fails on a given machine/plan: set `"fableFallbackModel": "claude-opus-4-8"` in `office/config/office.json`.
