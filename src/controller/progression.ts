// Main loop for progression milestones (architecture §4.2): survival interrupts
// preempt the objective skill (P0 > P1 > P2 > P3), the deterministic policy picks
// the next objective, Recovery handles failures (L2/L3/L5), and deaths reset
// transient state and re-plan from the real inventory (§7.4). No model calls:
// with `reasoner=none` the gate (§5.4) is never reached in milestone A.
import type { EventBus } from '../observer/events.js'
import type { WorldState } from '../observer/types.js'
import { candidateObjectives, fillerObjectives, nextObjective, type RequirementDef } from '../planner/policy.js'
import { recoverDecision, type DeathRecord, type DeathSite } from '../recovery/death.js'
import { Recovery, type RecoveryAction } from '../recovery/ladder.js'
import type { Failure, FailureClass, Objective, Outcome, SkillResult } from '../schema/index.js'
import type { SkillRunner } from '../skills/runner.js'
import { failureSignature } from '../skills/runner.js'
import type { Telemetry } from '../telemetry/telemetry.js'
import { bestWeapon, capacity } from '../skills/survival/threat.js'
import { Cooldowns, P, selectInterrupt, type Interrupt, type Priority } from './interrupts.js'
import { deferAtNight, schedule, surfaceNight } from './schedule.js'

export type ProgressionDeps = {
  runner: SkillRunner
  bus: EventBus
  telemetry: Telemetry
  state (): WorldState
  setObjective (o: Objective | undefined): void
  requirements: RequirementDef[]
  milestones: Record<string, (s: WorldState) => boolean>
  /** Extra first-reached flags (funnel). */
  flags: Record<string, (s: WorldState) => boolean>
  target: string
  deadline: number
  now?: () => number
  waitForRespawn (): Promise<void>
  /** Resync the client inventory with the server (STATE_INCONSISTENT, §7.2). */
  resync (): Promise<void>
  /** Drop transient world state after a death (interest cache, nav history). */
  afterDeath (): void
}

export type ProgressionResult = {
  outcome: Outcome
  reason: string
  terminalFailure: { class: FailureClass; signature: string; bundle: string | null } | null
}

export const LIMITS = { deaths: 5 }

/** Cooldown (s) after an interrupt skill fails, per interrupt kind. */
const INTERRUPT_COOLDOWN: Record<string, number> = { rest: 20, shelter: 60, hold: 10, defend: 20, flee: 15, cover: 10, forage: 120, pickup: 120, eat: 20, cook: 90, extinguish: 3, equip: 60, inventory: 90, surface: 2, suffocation: 2, escape_lava: 0, escape_fire: 0 }
/** Interrupts whose cooldown is per target entity. */
const PER_TARGET = new Set(['defend', 'flee', 'cover', 'forage'])
/** An objective iteration shorter than this is followed by a pause (never a synchronous spin). */
const MIN_ITERATION_MS = 250
const MIN_INTERRUPT_MS = 50
/** Seconds between holds in a sealed pocket. */
const HOLD_GAP_S = 30
/**
 * A weak bot (no weapon, or badly hurt) holds again almost at once while hostiles stay near,
 * for up to WEAK_HOLD_MAX_S in a row (then the normal gap, never pinned for good). Dev batch
 * 20261002-225340 r06: dug out of its pocket next to the skeleton it had hidden from, at 16 HP,
 * and died 26 s later.
 */
const WEAK_HOLD = { gapS: 0, maxS: 240, newChainAfterS: 60 } as const
/** Identical failures (same signature) within this window back off and share one bundle. */
const REPEAT = { windowS: 30, maxBackoffMs: 30_000 }
/** How often a running surface objective is checked against nightfall (ms). */
const NIGHTFALL_CHECK_MS = 2000
/** An interrupt that keeps firing this often without the objective progressing gets a breather. */
const THRASH = { windowS: 60, max: 25, pauseS: 30 }

export class ProgressionController {
  readonly recovery: Recovery
  readonly cooldowns: Cooldowns
  readonly flags: Record<string, number | null> = {}
  interrupts = 0
  private died = false
  private stopped = false
  private active: { skill: string; priority: Priority } | null = null
  private fired: { id: string; t: number }[] = []
  private repeats = new Map<string, { n: number; last: number }>()
  private lastSchedule = ''
  private current: Objective | null = null
  /** Last state while alive (equipment is gone by the time the death event arrives). */
  private alive: Record<string, unknown> | null = null
  /** The death site as last seen alive (recovery decision): cover and hostiles within 16. */
  private site: DeathSite | null = null
  private lastCover: { t: number; ok: boolean; method: string; why: string } | null = null
  /** Start and last end of the current chain of weak holds (bus seconds). */
  private weakHoldSince: number | null = null
  private weakHoldLast = -Infinity

  constructor (private readonly d: ProgressionDeps) {
    this.recovery = new Recovery(() => this.now())
    this.cooldowns = new Cooldowns(() => d.bus.now())
    d.bus.on(ev => {
      if (ev.type === 'death') { this.died = true; d.runner.cancel() }
      if (ev.type === 'cover' && !ev.data.step) this.lastCover = { t: ev.t, ok: Boolean(ev.data.ok), method: String(ev.data.method), why: String(ev.data.why) }
    })
  }

  stop (): void {
    this.stopped = true
    this.d.runner.cancel()
  }

  private now (): number { return (this.d.now ?? Date.now)() }

  /** Milestones and funnel flags: first transition emits `milestone` (+ snapshot for milestones). */
  checkMilestones (): void {
    const s = this.d.state()
    for (const [id, pred] of Object.entries(this.d.milestones)) {
      if (s.milestones[id] != null) continue
      if (pred(s)) {
        s.milestones[id] = s.t
        this.d.bus.emit('milestone', { id, t: s.t })
        this.d.telemetry.snapshot(id)
      } else s.milestones[id] ??= null
    }
    for (const [id, pred] of Object.entries(this.d.flags)) {
      if (this.flags[id] != null) continue
      if (pred(s)) { this.flags[id] = s.t; this.d.bus.emit('milestone', { id, t: s.t, flag: true }) } else this.flags[id] ??= null
    }
  }

  private targetReached (): boolean {
    return this.d.state().milestones[this.d.target] != null
  }

  private innermostSkill (): string | null {
    const st = this.d.state().control.skillStack
    return st.length ? st[st.length - 1]!.skill : null
  }

  private pickInterrupt (priority: Priority): Interrupt | null {
    const s = this.d.state()
    const i = selectInterrupt(s, this.cooldowns, { skill: this.innermostSkill(), priority })
    if (!i || i.priority >= priority) return null
    return i
  }

  /** Run a skill; a strictly higher-priority interrupt cancels it (the objective is reissued later). */
  private async runPreemptible (skill: string, params: unknown, priority: Priority): Promise<{ res: SkillResult; preemptedBy: Interrupt | null }> {
    this.active = { skill, priority }
    let preemptedBy: Interrupt | null = null
    let nightCheck = this.now()
    const iv = setInterval(() => {
      if (preemptedBy || this.died) return
      this.snapshotAlive()
      if (this.targetReached()) { this.d.runner.cancel(); return }
      const i = this.pickInterrupt(priority)
      if (i) { preemptedBy = i; this.d.runner.cancel(); return }
      // A surface objective started by day is stopped at nightfall (schedule.ts); the loop re-plans.
      const o = this.current
      if (priority === P.objective && o && o.skill === skill && this.now() - nightCheck >= NIGHTFALL_CHECK_MS) {
        nightCheck = this.now()
        const st = this.d.state()
        if (surfaceNight(st) && deferAtNight(o, st) && this.schedule(st).objective?.id !== o.id) {
          preemptedBy = { id: 'nightfall', priority: P.maintenance, skill: 'schedule', params: {}, reason: `${o.id} is surface work` }
          this.d.bus.emit('schedule', { mode: 'nightfall', stopped: o.id, timeOfDay: st.vitals.timeOfDay })
          this.d.runner.cancel()
        }
      }
    }, 250)
    try {
      const res = await this.d.runner.run(skill, params)
      return { res, preemptedBy }
    } finally {
      clearInterval(iv)
      this.active = null
    }
  }

  private snapshotAlive (): void {
    const s = this.d.state()
    if (s.vitals.health <= 0) return
    this.alive = {
      t: s.t, hp: Math.round(s.vitals.health * 10) / 10, food: s.vitals.food, pos: s.pos.map(Math.round), covered: s.body.covered, enclosed: s.body.enclosed ?? false,
      weapon: bestWeapon(s.inventory) ?? 'hand', armor: s.armor, shield: s.equipment.offHand === 'shield',
      worn: [s.equipment.head, s.equipment.chest, s.equipment.legs, s.equipment.feet].filter(Boolean),
      objective: s.control.objective?.id ?? null, interrupt: s.control.interrupt ?? null,
      stack: s.control.skillStack.map(x => x.skill), timeOfDay: s.vitals.timeOfDay,
      hostile: s.nearby.entities.filter(e => e.kind === 'hostile').slice(0, 6).map(e => `${e.name}@${Math.round(e.dist)}${e.los === false ? '(no los)' : ''}`),
    }
    this.site = { covered: s.body.covered, hostiles: s.nearby.entities.filter(e => e.kind === 'hostile' && e.dist <= 16).map(e => ({ name: e.name, dist: Math.round(e.dist) })) }
  }

  private async runInterrupt (i: Interrupt): Promise<void> {
    const s = this.d.state()
    const t = this.d.bus.now()
    this.fired = this.fired.filter(f => t - f.t < THRASH.windowS)
    this.fired.push({ id: i.id, t })
    if (this.fired.filter(f => f.id === i.id).length > THRASH.max && i.priority > P.emergency) {
      this.cooldowns.set(PER_TARGET.has(i.id) ? `${i.id}:${String(i.params.targetId)}` : i.id, THRASH.pauseS)
      this.d.bus.emit('interrupt_end', { id: i.id, status: 'throttled', reason: `fired > ${THRASH.max}× in ${THRASH.windowS}s` }, 'warn')
      return
    }
    this.interrupts++
    s.control.interrupt = i.id
    this.d.bus.emit('interrupt_start', { id: i.id, priority: i.priority, skill: i.skill, reason: i.reason, preempted: this.active?.skill ?? null }, i.priority <= P.threat ? 'warn' : 'info')
    const { res } = await this.runPreemptible(i.skill, i.params, i.priority)
    s.control.interrupt = null
    this.d.bus.emit('interrupt_end', { id: i.id, status: res.status, failure: res.failure?.class ?? null, reason: res.failure?.reason ?? null }, res.status === 'success' ? 'info' : 'warn')
    if (res.status === 'success' && i.id === 'eat') this.cooldowns.set('eat', 3) // the food level update trails the eat
    if (res.status === 'success' && i.id === 'cook') this.cooldowns.set('cook', 30)
    if (res.status === 'success' && i.id === 'shelter') this.cooldowns.set('shelter', 45)
    if (res.status === 'success' && i.id === 'rest') this.cooldowns.set('rest', 5)
    if (res.status === 'success' && i.id === 'inventory') this.cooldowns.set('inventory', 20)
    if (i.id === 'forage' && res.status !== 'cancelled') this.cooldowns.set('forage', 20)
    // A hold always ends with a turn for the objective (never pinned by a mob that stays near).
    if (i.id === 'hold' && res.status !== 'cancelled') {
      const weak = i.params.weak === true
      const now = this.d.bus.now()
      if (now - this.weakHoldLast > WEAK_HOLD.newChainAfterS) this.weakHoldSince = null
      if (weak) { this.weakHoldSince ??= now; this.weakHoldLast = now }
      const chained = weak && now - this.weakHoldSince! < WEAK_HOLD.maxS
      this.cooldowns.set('hold', chained ? WEAK_HOLD.gapS : HOLD_GAP_S)
    }
    if (res.status !== 'success' && res.status !== 'cancelled') {
      const key = PER_TARGET.has(i.id) ? `${i.id}:${String(i.params.targetId)}` : i.id === 'pickup' ? `pickup:${String(i.params.entityId)}` : i.id
      const cd = INTERRUPT_COOLDOWN[i.id] ?? 10
      if (cd > 0) this.cooldowns.set(key, cd)
      if (i.priority <= P.threat && res.failure && !this.died && !this.suppressRepeat(res.failure.signature)) {
        // P0/P1 failures are recorded (combat and hazards matter for diagnosis); P2 misses are not.
        const bundle = this.d.telemetry.failureBundle(`${res.failure.class}-${i.id}`, res.failure, { interrupt: i }, 120)
        this.d.telemetry.recordFailure({ t: this.d.state().t, class: res.failure.class, signature: res.failure.signature, objective: this.d.state().control.objective?.id ?? null, milestone: this.d.state().control.objective?.milestone ?? this.d.target, ladderLevel: i.priority === P.emergency ? 'P0' : 'P1', bundle })
      }
    }
  }

  private async afterDeath (lastObjective: Objective | null): Promise<void> {
    const s = this.d.state()
    const death = s.memory.deaths[s.memory.deaths.length - 1] as DeathRecord | undefined
    const sig = failureSignature('DEATH', this.active?.skill ?? lastObjective?.skill ?? '-', lastObjective?.id ?? null, s.dim, `hp=${Math.round(s.vitals.health)}`)
    const f: Failure = { class: 'DEATH', reason: death?.cause ?? 'bot died', detail: { lost: death?.lost ?? {} }, signature: sig }
    // Let the death message arrive, then bundle (§7.4 step 1: damage events are in the events tail).
    await new Promise(r => setTimeout(r, 1200))
    f.reason = death?.cause ?? f.reason
    // Death context (gate 20260929 analysis): equipment, objective, active interrupt, and
    // whether cover was attempted shortly before, from the last state while alive.
    const coverRecent = this.lastCover && death && death.t - this.lastCover.t <= 20 ? this.lastCover : null
    const context = { cause: death?.cause ?? null, ...(this.alive ?? {}), lastObjective: lastObjective?.id ?? null, cover: coverRecent }
    this.d.bus.emit('death_context', context, 'warn')
    const bundle = this.d.telemetry.failureBundle('DEATH', f, { objective: lastObjective, death, context }, 120)
    this.d.telemetry.recordFailure({ t: s.t, class: 'DEATH', signature: f.signature, objective: lastObjective?.id ?? null, milestone: lastObjective?.milestone ?? null, ladderLevel: 'death', bundle })
    await this.d.waitForRespawn()
    this.died = false
    // §7.4: abort skills (done), reset transient state, keep knowable memory, re-plan from inventory.
    this.cooldowns.clear()
    this.recovery.resetAfterDeath()
    this.d.afterDeath()
    this.d.setObjective(undefined)
    const now = this.d.state()
    this.d.bus.emit('recovery_step', { level: 'death', action: 'reset', inventory: now.inventory, deaths: now.counters.deaths })
    if (death) {
      const dec = recoverDecision(death, now.memory.deaths as DeathRecord[], now.t, now.pos, now.dim, this.site ?? undefined, surfaceNight(now))
      this.d.bus.emit('recovery_step', { level: 'death', action: dec.recover ? 'recover_items' : 'skip_recovery', reason: dec.reason })
      if (dec.recover && now.counters.deaths < LIMITS.deaths) {
        // Maintenance priority: the drop-pickup interrupt (P2) must not cancel the recovery walk.
        const { res } = await this.runPreemptible('recoverItems', { pos: death.pos }, P.maintenance)
        this.d.bus.emit('recovery_step', { level: 'death', action: 'recover_items_end', status: res.status, reason: res.failure?.reason ?? null })
      }
    }
    // What the bot does next from its real inventory (death-cascade tracking, survival report).
    const after = this.d.state()
    const sch = this.schedule(after)
    this.d.bus.emit('respawn_plan', { deaths: after.counters.deaths, objective: sch.objective?.id ?? null, shelter: sch.shelter, weapon: bestWeapon(after.inventory) ?? 'hand', capacity: capacity(after), night: surfaceNight(after), items: Object.keys(after.inventory).length })
  }

  private async act (a: RecoveryAction, obj: Objective): Promise<void> {
    if (a.kind === 'resync') { await this.d.resync(); await new Promise(r => setTimeout(r, 1000)) }
    if (a.kind === 'relocate') await this.relocate(obj)
    if (a.kind === 'suspend') {
      // Suspending only helps when something else can be done meanwhile.
      const alt = nextObjective(this.d.requirements, this.d.state(), id => id === obj.id || this.recovery.isSuspended(id))
      if (!alt) {
        this.recovery.unsuspend(obj.id)
        this.d.bus.emit('recovery_step', { level: 'L3', action: 'suspend_skipped', objective: obj.id, note: 'no other objective available; relocating instead' })
        await this.relocate(obj)
      }
    }
  }

  /**
   * L2 relocation. In the Nether a search walk is the hazard (lava, drops): the B-specific
   * move is a retreat through the remembered portal to the Overworld, from where the
   * policy re-enters for a fresh attempt.
   */
  private async relocate (obj: Objective): Promise<void> {
    if (this.d.state().dim === 'the_nether' && this.d.runner.has('usePortal')) {
      this.d.bus.emit('recovery_step', { level: 'L2', action: 'retreat', objective: obj.id, note: 'Nether: retreat through the portal instead of a search walk' }, 'warn')
      await this.runPreemptible('usePortal', { to: 'overworld' }, P.objective)
      return
    }
    await this.runPreemptible('relocate', {}, P.objective)
  }

  /** Day/night choice among the offerable objectives, with the night fillers (schedule.ts). */
  private schedule (s: WorldState): ReturnType<typeof schedule> {
    const suspended = (id: string) => this.recovery.isSuspended(id)
    const cands = candidateObjectives(this.d.requirements, s, suspended)
    return schedule(cands, s, surfaceNight(s) ? fillerObjectives(this.d.requirements, s, suspended) : [])
  }

  /**
   * Never spin: an objective iteration that returned almost at once (an instant
   * success or failure) is followed by a short timer pause, so the event loop,
   * keep-alives and telemetry always run (gate 20260929 r09: 2 million
   * microtask-only iterations froze the bot for 36 minutes).
   */
  private async pace (t0: number, min = MIN_ITERATION_MS): Promise<void> {
    const left = min - (this.now() - t0)
    await new Promise(r => setTimeout(r, Math.max(0, left)))
  }

  /** True when this signature already failed within REPEAT.windowS (no new bundle; back off). */
  private suppressRepeat (sig: string): boolean {
    const t = this.d.bus.now()
    const r = this.repeats.get(sig)
    if (r && t - r.last < REPEAT.windowS) { r.n++; r.last = t; return true }
    this.repeats.set(sig, { n: 1, last: t })
    return false
  }

  async run (): Promise<ProgressionResult> {
    const { bus } = this.d
    const tick = setInterval(() => { try { this.checkMilestones() } catch { /* state not ready */ } }, 1000)
    let current: string | null = null
    let lastObjective: Objective | null = null
    try {
      for (;;) {
        this.checkMilestones()
        const s = this.d.state()
        if (this.targetReached()) return { outcome: 'goal_reached', reason: `milestone ${this.d.target} reached`, terminalFailure: null }
        if (this.stopped) return { outcome: 'timeout', reason: 'stopped by evaluator', terminalFailure: null }
        if (s.counters.deaths >= LIMITS.deaths) return { outcome: 'death_limit', reason: `${s.counters.deaths} deaths`, terminalFailure: null }
        if (this.now() >= this.d.deadline) return { outcome: 'timeout', reason: 'bot-side deadline reached', terminalFailure: null }
        if (this.died) { await this.afterDeath(lastObjective); current = null; continue }

        const intr = this.pickInterrupt(P.objective)
        if (intr) { const t0 = this.now(); await this.runInterrupt(intr); await this.pace(t0, MIN_INTERRUPT_MS); continue }

        const sch = this.schedule(s)
        const schedKey = sch.shelter ? `shelter:${sch.deferred.join(',')}` : sch.deferred.length ? `defer:${sch.deferred.join(',')}>${sch.objective?.id}` : ''
        if (schedKey !== this.lastSchedule) {
          this.lastSchedule = schedKey
          if (schedKey) bus.emit('schedule', { mode: sch.shelter ? 'night_shelter' : sch.filler ? 'night_filler' : 'night_defer', deferred: sch.deferred, chosen: sch.objective?.id ?? null, timeOfDay: s.vitals.timeOfDay })
        }
        if (sch.shelter) {
          // Night, weak, and only surface work left: dig in and wait for day (P1/P2 still preempt).
          this.current = null
          const t0 = this.now()
          const { res } = await this.runPreemptible('shelter', { maxMs: 60_000, untilDay: true }, P.objective)
          if (res.status === 'failure') await this.runPreemptible('holdSafe', { ms: 5000 }, P.objective)
          await this.pace(t0)
          continue
        }
        const obj = sch.objective
        if (!obj) {
          if (this.d.requirements.every(r => r.met(s))) {
            // Every requirement met but the predicate is not: a gap between the list and the predicate.
            return { outcome: 'unrecoverable', reason: `all requirements met but ${this.d.target} predicate false`, terminalFailure: null }
          }
          await this.runPreemptible('holdSafe', { ms: 5000 }, P.objective)
          continue
        }
        const def = this.d.requirements.find(r => r.id === obj.id)
        const strat = this.recovery.strategy(obj.id)
        const o: Objective = { ...obj, strategy: strat.id === 'default' || def?.bounded ? obj.strategy : strat.id, params: def?.bounded ? obj.params : { ...obj.params, ...strat.params } }
        if (o.id !== current) {
          this.d.setObjective(o)
          current = o.id
          bus.emit('objective', { id: o.id, skill: o.skill, params: o.params, strategy: o.strategy })
        }
        lastObjective = o
        this.current = o
        const t0 = this.now()
        const { res, preemptedBy } = await this.runPreemptible(o.skill, o.params, P.objective)
        this.current = null
        this.recovery.addTime(o.id, this.now() - t0)
        if (this.died) continue
        let failed: SkillResult = res
        if (res.status === 'success') {
          // Invariant: an objective's success must satisfy the requirement it was chosen for.
          const after = this.d.state()
          if (!def || def.met(after)) { this.recovery.onSuccess(o.id); this.repeats.clear(); await this.pace(t0); continue }
          failed = {
            ...res,
            status: 'failure',
            failure: {
              class: 'OBJECTIVE_NOT_SATISFIED',
              reason: `${o.skill} succeeded but ${o.id} is still unmet (${def.desc ?? 'requirement predicate'})`,
              detail: { objective: o.id, params: o.params, expected: def.desc ?? null, prior: { status: res.status, durationMs: res.metrics.durationMs, outputs: res.outputs ?? null } },
              signature: failureSignature('OBJECTIVE_NOT_SATISFIED', o.skill, o.id, after.dim, `req=${o.id}`),
            },
          }
          bus.emit('failure', { class: 'OBJECTIVE_NOT_SATISFIED', objective: o.id, expected: def.desc ?? null, digest: this.d.telemetry.digest(), prior: failed.failure!.detail.prior }, 'warn')
        } else if (preemptedBy || res.status === 'cancelled') {
          await this.pace(t0)
          continue // reissued from scratch after the interrupt (§4.2)
        }

        const failure = failed.failure!
        const action = this.recovery.handle(o, failure, { persistent: def?.persistent, bounded: def?.bounded, noRelocate: def?.noRelocate })
        const isNav = failure.class.startsWith('NAV_') || failure.class === 'STALLED' || failure.class === 'SKILL_TIMEOUT'
        const repeat = this.suppressRepeat(failure.signature)
        const bundle = repeat ? null : this.d.telemetry.failureBundle(failure.class, failure, { objective: o, result: failed, action }, isNav ? 300 : 120)
        s.counters.failuresBySignature[failure.signature] = (s.counters.failuresBySignature[failure.signature] ?? 0) + 1
        s.counters.currentFailure = failure.signature
        s.counters.failuresThisObjective++
        this.d.telemetry.recordFailure({ t: s.t, class: failure.class, signature: failure.signature, objective: o.id, milestone: o.milestone, ladderLevel: action.level, bundle })
        bus.emit('recovery_step', { level: action.level, action: action.kind, note: action.note, objective: o.id, signature: failure.signature, failures: this.recovery.failures(o.id) })
        if (action.kind === 'terminate') {
          return { outcome: 'unrecoverable', reason: action.note, terminalFailure: { class: failure.class, signature: failure.signature, bundle } }
        }
        if (repeat) {
          // The same failure again within the window: back off (interruptible) before retrying.
          const r = this.repeats.get(failure.signature)!
          await this.runPreemptible('holdSafe', { ms: Math.min(REPEAT.maxBackoffMs, 1000 * 2 ** Math.min(5, r.n - 1)) }, P.objective)
        }
        await this.act(action, o)
        await this.pace(t0)
      }
    } finally {
      clearInterval(tick)
    }
  }
}
