import { randomUUID } from 'node:crypto'
import type { EventBus } from '../observer/events.js'
import type { WorldState } from '../observer/types.js'
import { unmetObjectives, type RequirementDef } from '../planner/policy.js'
import { validateDecision, type Reasoner } from '../planner/reasoner.js'
import type { AttemptSummary, DecisionKind, DecisionOption, Failure, FailureClass, Objective, Outcome, SkillResult, StateDigest } from '../schema/index.js'
import type { SkillRunner } from '../skills/runner.js'
import { failureSignature } from '../skills/runner.js'
import type { Telemetry } from '../telemetry/telemetry.js'

export interface ControllerDeps {
  runner: SkillRunner
  reasoner: Reasoner
  bus: EventBus
  telemetry: Telemetry
  state (): WorldState
  digest (): StateDigest
  setObjective (o: Objective | undefined): void
  requirements: RequirementDef[]
  milestones: Record<string, (s: WorldState) => boolean>
  /** Milestone that ends the run with `goal_reached`. */
  target: string
  deadline: number
  now?: () => number
  waitForRespawn? (): Promise<void>
}

export type ControllerResult = {
  outcome: Outcome
  reason: string
  terminalFailure: { class: FailureClass; signature: string; bundle: string | null } | null
}

export const LIMITS = { attemptsPerObjective: 3, deaths: 5, reasonerTimeoutMs: 90_000 }

/**
 * Minimal M0 controller (architecture §4.2 without interrupts): pick the next
 * objective through the reasoner interface, run its skill, record failures,
 * and ask the reasoner for a recovery choice from a whitelisted menu.
 */
export class Controller {
  readonly attempts: AttemptSummary[] = []
  reasonerCalls = 0
  reasonerFallbacks = 0
  readonly reasonerByKind: Record<string, number> = {}
  private failuresByObjective: Record<string, number> = {}
  private died = false
  private stopped = false

  constructor (private readonly d: ControllerDeps) {
    d.bus.on(ev => {
      if (ev.type === 'death') { this.died = true; d.runner.cancel() }
    })
  }

  stop (): void {
    this.stopped = true
    this.d.runner.cancel()
  }

  private now (): number { return (this.d.now ?? Date.now)() }

  /** Evaluate milestone predicates; first transition emits `milestone` + snapshot. */
  checkMilestones (): void {
    const s = this.d.state()
    for (const [id, pred] of Object.entries(this.d.milestones)) {
      if (s.milestones[id] != null) continue
      if (pred(s)) {
        s.milestones[id] = s.t
        this.d.bus.emit('milestone', { id, t: s.t })
        this.d.telemetry.snapshot(id)
      } else {
        s.milestones[id] ??= null
      }
    }
  }

  async run (): Promise<ControllerResult> {
    const { bus } = this.d
    let trigger = 'run_start'
    let current: string | null = null
    for (;;) {
      this.checkMilestones()
      const s = this.d.state()
      if (s.milestones[this.d.target] != null) return { outcome: 'goal_reached', reason: `milestone ${this.d.target} reached`, terminalFailure: null }
      if (this.stopped) return { outcome: 'timeout', reason: 'stopped by evaluator', terminalFailure: null }
      if (s.counters.deaths >= LIMITS.deaths) return { outcome: 'death_limit', reason: `${s.counters.deaths} deaths`, terminalFailure: null }
      if (this.now() >= this.d.deadline) return { outcome: 'timeout', reason: 'bot-side deadline reached', terminalFailure: null }

      const objectives = unmetObjectives(this.d.requirements, s)
      if (objectives.length === 0) return { outcome: 'unrecoverable', reason: `no unmet requirement but ${this.d.target} predicate false`, terminalFailure: null }
      const options: DecisionOption[] = objectives.map(o => ({
        id: o.id, label: `${o.skill} ${JSON.stringify(o.params)}`, detail: o.strategy,
        priorFailures: this.failuresByObjective[o.id] ?? 0,
      }))
      const choice = await this.decide('select_objective', trigger, options)
      const obj = objectives.find(o => o.id === choice) ?? objectives[0]!
      if (obj.id !== current) {
        this.d.setObjective(obj)
        current = obj.id
        bus.emit('objective', { id: obj.id, skill: obj.skill, params: obj.params, strategy: obj.strategy })
      }

      const result = await this.d.runner.run(obj.skill, obj.params)
      this.attempts.unshift({ objective: obj.id, skill: obj.skill, status: result.status, failureClass: result.failure?.class, durationS: Math.round(result.metrics.durationMs / 1000) })
      trigger = 'skill_end'

      if (this.died) {
        this.died = false
        const f: Failure = { class: 'DEATH', reason: 'bot died', detail: {}, signature: failureSignature('DEATH', obj.skill, obj.id, s.dim) }
        this.handleFailure(obj, f, 'DEATH', result)
        await this.d.waitForRespawn?.()
        continue
      }
      if (result.status === 'success' || result.status === 'cancelled') continue

      const failure = result.failure!
      const bundle = this.handleFailure(obj, failure, failure.class, result)
      const n = (this.failuresByObjective[obj.id] = (this.failuresByObjective[obj.id] ?? 0) + 1)
      const menu: DecisionOption[] = []
      if (n < LIMITS.attemptsPerObjective) menu.push({ id: 'retry', label: `retry ${obj.id}`, detail: `attempt ${n + 1}/${LIMITS.attemptsPerObjective}`, priorFailures: n })
      menu.push({ id: 'terminate', label: 'terminate run', detail: 'unrecoverable', priorFailures: 0 })
      const action = await this.decide('choose_recovery', 'skill_failure', menu, obj, failure)
      bus.emit('recovery_step', { level: 'L2', action, objective: obj.id, failures: n, signature: failure.signature })
      if (action !== 'retry') {
        return { outcome: 'unrecoverable', reason: `${obj.id} failed ${n}× (${failure.class}: ${failure.reason})`, terminalFailure: { class: failure.class, signature: failure.signature, bundle } }
      }
    }
  }

  private handleFailure (obj: Objective, f: Failure, label: string, result: SkillResult): string {
    const s = this.d.state()
    s.counters.failuresBySignature[f.signature] = (s.counters.failuresBySignature[f.signature] ?? 0) + 1
    s.counters.currentFailure = f.signature
    s.counters.failuresThisObjective++
    const isNav = f.class.startsWith('NAV_') || f.class === 'STALLED' || f.class === 'SKILL_TIMEOUT'
    const bundle = this.d.telemetry.failureBundle(label, f, { objective: obj, result }, isNav ? 300 : 120)
    this.d.telemetry.recordFailure({ t: s.t, class: f.class, signature: f.signature, objective: obj.id, milestone: obj.milestone, ladderLevel: 'L2', bundle })
    return bundle
  }

  private async decide (kind: DecisionKind, trigger: string, options: DecisionOption[], objective?: Objective, failure?: Failure): Promise<string | null> {
    const req = {
      id: randomUUID(), kind, trigger, digest: this.d.digest(), objective, failure,
      attempts: this.attempts.slice(0, 10), options,
    }
    this.reasonerCalls++
    this.d.state().counters.reasonerCalls++
    this.reasonerByKind[kind] = (this.reasonerByKind[kind] ?? 0) + 1
    const t0 = this.now()
    this.d.bus.emit('reasoner_call', { kind, trigger, options: options.map(o => o.id), reasoner: this.d.reasoner.id }, 'debug')
    let raw: unknown
    try {
      raw = await this.d.reasoner.decide(req, AbortSignal.timeout(LIMITS.reasonerTimeoutMs))
    } catch (e) {
      raw = { error: String(e) }
    }
    const v = validateDecision(req, raw)
    if (!v.accepted) this.reasonerFallbacks++
    this.d.bus.emit('reasoner_result', { kind, choice: v.choice, accepted: v.accepted, error: v.error ?? null, rationale: v.response?.rationale ?? null, latencyMs: this.now() - t0 }, v.accepted ? 'debug' : 'warn')
    return v.choice
  }
}
