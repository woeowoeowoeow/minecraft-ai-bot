import type { NavGoal, NavProfile, NavResult } from '../schema/index.js'

export type GotoOptions = {
  profile: NavProfile
  timeoutMs: number
  signal: AbortSignal
  /** Called whenever distance-to-goal improves (for skill progress heartbeats). */
  onProgress?: (dist: number) => void
}

/** Architecture §10. The only abstraction callers see; implementations own the pathfinder. */
export interface Navigator {
  goto (goal: NavGoal, o: GotoOptions): Promise<NavResult>
  stop (): void
  /** Time budget the navigator would use for `goal` from the current position (strategy-aware). */
  budgetMs (goal: NavGoal): number
  /** Diagnostics of the most recent calls, for failure bundles (nav.json). */
  recent (): NavResult[]
  /** Get the head out of water (swim up or along the route to open air). False if it never clears. Survival reflex (P0). */
  surface (): Promise<boolean>
  /** Out of the water at a reachable exit (wider search, notches into ice): the water trap escape. True when dry. */
  escapeWater (signal: AbortSignal): Promise<boolean>
}

/** Contract timeout for `navigate` (architecture §6.3): 20 s + 1.5 s/block. */
export function navTimeoutMs (distance: number): number {
  return 20_000 + 1_500 * Math.max(0, distance)
}

/** Excavation budget: 20 s + 4 s per block of vertical plus horizontal (Manhattan) work. */
export function excavationBudgetMs (work: number): number {
  return 20_000 + 4_000 * Math.max(0, work)
}

/**
 * Upper bound on any navigator budget for `goal` from `pos`, for a skill's hard
 * timeout (the navigator's own deadline, from `budgetMs`, always ends first).
 */
export function navBudgetUpperMs (goal: NavGoal, pos: [number, number, number], straightDist: number): number {
  const base = navTimeoutMs(straightDist)
  const t = goal.target
  if (goal.kind === 'y' && typeof t === 'number') return Math.max(base, excavationBudgetMs(pos[1] - t))
  if ((goal.kind === 'near' || goal.kind === 'block') && Array.isArray(t)) {
    return Math.max(base, excavationBudgetMs(Math.abs(pos[1] - t[1]) + Math.abs(pos[0] - t[0]) + Math.abs(pos[2] - t[2])))
  }
  return base
}
