# IDE Tab Playtest Run

- generatedAt: 2026-03-24T05:44:11.770Z
- mode: IDE tab only (no background tab)
- episodes: 6

## Cluster Summary

1. overlay_stuck - 4
2. clean - 2

## Primary Finding

Overlay/focus reacquire remains unstable in early episodes and across multiple scenarios.

## Recommended Next Fix

1. Ensure successful world input transitions explicitly clear click-to-play overlays.
2. Add a short guarded retry for pointer lock/focus acquisition after respawn.
3. Re-run 12+ episodes and compare overlay_stuck recurrence.
