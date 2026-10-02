// Shared zod schemas and TS types (architecture §3 "Schemas"). No logic here.
import { z } from 'zod'

export const Vec3S = z.tuple([z.number(), z.number(), z.number()])
export type V3 = z.infer<typeof Vec3S>

export const DimS = z.enum(['overworld', 'the_nether', 'the_end'])
export type Dim = z.infer<typeof DimS>

// ── Failures (architecture §7.1) ──────────────────────────────────────────
export const FailureClassS = z.enum([
  'NAV_STUCK', 'NAV_UNREACHABLE', 'NAV_HAZARD', 'NOT_FOUND', 'SEARCH_EXHAUSTED',
  'MISSING_RESOURCE', 'PRECONDITION_FAILED', 'COMBAT_DANGER', 'STATE_INCONSISTENT',
  'SKILL_TIMEOUT', 'STALLED', 'DEATH', 'STRATEGY_EXHAUSTED', 'INFRA',
  // An objective skill reported success but its requirement is still unmet (controller invariant).
  'OBJECTIVE_NOT_SATISFIED',
])
export type FailureClass = z.infer<typeof FailureClassS>

export const RequirementS = z.object({ item: z.string(), count: z.number() })
export type Requirement = z.infer<typeof RequirementS>

export const FailureS = z.object({
  class: FailureClassS,
  reason: z.string(),
  detail: z.record(z.string(), z.unknown()),
  missing: z.array(RequirementS).optional(),
  signature: z.string(),
})
export type Failure = z.infer<typeof FailureS>

// ── Navigation (architecture §10) ─────────────────────────────────────────
// 'reach' = stand where the block is within dig/interact reach with line of sight.
export const NavGoalS = z.object({
  kind: z.enum(['block', 'near', 'xz', 'y', 'entity', 'away', 'reach']),
  target: z.union([Vec3S, z.number()]),
  range: z.number().optional(),
  /** 'excavate': reach a buried `near`/`block` target by controlled excavation even when it is shallow or uncovered; 'walk': pathfinder only. */
  mode: z.enum(['auto', 'excavate', 'walk']).optional(),
  /** Plan with the strong dry-land preference from the start (fleeing aquatic mobs, inland relocation). */
  dry: z.boolean().optional(),
})
export type NavGoal = z.infer<typeof NavGoalS>

export const NavProfileS = z.enum(['overworld', 'overworld_cautious', 'nether', 'end', 'stronghold'])
export type NavProfile = z.infer<typeof NavProfileS>

// MISSING_RESOURCE: the chosen strategy needs an item the bot lacks (e.g. a pickaxe to excavate).
export const NavFailClassS = z.enum(['NAV_STUCK', 'NAV_UNREACHABLE', 'NAV_HAZARD', 'SKILL_TIMEOUT', 'CANCELLED', 'MISSING_RESOURCE'])
export type NavFailClass = z.infer<typeof NavFailClassS>

export const NavDiagS = z.object({
  goal: NavGoalS,
  profile: NavProfileS,
  startPos: Vec3S,
  lastPos: Vec3S,
  startDist: z.number(),
  endDist: z.number(),
  legs: z.number(),
  replans: z.number(),
  partial: z.boolean(),
  pathStatuses: z.record(z.string(), z.number()),
  resets: z.record(z.string(), z.number()),
  stuckEvents: z.number(),
  unstickAttempts: z.number(),
  blocksTravelled: z.number(),
  lastPath: z.array(Vec3S),
  surfacings: z.number().optional(),
  /** Server position-correction loops detected and recovered from. */
  correctionLoops: z.number().optional(),
  reason: z.string().optional(),
  /** 'pathfinder' search, or deterministic 'excavate' for underground targets. */
  strategy: z.enum(['pathfinder', 'excavate']).optional(),
  /** Excavation start check: already dry, relocated to a dry cell, or no dry cell in reach (fails NAV_HAZARD). */
  dryStart: z.enum(['already_dry', 'found', 'none']).optional(),
  excavation: z.object({
    steps: z.number(), dug: z.number(), falls: z.number(),
    byKind: z.record(z.string(), z.number()), entry: Vec3S, lastBlocked: z.string().optional(),
    /** Cells found solid again after a step's dig pass (falling blocks, refused breaks) and re-dug. */
    refills: z.number().optional(),
    /** Drops from a neighbour's lip into the open feet cell before planning. */
    unperched: z.number().optional(),
  }).optional(),
  water: z.object({
    msInWater: z.number(), exitAttempts: z.number(), exits: z.number(), dryReplans: z.number(), longestSwim: z.number(),
  }).optional(),
  missing: z.array(RequirementS).optional(),
})
export type NavDiag = z.infer<typeof NavDiagS>

export const NavResultS = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), dist: z.number(), ms: z.number(), detail: NavDiagS }),
  z.object({ ok: z.literal(false), class: NavFailClassS, ms: z.number(), detail: NavDiagS }),
])
export type NavResult = z.infer<typeof NavResultS>

// ── Skills (architecture §6.2) ────────────────────────────────────────────
export const SkillStatusS = z.enum(['success', 'failure', 'timeout', 'stalled', 'cancelled'])
export type SkillStatus = z.infer<typeof SkillStatusS>

export const SkillResultS = z.object({
  skill: z.string(),
  params: z.unknown(),
  status: SkillStatusS,
  failure: FailureS.optional(),
  outputs: z.unknown().optional(),
  metrics: z.object({
    durationMs: z.number(),
    navCalls: z.number(),
    navFailures: z.number(),
    localRecoveries: z.number(),
  }),
  evidence: z.array(z.string()),
})
export type SkillResult = z.infer<typeof SkillResultS>

// ── Planner (architecture §5) ─────────────────────────────────────────────
export const ObjectiveS = z.object({
  id: z.string(),
  milestone: z.string(),
  skill: z.string(),
  params: z.record(z.string(), z.unknown()),
  strategy: z.string(),
  budgetMs: z.number(),
})
export type Objective = z.infer<typeof ObjectiveS>

// ── Events (architecture §9) ──────────────────────────────────────────────
export const EventTypeS = z.enum([
  'run_start', 'run_end', 'spawn', 'death', 'respawn', 'dimension_change',
  'skill_start', 'skill_end', 'nav_start', 'nav_end', 'stuck_detected',
  'interrupt_start', 'interrupt_end', 'milestone', 'objective',
  'damage', 'item_delta', 'location_discovered', 'search_step',
  'failure', 'recovery_step', 'reasoner_call', 'reasoner_result', 'reasoner_skipped',
  'inventory_desync', 'chat', 'disconnect', 'intervention', 'capture',
  'physics_correction', 'navbench_trial', 'navbench_setup', 'error', 'excavation_step', 'water_event', 'dig_ack_correction',
  // Milestone A survival telemetry: ranged-threat cover attempts, death context, day/night scheduling.
  'cover', 'death_context', 'schedule',
  // Shoreline food risk: rejected and abandoned food targets, inland relocations.
  'food_risk',
])
export type EventType = z.infer<typeof EventTypeS>

export const SeverityS = z.enum(['debug', 'info', 'warn', 'error'])
export type Severity = z.infer<typeof SeverityS>

export const EventRecordS = z.object({
  t: z.number(),       // seconds since bot run start
  tick: z.number(),    // game age ticks (0 before spawn)
  type: EventTypeS,
  sev: SeverityS,
  data: z.record(z.string(), z.unknown()),
})
export type EventRecord = z.infer<typeof EventRecordS>

// ── StateDigest (architecture §8.2) ───────────────────────────────────────
export const StateDigestS = z.object({
  t: z.number(),
  dim: DimS,
  pos: Vec3S,
  vitals: z.object({
    hp: z.number(), food: z.number(), air: z.number(),
    effects: z.array(z.string()), armor: z.string(),
  }),
  inv: z.record(z.string(), z.number()),
  tools: z.array(z.string()),
  objective: z.object({ id: z.string(), strategy: z.string(), milestone: z.string(), elapsedS: z.number() }).nullable(),
  milestones: z.object({ reached: z.array(z.string()), flags: z.array(z.string()) }),
  locations: z.array(z.object({ kind: z.string(), dist: z.number(), dir: z.string(), pos: Vec3S })),
  nearby: z.object({
    hostile: z.array(z.string()),
    other: z.array(z.string()),
    hazards: z.array(z.string()),
    blocks: z.record(z.string(), z.number()),
  }),
  activeSkill: z.string().nullable(),
  recent: z.array(z.string()),
  failures: z.object({ current: z.string().nullable(), countThisObjective: z.number() }),
  deaths: z.number(),
})
export type StateDigest = z.infer<typeof StateDigestS>

// ── Reasoner (architecture §5.2) ──────────────────────────────────────────
export const DecisionKindS = z.enum(['select_objective', 'choose_strategy', 'diagnose_failure', 'choose_recovery', 'propose_skill_change'])
export type DecisionKind = z.infer<typeof DecisionKindS>

export const DecisionOptionS = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  estCost: z.string().optional(),
  priorFailures: z.number(),
})
export type DecisionOption = z.infer<typeof DecisionOptionS>

export const AttemptSummaryS = z.object({
  objective: z.string(), skill: z.string(), status: SkillStatusS,
  failureClass: FailureClassS.optional(), durationS: z.number(),
})
export type AttemptSummary = z.infer<typeof AttemptSummaryS>

export const DecisionRequestS = z.object({
  id: z.string(),
  kind: DecisionKindS,
  trigger: z.string(),
  digest: StateDigestS,
  objective: ObjectiveS.optional(),
  failure: FailureS.optional(),
  attempts: z.array(AttemptSummaryS).max(10),
  options: z.array(DecisionOptionS),
})
export type DecisionRequest = z.infer<typeof DecisionRequestS>

export const DecisionResponseS = z.object({
  choice: z.string().nullable(),
  params: z.unknown().optional(),
  confidence: z.number().min(0).max(1),
  diagnosis: z.object({ failureClass: FailureClassS, hypothesis: z.string(), evidence: z.array(z.string()) }).optional(),
  proposal: z.object({ skill: z.string(), change: z.string(), rationale: z.string() }).optional(),
  rationale: z.string().max(600),
})
export type DecisionResponse = z.infer<typeof DecisionResponseS>

// ── Bot process config (evaluator → bot). Never contains the seed. ───────
export const ScenarioS = z.enum(['m0', 'navbench', 'a'])
export type Scenario = z.infer<typeof ScenarioS>

export const BotConfigS = z.object({
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  runDir: z.string(),
  scenario: ScenarioS,
  reasoner: z.enum(['none', 'scripted']),
  limitMs: z.number().int().positive(),
  rngSeed: z.number().int().optional(), // the bot's own RNG (navbench targets); unrelated to the world seed
}).strict()
export type BotConfig = z.infer<typeof BotConfigS>

// ── Run outcome / summaries (evaluation.md §1, §4) ────────────────────────
export const OutcomeS = z.enum(['win', 'goal_reached', 'timeout', 'death_limit', 'unrecoverable', 'infra_error', 'intervened'])
export type Outcome = z.infer<typeof OutcomeS>

export const NavBenchTrialS = z.object({
  i: z.number(),
  kind: z.enum(['surface30', 'surface100', 'surface300', 'cave', 'depth']),
  profile: NavProfileS,
  ok: z.boolean(),
  class: z.string().nullable(),
  ms: z.number(),
  straightDist: z.number(),
  blocksTravelled: z.number(),
  stuckEvents: z.number(),
  replans: z.number(),
  endDist: z.number(),
  failureBundle: z.string().nullable(),
})
export type NavBenchTrial = z.infer<typeof NavBenchTrialS>

export const SkillStatsS = z.record(z.string(), z.object({
  runs: z.number(), ok: z.number(), durationsS: z.array(z.number()),
  failClasses: z.record(z.string(), z.number()),
}))
export type SkillStats = z.infer<typeof SkillStatsS>

export const NavStatsS = z.object({
  calls: z.number(), ok: z.number(), stuck: z.number(), unreachable: z.number(),
  hazard: z.number(), timeout: z.number(), cancelled: z.number(),
  stuckEvents: z.number(), blocksTravelled: z.number(),
  byProfile: z.record(z.string(), z.object({ calls: z.number(), ok: z.number() })),
})
export type NavStats = z.infer<typeof NavStatsS>

export const FailureEntryS = z.object({
  t: z.number(), class: FailureClassS, signature: z.string(), objective: z.string().nullable(),
  milestone: z.string().nullable(), ladderLevel: z.string(), bundle: z.string().nullable(),
})
export type FailureEntry = z.infer<typeof FailureEntryS>

/** Written by the bot at the end of its life (`bot_result.json`). */
export const BotResultS = z.object({
  outcome: OutcomeS,
  reason: z.string(),
  elapsedS: z.number(),
  gameTicks: z.number(),
  milestones: z.record(z.string(), z.number().nullable()),
  flags: z.record(z.string(), z.number().nullable()),
  deaths: z.array(z.object({ t: z.number(), dim: DimS, message: z.string().nullable() })),
  terminalFailure: z.object({ class: FailureClassS, signature: z.string(), bundle: z.string().nullable() }).nullable(),
  failures: z.array(FailureEntryS),
  skills: SkillStatsS,
  nav: NavStatsS,
  reasoner: z.object({ calls: z.number(), byKind: z.record(z.string(), z.number()), fallbacks: z.number(), impl: z.string() }),
  physicsCorrections: z.number(),
  interrupts: z.number().optional(),
  navbench: z.array(NavBenchTrialS).optional(),
})
export type BotResult = z.infer<typeof BotResultS>

export const GroundTruthS = z.object({
  t: z.number(),       // seconds since evaluator run start
  kind: z.enum(['server_ready', 'join', 'leave', 'death', 'advancement', 'kick', 'moved_wrongly', 'inventory', 'position', 'server_error', 'fixture']),
  data: z.record(z.string(), z.unknown()),
})
export type GroundTruth = z.infer<typeof GroundTruthS>

export const RunSummaryS = z.object({
  runId: z.string(),
  batchId: z.string(),
  seedSet: z.string(),
  fixture: z.boolean(),
  codeRev: z.string(),
  dirty: z.boolean(),
  mcVersion: z.string(),
  config: z.object({ scenario: ScenarioS, reasoner: z.string(), limitMin: z.number(), target: z.string(), fixture: z.string().nullable() }),
  startedAt: z.string(),
  endedAt: z.string(),
  outcome: OutcomeS,
  outcomeReason: z.string(),
  elapsedS: z.number(),
  timing: z.object({ serverStartS: z.number(), botConnectS: z.number().nullable(), botRunS: z.number().nullable(), teardownS: z.number() }),
  gameTicks: z.number(),
  milestones: z.record(z.string(), z.number().nullable()),
  flags: z.record(z.string(), z.number().nullable()),
  deaths: z.array(z.object({ t: z.number(), cause: z.string().nullable(), dim: z.string() })),
  terminalFailure: z.object({ class: z.string(), signature: z.string(), bundle: z.string().nullable() }).nullable(),
  failures: z.object({ total: z.number(), byClass: z.record(z.string(), z.number()), bySignature: z.record(z.string(), z.number()) }),
  skills: SkillStatsS,
  nav: NavStatsS,
  reasoner: z.object({ calls: z.number(), byKind: z.record(z.string(), z.number()), fallbacks: z.number(), impl: z.string() }),
  groundTruth: z.object({
    verified: z.boolean().nullable(),  // null = could not query
    inventory: z.record(z.string(), z.number()).nullable(),
    deaths: z.number(),
    advancements: z.array(z.string()),
    note: z.string(),
  }),
  interventions: z.number(),
  physicsCorrections: z.number(),
  botExit: z.object({ code: z.number().nullable(), signal: z.string().nullable() }),
  artifacts: z.object({ complete: z.boolean(), missing: z.array(z.string()) }),
  navbench: z.array(NavBenchTrialS).optional(),
})
export type RunSummary = z.infer<typeof RunSummaryS>

export function emptyNavStats(): NavStats {
  return { calls: 0, ok: 0, stuck: 0, unreachable: 0, hazard: 0, timeout: 0, cancelled: 0, stuckEvents: 0, blocksTravelled: 0, byProfile: {} }
}
