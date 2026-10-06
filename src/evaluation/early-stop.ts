// Predeclared early-fail rules for scored milestone-B runs (evaluation.md §1, early-fail rules). The
// evaluator feeds the bot's event stream (events.jsonl, appended synchronously by the
// bot) into this monitor while the run is live; the same monitor replays finished runs
// (`npm run inspect -- early-stop <batchId|runId>`), so live and replay decisions agree.
//
// An early stop never changes scoring: the run stays in the denominator as a failure,
// keeps its deaths, and records the rule and its evidence. The 70-minute limit stays the
// absolute maximum. Rule 1 (5 deaths, recovery L5, crash) is the bot's/evaluator's own
// terminal handling and is only labelled here. Rules 2–4 stop a run that is still going:
//
//   2 objective_exhausted: the same required objective ran its whole recovery ladder
//     (every strategy, ending in "strategies exhausted") with no alternate objective
//     available (`suspend_skipped`) EXHAUSTIONS times, with no milestone or requirement
//     progress in between. The controller would only relocate and start the ladder again.
//   3 controller_stall: no milestone or requirement progress for STALL_S continuous
//     seconds, AND the active requirement completed ≥ STALL_CYCLES failed attempt +
//     recovery cycles in that window, AND nothing new was discovered in that window.
//   4 impossible_remainder: remaining wall time < a deterministic lower bound on the
//     still-unmet mandatory B steps, built only from game-mechanics minima that no
//     strategy can beat (portal transit ticks, sprint speed over the excursion distance).
//     The A phase and the portal build have no strategy-independent minimum, so the bound
//     is at most ~12 s: the rule could only relabel natural timeouts in their last seconds.
//     It is implemented and tested but OFF for the gate (EARLY_STOP.remainderRule).
//
// Never: "looks bad", "slow", "few resources", "unlikely to succeed".
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import progression from '../../config/progression.json' with { type: 'json' }
import { B_REQUIREMENTS, type RequirementDef } from '../planner/policy.js'

export type EarlyStopRule = 'objective_exhausted' | 'controller_stall' | 'impossible_remainder'
export type TerminalTrigger = 'death_limit' | 'recovery_L5' | 'crash'

export type EarlyStop = {
  rule: EarlyStopRule
  /** Bot clock (seconds since bot start) when the rule fired. */
  atS: number
  stage: string
  evidence: Record<string, unknown>
}

export const EARLY_STOP = {
  /** Rule 2: full ladder exhaustions (no alternate) of one objective without progress. */
  exhaustions: 2,
  /** Rule 3: continuous seconds without progress. */
  stallS: 15 * 60,
  /** Rule 3: failed attempt + recovery cycles of the active requirement inside the stall window. */
  stallCycles: 3,
  /** Rule 4 minima (Minecraft 1.16 mechanics). A survival player stands 80 ticks in a portal. */
  portalTransitS: 4,
  /** Sprinting on flat ground, blocks per second (upper bound on travel speed without elytra/boats/ice). */
  sprintBps: 5.612,
  /** Rule 4 in the gate: off (no defensible bound larger than ~12 s exists; see above). */
  remainderRule: false,
} as const

/** Upkeep requirements (bounded + persistent: food reserves): their success is not progress toward B. */
export function maintenanceIds (reqs: RequirementDef[] = B_REQUIREMENTS): Set<string> {
  return new Set(reqs.filter(r => r.bounded && r.persistent).map(r => r.id))
}

export type Ev = { t: number; type: string; data: Record<string, unknown> }

/**
 * Deterministic lower bound (seconds) on finishing milestone B from the given state:
 * enter the Nether (portal transit), walk excursionMin blocks out and back, return
 * (portal transit). Building or lighting a portal and the whole A phase are left out
 * on purpose: their minimum depends on terrain and strategy, so no defensible bound
 * exists for them. The bound is therefore small and the rule can only fire in the
 * last seconds of the limit.
 */
export function remainingLowerBoundS (st: { inNether: boolean; excursionDone: boolean; returned: boolean }): number {
  if (st.returned) return 0
  const exc = progression.B.excursionMin
  let s = EARLY_STOP.portalTransitS // the return transit
  if (!st.excursionDone) s += (2 * exc) / EARLY_STOP.sprintBps
  if (!st.inNether) s += EARLY_STOP.portalTransitS
  return Math.round(s * 10) / 10
}

type Cycle = { t: number; objective: string; level: string; action: string; signature: string }

export class EarlyStopMonitor {
  private readonly maintenance: Set<string>
  private lastProgress = { t: 0, what: 'run start' }
  private lastDiscovery: { t: number; what: string } | null = null
  /** Current objective (from `objective` events with an id). */
  private objective: { id: string; skill: string } | null = null
  /** Most recent non-upkeep objective: the requirement the run is actually blocked on. */
  private active: string | null = null
  private interruptDepth = 0
  private pendingSuccess: { id: string; t: number } | null = null
  private cycles: Cycle[] = []
  /** objective → exhaustion times (no alternate) since the last progress. */
  private exhausted = new Map<string, number[]>()
  private lastExhaust: { objective: string; t: number } | null = null
  private seenItems = new Set<string>()
  private reached: string[] = []
  private dim = 'overworld'
  private flags = { inNether: false, excursionDone: false, returned: false }
  private lastT = 0
  private fired: EarlyStop | null = null

  constructor (private readonly o: { limitS: number; maintenance?: Set<string>; remainderRule?: boolean }) {
    this.maintenance = o.maintenance ?? maintenanceIds()
  }

  get decision (): EarlyStop | null { return this.fired }

  /** Where the run is: last milestone/flag reached, dimension, active requirement. */
  stage (): string {
    const ms = this.reached.filter(id => /^(M0|A|B)$/.test(id))
    const phase = ms.includes('B') ? 'B' : ms.includes('A') ? 'B-phase (nether_ready)' : ms.includes('M0') ? 'A-phase' : 'pre-M0'
    const last = this.reached[this.reached.length - 1] ?? 'none'
    return `${phase}; last=${last}; dim=${this.dim}; requirement=${this.active ?? this.objective?.id ?? 'none'}`
  }

  private progress (t: number, what: string): void {
    this.lastProgress = { t, what }
    this.exhausted.clear()
  }

  private confirmSuccess (now: number): void {
    // An objective success is requirement progress unless OBJECTIVE_NOT_SATISFIED follows at once.
    if (this.pendingSuccess && now > this.pendingSuccess.t + 1) {
      this.progress(this.pendingSuccess.t, `requirement ${this.pendingSuccess.id} met`)
      this.pendingSuccess = null
    }
  }

  feed (e: Ev): EarlyStop | null {
    if (this.fired) return this.fired
    if (typeof e.t !== 'number' || typeof e.type !== 'string') return null
    this.lastT = Math.max(this.lastT, e.t)
    this.confirmSuccess(e.t)
    const d = e.data ?? {}
    switch (e.type) {
      case 'milestone': {
        const id = String(d.id)
        if (!this.reached.includes(id)) this.reached.push(id)
        // First-reached flags only ever shrink the bound below (monotonic), so it stays a lower bound.
        if (id === 'in_nether') this.flags.inNether = true
        if (id === 'excursion') this.flags.excursionDone = true
        if (id === 'return_ok' || id === 'B') this.flags.returned = true
        this.progress(e.t, `milestone ${id}`)
        break
      }
      case 'dimension_change':
        if (typeof d.to === 'string') this.dim = String(d.to).replace(/^minecraft:/, '')
        if (this.dim === 'the_nether') this.flags.inNether = true
        break
      case 'objective':
        if (typeof d.id === 'string') {
          this.objective = { id: d.id, skill: String(d.skill) }
          if (!this.maintenance.has(d.id)) this.active = d.id
        }
        break
      case 'interrupt_start': this.interruptDepth++; break
      case 'interrupt_end': this.interruptDepth = Math.max(0, this.interruptDepth - 1); break
      case 'skill_end':
        if (d.depth === 0 && this.interruptDepth === 0 && d.status === 'success' && this.objective && d.skill === this.objective.skill && !this.maintenance.has(this.objective.id)) {
          this.pendingSuccess = { id: this.objective.id, t: e.t }
        }
        break
      case 'failure':
        if (d.class === 'OBJECTIVE_NOT_SATISFIED' && this.pendingSuccess?.id === d.objective) this.pendingSuccess = null
        break
      case 'recovery_step': {
        const obj = typeof d.objective === 'string' ? d.objective : null
        const level = String(d.level)
        if (!obj || (level !== 'L2' && level !== 'L3')) break
        if (d.action !== 'suspend_skipped') {
          this.cycles.push({ t: e.t, objective: obj, level, action: String(d.action), signature: String(d.signature ?? '') })
          // The ladder's last step ("strategies exhausted"), possibly followed by the controller
          // finding no alternate (`suspend_skipped`, after a repeat back-off of up to ~30 s).
          this.lastExhaust = d.action === 'suspend' && String(d.note ?? '').startsWith('strategies exhausted') ? { objective: obj, t: e.t } : null
        } else if (this.lastExhaust?.objective === obj) {
          const xs = [...(this.exhausted.get(obj) ?? []), e.t]
          this.exhausted.set(obj, xs)
          if (xs.length >= EARLY_STOP.exhaustions && !this.maintenance.has(obj)) {
            return this.fire('objective_exhausted', e.t, {
              objective: obj, exhaustions: xs, lastProgress: this.lastProgress,
              note: 'every strategy exhausted with no alternate objective, repeatedly, without progress',
            })
          }
          this.lastExhaust = null
        }
        break
      }
      case 'location_discovered':
        // Only what the bot observed in the world (its own placements are not discoveries).
        if (d.source === 'observed') this.lastDiscovery = { t: e.t, what: `${String(d.kind)} ${JSON.stringify(d.pos)}` }
        break
      case 'item_delta':
        // A resource never held before in this run is a new resource found.
        for (const [item, n] of Object.entries((d.delta ?? {}) as Record<string, number>)) {
          if (n > 0 && !this.seenItems.has(item)) {
            this.seenItems.add(item)
            if (e.t > 0) this.lastDiscovery = { t: e.t, what: `first ${item}` }
          }
        }
        break
    }
    return this.check(e.t)
  }

  /** Time-based rules; call with the bot clock (seconds since bot start). */
  check (now: number): EarlyStop | null {
    if (this.fired) return this.fired
    now = Math.max(now, this.lastT)
    this.confirmSuccess(now)

    // Rule 3: hard controller stall.
    const since = this.lastProgress.t
    if (now - since >= EARLY_STOP.stallS && this.active) {
      const from = now - EARLY_STOP.stallS
      const cycles = this.cycles.filter(c => c.objective === this.active && c.t >= from && c.t > since)
      const discovered = this.lastDiscovery && this.lastDiscovery.t >= from ? this.lastDiscovery : null
      if (cycles.length >= EARLY_STOP.stallCycles && !discovered) {
        return this.fire('controller_stall', now, {
          requirement: this.active, noProgressS: Math.round(now - since), lastProgress: this.lastProgress,
          cycles: cycles.map(c => `${c.t}s ${c.level}:${c.action} ${c.signature}`),
          lastDiscovery: this.lastDiscovery,
        })
      }
    }

    // Rule 4: impossible-to-finish remainder.
    if (!(this.o.remainderRule ?? EARLY_STOP.remainderRule)) return null
    const lb = remainingLowerBoundS(this.flags)
    const left = this.o.limitS - now
    if (left < lb) return this.fire('impossible_remainder', now, { remainingS: Math.round(left * 10) / 10, lowerBoundS: lb, unmet: this.flags })
    return null
  }

  private fire (rule: EarlyStopRule, atS: number, evidence: Record<string, unknown>): EarlyStop {
    this.fired = { rule, atS, stage: this.stage(), evidence }
    return this.fired
  }
}

/** Replay a finished run's events through the monitor: when (if ever) would it have stopped, and where did the stream end? */
export function replayEarlyStop (events: Ev[], limitS: number): { decision: EarlyStop | null; endStage: string } {
  const m = new EarlyStopMonitor({ limitS })
  let last = 0
  for (const e of events) {
    if (typeof e.t !== 'number') continue
    // Time passes between events: check the clock-only rules at 10 s resolution.
    for (let t = last + 10; t < e.t; t += 10) if (m.check(t)) return { decision: m.decision, endStage: m.stage() }
    if (m.feed(e)) return { decision: m.decision, endStage: m.stage() }
    last = e.t
  }
  return { decision: null, endStage: m.stage() }
}

/**
 * Live tail of a growing events.jsonl (the bot appends synchronously): returns the
 * complete lines added since the last call; a partial last line waits for the next call.
 */
export class JsonlTail {
  private offset = 0
  private rest = ''
  constructor (private readonly path: string) {}
  read (): Ev[] {
    if (!existsSync(this.path)) return []
    const size = statSync(this.path).size
    if (size <= this.offset) return []
    const fd = openSync(this.path, 'r')
    try {
      const buf = Buffer.alloc(size - this.offset)
      readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const lines = (this.rest + buf.toString('utf8')).split('\n')
      this.rest = lines.pop() ?? ''
      return lines.flatMap(l => { try { return l ? [JSON.parse(l) as Ev] : [] } catch { return [] } })
    } finally { closeSync(fd) }
  }
}

/** Rule-1 label for a run the bot or evaluator already ended (existing terminal handling). */
export function terminalTrigger (outcome: string): TerminalTrigger | null {
  if (outcome === 'death_limit') return 'death_limit'
  if (outcome === 'unrecoverable') return 'recovery_L5'
  if (outcome === 'infra_error') return 'crash'
  return null
}
