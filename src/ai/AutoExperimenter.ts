// AutoExperimenter.ts — AI-driven autonomous experiment loop

const EXPERIMENT_IDEAS = [
  'add salt to the water',
  'add iron filings',
  'heat the water to 100 degrees',
  'add olive oil to see if it floats',
  'add mercury — does it sink?',
  'pour molten copper into water',
  'add sand (silicon dioxide)',
  'add calcium carbonate (limestone)',
  'mix iron and carbon to make steel',
  'add sulfur',
  'add charcoal',
  'pour lava into water',
]

export class AutoExperimenter {
  private running = false
  private experimentIndex = 0
  private onExperiment: (description: string) => Promise<string>
  private onLog: (message: string) => void
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    onExperiment: (description: string) => Promise<string>,
    onLog: (message: string) => void,
  ) {
    this.onExperiment = onExperiment
    this.onLog = onLog
  }

  start() {
    this.running = true
    this.onLog('Auto-experiment started. Running experiments...')
    this.runNext()
  }

  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.onLog('Auto-experiment stopped.')
  }

  get isRunning(): boolean { return this.running }

  private async runNext() {
    if (!this.running) return

    const idea = EXPERIMENT_IDEAS[this.experimentIndex % EXPERIMENT_IDEAS.length]
    this.experimentIndex++

    this.onLog(`Experiment ${this.experimentIndex}: "${idea}"`)

    try {
      const result = await this.onExperiment(idea)
      this.onLog(`Result: ${result}`)
    } catch (e) {
      this.onLog(`Error: ${e}`)
    }

    // Wait 5 seconds between experiments
    if (this.running) {
      this.timer = setTimeout(() => this.runNext(), 5000)
    }
  }
}
