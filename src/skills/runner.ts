import type { Failure, FailureClass, NavGoal, NavProfile, NavResult, SkillResult, SkillStatus } from '../schema/index.js'
import { SkillFailure, type AnySkill, type SkillCtx, type SkillEnv } from './types.js'

export const MAX_DEPTH = 4
const CANCEL_GRACE_MS = 2000
const WATCHDOG_MS = 250

type Parent = { signal: AbortSignal; depth: number; deadline: number; heartbeat: () => void; metrics: SkillResult['metrics'] }

export class AbortError extends Error {
  /** `by`: what cancelled the skill (the preempting interrupt's id, or 'death'), when the caller says. */
  constructor (readonly why: 'timeout' | 'stalled' | 'cancelled', readonly by?: string) { super(`aborted: ${why}`); this.name = 'AbortError' }
}

export function failureSignature (cls: FailureClass, skill: string, objective: string | null, dim: string, detailKey = ''): string {
  return [cls, skill, objective ?? '-', dim, detailKey].join('|')
}

/**
 * Generic skill runner (architecture §6.2): param validation, isSatisfied,
 * preconditions, hard timeout, stall watchdog, cancellation with onCancel,
 * nested skills (shared abort, depth ≤ 4), skill_start/skill_end events.
 */
export class SkillRunner {
  private readonly skills = new Map<string, AnySkill>()
  private rootAbort: AbortController | null = null

  constructor (private readonly env: SkillEnv, private readonly now: () => number = Date.now) {}

  register (def: AnySkill): this {
    this.skills.set(def.id, def)
    return this
  }

  has (id: string): boolean { return this.skills.has(id) }

  /** Cancel the running top-level skill (preemption/pause/shutdown); `by` names the cause. */
  cancel (by?: string): void {
    this.rootAbort?.abort(new AbortError('cancelled', by))
  }

  async run (id: string, params: unknown, parent?: Parent): Promise<SkillResult> {
    const env = this.env
    const depth = parent ? parent.depth + 1 : 0
    const t0 = this.now()
    const metrics: SkillResult['metrics'] = { durationMs: 0, navCalls: 0, navFailures: 0, localRecoveries: 0 }
    const progressLog: Record<string, number> = {}
    const objective = env.state().control.objective?.id ?? null
    const stack = env.state().control.skillStack

    const finish = (status: SkillStatus, failure?: Omit<Failure, 'signature'> & { key?: string }, outputs?: unknown): SkillResult => {
      metrics.durationMs = this.now() - t0
      if (parent) {
        parent.metrics.navCalls += metrics.navCalls
        parent.metrics.navFailures += metrics.navFailures
        parent.metrics.localRecoveries += metrics.localRecoveries
      }
      let f: Failure | undefined
      if (failure) {
        const { key, ...rest } = failure
        f = { ...rest, signature: failureSignature(failure.class, id, objective, env.state().dim, key ?? '') }
      }
      const res: SkillResult = { skill: id, params, status, failure: f, outputs, metrics, evidence: [] }
      if (Object.keys(progressLog).length) res.outputs = { ...(outputs as object | undefined), progress: progressLog }
      env.bus.emit('skill_end', { skill: id, status, depth, durationMs: metrics.durationMs, failure: f ?? null, metrics, params }, status === 'success' || status === 'cancelled' ? 'info' : 'warn')
      return res
    }

    const def = this.skills.get(id)
    env.bus.emit('skill_start', { skill: id, params, depth })
    if (!def) return finish('failure', { class: 'PRECONDITION_FAILED', reason: `unknown skill ${id}`, detail: {} })
    if (depth > MAX_DEPTH) return finish('failure', { class: 'PRECONDITION_FAILED', reason: `max skill depth ${MAX_DEPTH} exceeded`, detail: {} })
    const parsed = def.params.safeParse(params)
    if (!parsed.success) return finish('failure', { class: 'PRECONDITION_FAILED', reason: 'invalid params', detail: { issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`) } })
    const p = parsed.data
    const s0 = env.state()
    if (def.isSatisfied?.(s0, p)) return finish('success', undefined, { alreadySatisfied: true })
    const pre = def.preconditions(s0, p, env)
    if (!pre.ok) return finish('failure', { class: pre.cls ?? 'MISSING_RESOURCE', reason: pre.reason, detail: {}, missing: pre.missing, key: pre.missing?.map(m => m.item).join('+') })

    const ac = new AbortController()
    if (!parent) this.rootAbort = ac
    const onParentAbort = () => ac.abort(parent!.signal.reason ?? new AbortError('cancelled'))
    if (parent) {
      if (parent.signal.aborted) onParentAbort()
      else parent.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    const deadline = Math.min(t0 + def.timeoutMs(s0, p), parent?.deadline ?? Infinity)
    let lastProgress = t0
    const heartbeat = () => { lastProgress = this.now(); parent?.heartbeat() }
    const frame = { skill: id, startedAt: env.bus.now() }
    stack.push(frame)

    const ctx: SkillCtx = {
      bot: env.bot,
      env,
      state: () => env.state(),
      memory: env.memory,
      signal: ac.signal,
      log: (type, data) => { if (!ac.signal.aborted) env.bus.emit(type, { skill: id, ...data }) },
      progress: (metric, value) => {
        if (ac.signal.aborted) return
        heartbeat()
        progressLog[metric] = value
      },
      localRecovery: (what) => {
        metrics.localRecoveries++
        env.bus.emit('recovery_step', { level: 'L1', skill: id, what }, 'info')
      },
      checkAbort: () => { if (ac.signal.aborted) throw ac.signal.reason ?? new AbortError('cancelled') },
      capture: (label) => env.capture(label),
      run: (child, cp) => this.run(child, cp, { signal: ac.signal, depth, deadline, heartbeat, metrics }),
      nav: {
        goto: async (goal: NavGoal, o?: { profile?: NavProfile; timeoutMs?: number }): Promise<NavResult> => {
          ctx.checkAbort()
          metrics.navCalls++
          const remaining = Math.max(1000, deadline - this.now())
          const timeoutMs = Math.min(o?.timeoutMs ?? env.nav.budgetMs(goal), remaining)
          // Movement profile follows the dimension unless the skill asks for one (milestone B: `nether`).
          const profile = o?.profile ?? (env.state().dim === 'the_nether' ? 'nether' : 'overworld')
          const r = await env.nav.goto(goal, { profile, timeoutMs, signal: ac.signal, onProgress: () => heartbeat() })
          if (!r.ok) metrics.navFailures++
          if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
          return r
        },
      },
    }

    const cleanup: (() => void)[] = []
    const watchdog = new Promise<AbortError>((resolve) => {
      const iv = setInterval(() => {
        const now = this.now()
        if (now >= deadline) ac.abort(new AbortError('timeout'))
        else if (now - lastProgress >= def.stallMs) ac.abort(new AbortError('stalled'))
      }, WATCHDOG_MS)
      const done = () => {
        clearInterval(iv)
        const r = ac.signal.reason
        resolve(r instanceof AbortError ? r : new AbortError('cancelled'))
      }
      if (ac.signal.aborted) done()
      else ac.signal.addEventListener('abort', done, { once: true })
      cleanup.push(() => clearInterval(iv))
    })

    type Outcome = { kind: 'ok'; v: unknown } | { kind: 'err'; e: unknown } | { kind: 'abort'; a: AbortError }
    const runP: Promise<Outcome> = def.run(ctx, p).then(v => ({ kind: 'ok' as const, v }), e => ({ kind: 'err' as const, e }))
    let out: Outcome = await Promise.race([runP, watchdog.then(a => ({ kind: 'abort' as const, a }))])
    for (const c of cleanup) c()
    if (out.kind === 'err' && ac.signal.aborted) out = { kind: 'abort', a: ac.signal.reason instanceof AbortError ? ac.signal.reason : new AbortError('cancelled') }
    if (out.kind === 'err' && out.e instanceof AbortError) out = { kind: 'abort', a: out.e }

    try {
      if (out.kind === 'abort') {
        if (!ac.signal.aborted) ac.abort(out.a)
        if (def.onCancel) await Promise.race([def.onCancel(ctx).catch(() => {}), sleep(CANCEL_GRACE_MS)])
        if (depth === 0) env.halt()
        const why = out.a.why
        if (why === 'timeout') return finish('timeout', { class: 'SKILL_TIMEOUT', reason: `exceeded ${Math.round((deadline - t0) / 1000)}s`, detail: {} })
        if (why === 'stalled') return finish('stalled', { class: 'STALLED', reason: `no progress for ${Math.round(def.stallMs / 1000)}s`, detail: {} })
        return finish('cancelled')
      }
      if (out.kind === 'err') {
        const e = out.e
        if (depth === 0) env.halt()
        if (e instanceof SkillFailure) {
          const key = typeof e.detail.key === 'string' ? e.detail.key : undefined
          return finish('failure', { class: e.cls, reason: e.reason, detail: e.detail, missing: e.missing, key })
        }
        const err = e as Error
        return finish('failure', { class: 'INFRA', reason: `uncaught: ${err?.message ?? String(e)}`, detail: { stack: String(err?.stack ?? '').split('\n').slice(0, 6) } })
      }
      return finish('success', undefined, out.v)
    } finally {
      const i = stack.lastIndexOf(frame)
      if (i >= 0) stack.splice(i, 1)
      if (parent) parent.signal.removeEventListener('abort', onParentAbort)
      if (!parent && this.rootAbort === ac) this.rootAbort = null
    }
  }
}

export function sleep (ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const h = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(h); reject(signal!.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
