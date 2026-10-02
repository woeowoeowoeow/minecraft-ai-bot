// Regression for gate 20260929 r09: an objective whose success did not satisfy its
// requirement was re-issued 2 million times in microtasks, freezing the bot. The
// controller must re-check the requirement after every success, classify the gap as
// OBJECTIVE_NOT_SATISFIED, route it through Recovery, and never spin without yielding.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ProgressionController } from '../../src/controller/progression.js'
import { buildDigest } from '../../src/observer/digest.js'
import type { RequirementDef } from '../../src/planner/policy.js'
import { SkillRunner } from '../../src/skills/runner.js'
import type { SkillDef } from '../../src/skills/types.js'
import { Telemetry } from '../../src/telemetry/telemetry.js'
import { fakeEnv, fakeState } from './helpers.js'

function setup (reqs: RequirementDef[], skill: SkillDef<{ item: string }>, ms: number) {
  const state = fakeState()
  const env = fakeEnv(state)
  const dir = mkdtempSync(join(tmpdir(), 'mcbot-inv-'))
  const telemetry = new Telemetry(dir, env.bus, {
    state: () => state, digest: () => buildDigest(state, env.bus.tail()), navRecent: () => [], voxels: () => ({ layers: [] }),
  })
  telemetry.start()
  const hold: SkillDef<{ ms: number }> = {
    id: 'holdSafe', level: 'survival', params: z.object({ ms: z.number() }), preconditions: () => ({ ok: true }), timeoutMs: (_s, p) => p.ms + 1000, stallMs: 60_000,
    run: (_c, p) => new Promise(r => setTimeout(r, p.ms)),
  }
  const relocate: SkillDef<Record<string, never>> = {
    id: 'relocate', level: 'generic', params: z.object({}).passthrough() as never, preconditions: () => ({ ok: true }), timeoutMs: () => 1000, stallMs: 1000, run: async () => ({}),
  }
  const runner = new SkillRunner(env).register(skill).register(hold).register(relocate)
  const c = new ProgressionController({
    runner, bus: env.bus, telemetry, state: () => state, setObjective: o => { state.control.objective = o },
    requirements: reqs, milestones: { X: () => false }, flags: {}, target: 'X', deadline: Date.now() + ms,
    waitForRespawn: async () => {}, resync: async () => {}, afterDeath: () => {},
  })
  return { state, env, dir, telemetry, c }
}

const P = z.object({ item: z.string() })

describe('objective success invariant (OBJECTIVE_NOT_SATISFIED)', () => {
  it('an instant success that leaves the requirement unmet is a failure, is suspended, and never spins', async () => {
    let runs = 0
    const fetch: SkillDef<{ item: string }> = {
      id: 'fetch', level: 'generic', params: P, preconditions: () => ({ ok: true }), timeoutMs: () => 1000, stallMs: 1000,
      // Mirrors r09: the skill's own goal is already met, so it succeeds at once.
      isSatisfied: () => { runs++; return true },
      run: async () => ({}),
    }
    const reqs: RequirementDef[] = [
      { id: 'edible', milestone: 'A', desc: 'safe food held', met: s => (s.inventory.beef ?? 0) > 0, objective: () => ({ skill: 'fetch', params: { item: 'chicken' }, strategy: 'default', budgetMs: 60_000 }) },
    ]
    const { c, env, telemetry, dir } = setup(reqs, fetch, 3000)
    let ticks = 0
    const iv = setInterval(() => { ticks++ }, 100)
    const r = await c.run()
    clearInterval(iv)
    telemetry.stop()
    expect(r.outcome).toBe('timeout')
    // The event loop kept running (timers fired) and the objective was not re-issued in a tight loop.
    expect(ticks).toBeGreaterThanOrEqual(20)
    expect(runs).toBeLessThanOrEqual(12)
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const fail = events.find(e => e.type === 'failure' && e.data.class === 'OBJECTIVE_NOT_SATISFIED')
    expect(fail?.data).toMatchObject({ objective: 'edible', expected: 'safe food held', prior: { status: 'success' } })
    expect(fail?.data.digest).toBeTruthy()
    expect(telemetry.failures[0]).toMatchObject({ class: 'OBJECTIVE_NOT_SATISFIED', signature: 'OBJECTIVE_NOT_SATISFIED|fetch|edible|overworld|req=edible' })
    const steps = events.filter(e => e.type === 'recovery_step' && e.data.signature?.startsWith('OBJECTIVE_NOT_SATISFIED')).map(e => e.data.action)
    expect(steps.slice(0, 2)).toEqual(['retry', 'suspend'])
    // Identical repeats share one bundle (rate-limited), and still appear in failures.jsonl.
    expect(telemetry.failures.length).toBeGreaterThanOrEqual(3)
    expect(telemetry.failures[0]!.bundle).not.toBeNull()
    expect(telemetry.failures.slice(1).every(f => f.bundle === null)).toBe(true)
    expect(env.bus.tail().length).toBeLessThan(400)
  }, 10_000)

  it('a success that meets the requirement is accepted', async () => {
    const fetch: SkillDef<{ item: string }> = {
      id: 'fetch', level: 'generic', params: P, preconditions: () => ({ ok: true }), timeoutMs: () => 1000, stallMs: 1000, run: async () => ({}),
    }
    const reqs: RequirementDef[] = [
      { id: 'edible', milestone: 'A', met: s => (s.inventory.beef ?? 0) > 0, objective: () => ({ skill: 'fetch', params: { item: 'beef' }, strategy: 'default', budgetMs: 60_000 }) },
    ]
    const { c, telemetry, state: ws } = setup(reqs, { ...fetch, run: async () => { ws.inventory.beef = 1; return {} } }, 1500)
    await c.run()
    telemetry.stop()
    expect(telemetry.failures.filter(f => f.class === 'OBJECTIVE_NOT_SATISFIED')).toHaveLength(0)
  }, 10_000)
})
