# Playtest Training Run 2026-03-24T06-16-01-625Z-c001

- episodes: 1
- clean: 0
- non-clean: 1
- planned fixes: 3
- applied runtime fixes: 3

## Failure Clusters
- low_food|low_water|panel_missing: 1

## Fix Queue
- fix-001 high low_food: Increase survival resource actions
- fix-002 high low_water: Increase survival resource actions
- fix-003 high panel_missing: Expand panel probing and relax panel-failure thresholds

## Applied Fixes
- fix-001 low_food: runtime.survival.resource_boost
- fix-002 low_water: runtime.survival.resource_boost
- fix-003 panel_missing: runtime.panelSweep.relaxed
