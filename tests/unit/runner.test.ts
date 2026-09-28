import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SkillResultS } from '../../src/schema/index.js'
import { SkillRunner, sleep } from '../../src/skills/runner.js'
import { SkillFailure, type SkillDef } from '../../src/skills/types.js'
import { fakeEnv, fakeState } from './helpers.js'

function skill (over: Partial<SkillDef<{ n: number }>> = {}): SkillDef<{ n: number }> {
  return {
    id: 'test', level: 'generic', params: z.object({ n: z.number() }),
    preconditions: () => ({ ok: true }), timeoutMs: () => 5000, stallMs: 5000,
    run: async () => 'done',
    ...over,
  }
}

describe('SkillRunner', () => {
  it('runs a skill to success and emits start/end events', async () => {
    const env = fakeEnv()
    const r = await new SkillRunner(env).register(skill()).run('test', { n: 1 })
    expect(r.status).toBe('success')
    expect(r.outputs).toBe('done')
    expect(SkillResultS.safeParse(r).success).toBe(true)
    expect(env.bus.tail().map(e => e.type)).toEqual(['skill_start', 'skill_end'])
    expect(env.state().control.skillStack).toHaveLength(0)
  })

  it('rejects invalid params as PRECONDITION_FAILED without running', async () => {
    let ran = false
    const r = await new SkillRunner(fakeEnv()).register(skill({ run: async () => { ran = true } })).run('test', { n: 'x' })
    expect(r.status).toBe('failure')
    expect(r.failure?.class).toBe('PRECONDITION_FAILED')
    expect(ran).toBe(false)
  })

  it('returns success immediately when the goal is already satisfied', async () => {
    let ran = false
    const r = await new SkillRunner(fakeEnv()).register(skill({ isSatisfied: () => true, run: async () => { ran = true } })).run('test', { n: 1 })
    expect(r.status).toBe('success')
    expect(ran).toBe(false)
  })

  it('reports unmet preconditions as MISSING_RESOURCE with missing items', async () => {
    const r = await new SkillRunner(fakeEnv()).register(skill({
      preconditions: () => ({ ok: false, reason: 'no logs', missing: [{ item: 'oak_log', count: 1 }] }),
    })).run('test', { n: 1 })
    expect(r.failure?.class).toBe('MISSING_RESOURCE')
    expect(r.failure?.missing).toEqual([{ item: 'oak_log', count: 1 }])
    expect(r.failure?.signature).toBe('MISSING_RESOURCE|test|-|overworld|oak_log')
  })

  it('maps SkillFailure to a structured failure with a coordinate-free signature', async () => {
    const env = fakeEnv(fakeState({ control: { skillStack: [], objective: { id: 'collect_logs', milestone: 'M0', skill: 'test', params: {}, strategy: 's', budgetMs: 1 } } }))
    const r = await new SkillRunner(env).register(skill({
      run: async () => { throw new SkillFailure('NOT_FOUND', 'no trees', { key: 'target=log' }) },
    })).run('test', { n: 1 })
    expect(r.status).toBe('failure')
    expect(r.failure).toMatchObject({ class: 'NOT_FOUND', reason: 'no trees', signature: 'NOT_FOUND|test|collect_logs|overworld|target=log' })
    expect(env.halted).toBe(1)
  })

  it('maps unexpected exceptions to INFRA', async () => {
    const r = await new SkillRunner(fakeEnv()).register(skill({ run: async () => { throw new TypeError('boom') } })).run('test', { n: 1 })
    expect(r.failure?.class).toBe('INFRA')
    expect(r.failure?.reason).toContain('boom')
  })

  it('times out a hung skill, runs onCancel, halts the bot', async () => {
    const env = fakeEnv()
    let cancelled = false
    const t0 = Date.now()
    const r = await new SkillRunner(env).register(skill({
      timeoutMs: () => 400,
      run: () => new Promise(() => {}),
      onCancel: async () => { cancelled = true },
    })).run('test', { n: 1 })
    expect(r.status).toBe('timeout')
    expect(r.failure?.class).toBe('SKILL_TIMEOUT')
    expect(cancelled).toBe(true)
    expect(env.halted).toBe(1)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('fails with STALLED when no progress heartbeat arrives within stallMs', async () => {
    const r = await new SkillRunner(fakeEnv()).register(skill({ stallMs: 300, run: ctx => sleep(5000, ctx.signal) })).run('test', { n: 1 })
    expect(r.status).toBe('stalled')
    expect(r.failure?.class).toBe('STALLED')
  })

  it('progress heartbeats keep a long skill alive', async () => {
    const r = await new SkillRunner(fakeEnv()).register(skill({
      stallMs: 300,
      run: async ctx => {
        for (let i = 0; i < 6; i++) { await sleep(100, ctx.signal); ctx.progress('i', i) }
        return 6
      },
    })).run('test', { n: 1 })
    expect(r.status).toBe('success')
  })

  it('cancel() aborts the running skill as cancelled (not a failure)', async () => {
    const runner = new SkillRunner(fakeEnv()).register(skill({ run: ctx => sleep(5000, ctx.signal) }))
    const p = runner.run('test', { n: 1 })
    setTimeout(() => runner.cancel(), 100)
    const r = await p
    expect(r.status).toBe('cancelled')
    expect(r.failure).toBeUndefined()
  })

  it('nested skills share the abort signal and the parent deadline', async () => {
    const env = fakeEnv()
    let childStatus = ''
    const runner = new SkillRunner(env)
      .register(skill({ id: 'child', timeoutMs: () => 60_000, run: ctx => sleep(5000, ctx.signal) }))
      .register(skill({
        id: 'parent', timeoutMs: () => 400,
        run: async ctx => { const c = await ctx.run('child', { n: 1 }); childStatus = c.status; return c },
      }))
    const r = await runner.run('parent', { n: 1 })
    expect(r.status).toBe('timeout')
    // the child was aborted by the parent's deadline, not left running for 60 s
    await sleep(50)
    expect(['timeout', 'cancelled']).toContain(childStatus)
    expect(env.state().control.skillStack).toHaveLength(0)
  })

  it('counts nav calls and failures in metrics', async () => {
    const env = fakeEnv()
    env.nav.goto = async () => ({ ok: false, class: 'NAV_STUCK', ms: 1, detail: {} as never })
    const r = await new SkillRunner(env).register(skill({
      run: async ctx => { await ctx.nav.goto({ kind: 'near', target: [1, 2, 3], range: 1 }); await ctx.nav.goto({ kind: 'near', target: [1, 2, 3] }) },
    })).run('test', { n: 1 })
    expect(r.metrics.navCalls).toBe(2)
    expect(r.metrics.navFailures).toBe(2)
  })

  it('unknown skill is a structured failure', async () => {
    const r = await new SkillRunner(fakeEnv()).run('nope', {})
    expect(r.failure?.class).toBe('PRECONDITION_FAILED')
  })
})
