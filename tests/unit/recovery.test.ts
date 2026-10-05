import { describe, expect, it } from 'vitest'
import progression from '../../config/progression.json' with { type: 'json' }
import { LAVA_POOL_MIN_SOURCES } from '../../src/observer/observer.js'
import { A_FLAGS, lavaPoolKnown, netherReady } from '../../src/planner/milestones.js'
import { A_REQUIREMENTS, ironNeed, nextObjective, unmetObjectives } from '../../src/planner/policy.js'
import { recoverDecision } from '../../src/recovery/death.js'
import { Recovery } from '../../src/recovery/ladder.js'
import type { Failure, Objective } from '../../src/schema/index.js'
import { fakeState } from './helpers.js'
import type { WorldState } from '../../src/observer/types.js'

const obj: Objective = { id: 'iron_ingots', milestone: 'A', skill: 'obtain', params: {}, strategy: 'default', budgetMs: 600_000 }
const fail = (cls: Failure['class'], sig = `${cls}|obtain|iron_ingots|overworld|x`): Failure => ({ class: cls, reason: 'r', detail: {}, signature: sig })

describe('recovery ladder (L2 → L3 → L5)', () => {
  it('nav failures: retry, relocate, alternate strategy, suspend', () => {
    let t = 0
    const r = new Recovery(() => t)
    expect(r.handle(obj, fail('NAV_STUCK')).kind).toBe('retry')
    expect(r.handle(obj, fail('NAV_STUCK')).kind).toBe('relocate')
    expect(r.handle(obj, fail('NAV_STUCK'))).toMatchObject({ kind: 'alternate', strategy: 'wide', level: 'L3' })
    expect(r.strategy('iron_ingots').params).toEqual({ searchSteps: 12 })
    r.handle(obj, fail('NAV_STUCK')); r.handle(obj, fail('NAV_STUCK'))
    expect(r.handle(obj, fail('NAV_STUCK'))).toMatchObject({ kind: 'suspend', level: 'L3' })
    expect(r.isSuspended('iron_ingots')).toBe(true)
    t += 301_000
    expect(r.isSuspended('iron_ingots')).toBe(false)
  })

  it('desync resyncs; an escaped MISSING_RESOURCE retries once; different signatures count separately', () => {
    const r = new Recovery(() => 0)
    expect(r.handle(obj, fail('STATE_INCONSISTENT')).kind).toBe('resync')
    expect(r.handle(obj, fail('MISSING_RESOURCE')).kind).toBe('retry')
    expect(r.handle(obj, fail('SEARCH_EXHAUSTED', 'a')).kind).toBe('retry')
    expect(r.handle(obj, fail('SEARCH_EXHAUSTED', 'b')).kind).toBe('retry')
  })

  it('over budget jumps to L3; success clears counters; too many failures terminate', () => {
    const r = new Recovery(() => 0)
    r.addTime('iron_ingots', 700_000)
    expect(r.handle(obj, fail('SKILL_TIMEOUT')).level).toBe('L3')
    const r2 = new Recovery(() => 0)
    r2.handle(obj, fail('NAV_STUCK')); r2.onSuccess('iron_ingots')
    expect(r2.handle(obj, fail('NAV_STUCK')).kind).toBe('retry')
    const r3 = new Recovery(() => 0)
    let last = r3.handle(obj, fail('NAV_STUCK', 's0'))
    for (let i = 1; i < 14; i++) last = r3.handle(obj, fail('NAV_STUCK', `s${i}`))
    expect(last).toMatchObject({ kind: 'terminate', level: 'L5' })
  })
})

describe('death handling (architecture §7.4)', () => {
  const death = { pos: [10, 64, 10] as [number, number, number], dim: 'overworld', t: 100, lost: { iron_ore: 12, stone_pickaxe: 1 }, cause: 'Bot fell from a high place' }
  it('goes back only for fresh, reachable, intact drops', () => {
    expect(recoverDecision(death, [death], 150, [0, 64, 0], 'overworld').recover).toBe(true)
    expect(recoverDecision(death, [death], 400, [0, 64, 0], 'overworld').reason).toMatch(/despawn/)
    expect(recoverDecision({ ...death, cause: 'Bot tried to swim in lava' }, [], 150, [0, 64, 0], 'overworld').recover).toBe(false)
    expect(recoverDecision(death, [death], 150, [900, 64, 0], 'overworld').recover).toBe(false)
    expect(recoverDecision(death, [{ ...death, t: 20 }, death], 150, [0, 64, 0], 'overworld').reason).toMatch(/died there before/)
    expect(recoverDecision({ ...death, lost: { dirt: 30 } }, [], 150, [0, 64, 0], 'overworld').recover).toBe(false)
  })

  // B gate 20261002: 8 of 9 recovery walks were cancelled by threats; 4 of 5 repeat deaths within 5 min followed one.
  it('after a mob death goes back only for high-value items, by day, to a quiet surface site', () => {
    const mob = { ...death, cause: 'Bot was slain by Zombie' }
    const quiet = { covered: false, hostiles: [{ name: 'zombie', dist: 2 }] }
    // stone tools and ore are rebuilt faster than fetched (r07, r11)
    expect(recoverDecision(mob, [], 150, [0, 64, 0], 'overworld', quiet)).toMatchObject({ recover: false, reason: expect.stringMatching(/low-value/) })
    const gear = { ...mob, lost: { iron_sword: 1, iron_helmet: 1, shield: 1, cobblestone: 20 } }
    expect(recoverDecision(gear, [], 150, [0, 64, 0], 'overworld', quiet).recover).toBe(true)
    expect(recoverDecision(gear, [], 150, [0, 64, 0], 'overworld', quiet, true).reason).toMatch(/night/)
    expect(recoverDecision(gear, [], 150, [0, 64, 0], 'overworld', { ...quiet, covered: true }).reason).toMatch(/under cover/) // r02: cave
    // r06: a spider and two skeletons about
    expect(recoverDecision(gear, [], 150, [0, 64, 0], 'overworld', { covered: false, hostiles: [{ name: 'spider', dist: 1 }, { name: 'skeleton', dist: 7 }] }).reason).toMatch(/shooter/)
    expect(recoverDecision(gear, [], 150, [0, 64, 0], 'overworld', { covered: false, hostiles: [{ name: 'zombie', dist: 1 }, { name: 'zombie', dist: 9 }] }).recover).toBe(false)
    // a terrain death is not a mob death: the site rules do not apply
    expect(recoverDecision({ ...gear, cause: 'Bot fell from a high place' }, [], 150, [0, 64, 0], 'overworld', { ...quiet, covered: true }).recover).toBe(true)
  })
})

const ready = (): Record<string, number> => ({ iron_pickaxe: 1, iron_sword: 1, shield: 1, bucket: 1, iron_helmet: 1, iron_boots: 1, flint_and_steel: 1, cooked_beef: 10, water_bucket: 1 })
const withPool = (inv: Record<string, number>, sources = 12): WorldState => {
  const s = fakeState({ inventory: inv })
  s.memory.locations.push({ kind: 'lava_pool', dim: 'overworld', pos: [5, 11, 5], confidence: 1, source: 'observed', lastSeen: 0, detail: { sources } })
  return s
}

describe('milestone A predicate and policy', () => {
  it('nether_ready needs every item and the obsidian clause', () => {
    expect(netherReady(withPool(ready()))).toBe(true)
    expect(netherReady(fakeState({ inventory: ready() }))).toBe(false) // no lava pool known
    expect(netherReady(fakeState({ inventory: { ...ready(), water_bucket: 0, obsidian: 10 } }))).toBe(true)
    expect(netherReady(withPool({ ...ready(), cooked_beef: 9 }))).toBe(false)
    expect(netherReady(withPool({ ...ready(), iron_boots: 0 }))).toBe(false)
    expect(netherReady(withPool(ready(), 6))).toBe(false)
    expect(lavaPoolKnown(withPool({}, LAVA_POOL_MIN_SOURCES))).toBe(true)
    expect(LAVA_POOL_MIN_SOURCES).toBe(progression.A.lavaPoolMinSources)
  })

  it('funnel flags end with nether_ready', () => {
    expect(Object.keys(A_FLAGS).at(-1)).toBe('nether_ready')
  })

  it('walks the requirement list in order from a fresh spawn', () => {
    const ids = (inv: Record<string, number>) => unmetObjectives(A_REQUIREMENTS, fakeState({ inventory: inv })).map(o => o.id)
    expect(ids({})[0]).toBe('wooden_pickaxe')
    expect(ids({ wooden_pickaxe: 1 })[0]).toBe('stone_pickaxe')
    expect(ids({ stone_pickaxe: 1 })[0]).toBe('stone_sword')
    // A small food buffer (nearby animals only), not the whole cooked stock.
    expect(ids({ stone_pickaxe: 1, stone_sword: 1 })[0]).toBe('food_buffer')
    const o = nextObjective(A_REQUIREMENTS, fakeState({ inventory: { stone_pickaxe: 1, stone_sword: 1, beef: 1 } }))!
    expect(o).toMatchObject({ id: 'food_buffer', skill: 'obtain', params: { item: 'raw_meat', count: 3, searchSteps: progression.A.foodBufferSearchSteps } })
    // Then wood for the post-iron crafting, carried down (shield, table, margin).
    expect(ids({ stone_pickaxe: 1, stone_sword: 1, beef: 3 })[0]).toBe('kit_wood')
    expect(nextObjective(A_REQUIREMENTS, fakeState({ inventory: { stone_pickaxe: 1, stone_sword: 1, beef: 3, oak_log: 1 } }))).toMatchObject({ id: 'kit_wood', params: { item: 'log', count: 1 + Math.ceil((6 + 4 + progression.A.kitWoodMargin - 4) / 4) } })
  })

  it('the cooked-food stock waits for sword, shield and armor (defense before long surface work)', () => {
    const base = { stone_pickaxe: 1, stone_sword: 1, beef: 3, oak_planks: 20, iron_pickaxe: 1, crafting_table: 1 }
    const ids = (inv: Record<string, number>) => unmetObjectives(A_REQUIREMENTS, fakeState({ inventory: inv })).map(o => o.id)
    expect(ids({ ...base, iron_ingot: 30 })).not.toContain('food')
    expect(ids({ ...base, iron_sword: 1, shield: 1, iron_helmet: 1, iron_boots: 1, iron_ingot: 8 })).toContain('food')
  })

  it('badly hurt with nothing edible: a little meat before anything else', () => {
    const hurt = fakeState({ inventory: { stone_pickaxe: 1 }, vitals: { ...fakeState().vitals, health: 4 } })
    expect(nextObjective(A_REQUIREMENTS, hurt)).toMatchObject({ id: 'emergency_food', params: { item: 'raw_meat', count: 2 } })
    expect(nextObjective(A_REQUIREMENTS, fakeState({ inventory: { beef: 1 }, vitals: { ...fakeState().vitals, health: 4 } }))?.id).not.toBe('emergency_food')
  })

  it('iron need covers every iron item and shrinks as items are made', () => {
    expect(ironNeed(fakeState())).toBe(3 + 2 + 1 + 1 + 6 + 9)
    expect(ironNeed(fakeState({ inventory: { iron_pickaxe: 1, bucket: 1 } }))).toBe(2 + 1 + 1 + 3 + 9)
    expect(ironNeed(fakeState({ inventory: { iron_pickaxe: 1, iron_sword: 1, shield: 1, flint_and_steel: 1, bucket: 1, water_bucket: 1, iron_chestplate: 1, iron_leggings: 1 } }))).toBe(0)
  })

  it('iron ingots wait for the mining kit; the kit asks for enough pickaxes to reach the durability', () => {
    const s = fakeState({ inventory: { stone_pickaxe: 1, stone_sword: 1, cooked_beef: 3, stick: 4, oak_log: 4 }, tools: [{ name: 'stone_pickaxe', slot: 36, remaining: 131, max: 131 }] })
    // 131 + 2 × 131 ≥ 250 plus a wear margin (mining the cobblestone wears the old pickaxe).
    expect(nextObjective(A_REQUIREMENTS, s)).toMatchObject({ id: 'kit_pickaxe', params: { item: 'stone_pickaxe', count: 3 } })
    const worn = fakeState({ inventory: { stone_pickaxe: 1, stone_sword: 1, cooked_beef: 3, stick: 4, oak_log: 4 }, tools: [{ name: 'stone_pickaxe', slot: 36, remaining: 10, max: 131 }] })
    expect(nextObjective(A_REQUIREMENTS, worn)).toMatchObject({ id: 'kit_pickaxe', params: { item: 'stone_pickaxe', count: 3 } })
    const kitted = fakeState({ inventory: { stone_pickaxe: 2, stone_sword: 1, cooked_beef: 3, stick: 4, oak_log: 4 }, tools: [{ name: 'stone_pickaxe', slot: 36, remaining: 131, max: 131 }, { name: 'stone_pickaxe', slot: 37, remaining: 131, max: 131 }] })
    expect(nextObjective(A_REQUIREMENTS, kitted)).toMatchObject({ id: 'iron_ingots', params: { item: 'iron_ingot', count: 22 } })
  })

  it('after a death the policy restarts from what is actually held (no objective whose inputs were lost)', () => {
    // Lost everything: back to the start, never "craft iron pickaxe".
    expect(nextObjective(A_REQUIREMENTS, fakeState({ inventory: {} }))!.id).toBe('wooden_pickaxe')
    // Kept the ingots but lost the pickaxe: crafting it is offered once the tier chain is back.
    const ids = unmetObjectives(A_REQUIREMENTS, fakeState({ inventory: { iron_ingot: 22, stone_pickaxe: 1, stone_sword: 1, cooked_beef: 12, stick: 4, oak_log: 4 }, tools: [{ name: 'stone_pickaxe', slot: 36, remaining: 300, max: 131 }] })).map(o => o.id)
    expect(ids.slice(0, 2)).toEqual(['iron_pickaxe', 'iron_sword'])
  })

  it('suspended objectives are skipped', () => {
    expect(nextObjective(A_REQUIREMENTS, fakeState(), id => id === 'wooden_pickaxe')).toBeNull()
    expect(nextObjective(A_REQUIREMENTS, fakeState({ inventory: { stone_pickaxe: 1 } }), id => id === 'stone_sword')?.id).toBe('kit_wood')
  })
})

describe('persistent objectives (dev batch 8 r04)', () => {
  it('a food search failing 14 times suspends or relocates, never terminates the run', async () => {
    const { Recovery } = await import('../../src/recovery/ladder.js')
    const r = new Recovery(() => 0)
    const o = { id: 'food_buffer', milestone: 'A', skill: 'obtain', params: {}, strategy: 'default', budgetMs: 1e9 }
    const f = { class: 'SEARCH_EXHAUSTED' as const, reason: 'none', detail: {}, signature: 'S' }
    const kinds = Array.from({ length: 20 }, () => r.handle(o, f, { persistent: true }).kind)
    expect(kinds).not.toContain('terminate')
    const r2 = new Recovery(() => 0)
    const stuck = { ...f, class: 'NAV_STUCK' as const }
    expect(Array.from({ length: 14 }, () => r2.handle(o, stuck).kind)).toContain('terminate')
    expect(Array.from({ length: 1 }, () => new Recovery(() => 0).handle(o, stuck, { persistent: true }).kind)).not.toContain('terminate')
  })
})

describe('bounded objectives (dev batch 9 r03, r08)', () => {
  it('a bounded search that finds nothing is suspended at once, without retry or relocation', async () => {
    const { Recovery } = await import('../../src/recovery/ladder.js')
    const r = new Recovery(() => 0)
    const o = { id: 'food_buffer', milestone: 'A', skill: 'obtain', params: {}, strategy: 'default', budgetMs: 1e9 }
    expect(r.handle(o, { class: 'SEARCH_EXHAUSTED', reason: 'none', detail: {}, signature: 'S' }, { bounded: true, persistent: true })).toMatchObject({ kind: 'suspend', level: 'L3' })
    expect(r.isSuspended('food_buffer')).toBe(true)
    // Other failure classes of a bounded objective still go through the ladder.
    const r2 = new Recovery(() => 0)
    expect(r2.handle(o, { class: 'NAV_STUCK', reason: 'x', detail: {}, signature: 'N' }, { bounded: true }).kind).toBe('retry')
  })
})

describe('search failures never terminate (dev batch 11 r07)', () => {
  it('14 fruitless searches relocate or suspend; 14 other failures still terminate', async () => {
    const { Recovery } = await import('../../src/recovery/ladder.js')
    const o = { id: 'wooden_pickaxe', milestone: 'A', skill: 'obtain', params: {}, strategy: 'default', budgetMs: 1e9 }
    const r = new Recovery(() => 0)
    expect(Array.from({ length: 20 }, () => r.handle(o, { class: 'SEARCH_EXHAUSTED', reason: 'x', detail: {}, signature: 'S' }).kind)).not.toContain('terminate')
    const r2 = new Recovery(() => 0)
    expect(Array.from({ length: 14 }, () => r2.handle(o, { class: 'NAV_STUCK', reason: 'x', detail: {}, signature: 'N' }).kind)).toContain('terminate')
  })
})

