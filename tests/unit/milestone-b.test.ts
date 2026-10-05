import { describe, expect, it } from 'vitest'
import { mapView } from '../../src/nav/blocks.js'
import { milestoneBVerified, NETHER_ADVANCEMENT, parseDimension } from '../../src/evaluation/groundtruth.js'
import type { Location, Transition, WorldState } from '../../src/observer/types.js'
import { B_FLAGS, builtPortal, excursionDone, inNetherViaBuilt, milestoneB, returnOk } from '../../src/planner/milestones.js'
import { aDone, B_REQUIREMENTS, candidateObjectives } from '../../src/planner/policy.js'
import { Recovery } from '../../src/recovery/ladder.js'
import { arrivalHazards, excursionTargets, safeStand, tunnelTarget, tunnelTargets } from '../../src/skills/progression/nether-plan.js'
import { portalStrategies } from '../../src/skills/progression/portal.js'
import type { Objective } from '../../src/schema/index.js'
import { fakeState } from './helpers.js'
import { armorUpgrades } from '../../src/skills/food.js'

const built: Location = { kind: 'portal_ow', dim: 'overworld', pos: [10, 64, 10], confidence: 1, source: 'built', lastSeen: 100, detail: { lit: true, builtAt: 100 } }
const netherPortal: Location = { kind: 'portal_nether', dim: 'the_nether', pos: [1, 70, 1], confidence: 1, source: 'observed', lastSeen: 120, detail: { lit: true } }
const tr = (from: Transition['from'], to: Transition['to'], t: number, fromPos: [number, number, number], cause: Transition['cause'] = 'portal'): Transition => ({ from, to, t, fromPos, toPos: [0, 70, 0], cause })

function stateWith (over: { dim?: WorldState['dim']; locations?: Location[]; transitions?: Transition[]; excursions?: WorldState['memory']['excursions']; inventory?: Record<string, number>; A?: number | null } = {}): WorldState {
  const s = fakeState({ dim: over.dim ?? 'overworld', inventory: over.inventory ?? {} })
  s.memory.locations.push(...(over.locations ?? []))
  s.memory.transitions.push(...(over.transitions ?? []))
  s.memory.excursions.push(...(over.excursions ?? []))
  if (over.A !== undefined) s.milestones.A = over.A
  return s
}

describe('milestone B predicates (bot memory + client dimension)', () => {
  const entry = tr('overworld', 'the_nether', 200, [10.5, 64, 10.5])
  const back = tr('the_nether', 'overworld', 300, [1, 70, 1])
  it('a full trip: entry through the built portal, excursion, portal return', () => {
    const s = stateWith({ locations: [built, netherPortal], transitions: [entry, back], excursions: [{ t: 250, dist: 14, portal: [1, 70, 1] }] })
    expect(builtPortal(s)).toBe(built)
    expect(returnOk(s)).toBe(true)
    expect(milestoneB(s)).toBe(true)
  })
  it('in_nether only after arriving through the built portal', () => {
    expect(inNetherViaBuilt(stateWith({ dim: 'the_nether', locations: [built], transitions: [entry] }))).toBe(true)
    const elsewhere = tr('overworld', 'the_nether', 200, [400, 64, 400])
    expect(inNetherViaBuilt(stateWith({ dim: 'the_nether', locations: [built], transitions: [elsewhere] }))).toBe(false)
  })
  it('a death respawn is not a return; no excursion means no return_ok', () => {
    const died = tr('the_nether', 'overworld', 300, [1, 70, 1], 'death')
    expect(returnOk(stateWith({ locations: [built, netherPortal], transitions: [entry, died], excursions: [{ t: 250, dist: 14, portal: [1, 70, 1] }] }))).toBe(false)
    expect(returnOk(stateWith({ locations: [built, netherPortal], transitions: [entry, back] }))).toBe(false)
    expect(returnOk(stateWith({ locations: [built, netherPortal], transitions: [entry, back], excursions: [{ t: 250, dist: 5, portal: [1, 70, 1] }] }))).toBe(false)
  })
  it('excursion counts only for the current visit', () => {
    const second = tr('overworld', 'the_nether', 400, [10.5, 64, 10.5])
    const s = stateWith({ dim: 'the_nether', locations: [built], transitions: [entry, back, second], excursions: [{ t: 250, dist: 14, portal: [1, 70, 1] }] })
    expect(excursionDone(s)).toBe(false)
    expect(B_FLAGS.excursion!(s)).toBe(false)
  })
})

describe('milestone B policy', () => {
  // nether_ready always includes an iron sword (the stone_sword requirement stays met).
  const kit = { iron_pickaxe: 1, iron_sword: 1, flint_and_steel: 1, water_bucket: 1, bucket: 1, cooked_beef: 10 }
  const pool: Location = { kind: 'lava_pool', dim: 'overworld', pos: [30, 11, 30], confidence: 1, source: 'observed', lastSeen: 1, detail: { sources: 20, open: 5 } }
  const ids = (s: WorldState) => candidateObjectives(B_REQUIREMENTS, s).map(o => o.id)
  it('B work waits for nether_ready', () => {
    const s = stateWith({ inventory: kit, locations: [pool], A: null })
    expect(aDone(s)).toBe(false)
    expect(ids(s).some(id => ['nether_portal', 'enter_nether', 'b_lava_pool'].includes(id))).toBe(false)
  })
  it('a golden armor piece comes before the portal; golden helmet replaces an iron one', () => {
    expect(ids(stateWith({ inventory: kit, locations: [pool], A: 1000 }))[0]).toBe('b_gold_armor')
    expect(armorUpgrades({ golden_helmet: 1, iron_helmet: 1 }, { head: 'iron_helmet', chest: null, legs: null, feet: 'iron_boots' })).toEqual([{ item: 'golden_helmet', slot: 'head' }])
    expect(armorUpgrades({ golden_boots: 1, iron_boots: 1 }, { head: null, chest: null, legs: null, feet: 'iron_boots' })).toEqual([])
  })
  it('after nether_ready: build, then enter; the A kit is not rebuilt', () => {
    const s = stateWith({ inventory: { ...kit, golden_helmet: 1 }, locations: [pool], A: 1000 })
    expect(ids(s)[0]).toBe('nether_portal')
    expect(ids(s)).not.toContain('food')
    const s2 = stateWith({ inventory: { ...kit, golden_helmet: 1, bucket: 0, lava_bucket: 1 }, locations: [pool, built], A: 1000 })
    expect(ids(s2)[0]).toBe('enter_nether')
  })
  it('a death in B work restores a stone sword before the portal kit (B gate 20261002: bare-handed B deaths)', () => {
    const s = stateWith({ inventory: { stone_pickaxe: 1, wooden_pickaxe: 1, cobblestone: 8, stick: 2 }, locations: [pool], A: 1000 })
    expect(ids(s)[0]).toBe('stone_sword')
  })
  it('a rejected pool makes the lava search come back', () => {
    const bad = { ...pool, detail: { ...pool.detail, unusable: true } }
    expect(ids(stateWith({ inventory: { ...kit, golden_helmet: 1 }, locations: [bad], A: 1000 }))[0]).toBe('b_lava_pool')
  })
  it('in the Nether: excursion, then the return', () => {
    const entry = tr('overworld', 'the_nether', 200, [10.5, 64, 10.5])
    const s = stateWith({ dim: 'the_nether', inventory: kit, locations: [built, netherPortal], transitions: [entry], A: 1000 })
    expect(ids(s)).toEqual(['nether_excursion'])
    s.memory.excursions.push({ t: 250, dist: 13, portal: [1, 70, 1] })
    expect(ids(s)).toEqual(['return_overworld'])
  })
  it('portal strategies: lava cast first, obsidian when carried', () => {
    const s = stateWith({ inventory: { ...kit, obsidian: 10 }, locations: [pool], A: 1000 })
    expect(portalStrategies(s)).toEqual(['lava_cast', 'obsidian'])
    expect(portalStrategies(stateWith({ inventory: { obsidian: 12, flint_and_steel: 1 } }))).toEqual(['obsidian'])
    expect(portalStrategies(stateWith({ inventory: kit }))).toEqual([])
  })
  it('Nether objectives never relocate (retry instead)', () => {
    const r = new Recovery(() => 0)
    const obj: Objective = { id: 'nether_excursion', milestone: 'B', skill: 'netherExcursion', params: {}, strategy: 's', budgetMs: 1e9 }
    const f = { class: 'NAV_HAZARD' as const, reason: 'x', detail: {}, signature: 'NAV_HAZARD|netherExcursion|nether_excursion|the_nether|step=excursion' }
    expect(r.handle(obj, f, { noRelocate: true }).kind).toBe('retry')
    expect(r.handle(obj, f, { noRelocate: true }).kind).toBe('retry')
  })
})

describe('Nether movement planning', () => {
  // Netherrack floor at y 69, lava lake for x < -3.
  const nether = (x: number, y: number, z: number) => (x < -3 && y === 69 ? 'lava' : y <= 69 ? 'netherrack' : 'air')
  const v = mapView(nether)
  it('excursion targets keep away from lava and reach the distance', () => {
    const ts = excursionTargets(v, [0, 70, 0], 12)
    expect(ts.length).toBeGreaterThan(0)
    for (const t of ts) {
      expect(Math.hypot(t[0], t[2])).toBeGreaterThanOrEqual(12)
      expect(safeStand(v, t)).toBe(true)
      expect(t[0]).toBeGreaterThan(-2)
    }
  })
  it('tunnel fallback picks a lava-free line', () => {
    const solid = (x: number, y: number, z: number) => (x < -3 ? 'lava' : 'netherrack')
    const t = tunnelTarget(mapView(solid), [0, 70, 0], 12)
    expect(t).not.toBeNull()
    expect(t![0]).toBeGreaterThanOrEqual(0)
  })
  it('tunnel fallback never runs through the portal frame (obsidian), and offers every clear line (b3-dev1 r05)', () => {
    // A portal along x at the origin: obsidian frame cells and portal blocks east of it.
    const frame = (x: number, y: number, z: number) => (z === 0 && x >= 1 && x <= 3 && y >= 70 && y <= 72 ? (x === 3 ? 'obsidian' : 'nether_portal') : 'netherrack')
    const v = mapView(frame, {}, n => (n === 'obsidian' ? 250_000 : n === 'bedrock' ? Infinity : 400))
    const ts = tunnelTargets(v, [0, 70, 0], 12)
    expect(ts.length).toBe(3)
    expect(ts.some(t => t[0] > 0 && t[2] === 0)).toBe(false)
  })
  it('arrival hazards count lava and safe cells', () => {
    expect(arrivalHazards(v, [0, 70, 0]).safe).toBe(true)
    const island = (x: number, y: number, z: number) => (Math.abs(x) <= 1 && Math.abs(z) <= 1 && y === 69 ? 'obsidian' : y <= 69 ? 'lava' : 'air')
    expect(arrivalHazards(mapView(island), [0, 70, 0])).toMatchObject({ safe: false })
  })
})

describe('B ground truth', () => {
  it('needs the Nether advancement, the Overworld at the end and the lit built portal', () => {
    expect(parseDimension('Bot has the following entity data: "minecraft:overworld"', 'Bot')).toBe('overworld')
    expect(milestoneBVerified({ advancements: [NETHER_ADVANCEMENT], dimension: 'overworld', portalCheck: true })).toBe(true)
    expect(milestoneBVerified({ advancements: [NETHER_ADVANCEMENT], dimension: 'the_nether', portalCheck: true })).toBe(false)
    expect(milestoneBVerified({ advancements: [], dimension: 'overworld', portalCheck: true })).toBe(false)
    expect(milestoneBVerified({ advancements: [NETHER_ADVANCEMENT], dimension: 'overworld', portalCheck: null })).toBe(false)
  })
})
