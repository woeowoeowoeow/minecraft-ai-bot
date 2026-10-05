// Milestone A survival and progression changes after gate 20260929: requirement /
// objective consistency, day/night scheduling, ranged-threat cover, creeper spacing,
// sealed dig-in planning, emergency food and opportunistic foraging.
import mcData from 'minecraft-data'
import { describe, expect, it } from 'vitest'
import progression from '../../config/progression.json' with { type: 'json' }
import { Cooldowns, forageTarget, selectInterrupt } from '../../src/controller/interrupts.js'
import { nightCapable, schedule, surfaceNight, surfaceWork } from '../../src/controller/schedule.js'
import { mapView } from '../../src/nav/blocks.js'
import type { EntityInfo, WorldState } from '../../src/observer/types.js'
import { A_REQUIREMENTS, candidateObjectives, unmetObjectives } from '../../src/planner/policy.js'
import type { Objective } from '../../src/schema/index.js'
import { chooseFood, hasEmergencyFood } from '../../src/skills/food.js'
import { countOf, GROUPS } from '../../src/skills/sources.js'
import { capBlock, findCoverCells, hiddenAt, planDigIn, shooters } from '../../src/skills/survival/cover.js'
import { assessThreat } from '../../src/skills/survival/threat.js'
import { MC_VERSION } from '../../src/version.js'
import { fakeState } from './helpers.js'

const data = mcData(MC_VERSION)
const mob = (name: string, dist: number, over: Partial<EntityInfo> = {}): EntityInfo => ({ id: Math.round(dist * 100) + name.length, name, kind: 'hostile', pos: [dist, 64, 0], dist, los: true, ...over })
const near = (...entities: EntityInfo[]) => ({ entities, interestBlocks: {}, hazards: [] })
const none = { skill: null, priority: null }
const cd = () => new Cooldowns(() => 0)
const night = (s: Partial<WorldState> = {}) => fakeState({ ...s, vitals: { ...fakeState().vitals, timeOfDay: 18_000, ...(s.vitals ?? {}) } })

/** Simulate an `obtain` success: the inventory holds `count` of the item (for a group, of one member), tools at full durability. */
function obtained (s: WorldState, item: string, count: number, member?: string): WorldState {
  const inv = { ...s.inventory }
  const real = GROUPS[item] ? member! : item
  inv[real] = (inv[real] ?? 0) + Math.max(0, count - countOf(s.inventory, item))
  const tools = [...s.tools]
  const max = data.itemsByName[real]?.maxDurability
  if (max) for (let i = s.inventory[real] ?? 0; i < inv[real]!; i++) tools.push({ name: real, slot: 36 + i, remaining: max, max })
  return { ...s, inventory: inv, tools }
}

const STATES: Record<string, WorldState> = {
  fresh: fakeState(),
  hurt: fakeState({ inventory: { stone_pickaxe: 1 }, vitals: { ...fakeState().vitals, health: 4 } }),
  stone: fakeState({ inventory: { stone_pickaxe: 1, stone_sword: 1 }, tools: [{ name: 'stone_pickaxe', slot: 36, remaining: 20, max: 131 }] }),
  kitted: fakeState({ inventory: { stone_pickaxe: 2, stone_sword: 1, beef: 3, oak_log: 4, stick: 4, crafting_table: 1 }, tools: [{ name: 'stone_pickaxe', slot: 36, remaining: 131, max: 131 }, { name: 'stone_pickaxe', slot: 37, remaining: 131, max: 131 }] }),
  iron: fakeState({ inventory: { stone_pickaxe: 1, stone_sword: 1, beef: 3, oak_planks: 12, stick: 4, iron_ingot: 22, crafting_table: 1 }, tools: [{ name: 'stone_pickaxe', slot: 36, remaining: 300, max: 131 }] }),
  armed: fakeState({ inventory: { iron_pickaxe: 1, iron_sword: 1, shield: 1, iron_helmet: 1, iron_boots: 1, beef: 3, iron_ingot: 7, crafting_table: 1 } }),
}

describe('every objective satisfies its requirement (OBJECTIVE_NOT_SATISFIED never fires by construction)', () => {
  for (const [name, s] of Object.entries(STATES)) {
    it(`state ${name}`, () => {
      for (const o of unmetObjectives(A_REQUIREMENTS, s)) {
        if (o.skill !== 'obtain') continue
        const item = String(o.params.item)
        const count = Number(o.params.count)
        const req = A_REQUIREMENTS.find(r => r.id === o.id)!
        // A group objective (raw_meat) can be satisfied by any member: every member must meet it.
        const members = GROUPS[item] ? Object.keys(data.itemsByName).filter(GROUPS[item]!) : [undefined]
        for (const m of members) expect(req.met(obtained(s, item, count, m)), `${name}: ${o.id} via ${m ?? item}×${count}`).toBe(true)
      }
    })
  }

  it('the early food buffer steps aside once defense is complete (no alternation with the stock)', () => {
    const buf = A_REQUIREMENTS.find(r => r.id === 'food_buffer')!
    expect(buf.met(fakeState({ inventory: { stone_sword: 1 } }))).toBe(false)
    expect(buf.met(fakeState({ inventory: { iron_sword: 1, shield: 1, iron_helmet: 1, iron_boots: 1 } }))).toBe(true)
    const ids = unmetObjectives(A_REQUIREMENTS, fakeState({ inventory: { iron_pickaxe: 1, iron_sword: 1, shield: 1, iron_helmet: 1, iron_boots: 1, bucket: 1, crafting_table: 1 } })).map(o => o.id)
    expect(ids).toContain('food')
    expect(ids).not.toContain('food_buffer')
  })

  it('run-9: two raw chicken meet emergency_food, and are eaten when hurt', () => {
    const s = fakeState({ inventory: { chicken: 2 }, vitals: { ...fakeState().vitals, health: 7 } })
    expect(A_REQUIREMENTS.find(r => r.id === 'emergency_food')!.met(s)).toBe(true)
    expect(hasEmergencyFood({ chicken: 2 })).toBe(true)
    expect(chooseFood({ chicken: 2 }, 18, 7)).toBe('chicken')
    expect(chooseFood({ chicken: 2 }, 5, 20)).toBe('chicken')
    expect(chooseFood({ chicken: 2 }, 15, 20)).toBeNull()
    expect(chooseFood({ chicken: 2, beef: 1 }, 15, 7)).toBe('beef')
  })
})

describe('day/night scheduling', () => {
  const obj = (id: string, item: string, count = 1): Objective => ({ id, milestone: 'A', skill: 'obtain', params: { item, count }, strategy: 'default', budgetMs: 60_000 })
  it('classifies surface work from the resolved plan', () => {
    const s = fakeState({ inventory: { stone_pickaxe: 1, crafting_table: 1, oak_planks: 8 }, nearby: { entities: [], interestBlocks: { coal_ore: [[0, 40, 0]] }, hazards: [] } })
    expect(surfaceWork(obj('w', 'log', 3), s)).toBe(true)
    expect(surfaceWork(obj('f', 'cooked_food', 5), s)).toBe(true)
    expect(surfaceWork(obj('b', 'water_bucket'), fakeState({ inventory: { bucket: 1 } }))).toBe(true)
    expect(surfaceWork(obj('i', 'iron_ingot', 3), s)).toBe(false)
    expect(surfaceWork(obj('p', 'stone_pickaxe', 2), fakeState({ inventory: { stick: 4, stone_pickaxe: 1, crafting_table: 1 } }))).toBe(false)
  })

  it('by day the first objective runs; at night surface work is deferred for underground work, else the bot shelters', () => {
    const cands = [obj('food_buffer', 'raw_meat', 3), obj('kit_pickaxe', 'stone_pickaxe', 2)]
    const inv = { stone_pickaxe: 1, stick: 4, crafting_table: 1 }
    expect(schedule(cands, fakeState({ inventory: inv })).objective?.id).toBe('food_buffer')
    expect(schedule(cands, night({ inventory: inv }))).toMatchObject({ objective: { id: 'kit_pickaxe' }, shelter: false, deferred: ['food_buffer'] })
    expect(schedule([cands[0]!], night({ inventory: inv }))).toMatchObject({ objective: null, shelter: true })
    // With iron sword, shield and armor, short surface work (logs, water) goes ahead at night;
    // hunting still waits for day.
    const strong = night({ inventory: { ...inv, iron_sword: 1, shield: 1 }, armor: 4 })
    expect(nightCapable(strong)).toBe(true)
    expect(schedule(cands, strong).objective?.id).toBe('kit_pickaxe')
    expect(schedule([obj('kit_wood', 'log', 3), ...cands], strong).objective?.id).toBe('kit_wood')
    expect(surfaceNight(fakeState({ dim: 'the_nether', vitals: { ...fakeState().vitals, timeOfDay: 18_000 } }))).toBe(false)
  })

  it('hunting waits for day even when equipped (dev batches 7 and 9: night hunts cost three deaths)', () => {
    const strong = night({ inventory: { iron_sword: 1, shield: 1, iron_pickaxe: 1 }, armor: 4 })
    expect(schedule([obj('food', 'cooked_food', 14)], strong)).toMatchObject({ objective: null, shelter: true })
    expect(schedule([obj('food', 'cooked_food', 14)], night())).toMatchObject({ objective: null, shelter: true })
  })

  it('after a death at night with nothing, the bot digs in rather than walking for wood', () => {
    const s = night()
    expect(schedule(candidateObjectives(A_REQUIREMENTS, s), s)).toMatchObject({ objective: null, shelter: true, deferred: ['wooden_pickaxe'] })
  })
})

describe('ranged threats and creepers', () => {
  it('shooters in sight: cover, not flee, whether weak or hurt', () => {
    expect(assessThreat(fakeState({ nearby: near(mob('skeleton', 12)) })).action).toBe('cover')
    expect(assessThreat(fakeState({ inventory: { stone_sword: 1 }, nearby: near(mob('pillager', 10)) })).action).toBe('cover')
    expect(assessThreat(fakeState({ inventory: { stone_sword: 1 }, vitals: { ...fakeState().vitals, health: 5 }, nearby: near(mob('skeleton', 9)) })).action).toBe('cover')
    expect(assessThreat(fakeState({ inventory: { stone_sword: 1 }, nearby: near(mob('drowned', 10, { held: 'trident' })) })).action).toBe('cover')
    // A shooter in melee range is fought; out of sight it is no threat at range.
    expect(assessThreat(fakeState({ inventory: { stone_sword: 1 }, nearby: near(mob('skeleton', 3)) })).action).toBe('defend')
    expect(assessThreat(fakeState({ inventory: { stone_sword: 1 }, nearby: near(mob('skeleton', 12, { los: false })) })).engage).toBe(false)
    // Never charged across open ground, even fully equipped (dev batch 7: two deaths doing so).
    expect(assessThreat(fakeState({ inventory: { iron_sword: 1, shield: 1 }, armor: 4, nearby: near(mob('skeleton', 10)) })).action).toBe('cover')
    // Hurt, with a shooter in sight even at close range: cover, not flee.
    expect(assessThreat(fakeState({ inventory: { iron_sword: 1 }, vitals: { ...fakeState().vitals, health: 3 }, nearby: near(mob('skeleton', 2.8)) })).action).toBe('cover')
    expect(selectInterrupt(fakeState({ nearby: near(mob('skeleton', 12)) }), cd(), none)).toMatchObject({ id: 'cover', skill: 'cover', priority: 1 })
  })

  it('a creeper in sight within 6 blocks is never fought, even when well armed', () => {
    const armed = { iron_sword: 1, shield: 1 }
    const th = assessThreat(fakeState({ inventory: armed, armor: 4, nearby: near(mob('zombie', 3), mob('creeper', 5)) }))
    expect(th).toMatchObject({ action: 'flee' })
    expect(th.primary?.e.name).toBe('creeper')
    expect(assessThreat(fakeState({ inventory: armed, nearby: near(mob('creeper', 5, { los: false })) })).action).not.toBe('defend')
    // With the flee on cooldown the bot does not fall back to fighting the creeper.
    const c = cd()
    const s = fakeState({ inventory: armed, nearby: near(mob('creeper', 5)) })
    c.set(`flee:${s.nearby.entities[0]!.id}`, 10)
    expect(selectInterrupt(s, c, none)?.id ?? null).not.toBe('defend')
  })

  it('a creeper within 3 blocks counts even out of sight', () => {
    const th = assessThreat(fakeState({ inventory: { iron_sword: 1 }, nearby: near(mob('zombie', 2), mob('creeper', 2.5, { los: false })) }))
    expect(th.primary?.e.name).toBe('creeper')
    expect(th.action).toBe('flee')
  })

  it('inside a sealed dig-in, threats outside do not pull the bot out', () => {
    const s = fakeState({ body: { feet: 'air', head: 'air', velY: 0, fallDist: 0, light: null, covered: false, enclosed: true }, nearby: near(mob('zombie', 2, { los: false }), mob('skeleton', 8)) })
    expect(selectInterrupt(s, cd(), none)?.priority ?? 3).toBeGreaterThan(1)
  })

  it('sealed in with a hostile near: hold the pocket (no objective), not before', () => {
    const body = { feet: 'air' as const, head: 'air' as const, velY: 0, fallDist: 0, light: null, covered: false, enclosed: true }
    expect(selectInterrupt(fakeState({ body, nearby: near(mob('skeleton', 6, { los: false })) }), cd(), none)).toMatchObject({ id: 'hold', priority: 2, skill: 'shelter', params: { whileThreat: true, near: 8 } })
    // A mob in a nearby cave (out of sight, beyond 8) does not pin the bot (dev batch 8: 67 holds in one run).
    expect(selectInterrupt(fakeState({ body, nearby: near(mob('zombie', 12, { los: false })) }), cd(), none)).toBeNull()
    const c = cd()
    c.set('hold', 30)
    expect(selectInterrupt(fakeState({ body, nearby: near(mob('skeleton', 6, { los: false })) }), c, none)).toBeNull()
  })

  it('lists shooters in range, including a trident drowned', () => {
    const s = fakeState({ nearby: near(mob('skeleton', 14), mob('zombie', 3), mob('drowned', 9, { held: 'trident' }), mob('pillager', 30)) })
    expect(shooters(s).map(e => e.name)).toEqual(['skeleton', 'drowned'])
  })
})

describe('cover and dig-in planners (pure)', () => {
  // Flat ground: grass at y 63, dirt below to y 60, stone to y 50, bedrock under.
  const ground = (x: number, y: number) => (y >= 64 ? 'air' : y === 63 ? 'grass_block' : y >= 60 ? 'dirt' : y >= 50 ? 'stone' : 'bedrock')
  const flat = (cells: Record<string, string> = {}, dig: (n: string) => number = n => (n === 'stone' ? 7500 : n === 'bedrock' ? Infinity : 750)) => mapView((x, y) => ground(x, y), cells, dig)

  it('finds the cell behind a wall, out of the shooter\'s sight', () => {
    const wall: Record<string, string> = {}
    for (let z = -3; z <= 3; z++) for (const y of [64, 65, 66]) wall[`2,${y},${z}`] = 'stone'
    const view = flat(wall)
    // The bot stands between the wall (x 2) and the shooter (x 12).
    const shooter: [number, number, number] = [12.5, 64 + 1.62, 0.5]
    expect(hiddenAt(view, [5, 64, 0], [shooter])).toBe(false)
    const cells = findCoverCells(view, [5, 64, 0], [shooter])
    expect(cells.length).toBeGreaterThan(0)
    expect(cells[0]![0]).toBeLessThanOrEqual(1) // behind the wall
    expect(hiddenAt(view, cells[0]!, [shooter])).toBe(true)
    // Open ground: nowhere to hide.
    expect(findCoverCells(flat(), [0, 64, 0], [shooter])).toEqual([])
  })

  it('plans a sealed dig-in in soft ground, never next to water, never through slow blocks', () => {
    expect(planDigIn(flat(), [0, 64, 0])).toMatchObject({ stand: [0, 64, 0] })
    expect(planDigIn(flat(), [0, 64, 0])!.ref).not.toBeNull()
    expect(planDigIn(flat({ '1,62,0': 'water' }), [0, 64, 0])).toBeNull()
    // Sand in the shaft or its walls: a pocket it could not leave (dev batch 14 r03).
    expect(planDigIn(flat({ '0,62,0': 'sand' }), [0, 64, 0])).toBeNull()
    expect(planDigIn(flat({ '1,63,0': 'sand' }), [0, 64, 0])).toBeNull()
    // Hard ground by hand (stone at y 61 in this column only): try a neighbour column.
    const p = planDigIn(flat({ '0,61,0': 'stone' }), [0, 64, 0], 1)
    expect(p).not.toBeNull()
    expect(p!.stand).not.toEqual([0, 64, 0])
    expect(planDigIn(flat({ '0,61,0': 'stone' }), [0, 64, 0], 0)).toBeNull()
    // With a pickaxe stone is quick: dig in where standing.
    expect(planDigIn(flat({ '0,61,0': 'stone' }, n => (n === 'bedrock' ? Infinity : 600)), [0, 64, 0])).toMatchObject({ stand: [0, 64, 0] })
  })

  it('caps only with non-falling blocks', () => {
    expect(capBlock({ sand: 5, gravel: 2 })).toBeNull()
    expect(capBlock({ sand: 5, dirt: 1 })).toBe('dirt')
  })
})

describe('opportunistic forage', () => {
  const cow = (dist: number, over: Partial<EntityInfo> = {}): EntityInfo => ({ id: 7, name: 'cow', kind: 'passive', pos: [dist, 64, 0], dist, los: true, ...over })
  it('takes a short detour for a nearby adult food animal by day on the surface', () => {
    expect(forageTarget(fakeState({ nearby: near(cow(8)) }), { skill: 'collect', priority: 3 }, false)).toMatchObject({ name: 'cow' })
    expect(forageTarget(fakeState({ nearby: near(cow(8, { baby: true })) }), none, false)).toBeNull()
    // Short of the cooked-food stock the detour reaches 24 blocks (B round 3); with the stock held, 12.
    expect(forageTarget(fakeState({ nearby: near(cow(20)) }), none, false)).toMatchObject({ name: 'cow' })
    expect(forageTarget(fakeState({ nearby: near(cow(30)) }), none, false)).toBeNull()
    expect(forageTarget(fakeState({ inventory: { beef: 13 }, nearby: near(cow(20)) }), none, false)).toMatchObject({ name: 'cow' })
    expect(forageTarget(night({ nearby: near(cow(8)) }), none, false)).toBeNull()
    expect(forageTarget(fakeState({ nearby: near(cow(8)) }), { skill: 'hunt', priority: 3 }, false)).toBeNull()
    expect(forageTarget(fakeState({ nearby: near(cow(8)) }), none, true)).toBeNull()
    expect(forageTarget(fakeState({ inventory: { cooked_beef: progression.A.cookedFoodTarget }, nearby: near(cow(8)) }), none, false)).toBeNull()
    const i = selectInterrupt(fakeState({ nearby: near(cow(8)) }), cd(), { skill: 'collect', priority: 3 })
    expect(i).toMatchObject({ id: 'forage', priority: 2, skill: 'hunt', params: { item: 'raw_meat', count: 1, mobs: ['cow'], searchSteps: 0 } })
  })
})
