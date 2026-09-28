import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Controller } from '../../src/controller/controller.js'
import { buildDigest } from '../../src/observer/digest.js'
import { M0_REQUIREMENTS, MILESTONES } from '../../src/planner/policy.js'
import { NoModelReasoner, ScriptedReasoner, type Reasoner } from '../../src/planner/reasoner.js'
import { EventRecordS } from '../../src/schema/index.js'
import { SkillRunner } from '../../src/skills/runner.js'
import { SkillFailure, type SkillDef } from '../../src/skills/types.js'
import { Telemetry } from '../../src/telemetry/telemetry.js'
import { fakeEnv, fakeState } from './helpers.js'

function setup (collectBehaviour: (inv: Record<string, number>) => void, reasoner: Reasoner = new NoModelReasoner()) {
  const state = fakeState()
  const env = fakeEnv(state)
  const dir = mkdtempSync(join(tmpdir(), 'mcbot-'))
  const telemetry = new Telemetry(dir, env.bus, {
    state: () => state, digest: () => buildDigest(state, env.bus.tail()), navRecent: () => [{ ok: false }], voxels: () => ({ layers: [] }),
  })
  telemetry.start()
  const P = z.object({ block: z.string().optional(), item: z.string().optional(), count: z.number() })
  const collect: SkillDef<z.infer<typeof P>> = {
    id: 'collect', level: 'generic', params: P, preconditions: () => ({ ok: true }), timeoutMs: () => 2000, stallMs: 2000,
    run: async () => collectBehaviour(state.inventory),
  }
  const craft: SkillDef<z.infer<typeof P>> = {
    id: 'craft', level: 'generic', params: P, preconditions: () => ({ ok: true }), timeoutMs: () => 2000, stallMs: 2000,
    run: async (_c, p) => {
      if (p.item === 'crafting_table') { state.inventory.oak_planks! -= 4; state.inventory.crafting_table = 1 } else { state.inventory.oak_log! -= 1; state.inventory.oak_planks = 4 }
    },
  }
  const runner = new SkillRunner(env).register(collect).register(craft)
  const controller = new Controller({
    runner, reasoner, bus: env.bus, telemetry, state: () => state, digest: () => buildDigest(state, env.bus.tail()),
    setObjective: o => { state.control.objective = o }, requirements: M0_REQUIREMENTS, milestones: MILESTONES, target: 'M0', deadline: Date.now() + 10_000,
  })
  return { state, env, dir, telemetry, controller }
}

describe('Controller (scripted M0 flow)', () => {
  it('reaches M0 with the scripted reasoner and writes telemetry', async () => {
    const { dir, controller, telemetry, state } = setup(inv => { inv.oak_log = 4 }, new ScriptedReasoner({ select_objective: ['collect_logs', 'craft_planks', 'craft_crafting_table'] }))
    const r = await controller.run()
    telemetry.stop()
    expect(r.outcome).toBe('goal_reached')
    expect(state.milestones.M0).not.toBeNull()
    expect(controller.reasonerFallbacks).toBe(0)
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(events.every(e => EventRecordS.safeParse(e).success)).toBe(true)
    expect(events.filter(e => e.type === 'objective').map(e => e.data.id)).toEqual(['collect_logs', 'craft_planks', 'craft_crafting_table'])
    expect(events.some(e => e.type === 'milestone' && e.data.id === 'M0')).toBe(true)
    expect(existsSync(join(dir, 'snapshots', 'M0.json'))).toBe(true)
    expect(readFileSync(join(dir, 'state.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(3)
    expect(telemetry.stats.skills.craft).toMatchObject({ runs: 2, ok: 2 })
  })

  it('retries a failing objective, bundles each failure, then terminates as unrecoverable', async () => {
    const { dir, controller, telemetry } = setup(() => { throw new SkillFailure('NOT_FOUND', 'no trees', { key: 'target=log' }) })
    const r = await controller.run()
    telemetry.stop()
    expect(r.outcome).toBe('unrecoverable')
    expect(r.terminalFailure?.class).toBe('NOT_FOUND')
    expect(r.terminalFailure?.signature).toBe('NOT_FOUND|collect|collect_logs|overworld|target=log')
    expect(telemetry.failures).toHaveLength(3)
    const bundles = readdirSync(join(dir, 'failures'))
    expect(bundles).toHaveLength(3)
    const b = join(dir, 'failures', bundles[0]!)
    for (const f of ['failure.json', 'state.json', 'digest.json', 'events_tail.jsonl', 'trace_tail.jsonl', 'skill_stack.json', 'nav.json', 'voxels.json']) {
      expect(existsSync(join(b, f)), f).toBe(true)
    }
  })

  it('a timed-out skill is a failure with class SKILL_TIMEOUT', async () => {
    const { controller, telemetry } = setup(() => new Promise(() => {}) as never)
    const r = await controller.run()
    telemetry.stop()
    expect(r.terminalFailure?.class).toBe('SKILL_TIMEOUT')
  }, 15_000)
})
