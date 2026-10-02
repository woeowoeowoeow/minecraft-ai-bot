import mcData from 'minecraft-data'
import { describe, expect, it } from 'vitest'
import { MC_VERSION } from '../../src/version.js'
import progression from '../../config/progression.json' with { type: 'json' }
import { M0_REQUIREMENTS, MILESTONES, planksFor, unmetObjectives } from '../../src/planner/policy.js'
import { NoModelReasoner, ScriptedReasoner, validateDecision } from '../../src/planner/reasoner.js'
import type { DecisionRequest } from '../../src/schema/index.js'
import { buildDigest } from '../../src/observer/digest.js'
import { fakeState } from './helpers.js'

function req (ids: string[], kind: DecisionRequest['kind'] = 'select_objective'): DecisionRequest {
  return { id: 'r', kind, trigger: 't', digest: buildDigest(fakeState(), []), attempts: [], options: ids.map(id => ({ id, label: id, detail: '', priorFailures: 0 })) }
}

describe('M0 policy', () => {
  it('walks logs → planks → table, goal-shaped, offering only objectives whose prerequisites are met', () => {
    expect(unmetObjectives(M0_REQUIREMENTS, fakeState()).map(o => o.id)).toEqual(['collect_logs'])
    expect(unmetObjectives(M0_REQUIREMENTS, fakeState({ inventory: { birch_log: 4 } })).map(o => o.id)).toEqual(['craft_planks'])
    // after a death that lost the logs, crafting is not offered again until logs are back
    expect(unmetObjectives(M0_REQUIREMENTS, fakeState({ inventory: { birch_log: 1 } })).map(o => o.id)).toEqual(['collect_logs'])
    expect(unmetObjectives(M0_REQUIREMENTS, fakeState({ inventory: { birch_planks: 4 } })).map(o => o.id)).toEqual(['craft_crafting_table'])
    expect(unmetObjectives(M0_REQUIREMENTS, fakeState({ inventory: { crafting_table: 1 } }))).toEqual([])
  })

  it('crafts planks matching the logs actually held', () => {
    expect(planksFor(fakeState({ inventory: { spruce_log: 3, oak_log: 1 } }))).toBe('spruce_planks')
    expect(planksFor(fakeState({ inventory: { stripped_acacia_log: 2 } }))).toBe('acacia_planks')
    const o = unmetObjectives(M0_REQUIREMENTS, fakeState({ inventory: { dark_oak_log: 4 } }))[0]!
    expect(o.params).toEqual({ item: 'dark_oak_planks', count: 4 })
  })

  it('progression config targets the pinned version', () => {
    expect(progression.mcVersion).toBe(MC_VERSION)
  })

  it('every 1.16.1 log maps to a craftable 1.16.1 planks item', () => {
    const d = mcData(MC_VERSION)
    const logs = d.blocksArray.map(b => b.name).filter(n => n.endsWith('_log'))
    expect(logs.length).toBeGreaterThanOrEqual(12) // 6 woods × (log, stripped log)
    for (const log of logs) {
      const planks = planksFor(fakeState({ inventory: { [log]: 1 } }))
      const item = d.itemsByName[planks]
      expect(item, `${log} → ${planks}`).toBeDefined()
      expect(d.recipes[item!.id]?.length, `recipe for ${planks}`).toBeGreaterThan(0)
    }
  })

  it('M0 predicate is crafting_table in inventory', () => {
    expect(MILESTONES.M0!(fakeState())).toBe(false)
    expect(MILESTONES.M0!(fakeState({ inventory: { crafting_table: 1 } }))).toBe(true)
  })
})

describe('reasoners', () => {
  it('NoModelReasoner picks the first option', async () => {
    expect((await new NoModelReasoner().decide(req(['a', 'b']))).choice).toBe('a')
    expect((await new NoModelReasoner().decide(req([]))).choice).toBeNull()
  })

  it('ScriptedReasoner replays choices in order, only consuming available ones', async () => {
    const r = new ScriptedReasoner({ select_objective: ['b', 'c'] })
    expect((await r.decide(req(['a', 'b']))).choice).toBe('b')
    expect((await r.decide(req(['a', 'b']))).choice).toBe('a') // 'c' unavailable → default, cursor stays
    expect((await r.decide(req(['c']))).choice).toBe('c')
    expect((await r.decide(req(['x', 'y']))).choice).toBe('x') // exhausted → default
    expect((await r.decide(req(['p', 'q'], 'choose_recovery'))).choice).toBe('p')
  })

  it('validation rejects out-of-menu and malformed answers with a deterministic fallback', () => {
    expect(validateDecision(req(['a', 'b']), { choice: 'b', confidence: 1, rationale: '' })).toMatchObject({ choice: 'b', accepted: true })
    expect(validateDecision(req(['a', 'b']), { choice: 'z', confidence: 1, rationale: '' })).toMatchObject({ choice: 'a', accepted: false })
    expect(validateDecision(req(['a', 'b']), { nonsense: true })).toMatchObject({ choice: 'a', accepted: false })
  })
})
