// B round 3 (after re-gate 20261003): A-phase resource search on poor terrain.
// Pure parts: heading survey and choice, searched regions, tree and animal spots,
// cook-before-eating-raw, night fillers, flint from mined gravel.
import { describe, expect, it } from 'vitest'
import { cookPlan, selectInterrupt, Cooldowns } from '../../src/controller/interrupts.js'
import { schedule } from '../../src/controller/schedule.js'
import { clusterPoints } from '../../src/observer/observer.js'
import type { WorldState } from '../../src/observer/types.js'
import { A_REQUIREMENTS, B_REQUIREMENTS, candidateObjectives, fillerObjectives } from '../../src/planner/policy.js'
import { cookableRaw } from '../../src/skills/food.js'
import { treeSpot, TREE_SPOT } from '../../src/skills/generic/collect.js'
import { animalSpot, ANIMAL_SPOT } from '../../src/skills/generic/hunt.js'
import { activeRegions, chooseHeading, headingDeg, markSearched, SEARCH, surveyHeadings, type SurfaceClass } from '../../src/skills/generic/search.js'
import { planObtain } from '../../src/skills/sources.js'
import type { V3 } from '../../src/schema/index.js'
import { fakeState } from './helpers.js'

const none = () => false
/** Heading (deg, 0 = north/−z, clockwise) to a unit direction (x, z). */
const dirDeg = (deg: number) => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)] as const

describe('surface search: heading survey', () => {
  it('an ocean start heads for the visible coast, not straight out to sea', () => {
    // Water everywhere except land east of x = 100 (inside the loaded radius).
    const probe = (x: number): SurfaceClass => (x > 100 ? 'green' : 'water')
    for (const kind of ['log', 'animals', 'relocate']) {
      const { stat } = chooseHeading(surveyHeadings(probe, [0, 62, 0], kind, none, []), null)
      expect(headingDeg(stat.heading)).toBeGreaterThanOrEqual(45)
      expect(headingDeg(stat.heading)).toBeLessThanOrEqual(135)
    }
  })

  it('wood search prefers trees, then grass, over bare land', () => {
    const probe = (x: number, z: number): SurfaceClass => (z < -60 ? 'tree' : x > 60 ? 'green' : 'land')
    const { stat } = chooseHeading(surveyHeadings(probe, [0, 64, 0], 'log', none, []), null)
    const [, dz] = dirDeg(headingDeg(stat.heading))
    expect(dz).toBeLessThan(-0.7) // north, toward the trees
  })

  it('unexplored chunks win over ground already walked, other things equal', () => {
    // Everything explored west of x = 64.
    const explored = (cx: number) => cx < 4
    const { stat } = chooseHeading(surveyHeadings(() => 'land', [0, 64, 0], 'log', explored, []), null)
    expect(dirDeg(headingDeg(stat.heading))[0]).toBeGreaterThan(0.3)
  })

  it('never steps back into a region searched for the same resource (r15: the respawn re-searched the corridor)', () => {
    const mem = { searched: [] as NonNullable<WorldState['memory']['searched']> }
    // First life: searched eastward from spawn in three steps.
    for (const x of [0, 96, 192]) markSearched(mem, 'log', 'overworld', [x, 62, 0], 100)
    const regions = activeRegions(mem.searched, 'log', 'overworld', 200)
    // Respawn at spawn: land all round, nothing explored beyond the loaded radius.
    const { stat } = chooseHeading(surveyHeadings(() => 'land', [0, 62, 0], 'log', none, regions), null)
    expect(dirDeg(headingDeg(stat.heading))[0]).toBeLessThan(0.1) // not east again
    expect(stat.exhausted).toBeLessThanOrEqual(0.5) // the way out of the spawn region
    // Another resource's searches do not count.
    expect(activeRegions(mem.searched, 'animals', 'overworld', 200)).toHaveLength(0)
  })

  it('a run of relocations covers new ground instead of circling', () => {
    const mem = { searched: [] as NonNullable<WorldState['memory']['searched']> }
    const seen = new Set<string>()
    let pos: V3 = [0, 64, 0]
    let prev: number | null = null
    for (let i = 0; i < 10; i++) {
      markSearched(mem, 'animals', 'overworld', pos, i)
      for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) seen.add(`${(Math.floor(pos[0]) >> 4) + dx},${(Math.floor(pos[2]) >> 4) + dz}`)
      const { stat } = chooseHeading(surveyHeadings(() => 'green', pos, 'animals', (cx, cz) => seen.has(`${cx},${cz}`), activeRegions(mem.searched, 'animals', 'overworld', i)), prev)
      prev = stat.heading
      pos = [pos[0] + Math.sin(stat.heading) * SEARCH.step, 64, pos[2] - Math.cos(stat.heading) * SEARCH.step]
    }
    expect(Math.hypot(pos[0], pos[2])).toBeGreaterThan(5 * SEARCH.step)
  })

  it('a heading that just failed is avoided', () => {
    const stats = surveyHeadings(() => 'land', [0, 64, 0], 'relocate', none, [])
    const first = chooseHeading(stats, null)
    const second = chooseHeading(stats, null, [first.stat.heading])
    expect(Math.cos(second.stat.heading - first.stat.heading)).toBeLessThan(Math.cos(Math.PI / 6))
  })

  it('searched regions refresh instead of piling up, and expire', () => {
    const mem = { searched: [] as NonNullable<WorldState['memory']['searched']> }
    markSearched(mem, 'animals', 'overworld', [0, 64, 0], 0)
    markSearched(mem, 'animals', 'overworld', [10, 64, 0], 50)
    expect(mem.searched).toHaveLength(1)
    expect(activeRegions(mem.searched, 'animals', 'overworld', 50 + SEARCH.regionTtlS.animals! - 1)).toHaveLength(1)
    expect(activeRegions(mem.searched, 'animals', 'overworld', 50 + SEARCH.regionTtlS.animals! + 1)).toHaveLength(0)
  })
})

describe('remembered tree and animal spots', () => {
  it('clusters logs into one spot per 24 blocks', () => {
    const c = clusterPoints([[0, 64, 0], [3, 65, 2], [40, 70, 0], [42, 64, 1], [0, 66, 30]], 24)
    expect(c).toEqual([{ pos: [0, 64, 0], n: 2 }, { pos: [40, 70, 0], n: 2 }, { pos: [0, 66, 30], n: 1 }])
  })

  it('goes back to the nearest remembered trees outside the scan radius, across a respawn', () => {
    const loc = (pos: V3) => ({ kind: 'trees' as const, dim: 'overworld' as const, pos, confidence: 1, source: 'observed' as const, lastSeen: 10 })
    const s = fakeState({ pos: [0, 63, 0], t: 4000 })
    s.memory.locations.push(loc([900, 64, 400]), loc([-300, 70, 0]), loc([10, 64, 5]))
    expect(treeSpot(s, none)).toEqual([-300, 70, 0]) // the one at 11 blocks is inside the log scan
    expect(treeSpot(s, k => k === 'trees:-300,0')).toEqual([900, 64, 400])
    s.memory.locations.push(loc([TREE_SPOT.maxDist + 50, 64, 0]))
    expect(treeSpot(s, k => k !== `trees:${TREE_SPOT.maxDist + 50},0`)).toBeNull()
  })

  it('animal sightings stay useful for 20 min and up to 256 blocks', () => {
    const spot = (pos: V3, lastSeen: number) => ({ kind: 'animals' as const, dim: 'overworld' as const, pos, confidence: 1, source: 'observed' as const, lastSeen })
    const s = fakeState({ t: 1000 })
    s.memory.locations.push(spot([200, 64, 0], 1000 - ANIMAL_SPOT.maxAgeS + 10))
    expect(animalSpot(s, none)).toEqual([200, 64, 0])
    s.memory.locations[0]!.lastSeen = 1000 - ANIMAL_SPOT.maxAgeS - 10
    expect(animalSpot(s, none)).toBeNull()
  })
})

describe('cook before eating raw', () => {
  const hungry = (inventory: Record<string, number>, over: Partial<WorldState['vitals']> = {}) =>
    fakeState({ inventory, vitals: { ...fakeState().vitals, food: 12, ...over } })

  it('cooks up to four carried raw items when hungry with nothing else to eat', () => {
    const s = hungry({ porkchop: 6, furnace: 1, oak_planks: 8 })
    expect(cookableRaw(s.inventory)).toBe(6)
    expect(cookPlan(s)).toEqual({ count: 4, raw: 6 })
    const i = selectInterrupt(s, new Cooldowns(() => 0), { skill: 'hunt', priority: 3 })
    expect(i).toMatchObject({ id: 'cook', priority: 2, skill: 'obtain', params: { item: 'cooked_food', count: 4 } })
  })

  it('a furnace can be crafted from carried cobblestone', () => {
    expect(cookPlan(hungry({ beef: 2, cobblestone: 8, coal: 1, crafting_table: 1 }))).toEqual({ count: 2, raw: 2 })
  })

  it('not when cooked food is held, in an emergency, without a furnace route, or in the Nether', () => {
    expect(cookPlan(hungry({ porkchop: 6, cooked_beef: 1, furnace: 1, oak_planks: 8 }))).toBeNull()
    expect(cookPlan(hungry({ porkchop: 6, furnace: 1, oak_planks: 8 }, { food: 5 }))).toBeNull()
    expect(cookPlan(hungry({ porkchop: 6, furnace: 1, oak_planks: 8 }, { health: 7 }))).toBeNull()
    expect(cookPlan(hungry({ porkchop: 6, oak_planks: 8 }))).toBeNull() // furnace needs stone gathered
    expect(cookPlan(hungry({ porkchop: 6, furnace: 1 }))).toBeNull() // no fuel
    expect(cookPlan(fakeState({ inventory: { porkchop: 6, furnace: 1, oak_planks: 8 } }))).toBeNull() // not hungry
    expect(cookPlan({ ...hungry({ porkchop: 6, furnace: 1, oak_planks: 8 }), dim: 'the_nether' })).toBeNull()
  })

  it('takes precedence over eating the raw meat', () => {
    const s = hungry({ porkchop: 3, furnace: 1, oak_planks: 4 }, { food: 9 })
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: null, priority: null })?.id).toBe('cook')
    const cd = new Cooldowns(() => 0)
    cd.set('cook', 30)
    expect(selectInterrupt(s, cd, { skill: null, priority: null })?.id).toBe('eat')
  })
})

describe('night fillers', () => {
  const night = (over: Partial<WorldState> = {}) => fakeState({ vitals: { ...fakeState().vitals, timeOfDay: 14_000 }, ...over })
  const geared = { iron_pickaxe: 1, iron_sword: 1, shield: 1, iron_helmet: 1, iron_boots: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1, crafting_table: 1, furnace: 1, oak_planks: 20, stone_pickaxe: 3, stick: 6 }
  const lava = { kind: 'lava_pool' as const, dim: 'overworld' as const, pos: [0, 12, 0] as V3, confidence: 1, source: 'observed' as const, lastSeen: 0, detail: { sources: 20 } }
  const geardState = (over: Partial<WorldState>) => { const s = night({ inventory: { ...geared }, armor: 4, equipment: { ...fakeState().equipment, offHand: 'shield' }, ...over }); s.memory.locations.push(lava); return s }

  it('are never ordinary candidates', () => {
    const s = geardState({ inventory: { ...geared, beef: 3 } })
    expect(candidateObjectives(B_REQUIREMENTS, s).map(o => o.id)).not.toContain('pre_gold_armor')
    expect(candidateObjectives(A_REQUIREMENTS, s).map(o => o.id)).not.toContain('cook_raw')
    expect(fillerObjectives(A_REQUIREMENTS, s).map(o => o.id)).toEqual(['cook_raw'])
  })

  it('at night with only the food hunt left, cook the carried meat, then mine the golden helmet, before sheltering', () => {
    let s = geardState({ inventory: { ...geared, beef: 3 } })
    let sch = schedule(candidateObjectives(B_REQUIREMENTS, s), s, fillerObjectives(B_REQUIREMENTS, s))
    expect(sch).toMatchObject({ shelter: false, filler: true, objective: { id: 'cook_raw', params: { item: 'cooked_food', count: 3 } }, deferred: ['food'] })
    s = geardState({ inventory: { ...geared, cooked_beef: 3 } })
    sch = schedule(candidateObjectives(B_REQUIREMENTS, s), s, fillerObjectives(B_REQUIREMENTS, s))
    expect(sch).toMatchObject({ shelter: false, filler: true, objective: { id: 'pre_gold_armor', skill: 'obtain', params: { item: 'golden_helmet' } } })
    s = geardState({ inventory: { ...geared, cooked_beef: 3, golden_helmet: 1 } })
    sch = schedule(candidateObjectives(B_REQUIREMENTS, s), s, fillerObjectives(B_REQUIREMENTS, s))
    expect(sch).toMatchObject({ shelter: true, objective: null })
  })

  it('never run by day, and the golden helmet filler only before nether_ready', () => {
    const day = geardState({ vitals: { ...fakeState().vitals, timeOfDay: 1000 }, inventory: { ...geared, beef: 3 } })
    expect(schedule(candidateObjectives(B_REQUIREMENTS, day), day, fillerObjectives(B_REQUIREMENTS, day))).toMatchObject({ objective: { id: 'food' }, shelter: false })
    const ready = geardState({ inventory: { ...geared, cooked_beef: 12 }, milestones: { A: 900 } })
    expect(fillerObjectives(B_REQUIREMENTS, ready).map(o => o.id)).not.toContain('pre_gold_armor')
  })

  it('cook_raw success satisfies its requirement', () => {
    const def = A_REQUIREMENTS.find(r => r.id === 'cook_raw')!
    for (const inv of [{ beef: 3 }, { beef: 30 }, { chicken: 2, cooked_beef: 4 }] as Record<string, number>[]) {
      const o = def.objective(fakeState({ inventory: inv }))
      // Success: cooked food reaches the objective's count, smelted from the carried raw meat.
      const cooked = Object.entries(inv).filter(([k]) => k.startsWith('cooked_')).reduce((a, [, v]) => a + v, 0)
      const smelted = Number(o.params.count) - cooked
      expect(smelted).toBeLessThanOrEqual(cookableRaw(inv))
      const after = fakeState({ inventory: { cooked_beef: cooked + smelted, beef: cookableRaw(inv) - smelted } })
      expect(def.met(after)).toBe(true)
    }
  })
})

describe('flint from mined gravel', () => {
  it('flint and steel needs no surface work: mine one gravel block, knap it', () => {
    const steps = planObtain('flint_and_steel', 1, { iron_ingot: 1 }).steps
    expect(steps.map(s => `${s.kind}:${s.item}${s.kind === 'gather' ? `/${s.skill}` : ''}`)).toEqual(['gather:gravel/mine', 'gather:flint/collect', 'craft:flint_and_steel'])
  })
})

describe('burning after a lava escape (b3-smoke1 r01)', () => {
  const burning = (over: Partial<WorldState> = {}) => fakeState({ vitals: { ...fakeState().vitals, onFire: true, health: 9 }, inventory: { water_bucket: 1 }, ...over })
  it('puts the fire out with the water bucket in the Overworld (P0, before anything else)', () => {
    expect(selectInterrupt(burning(), new Cooldowns(() => 0), { skill: 'rest', priority: 2 })).toMatchObject({ id: 'extinguish', priority: 0, skill: 'extinguish' })
  })
  it('not without a water bucket, in the Nether, or in liquid', () => {
    expect(selectInterrupt(burning({ inventory: {} }), new Cooldowns(() => 0), { skill: null, priority: null })?.id).not.toBe('extinguish')
    expect(selectInterrupt(burning({ dim: 'the_nether' }), new Cooldowns(() => 0), { skill: null, priority: null })?.id).not.toBe('extinguish')
    expect(selectInterrupt(burning({ inLiquid: 'water' }), new Cooldowns(() => 0), { skill: null, priority: null })?.id).not.toBe('extinguish')
  })
})

describe('extinguish never holds the bot at the lava (b3-smoke2 r01)', () => {
  it('not with lava within 2.5 blocks, at the feet, or while airborne', () => {
    const base = { vitals: { ...fakeState().vitals, onFire: true, health: 14 }, inventory: { water_bucket: 1 } }
    const cd = () => new Cooldowns(() => 0)
    expect(selectInterrupt(fakeState({ ...base, nearby: { entities: [], interestBlocks: {}, hazards: [{ kind: 'lava', pos: [1, 63, 0], dist: 1.4 }] } }), cd(), { skill: null, priority: null })?.id).not.toBe('extinguish')
    expect(selectInterrupt(fakeState({ ...base, onGround: false }), cd(), { skill: null, priority: null })?.id).not.toBe('extinguish')
    expect(selectInterrupt(fakeState({ ...base, nearby: { entities: [], interestBlocks: {}, hazards: [{ kind: 'lava', pos: [4, 63, 0], dist: 4 }] } }), cd(), { skill: null, priority: null })?.id).toBe('extinguish')
  })
})
