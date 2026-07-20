// Single source of truth for the company roster: 8 teams × 7 agents + 1 director = 57.
// Per team: 1 lead (fable), 1 principal researcher (fable) + 2 senior researchers (opus),
// 1 reviewer (opus), 1 research engineer (fable), 1 liaison/scribe (sonnet). Haiku is never used.
// The scaffold generator writes company/ from this; the orchestrator loads the generated
// profile.json files at runtime (so the user can hand-edit profiles without touching code).

export const MODELS = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
} as const

export interface RoleSpec {
  suffix: string
  role: string
  model: string
  duty: string
}

export const TEAM_ROLES: RoleSpec[] = [
  // 2026-07-20 owner decision: Fable 5 verified back in-plan (one-turn CLI ping OK).
  // Fable goes where planning/thinking compounds: the director, team leads, one principal
  // researcher per team, and research engineers. fable-2/3 stay on Opus — the principal
  // plans the research and coordinates them. 25 of 57 agents on Fable (~2x Opus burn);
  // the usage hard stop (scheduler.ts) is the money guard.
  { suffix: 'lead',     role: 'Team Lead',            model: MODELS.fable,  duty: 'Decomposes assignments into subtasks, assigns them, tracks progress, escalates blockers to the director.' },
  { suffix: 'fable-1',  role: 'Principal Researcher', model: MODELS.fable,  duty: 'Plans the team\'s research: decomposes questions into angles, coordinates the two senior researchers, synthesizes their threads into the draft.' },
  { suffix: 'fable-2',  role: 'Senior Researcher',    model: MODELS.opus,   duty: 'Deep research, idea generation, and report drafting at the highest quality bar.' },
  { suffix: 'fable-3',  role: 'Senior Researcher',    model: MODELS.opus,   duty: 'Deep research, idea generation, and report drafting at the highest quality bar.' },
  { suffix: 'reviewer', role: 'Reviewer / Editor',    model: MODELS.opus,   duty: 'Gates every report against company/REPORT_STANDARDS.md; requests revisions until the bar is met.' },
  { suffix: 'engineer', role: 'Research Engineer',    model: MODELS.fable,  duty: 'Grounds proposals in the actual codebase; writes feasibility notes with concrete file references.' },
  { suffix: 'liaison',  role: 'Liaison / Scribe',     model: MODELS.sonnet, duty: 'Handles cross-team mail, keeps the team charter current, writes digests of finished work.' },
]

export interface TeamSpec {
  id: string
  name: string
  color: string // team accent used by the office UI
  mission: string
  sources: string[] // repo docs this team treats as primary literature
  names: string[] // 7 human names, in TEAM_ROLES order
}

export const TEAMS: TeamSpec[] = [
  {
    id: 'physics',
    name: 'Physics Research',
    color: '#00d4ff',
    mission: 'Make the simulated universe physically honest: mechanics, thermodynamics, materials, and the physics tick architecture.',
    sources: ['structure.md', 'docs/element-properties.md', 'VISION_REALIGNMENT.md'],
    names: ['Elara Voss', 'Kenji Sato', 'Priya Raman', 'Theo Lindqvist', 'Amara Diallo', 'Felix Braun', 'Nora Castellanos'],
  },
  {
    id: 'chemistry',
    name: 'Chemistry Research',
    color: '#ff6b35',
    mission: 'Design reaction networks rich enough that prebiotic chemistry — and eventually life — can emerge without scripting.',
    sources: ['structure.md', 'docs/element-properties.md', 'src/composition/'],
    names: ['Ivan Petrov', 'Lucia Ferreira', 'Hana Kobayashi', 'Marcus Webb', 'Zainab Odili', 'Oskar Nilsen', 'Renata Kovacs'],
  },
  {
    id: 'bio',
    name: 'Biology Research',
    color: '#00ff88',
    mission: 'Genomes, metabolism, evolution, ecosystems: define what "life emerged" means and how to measure it.',
    sources: ['structure.md', 'VISION_REALIGNMENT.md'],
    names: ['Maya Okafor', 'Dmitri Sokolov', 'Ines Duarte', 'Ravi Chandra', 'Freya Holm', 'Tomas Aliyev', 'Greta Molnar'],
  },
  {
    id: 'fluid',
    name: 'Fluid Simulation',
    color: '#4d9fff',
    mission: 'MLS-MPM / SPH fluids: accuracy, stability, and scale of the hybrid GPU simulator.',
    sources: ['docs/superpowers/plans/2026-04-06-hybrid-fluid-simulator.md', 'docs/superpowers/specs/2026-04-06-hybrid-fluid-simulator-design.md', 'src/gpu-sim/', 'sph-wasm/'],
    names: ['Yuki Tanaka', 'Sofia Marino', 'Abel Tesfaye', 'Clara Novak', 'Jonas Weber', 'Leila Haddad', 'Piotr Zielinski'],
  },
  {
    id: 'game',
    name: 'Game Research',
    color: '#ffd700',
    mission: 'The observer experience: what makes watching a living universe compelling, and playtesting the sim as it grows.',
    sources: ['structure.md', 'DIRECTOR_PLAN.md', '.claude/agent-memory/game-playtester/'],
    names: ['Rosa Delgado', 'Emil Janssen', 'Aisha Bakr', 'Viktor Hale', 'Mina Park', 'Caleb Osei', 'Astrid Lund'],
  },
  {
    id: 'ml',
    name: 'ML Research',
    color: '#c77dff',
    mission: 'Surrogate models for physics and materials: replace hand-crafted formulas with learned, clamped corrections.',
    sources: ['FUTURE_ML.md', 'structure.md'],
    names: ['Wei Zhang', 'Iris Papadaki', 'Sam Whitfield', 'Anya Sharma', 'Bruno Costa', 'Nadia Rahim', 'Elias Berg'],
  },
  {
    id: 'rendering',
    name: 'Rendering Research',
    color: '#ff5fa2',
    mission: 'SSFR and beyond: make the universe look as real as it behaves, within browser GPU budgets.',
    sources: ['docs/superpowers/plans/2026-04-07-ssfr-threejs-migration.md', 'src/fluid-render/'],
    names: ['Talia Moreau', 'Hugo Andrade', 'Sena Yildiz', 'Owen Gallagher', 'Kira Volkova', 'Mateo Rios', 'Ingrid Falk'],
  },
  {
    id: 'engine',
    name: 'Engine Research',
    color: '#a3e635',
    mission: 'Game-engine subsystem research for the Rust/Bevy Universe Engine. For each subsystem (motion, collision, time control, thermal, instrumentation, …) produce a cited report proposing: the most physically precise method (exact published equations, real constants with sources — never third-party game-physics middleware, which trades accuracy for speed), the editor controls ("buttons") the subsystem needs, and the exact wiring into the engine loop. Every proposal must state how it will be verified against independent analytic references. f64 state; physics-shaped interfaces that expose full physical state, never convenience-shaped simplifications.',
    sources: ['structure.md', 'VISION_REALIGNMENT.md'],
    names: ['Iida Korhonen', 'Dario Bianchi', 'Yara Mansour', 'Callum Reid', 'Sachiko Endo', 'Lukas Meyer', 'Beatriz Anaya'],
  },
]

export interface AgentSpec {
  id: string
  name: string
  team: string // team id, or 'company' for the director
  role: string
  model: string
  duty: string
}

export function buildRoster(): AgentSpec[] {
  const agents: AgentSpec[] = [{
    id: 'director',
    name: 'Aurelio Kade',
    team: 'company',
    role: 'Company Director',
    model: MODELS.fable,
    duty: 'Routes the owner\'s assignments to team leads, keeps the company journal, arbitrates cross-team priorities.',
  }]
  for (const team of TEAMS) {
    TEAM_ROLES.forEach((r, i) => {
      agents.push({
        id: `${team.id}-${r.suffix}`,
        name: team.names[i],
        team: team.id,
        role: r.role,
        model: r.model,
        duty: r.duty,
      })
    })
  }
  return agents
}
