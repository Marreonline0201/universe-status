// Mirrors LabExperiment in office/server/protocol.ts — keep in sync.
export interface LabExperiment {
  id: string
  name: string
  path: string
  hasScenario: boolean
  hasNotes: boolean
  updatedAt: number
}
