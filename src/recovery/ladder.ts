// Recovery ladder (architecture §7.2), levels L1–L3 plus the L5 terminate.
// L1 runs inside skills (localRecovery). Here: L2 retry / resync / relocate,
// L3 alternate strategy or suspend the objective, L5 terminate. Decisions key on
// the failure class and signature (no coordinates, no seeds), never on a run.
import type { Failure, FailureClass, Objective } from '../schema/index.js'

export type RecoveryAction =
  | { kind: 'retry'; level: 'L2'; note: string }
  | { kind: 'resync'; level: 'L2'; note: string }
  | { kind: 'relocate'; level: 'L2'; note: string }
  | { kind: 'alternate'; level: 'L3'; strategy: string; note: string }
  | { kind: 'suspend'; level: 'L3'; seconds: number; note: string }
  | { kind: 'terminate'; level: 'L5'; note: string }

export type StrategyEntry = { id: string; params?: Record<string, unknown>; skill?: string }

/** Strategy catalog for obtain-style objectives: the same goal with more search. */
export const STRATEGIES: StrategyEntry[] = [
  { id: 'default', params: {} },
  { id: 'wide', params: { searchSteps: 12 } },
]

export const LADDER = {
  /** L2 attempts per objective+signature before L3. */
  l2PerSignature: 2,
  /** Objective failures (all signatures) before the run is declared unrecoverable. */
  terminateAfter: 14,
  suspendS: 300,
  /** Objective wall budget exceeded → L3 at once (milestone watchdog, §7.2). */
} as const

/**
 * NAV_UNREACHABLE on a search target (a tree, an animal: the skill blacklisted it and tried
 * others) is search exhaustion in this area, not a broken navigator (re-gate 20260930 r03:
 * terminated after 14 unreachable logs). Plain navigation failures keep counting.
 */
export function searchTargetUnreachable (f: Pick<Failure, 'class' | 'detail'>): boolean {
  if (f.class !== 'NAV_UNREACHABLE') return false
  // obtain wraps its step's failure detail as `child` (possibly nested obtains).
  for (let d: Record<string, unknown> | undefined = f.detail, i = 0; d && i < 4; d = d.child as Record<string, unknown> | undefined, i++) {
    if (d.searchTarget === true) return true
  }
  return false
}

const NAVISH = new Set<FailureClass>(['NAV_STUCK', 'NAV_UNREACHABLE', 'NAV_HAZARD', 'NOT_FOUND', 'SEARCH_EXHAUSTED', 'SKILL_TIMEOUT', 'STALLED', 'COMBAT_DANGER', 'INFRA', 'PRECONDITION_FAILED', 'STRATEGY_EXHAUSTED'])

type ObjState = { total: number; bySig: Record<string, number>; strategy: number; suspendedUntil: number; elapsedMs: number }

export class Recovery {
  private objs = new Map<string, ObjState>()

  /** `catalog`: an objective's own strategy catalog (RequirementDef.strategies), if it has one. */
  constructor (private readonly now: () => number, private readonly catalog: (id: string) => StrategyEntry[] | undefined = () => undefined) {}

  private strategiesOf (id: string): StrategyEntry[] {
    const c = this.catalog(id)
    return c && c.length ? c : STRATEGIES
  }

  private get (id: string): ObjState {
    let o = this.objs.get(id)
    if (!o) { o = { total: 0, bySig: {}, strategy: 0, suspendedUntil: 0, elapsedMs: 0 }; this.objs.set(id, o) }
    return o
  }

  isSuspended (id: string): boolean {
    return this.get(id).suspendedUntil > this.now()
  }

  strategy (id: string): StrategyEntry & { params: Record<string, unknown>; index: number; own: boolean } {
    const cat = this.strategiesOf(id)
    const index = Math.min(this.get(id).strategy, cat.length - 1)
    const e = cat[index]!
    return { ...e, params: e.params ?? {}, index, own: cat !== STRATEGIES }
  }

  /** Wall time spent on an objective's attempts (success or not). */
  addTime (id: string, ms: number): void { this.get(id).elapsedMs += ms }

  onSuccess (id: string): void {
    const o = this.get(id)
    o.bySig = {}
    o.total = 0
  }

  /** After a death: L2 counters describe a situation that no longer exists. Suspensions and strategies stay. */
  resetAfterDeath (): void {
    for (const o of this.objs.values()) o.bySig = {}
  }

  failures (id: string): number { return this.get(id).total }

  /**
   * Next ladder step for a failed objective. MISSING_RESOURCE is normally
   * handled by `obtain` itself (it re-plans); one that escapes gets one retry.
   * STATE_INCONSISTENT resyncs first. Movement, search, combat and watchdog
   * failures retry, then relocate, then switch strategy, then suspend.
   */
  handle (obj: Objective, f: Failure, opts: { persistent?: boolean; bounded?: boolean; noRelocate?: boolean } = {}): RecoveryAction {
    const o = this.get(obj.id)
    o.total++
    const sigN = (o.bySig[f.signature] = (o.bySig[f.signature] ?? 0) + 1)
    // "Not found yet" is not unrecoverable in a time-limited run: search failures keep relocating
    // (dev batch 11 r07: terminated after 14 fruitless tree searches with 15 min left).
    const searching = f.class === 'SEARCH_EXHAUSTED' || f.class === 'NOT_FOUND' || searchTargetUnreachable(f)
    if (o.total >= LADDER.terminateAfter && !opts.persistent && !searching) return { kind: 'terminate', level: 'L5', note: `${obj.id} failed ${o.total}× (last ${f.class})` }
    const overBudget = o.elapsedMs > obj.budgetMs
    // A bounded, optional objective (the early food buffer) that finds nothing is set aside at
    // once: retry, relocate and a wider search cost ~160 s each time (dev batch 9 r03).
    if (opts.bounded && (f.class === 'SEARCH_EXHAUSTED' || f.class === 'NOT_FOUND')) {
      o.bySig = {}
      o.elapsedMs = 0
      o.suspendedUntil = this.now() + LADDER.suspendS * 1000
      return { kind: 'suspend', level: 'L3', seconds: LADDER.suspendS, note: `${obj.id}: nothing found nearby (bounded)` }
    }
    // Success that leaves the requirement unmet: one retry (state may have moved on), then
    // suspend. A wider search cannot fix a mismatch between an objective and its requirement.
    if (f.class === 'OBJECTIVE_NOT_SATISFIED') {
      if (sigN <= 1 && !overBudget) return { kind: 'retry', level: 'L2', note: 'objective reported success but its requirement is unmet: retry once' }
      o.bySig = {}
      o.elapsedMs = 0
      o.suspendedUntil = this.now() + LADDER.suspendS * 1000
      return { kind: 'suspend', level: 'L3', seconds: LADDER.suspendS, note: `${obj.id} succeeds without meeting its requirement` }
    }
    if (!overBudget) {
      if (f.class === 'STATE_INCONSISTENT' && sigN <= LADDER.l2PerSignature) return { kind: 'resync', level: 'L2', note: 'resync inventory and retry' }
      if (f.class === 'MISSING_RESOURCE' && sigN <= 1) return { kind: 'retry', level: 'L2', note: 'retry: obtain re-resolves from the inventory' }
      if (NAVISH.has(f.class) && sigN === 1) return { kind: 'retry', level: 'L2', note: 'retry (failed targets are blacklisted)' }
      // Nether objectives never take a relocation walk (milestone B): they retry in place.
      if (NAVISH.has(f.class) && sigN === 2) return opts.noRelocate ? { kind: 'retry', level: 'L2', note: 'retry again (no relocation for this objective)' } : { kind: 'relocate', level: 'L2', note: 'relocate, then retry' }
    }
    // L3: the next strategy, then suspension.
    o.bySig = {}
    const cat = this.strategiesOf(obj.id)
    if (o.strategy < cat.length - 1) {
      o.strategy++
      o.elapsedMs = 0
      return { kind: 'alternate', level: 'L3', strategy: cat[o.strategy]!.id, note: overBudget ? `objective over budget; strategy ${cat[o.strategy]!.id}` : `strategy ${cat[o.strategy]!.id}` }
    }
    o.strategy = 0
    o.elapsedMs = 0
    o.suspendedUntil = this.now() + LADDER.suspendS * 1000
    return { kind: 'suspend', level: 'L3', seconds: LADDER.suspendS, note: `strategies exhausted for ${obj.id}` }
  }

  /** Lift a suspension early (nothing else to do). */
  unsuspend (id: string): void { this.get(id).suspendedUntil = 0 }
}
