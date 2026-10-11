// Milestone C: predicates, policy, strategy catalogs and resupply, Nether gold sources,
// fortress-search planning (1.16.1 region grid), blaze fight geometry, mob ownership in
// the threat check, the Nether trail, ground truth and the report statistics.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ignoredMobs, selectInterrupt, Cooldowns } from '../../src/controller/interrupts.js'
import { ProgressionController } from '../../src/controller/progression.js'
import { cRunStats } from '../../src/evaluation/c-report.js'
import { milestoneCVerified, NETHER_ADVANCEMENT } from '../../src/evaluation/groundtruth.js'
import { mapView } from '../../src/nav/blocks.js'
import { buildDigest } from '../../src/observer/digest.js'
import { Observer } from '../../src/observer/observer.js'
import type { EntityInfo, Location, Transition, WorldState } from '../../src/observer/types.js'
import { C_FLAGS, milestoneC } from '../../src/planner/milestones.js'
import { anyPickDurability, barterUnproductive, C_REQUIREMENTS, candidateObjectives, cDeath, cRoute, goldExhausted, goldWant, piglinsKnown, usableBastion, type RequirementDef } from '../../src/planner/policy.js'
import progressionCfg from '../../config/progression.json' with { type: 'json' }
const C_CFG = progressionCfg.C
import { Recovery } from '../../src/recovery/ladder.js'
import type { Failure, Objective } from '../../src/schema/index.js'
import { NETHER_MINE_Y, piglinsWatching } from '../../src/skills/generic/mine.js'
import { shooters } from '../../src/skills/survival/cover.js'
import { deflectTarget, wantsDeflect } from '../../src/skills/survival/ghast.js'
import { GUARD_FIGHT_MOBS, strikeWindow } from '../../src/skills/survival/hoglin.js'
import { unsafeBridge, type BridgeCell } from '../../src/nav/pathfinder.js'
import type { V3 } from '../../src/schema/index.js'
import { GHAST } from '../../src/version.js'
import { campCells, eyeToBox, fortressFloors, strikeCell } from '../../src/skills/progression/blaze-plan.js'
import { attributeStructure, blockedHeading, chooseAxis, chooseRegion, legToward, regionOfBlock, zoneChunks } from '../../src/skills/progression/fortress-plan.js'
import { trailIndex } from '../../src/skills/progression/nether.js'
import { SkillRunner } from '../../src/skills/runner.js'
import { planObtain } from '../../src/skills/sources.js'
import type { SkillDef } from '../../src/skills/types.js'
import { assessThreat } from '../../src/skills/survival/threat.js'
import { isProtected } from '../../src/nav/hazards.js'
import { Telemetry } from '../../src/telemetry/telemetry.js'
import { fakeEnv, fakeState } from './helpers.js'

const built: Location = { kind: 'portal_ow', dim: 'overworld', pos: [10, 64, 10], confidence: 1, source: 'built', lastSeen: 100, detail: { lit: true, builtAt: 100 } }
const tr = (from: Transition['from'], to: Transition['to'], t: number, cause: Transition['cause'] = 'portal'): Transition => ({ from, to, t, fromPos: [10, 64, 10], toPos: [1, 70, 1], cause })

function cState (over: { dim?: WorldState['dim']; inventory?: Record<string, number>; transitions?: Transition[]; locations?: Location[]; B?: number | null; t?: number } = {}): WorldState {
  const s = fakeState({ dim: over.dim ?? 'overworld', inventory: over.inventory ?? {}, t: over.t ?? 1000 })
  s.memory.locations.push(built, ...(over.locations ?? []))
  s.memory.transitions.push(...(over.transitions ?? []))
  s.milestones.A = 400
  if (over.B !== null) s.milestones.B = over.B ?? 500
  return s
}

describe('milestone C predicate', () => {
  const kit = { blaze_rod: 7, ender_pearl: 14 }
  it('rods and pearls, back in the Overworld through a portal after a Nether entry made after B', () => {
    const s = cState({ inventory: kit, transitions: [tr('overworld', 'the_nether', 300), tr('the_nether', 'overworld', 400), tr('overworld', 'the_nether', 600), tr('the_nether', 'overworld', 900)] })
    expect(milestoneC(s)).toBe(true)
    expect(C_FLAGS.c_kit!(s)).toBe(true)
  })
  it('not before B, not in the Nether, not after a death respawn, not short of either item', () => {
    const trip = [tr('overworld', 'the_nether', 600), tr('the_nether', 'overworld', 900)]
    expect(milestoneC(cState({ inventory: kit, transitions: trip, B: null }))).toBe(false)
    expect(milestoneC(cState({ inventory: kit, transitions: [tr('overworld', 'the_nether', 600)], dim: 'the_nether' }))).toBe(false)
    expect(milestoneC(cState({ inventory: kit, transitions: [tr('overworld', 'the_nether', 600), tr('the_nether', 'overworld', 900, 'death')] }))).toBe(false)
    expect(milestoneC(cState({ inventory: { blaze_rod: 7, ender_pearl: 13 }, transitions: trip }))).toBe(false)
    expect(milestoneC(cState({ inventory: { blaze_rod: 6, ender_pearl: 14 }, transitions: trip }))).toBe(false)
    // The B round trip alone (entry before B was reached) is not the C trip.
    expect(milestoneC(cState({ inventory: kit, transitions: [tr('overworld', 'the_nether', 300), tr('the_nether', 'overworld', 450)] }))).toBe(false)
  })
  it('server ground truth needs B checks plus the items', () => {
    const g = { advancements: [NETHER_ADVANCEMENT], dimension: 'overworld', portalCheck: true }
    expect(milestoneCVerified({ ...g, inventory: { blaze_rod: 8, ender_pearl: 15 } })).toBe(true)
    expect(milestoneCVerified({ ...g, inventory: { blaze_rod: 6, ender_pearl: 15 } })).toBe(false)
    expect(milestoneCVerified({ ...g, dimension: 'the_nether', inventory: { blaze_rod: 8, ender_pearl: 15 } })).toBe(false)
    expect(milestoneCVerified({ ...g, inventory: null })).toBe(false)
  })
})

describe('milestone C policy', () => {
  const ids = (s: WorldState) => candidateObjectives(C_REQUIREMENTS, s).map(o => o.id)
  const tools = (s: WorldState, list: [string, number][]) => { s.tools = list.map(([name, remaining], i) => ({ name, slot: 36 + i, remaining, max: 250 })); return s }
  const loc = (kind: Location['kind'], pos: V3, detail?: Location['detail']): Location => ({ kind, dim: kind === 'bed' ? 'overworld' : 'the_nether', pos, confidence: 1, source: 'observed', lastSeen: 990, detail })
  it('C work waits for B; after B the required kit, then optional staging only from what is carried', () => {
    expect(ids(cState({ B: null, inventory: { iron_sword: 1, wooden_pickaxe: 1 } })).filter(i => i.startsWith('c_'))).toEqual([])
    // Within the staging window (t 700, B 500): no table → only the required items (a table, food).
    const s = tools(cState({ t: 700, inventory: { iron_sword: 1, stone_pickaxe: 1, shield: 1, cooked_beef: 3, golden_helmet: 1 } }), [['stone_pickaxe', 100]])
    expect(ids(s).filter(i => i.startsWith('c_'))).toEqual(['c_food', 'c_table'])
    delete s.inventory.shield
    expect(ids(s).filter(i => i.startsWith('c_'))).toEqual(['c_food', 'c_table', 'c_shield'])
    // The ckit inventory (one table, sticks, no wood, no gold, no wool): nothing optional is cheap → straight in.
    const ckit = tools(cState({ t: 600, inventory: { iron_sword: 1, iron_pickaxe: 1, stone_pickaxe: 2, shield: 1, cooked_beef: 20, cobblestone: 64, crafting_table: 1, stick: 8, golden_helmet: 1 } }), [['iron_pickaxe', 250], ['stone_pickaxe', 131], ['stone_pickaxe', 131]])
    expect(ids(ckit).filter(i => i.startsWith('c_'))).toEqual(['c_stash_wood', 'c_enter'])
    // The kit wood is a local collect (no search, no far scan), offered once in the window.
    expect(candidateObjectives(C_REQUIREMENTS, ckit).find(o => o.id === 'c_stash_wood')).toMatchObject({ skill: 'collect', params: { block: 'log', count: 2, maxDist: progressionCfg.C.stageWoodR, searchSteps: 0, local: true } })
    // Wood, gold, wool carried: the second table, the spare golden piece, the bed and the kit come first.
    const rich = tools(cState({ t: 600, inventory: { iron_sword: 1, stone_pickaxe: 3, shield: 1, cooked_beef: 10, crafting_table: 1, golden_helmet: 1, gold_ingot: 4, oak_planks: 24, white_wool: 3 } }), [['stone_pickaxe', 131], ['stone_pickaxe', 131], ['stone_pickaxe', 131], ['iron_pickaxe', 240]])
    expect(anyPickDurability(rich)).toBe(633)
    expect(ids(rich).filter(i => i.startsWith('c_'))).toEqual(['c_table2', 'c_stash_gold', 'c_bed', 'c_stash', 'c_enter'])
    // The bed from carried wool is a craft, then setSpawnBed.
    expect(candidateObjectives(C_REQUIREMENTS, rich).find(o => o.id === 'c_bed')).toMatchObject({ skill: 'obtain', params: { item: 'white_bed', count: 1 } })
    rich.inventory.white_bed = 1
    expect(candidateObjectives(C_REQUIREMENTS, rich).find(o => o.id === 'c_bed')).toMatchObject({ skill: 'setSpawnBed' })
    // The bed is skipped when the world spawn is beside the portal (a death respawns there anyway).
    rich.memory.locations.push({ kind: 'spawn', dim: 'overworld', pos: [14, 64, 20], confidence: 1, source: 'observed', lastSeen: 0 })
    expect(ids(rich)).not.toContain('c_bed')
    rich.memory.locations = rich.memory.locations.filter(l => l.kind !== 'spawn')
    // Bounded attempts: two failed bed uses, two failed kits → no more.
    rich.memory.cStage = { tries: { bed: 2, stash: 2 } }
    expect(ids(rich).filter(i => i.startsWith('c_'))).toEqual(['c_table2', 'c_stash_gold', 'c_enter'])
    rich.memory.cStage = undefined
    // Window closed (B + 300 s): optional staging is dropped, the re-entry goes on.
    rich.t = 900
    expect(ids(rich).filter(i => i.startsWith('c_'))).toEqual(['c_enter'])
    const ready = rich
    // Bed set and kit staged: straight in.
    ready.memory.locations.push(loc('bed', [12, 64, 10], { set: true }))
    ready.memory.stash = { pos: [11, 64, 12], items: { stone_sword: 1 }, t: 900 }
    expect(ids(ready).filter(i => i.startsWith('c_'))).toEqual(['c_enter'])
    // Never in without golden armor: the re-entry waits for c_ow_gold.
    delete ready.inventory.golden_helmet
    delete ready.inventory.golden_boots
    expect(ids(ready).filter(i => i.startsWith('c_'))).toEqual(['c_ow_gold'])
  })
  it('in the Nether, neither structure known: a structure search first; gold armor before any of it', () => {
    const n = cState({ dim: 'the_nether', inventory: { iron_sword: 1 } })
    // No pickaxe left in the Nether: back to the Overworld to restock first.
    expect(ids(n)[0]).toBe('c_restock')
    tools(n, [['stone_pickaxe', 120]])
    expect(ids(n)).toEqual(['c_gold_armor', 'c_structure', 'c_fortress'])
    n.inventory.golden_helmet = 1
    expect(cRoute(n)).toBe('search')
    expect(ids(n)).toEqual(['c_structure', 'c_fortress'])
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ skill: 'findFortress', params: { target: 'any' } })
    // Piglins alone are no strong gold opportunity: the search still comes first, ore + barter behind it.
    n.memory.locations.push(loc('piglins', [20, 70, 0]))
    expect(piglinsKnown(n)).toBe(true)
    expect(ids(n)).toEqual(['c_structure', 'c_gold', 'c_pearls', 'c_fortress'])
    expect(candidateObjectives(C_REQUIREMENTS, n).find(o => o.id === 'c_gold')).toMatchObject({ skill: 'obtain', strategy: 'nether_gold' })
    // A suspended search hands the turn to ore gold and bartering.
    expect(candidateObjectives(C_REQUIREMENTS, n, id => id === 'c_structure').map(o => o.id)[0]).toBe('c_gold')
  })
  it('a fortress already known (seen during B): blaze rods first, pearls after', () => {
    // No gold source known: straight to the blazes, on the fortress floors (no spawner camp without fire resistance).
    const n = tools(cState({ dim: 'the_nether', inventory: { iron_sword: 1, golden_helmet: 1 }, locations: [loc('fortress', [200, 60, 0])] }), [['iron_pickaxe', 200]])
    expect(cRoute(n)).toBe('rods')
    expect(ids(n)[0]).toBe('c_rods')
    expect(ids(n).filter(i => i === 'c_rods')).toHaveLength(1)
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ skill: 'collectBlazeRods', params: { mode: 'roam' } })
    // Piglins known: one fire resistance potion first (gold in a small batch, bartered until the potion), then rods.
    n.memory.locations.push(loc('piglins', [20, 70, 0]))
    expect(ids(n).slice(0, 3)).toEqual(['c_gold', 'c_fire_res', 'c_rods'])
    n.inventory.gold_ingot = 3
    expect(ids(n)[0]).toBe('c_fire_res')
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ skill: 'barterPearls', params: { fireRes: 1, untilFireRes: true } })
    n.inventory.potion = 1
    expect(ids(n)[0]).toBe('c_rods')
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ params: { mode: 'spawner' } })
    // A bastion known as well: the fortress still wins.
    n.memory.locations.push(loc('bastion', [-150, 50, 0]))
    expect(ids(n)[0]).toBe('c_rods')
    // Rods suspended (catalog exhausted): the pearls take over meanwhile.
    expect(candidateObjectives(C_REQUIREMENTS, n, id => id === 'c_rods').map(o => o.id)[0]).toBe('c_pearls')
    n.inventory.blaze_rod = 7
    expect(cRoute(n)).toBe('pearls')
    expect(ids(n)).toEqual(['c_pearls'])
    delete n.inventory.gold_ingot
    expect(ids(n)).toEqual(['c_gold', 'c_pearls'])
    n.inventory.ender_pearl = 14
    expect(ids(n)).toEqual(['c_return'])
  })
  it('a bastion known: its gold and the pearls first, then the fortress search, fire resistance and rods', () => {
    const n = tools(cState({ dim: 'the_nether', inventory: { iron_sword: 1, golden_helmet: 1 }, locations: [loc('portal_nether', [0, 70, 0]), loc('bastion', [120, 50, 40])] }), [['iron_pickaxe', 200]])
    expect(usableBastion(n)?.pos).toEqual([120, 50, 40])
    expect(cRoute(n)).toBe('pearls')
    expect(ids(n)).toEqual(['c_gold', 'c_pearls', 'c_fortress'])
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ skill: 'bastionGold', params: { count: 8 } })
    n.inventory.gold_ingot = 9
    expect(ids(n)[0]).toBe('c_pearls')
    n.inventory.ender_pearl = 14
    expect(cRoute(n)).toBe('rods')
    expect(ids(n)).toEqual(['c_fortress'])
    n.memory.locations.push(loc('fortress', [-200, 60, 0]))
    expect(ids(n)).toEqual(['c_fire_res', 'c_rods'])
    // An exhausted bastion or one far beyond the portal radius is not an opportunity.
    const far = tools(cState({ dim: 'the_nether', inventory: { golden_helmet: 1 }, locations: [loc('portal_nether', [0, 70, 0]), loc('bastion', [600, 50, 0])] }), [['iron_pickaxe', 200]])
    expect(usableBastion(far)).toBeNull()
    expect(cRoute(far)).toBe('search')
    const done = tools(cState({ dim: 'the_nether', inventory: { golden_helmet: 1 }, locations: [loc('portal_nether', [0, 70, 0]), loc('bastion', [100, 50, 0], { exhausted: true })] }), [['iron_pickaxe', 200]])
    expect(cRoute(done)).toBe('search')
  })
  it('adaptive pearl budget: gold sources spent or bartering unproductive → the enderman alternate', () => {
    const n = tools(cState({ dim: 'the_nether', inventory: { iron_sword: 1, golden_helmet: 1 }, locations: [loc('piglins', [20, 70, 0]), loc('fortress', [200, 60, 0])] }), [['iron_pickaxe', 200]])
    n.inventory.blaze_rod = 7
    expect(ids(n)).toEqual(['c_gold', 'c_pearls'])
    n.memory.cLedger = { given: 30, pearls: 4, refused: 0, tossed: 0, potions: 0, gold: { ore: 30, bastionBlock: 0, chest: 0 }, oreS: C_CFG.oreBudgetS }
    expect(goldExhausted(n)).toBe(true)
    expect(ids(n)).toEqual(['c_pearls'])
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ skill: 'huntEndermen' })
    // Gold still in hand: barter it first.
    n.inventory.gold_ingot = 3
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ skill: 'barterPearls' })
    delete n.inventory.gold_ingot
    // A bastion with gold left reopens the gold source.
    n.memory.locations.push(loc('bastion', [150, 50, 0]))
    expect(goldExhausted(n)).toBe(false)
    expect(ids(n)[0]).toBe('c_gold')
    n.memory.cLedger.given = C_CFG.barterCap
    expect(barterUnproductive(n)).toBe(true)
    expect(candidateObjectives(C_REQUIREMENTS, n)[0]).toMatchObject({ id: 'c_pearls', skill: 'huntEndermen' })
  })
  it('an Overworld death after B, before the first entry: the minimum kit only, no optional staging', async () => {
    const { rekit } = await import('../../src/planner/policy.js')
    const s = cState({ t: 650, inventory: { stone_sword: 1, cooked_beef: 5, crafting_table: 1, golden_boots: 1, oak_planks: 20, gold_ingot: 4 } })
    tools(s, [['stone_pickaxe', 131]])
    s.inventory.stone_pickaxe = 1
    s.memory.deaths.push({ pos: [0, 40, 0], dim: 'overworld', t: 600 })
    expect(cDeath(s)).toBe(false)
    expect(rekit(s)).toBe(true)
    // 5 food ≥ 4, one table, 131 ≥ 131 uses, no iron → no shield trip, a golden piece: straight in.
    expect(ids(s).filter(i => i.startsWith('c_'))).toEqual(['c_enter'])
  })
  it('after a C death: the staged kit first, then only the minimum safe kit and golden armor before re-entry', () => {
    const trips = [tr('overworld', 'the_nether', 600)]
    const s = cState({ inventory: {}, transitions: [...trips, tr('the_nether', 'overworld', 800, 'death')] })
    s.memory.stash = { pos: [11, 64, 12], items: { stone_sword: 1, stone_pickaxe: 2, crafting_table: 1, cooked_beef: 4, golden_boots: 1 }, t: 550 }
    s.memory.locations.push(loc('bed', [12, 64, 10], { set: true }))
    s.memory.deaths.push({ pos: [5, 40, 5], dim: 'the_nether', t: 800 })
    s.pos = [12, 64, 11]
    expect(cDeath(s)).toBe(true)
    expect(ids(s)[0]).toBe('c_unstash')
    // Far from the kit and unarmed: the A basics first (a stone sword), then the kit.
    s.pos = [300, 64, 300]
    expect(ids(s)[0]).not.toBe('c_unstash')
    // Kit taken: one table, one stone pickaxe's durability and 4 food are enough.
    s.pos = [12, 64, 11]
    s.memory.stash.items = {}
    Object.assign(s.inventory, { stone_sword: 1, stone_pickaxe: 2, crafting_table: 1, cooked_beef: 4, golden_boots: 1 })
    tools(s, [['stone_pickaxe', 131], ['stone_pickaxe', 131]])
    expect(ids(s).filter(i => i.startsWith('c_'))).toEqual(['c_enter'])
    // No shield and no iron: it is not made (no iron trip after a death).
    expect(ids(s)).not.toContain('c_shield')
    // A restock trip after the death with one worn pickaxe: rebuilt to pickReopen, not to a single
    // 131-use pickaxe (ckit-r2b r02: 4 restock round trips in an hour).
    tools(s, [['stone_pickaxe', 40]])
    s.inventory.stone_pickaxe = 1
    expect(candidateObjectives(C_REQUIREMENTS, s).find(o => o.id === 'c_pickaxes')?.params).toMatchObject({ item: 'stone_pickaxe', count: 1 + Math.ceil((C_CFG.pickReopen - 40) / 131) })
    s.inventory.stone_pickaxe = 2
    tools(s, [['stone_pickaxe', 131], ['stone_pickaxe', 131]])
    // Without golden armor (kit had none): obtained in the Overworld before the re-entry.
    delete s.inventory.golden_boots
    expect(ids(s).filter(i => i.startsWith('c_'))).toEqual(['c_ow_gold'])
  })
  it('gold batch follows the pearls still missing (1.16.1 barter yield), capped at a small batch', () => {
    expect(goldWant(cState({ inventory: {} }))).toBe(8)
    expect(goldWant(cState({ inventory: { ender_pearl: 12 } }))).toBe(8)
    expect(goldWant(cState({ inventory: { ender_pearl: 13 } }))).toBe(4)
    // Pearls done but no fire resistance before the rods: a batch for it.
    expect(goldWant(cState({ inventory: { ender_pearl: 14 } }))).toBe(8)
    expect(goldWant(cState({ inventory: { ender_pearl: 14, splash_potion: 1 } }))).toBe(0)
    expect(goldWant(cState({ inventory: { ender_pearl: 14, blaze_rod: 7 } }))).toBe(0)
  })
  it('the pearl and rod objectives carry their own catalogs; gold is restocked by c_gold', () => {
    const pearls = C_REQUIREMENTS.find(r => r.id === 'c_pearls')!
    expect(pearls.strategies?.map(x => x.id)).toEqual(['barter', 'endermen'])
    expect(pearls.strategies?.[1]?.skill).toBe('huntEndermen')
    expect(pearls.resupply).toEqual({ gold_ingot: 'c_gold' })
    for (const id of ['c_gold_armor', 'c_gold', 'c_pearls', 'c_fortress', 'c_rods']) expect(C_REQUIREMENTS.find(r => r.id === id)).toMatchObject({ noRelocate: true, noRetreat: true })
  })
})

describe('strategy catalogs per objective (Recovery L3)', () => {
  const cat = (id: string) => C_REQUIREMENTS.find(r => r.id === id)?.strategies
  const pearlsObj: Objective = { id: 'c_pearls', milestone: 'C', skill: 'barterPearls', params: {}, strategy: 'barter', budgetMs: 600_000 }
  const f = (cls: Failure['class']): Failure => ({ class: cls, reason: 'r', detail: {}, signature: `${cls}|barterPearls|c_pearls|the_nether|target=piglins` })
  it('piglins not found: retry twice in place, then the enderman alternate, then suspend and start over', () => {
    let t = 0
    const r = new Recovery(() => t, cat)
    expect(r.strategy('c_pearls')).toMatchObject({ id: 'barter', own: true })
    expect(r.handle(pearlsObj, f('NOT_FOUND'), { noRelocate: true, persistent: true }).kind).toBe('retry')
    expect(r.handle(pearlsObj, f('NOT_FOUND'), { noRelocate: true, persistent: true }).kind).toBe('retry')
    expect(r.handle(pearlsObj, f('NOT_FOUND'), { noRelocate: true, persistent: true })).toMatchObject({ kind: 'alternate', strategy: 'endermen' })
    expect(r.strategy('c_pearls')).toMatchObject({ id: 'endermen', skill: 'huntEndermen' })
    r.handle(pearlsObj, f('NOT_FOUND'), { noRelocate: true }); r.handle(pearlsObj, f('NOT_FOUND'), { noRelocate: true })
    expect(r.handle(pearlsObj, f('NOT_FOUND'), { noRelocate: true })).toMatchObject({ kind: 'suspend' })
    expect(r.strategy('c_pearls').id).toBe('barter')
    t += 301_000
    expect(r.isSuspended('c_pearls')).toBe(false)
  })
  it('objectives without a catalog keep default/wide (A and B unchanged)', () => {
    const r = new Recovery(() => 0, cat)
    expect(r.strategy('iron_ingots')).toMatchObject({ id: 'default', own: false })
  })
})

describe('controller: resupply hand-over and strategy skills', () => {
  it('out of gold hands the turn to the gold requirement without climbing the ladder', async () => {
    const state = fakeState({ dim: 'the_nether', inventory: { gold_ingot: 2 } })
    const env = fakeEnv(state)
    const dir = mkdtempSync(join(tmpdir(), 'mcbot-c-'))
    const telemetry = new Telemetry(dir, env.bus, { state: () => state, digest: () => buildDigest(state, env.bus.tail()), navRecent: () => [], voxels: () => ({ layers: [] }) })
    telemetry.start()
    const runs: string[] = []
    const P = z.object({}).passthrough()
    const barter: SkillDef<Record<string, unknown>> = {
      id: 'barter', level: 'progression', params: P as never, preconditions: () => ({ ok: true }), timeoutMs: () => 1000, stallMs: 1000,
      run: async () => {
        runs.push('barter')
        if ((state.inventory.gold_ingot ?? 0) > 0) { state.inventory.gold_ingot = 0; state.inventory.ender_pearl = (state.inventory.ender_pearl ?? 0) + 7 }
        if ((state.inventory.ender_pearl ?? 0) >= 14) return {}
        throw Object.assign(new (await import('../../src/skills/types.js')).SkillFailure('MISSING_RESOURCE', 'out of gold', { key: 'item=gold_ingot' }, [{ item: 'gold_ingot', count: 1 }]))
      },
    }
    const mineGold: SkillDef<Record<string, unknown>> = {
      id: 'mineGold', level: 'generic', params: P as never, preconditions: () => ({ ok: true }), timeoutMs: () => 1000, stallMs: 1000,
      run: async () => { runs.push('gold'); state.inventory.gold_ingot = 5; return {} },
    }
    const hold: SkillDef<{ ms: number }> = { id: 'holdSafe', level: 'survival', params: z.object({ ms: z.number() }), preconditions: () => ({ ok: true }), timeoutMs: () => 2000, stallMs: 2000, run: (_c, p) => new Promise(r => setTimeout(r, Math.min(p.ms, 50))) }
    const reqs: RequirementDef[] = [
      { id: 'gold', milestone: 'C', met: s => (s.inventory.gold_ingot ?? 0) >= 1 || (s.inventory.ender_pearl ?? 0) >= 14, objective: () => ({ skill: 'mineGold', params: {}, strategy: 'x', budgetMs: 60_000 }) },
      { id: 'pearls', milestone: 'C', resupply: { gold_ingot: 'gold' }, met: s => (s.inventory.ender_pearl ?? 0) >= 14, objective: () => ({ skill: 'barter', params: {}, strategy: 'barter', budgetMs: 60_000 }), strategies: [{ id: 'barter' }, { id: 'endermen', skill: 'hunt' }] },
    ]
    const runner = new SkillRunner(env).register(barter).register(mineGold).register(hold)
    const c = new ProgressionController({
      runner, bus: env.bus, telemetry, state: () => state, setObjective: o => { state.control.objective = o },
      requirements: reqs, milestones: { X: s => (s.inventory.ender_pearl ?? 0) >= 14 }, flags: {}, target: 'X', deadline: Date.now() + 5000,
      waitForRespawn: async () => {}, resync: async () => {}, afterDeath: () => {},
    })
    const r = await c.run()
    telemetry.stop()
    expect(r.outcome).toBe('goal_reached')
    expect(runs).toEqual(['barter', 'gold', 'barter'])
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(events.filter(e => e.type === 'recovery_step' && e.data.action === 'resupply')).toHaveLength(1)
    expect(telemetry.failures.filter(f => f.class === 'MISSING_RESOURCE')).toHaveLength(0)
  }, 10_000)
})

describe('Nether gold sources', () => {
  it('Nether: nuggets from nether gold ore (any pickaxe), ingots from 9 nuggets at a table', () => {
    const { steps } = planObtain('gold_ingot', 3, { crafting_table: 1, wooden_pickaxe: 1, gold_nugget: 4 }, { nether: true })
    expect(steps).toEqual([
      { kind: 'gather', item: 'gold_nugget', count: 27, blocks: ['nether_gold_ore'], skill: 'mine', chance: undefined },
      { kind: 'craft', item: 'gold_ingot', count: 3 },
    ])
  })
  it('Overworld gold stays smelted from gold ore (milestone B golden helmet unchanged)', () => {
    const { steps } = planObtain('gold_ingot', 1, { iron_pickaxe: 1, furnace: 1, coal: 2 }, {})
    expect(steps.map(s => `${s.kind}:${s.item}`)).toEqual(['gather:gold_ore', 'smelt:gold_ingot'])
  })
})

describe('fortress search planning (1.16.1 region grid)', () => {
  it('regions and zones: 27-chunk grid, start chunks at offsets 0–22, negative coordinates floor', () => {
    expect(regionOfBlock(0, 0)).toEqual([0, 0])
    expect(regionOfBlock(-1, 431)).toEqual([-1, 0])
    expect(regionOfBlock(432, -433)).toEqual([1, -2])
    expect(zoneChunks(-1, 0)).toEqual({ cx0: -27, cz0: 0, cx1: -5, cz1: 22 })
  })
  it('a bastion resolves the region it lies in; one in the separation gap goes to the nearest zone', () => {
    expect(attributeStructure([100, 70, 100])).toEqual([0, 0])
    expect(attributeStructure([-80, 70, 100])).toEqual([-1, 0])
    expect(attributeStructure([-20, 70, 100])).toEqual([0, 0])
  })
  it('heads for the unresolved zone with the most unseen area per block; resolved zones are skipped', () => {
    const none = () => false
    const c = chooseRegion([10, 70, 10], [10, 70, 10], none, [], 720)!
    expect(c.region).toEqual([0, 0])
    // Region (0,0) seen entirely, (-1,0) has a bastion: the next is (0,-1) or (-1,-1), deterministically.
    const seen00 = (cx: number, cz: number) => cx >= 0 && cx <= 22 && cz >= 0 && cz <= 22
    const c2 = chooseRegion([10, 70, 10], [10, 70, 10], seen00, [[-200, 70, 150]], 720)!
    expect(c2.region).not.toEqual([0, 0])
    expect(c2.region).not.toEqual([-1, 0])
    expect(chooseRegion([10, 70, 10], [10, 70, 10], seen00, [[-200, 70, 150]], 720)).toEqual(c2)
    // Everything within the radius seen: exhausted.
    expect(chooseRegion([10, 70, 10], [10, 70, 10], () => true, [], 720)).toBeNull()
  })
  it('legs turn away from headings that failed nearby, and give up when all are blocked', () => {
    const failed = [{ pos: [0, 70, 0] as [number, number, number], heading: 0, t: 100 }]
    const blocked = (h: number) => blockedHeading(failed, [2, 70, 2], h, 200)
    const leg = legToward([0, 70, 0], [200, 0], 64, blocked)!
    expect(Math.abs(leg.heading)).toBeCloseTo(Math.PI / 3) // ±30° is still inside the failed arc (±36°)
    expect(legToward([0, 70, 0], [200, 0], 64, () => true)).toBeNull()
    expect(blockedHeading(failed, [2, 70, 2], 0, 100 + 601)).toBe(false)
  })
  it('axis sweep picks the least-seen cardinal direction', () => {
    const seenEast = (cx: number) => cx >= 0
    expect(chooseAxis([0, 70, 0], seenEast, 160, () => false)!.heading).toBeCloseTo(Math.PI)
  })
})

describe('blaze fight geometry', () => {
  // Nether-brick floor at y 64 (stand at y 65), spawner at (0, 66, 0) on a pillar, roof at y 69 over x ≤ 0.
  const fill = (x: number, y: number, z: number) => {
    if (y === 64 && Math.abs(x) <= 6 && Math.abs(z) <= 6) return 'nether_bricks'
    if (y === 69 && x <= 0 && Math.abs(x) <= 6 && Math.abs(z) <= 6) return 'nether_bricks'
    if (y < 64) return 'netherrack'
    return 'air'
  }
  const view = mapView(fill, { '0,65,0': 'nether_bricks', '0,66,0': 'spawner' })
  it('camp cells are fortress floor 2–5 blocks from the spawner, roofed first', () => {
    const cells = campCells(view, [0, 66, 0])
    expect(cells.length).toBeGreaterThan(0)
    for (const c of cells) expect(Math.hypot(c[0], c[2])).toBeGreaterThanOrEqual(2)
    expect(cells[0]![0]).toBeLessThanOrEqual(0)
    expect(fortressFloors(view, [0, 65, 0], 6, 2, [6, 65, 6]).length).toBeGreaterThan(0)
  })
  it('reach is eye to hitbox (3 blocks); a strike cell puts a hovering blaze within it', () => {
    expect(eyeToBox([0, 66.62, 0], [2, 66, 0], 0.6, 1.8)).toBeCloseTo(1.7)
    expect(eyeToBox([0, 66.62, 0], [0, 70, 0], 0.6, 1.8)).toBeCloseTo(3.38)
    const c = strikeCell(view, [4.5, 65, 4.5], [3.5, 68.5, 3.5])!
    expect(c).not.toBeNull()
    expect(eyeToBox([c[0] + 0.5, c[1] + 1.62, c[2] + 0.5], [3.5, 68.5, 3.5], 0.6, 1.8)).toBeLessThanOrEqual(3)
  })
})

describe('mob ownership in the threat check', () => {
  const blaze: EntityInfo = { id: 7, name: 'blaze', kind: 'hostile', pos: [6, 66, 0], dist: 6, los: true }
  const wither: EntityInfo = { id: 8, name: 'wither_skeleton', kind: 'hostile', pos: [2, 65, 0], dist: 2, los: true }
  const piglin: EntityInfo = { id: 9, name: 'piglin', kind: 'hostile', pos: [2, 65, 0], dist: 2, los: true }
  const nether = (hp: number, ents: EntityInfo[], extra: Partial<WorldState> = {}) => fakeState({ dim: 'the_nether', pos: [0, 65, 0], vitals: { ...fakeState().vitals, health: hp }, inventory: { iron_sword: 1, shield: 1 }, equipment: { head: null, chest: null, legs: null, feet: null, mainHand: 'iron_sword', offHand: 'shield' }, nearby: { entities: ents, interestBlocks: {}, hazards: [] }, ...extra })
  it('blazes are the blaze skill’s own above 8 HP; wither skeletons never are', () => {
    expect(ignoredMobs(nether(18, [blaze]), 'collectBlazeRods')?.has('blaze')).toBe(true)
    expect(ignoredMobs(nether(7, [blaze]), 'collectBlazeRods')).toBeUndefined()
    expect(ignoredMobs(nether(18, [blaze]), 'findFortress')).toBeUndefined()
    const cd = new Cooldowns(() => 0)
    expect(selectInterrupt(nether(18, [blaze]), cd, { skill: 'collectBlazeRods', priority: 3 })).toBeNull()
    expect(selectInterrupt(nether(18, [blaze]), cd, { skill: 'findFortress', priority: 3 })?.id).toBe('cover')
    expect(selectInterrupt(nether(18, [blaze, wither]), cd, { skill: 'collectBlazeRods', priority: 3 })?.priority).toBe(1)
  })
  it('a piglin next to a gold-wearing bot is a trade partner while bartering, an enemy once provoked', () => {
    const gold = { equipment: { head: 'golden_helmet', chest: null, legs: null, feet: null, mainHand: 'gold_ingot', offHand: 'shield' } }
    const s = nether(18, [piglin], gold)
    expect(assessThreat(s, ignoredMobs(s, 'barterPearls')).mobs).toHaveLength(0)
    s.memory.blacklist.push({ key: 'provoked:piglin', until: s.t + 60, reason: 'x' })
    expect(ignoredMobs(s, 'barterPearls')).toBeUndefined()
    expect(assessThreat(s).mobs.map(m => m.e.name)).toEqual(['piglin'])
    const far = nether(18, [{ ...piglin, pos: [8, 65, 0], dist: 8 }], gold)
    expect(assessThreat(far).mobs).toHaveLength(0)
    far.memory.blacklist.push({ key: 'provoked:piglin', until: far.t + 60, reason: 'x' })
    expect(assessThreat(far).mobs).toHaveLength(1)
  })
  it('ckit-r2 r01: unprovoked piglins are no threat and no shooter to a gold-wearing bot at any distance', () => {
    const gold = { equipment: { head: 'golden_helmet', chest: null, legs: null, feet: null, mainHand: 'iron_sword', offHand: 'shield' } }
    const xbow: EntityInfo = { ...piglin, id: 10, pos: [10, 65, 0], dist: 10, held: 'crossbow' }
    const s = nether(18, [{ ...piglin, pos: [1.5, 65, 0], dist: 1.5 }, xbow], gold)
    expect(assessThreat(s).mobs).toHaveLength(0)
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: 'bastionGold', priority: 3 })).toBeNull()
    expect(shooters(s)).toHaveLength(0)
    s.memory.blacklist.push({ key: 'provoked:piglin', until: s.t + 60, reason: 'x' })
    expect(assessThreat(s).mobs).toHaveLength(2)
    expect(shooters(s).map(e => e.id)).toEqual([10])
    // Without gold, piglins stay hostile.
    expect(shooters(nether(18, [xbow])).map(e => e.id)).toEqual([10])
  })
  it('ckit-r2 r01: calm piglins do not keep a sealed-in bot waiting; the bed and the kit chest are never dug', () => {
    const gold = { equipment: { head: 'golden_helmet', chest: null, legs: null, feet: null, mainHand: 'iron_sword', offHand: 'shield' } }
    const s = nether(20, [piglin], gold)
    s.body = { ...s.body, enclosed: true }
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: null, priority: null })).toBeNull()
    s.memory.blacklist.push({ key: 'provoked:piglin', until: s.t + 60, reason: 'x' })
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: null, priority: null })?.id).toBe('hold')
    expect(['white_bed', 'red_bed', 'chest'].map(isProtected)).toEqual([true, true, true])
    expect(isProtected('obsidian')).toBe(true)
    expect(['bedrock', 'trapped_chest', 'stone'].map(isProtected)).toEqual([false, false, false])
  })
  it('ckit-r2b r02: an angry enderman is a threat at range and keeps a sealed-in bot inside up to 32 blocks', () => {
    const ender: EntityInfo = { id: 12, name: 'enderman', kind: 'hostile', pos: [8, 65, 0], dist: 8, los: true }
    expect(assessThreat(nether(20, [ender])).mobs).toHaveLength(0)
    const angry = nether(20, [{ ...ender, aggro: true }])
    expect(assessThreat(angry).primary?.e.name).toBe('enderman')
    expect(selectInterrupt(angry, new Cooldowns(() => 0), { skill: 'barterPearls', priority: 3 })?.skill).toBe('cover')
    const sealed = nether(20, [{ ...ender, pos: [20, 65, 0], dist: 20, los: false, aggro: true }])
    sealed.body = { ...sealed.body, enclosed: true }
    expect(selectInterrupt(sealed, new Cooldowns(() => 0), { skill: null, priority: null })).toMatchObject({ id: 'hold', params: { near: 21 } })
    const calm = nether(20, [{ ...ender, pos: [20, 65, 0], dist: 20, los: false }])
    calm.body = { ...calm.body, enclosed: true }
    expect(selectInterrupt(calm, new Cooldowns(() => 0), { skill: null, priority: null })).toBeNull()
  })
  it('standing on magma in the Nether is a P0 emergency; crossbow piglins are shooters for cover too', () => {
    const cd = new Cooldowns(() => 0)
    const s = nether(20, [])
    s.body = { ...s.body, floor: 'magma_block' }
    expect(selectInterrupt(s, cd, { skill: 'mine', priority: 3 })).toMatchObject({ id: 'magma', priority: 0, skill: 'stepOffMagma' })
    const xbow: EntityInfo = { ...piglin, pos: [10, 65, 0], dist: 10, held: 'crossbow' }
    expect(shooters(nether(20, [xbow])).map(e => e.name)).toEqual(['piglin'])
    expect(NETHER_MINE_Y[0]).toBeGreaterThan(31 + 5)
  })
  it('hoglins are avoided, never fought, even when the distance-scaled score would allow it', () => {
    const hog: EntityInfo = { id: 11, name: 'hoglin', kind: 'hostile', pos: [7, 65, 0], dist: 7, los: true }
    const th = assessThreat(nether(20, [hog]))
    expect(th.action).toBe('cover') // a sealed pocket on land
    expect(th.primary?.e.name).toBe('hoglin')
    const cd = new Cooldowns(() => 0)
    cd.set('cover:11', 10); cd.set('flee:11', 15)
    // Cover and flight both cooling down: still flight, never defend.
    expect(selectInterrupt(nether(20, [hog]), cd, { skill: 'barterPearls', priority: 3 })?.id).toBe('flee')
    // A ghast far off with cover cooling down draws nothing.
    const ghast: EntityInfo = { id: 12, name: 'ghast', kind: 'hostile', pos: [30, 70, 0], dist: 30, los: true }
    cd.set('cover:12', 10)
    expect(selectInterrupt(nether(20, [ghast]), cd, { skill: 'barterPearls', priority: 3 })).toBeNull()
  })
  it('gold digs wait while a piglin is within 18 blocks, in sight or not', () => {
    expect(piglinsWatching({ nearby: { entities: [{ name: 'piglin', dist: 12, los: true }] } })).toBe(1)
    // Out of the client's sight still counts (the server judges sight); beyond 18 does not.
    expect(piglinsWatching({ nearby: { entities: [{ name: 'piglin', dist: 12, los: false }, { name: 'piglin', dist: 20, los: true }] } })).toBe(1)
  })
})

describe('ghast fire (C smoke 20261006 r01: two deaths to ghasts 32–64 blocks off)', () => {
  const kit = { inventory: { iron_sword: 1, shield: 1 }, equipment: { head: 'golden_helmet', chest: null, legs: null, feet: null, mainHand: 'iron_sword', offHand: 'shield' } }
  const nether = (ents: EntityInfo[], hp = 20) => fakeState({ dim: 'the_nether', pos: [0, 65, 0], vitals: { ...fakeState().vitals, health: hp }, nearby: { entities: ents, interestBlocks: {}, hazards: [] }, ...kit })
  const ghast = (over: Partial<EntityInfo> = {}): EntityInfo => ({ id: 21, name: 'ghast', kind: 'hostile', pos: [45, 66, 0], dist: 45, los: true, ...over })
  const active = { skill: 'mine', priority: 3 as const }
  it('a ghast is a shooter to 64 blocks; beyond 32 only once it has charged at the bot', () => {
    expect(GHAST.range).toBe(64)
    expect(assessThreat(nether([ghast()])).mobs).toHaveLength(0)
    expect(assessThreat(nether([ghast({ aggro: true })])).action).toBe('cover')
    expect(assessThreat(nether([ghast({ dist: 28, pos: [28, 66, 0] })])).action).toBe('cover')
    expect(assessThreat(nether([ghast({ aggro: true, dist: 70 })])).mobs).toHaveLength(0)
    expect(assessThreat(nether([ghast({ aggro: true, los: false })])).mobs).toHaveLength(0)
    expect(shooters(nether([ghast({ dist: 60 })]))).toHaveLength(1)
  })
  it('P0 deflect: an incoming fireball, or a charging ghast in sight, with a shield carried', () => {
    const cd = new Cooldowns(() => 0)
    const charging = ghast({ charging: true, aggro: true })
    expect(selectInterrupt(nether([charging]), cd, active)).toMatchObject({ id: 'deflect', priority: 0, skill: 'deflect', params: { targetId: 21 } })
    const fb: EntityInfo = { id: 30, name: 'fireball', kind: 'other', pos: [20, 66, 0], dist: 20, closing: 25 }
    expect(deflectTarget(nether([charging, fb]))?.id).toBe(30) // the fireball first
    expect(deflectTarget(nether([{ ...fb, closing: -20 }]))).toBeNull() // flying away
    expect(deflectTarget(nether([ghast({ charging: true, los: false })]))).toBeNull()
    // Without a shield: no reflex, cover (P1) as before.
    const bare = nether([charging]); bare.inventory = { iron_sword: 1 }; bare.equipment = { ...bare.equipment, offHand: null }
    expect(wantsDeflect(bare)).toBeNull()
    expect(selectInterrupt(bare, cd, active)?.id).toBe('cover')
    // The Overworld never deflects (no ghasts); a cooling reflex falls through to cover.
    cd.set('deflect', 2)
    expect(selectInterrupt(nether([charging]), cd, active)?.id).toBe('cover')
  })
  it('fire in a cell the hitbox overlaps is a P0 emergency, not only fire at the centre column', () => {
    const s = nether([])
    s.body = { ...s.body, feet: 'air', head: 'air', inFire: true }
    expect(selectInterrupt(s, new Cooldowns(() => 0), active)).toMatchObject({ id: 'escape_fire', priority: 0 })
  })
})

describe('C dev batch 20261007-110334 fixes: bridges, piglin guard box, hoglin fight', () => {
  it('no Nether bridge block over lava or a drop deeper than 4; short gaps and towers stay allowed', () => {
    const col = (cells: BridgeCell[]) => (dy: number) => cells[dy - 1] ?? 'air'
    expect(unsafeBridge(col(['solid']))).toBe(false) // tower: the floor right below
    expect(unsafeBridge(col(['air', 'air', 'solid']))).toBe(false) // a 2-deep gap
    expect(unsafeBridge(col(['air', 'air', 'air', 'air', 'solid']))).toBe(true) // 5 deep
    expect(unsafeBridge(col(['air', 'lava']))).toBe(true) // over the lava sea
    expect(unsafeBridge(col(['air', 'unknown']))).toBe(true)
    expect(unsafeBridge(col([]))).toBe(true) // void
  })
  it('the gold-dig guard counts piglins in the vanilla box (inflate 16), not an 18-block sphere', () => {
    const at = (pos: V3) => ({ name: 'piglin', dist: Math.hypot(...pos), los: true, pos })
    const s = (ents: ReturnType<typeof at>[]) => ({ pos: [0, 0, 0] as V3, nearby: { entities: ents } })
    expect(piglinsWatching(s([at([14, 8, 12])]))).toBe(1) // 20 blocks away, inside the box
    expect(piglinsWatching(s([at([17, 0, 0])]))).toBe(1) // margin for movement
    expect(piglinsWatching(s([at([19, 0, 0])]))).toBe(0)
    expect(piglinsWatching(s([at([0, 20, 0])]))).toBe(0)
  })
  it('guarded hoglin fight: strike only while every hoglin in reach has just attacked', () => {
    const last = new Map([[1, 1000], [2, 100]])
    expect(strikeWindow([1], last, 1500)).toBe(true) // 0.5 s after its attack
    expect(strikeWindow([1], last, 2500)).toBe(false) // its next attack is due
    expect(strikeWindow([1, 2], last, 1500)).toBe(false) // the second one has not just attacked
    expect(strikeWindow([3], last, 1500)).toBe(false) // never attacked yet: guard
    expect(strikeWindow([], last, 1500)).toBe(false)
    expect(GUARD_FIGHT_MOBS.has('hoglin') && GUARD_FIGHT_MOBS.has('zoglin') && !GUARD_FIGHT_MOBS.has('magma_cube')).toBe(true)
  })
})

describe('Nether trail (observer) and the way back', () => {
  function fakeObserver (): Observer {
    const bot = { registry: { blocksArray: [] }, on: () => {} } as never
    const o = new Observer(bot, fakeEnv().bus)
    o.memory.trail = { since: 0, points: [[0, 70, 0]] }
    return o
  }
  it('records a point every 6 blocks and erases loops', () => {
    const o = fakeObserver()
    o.extendTrail([3, 70, 0])
    expect(o.memory.trail!.points).toHaveLength(1)
    for (const x of [6, 12, 18, 24]) o.extendTrail([x, 70, 0])
    o.extendTrail([24, 70, 6]); o.extendTrail([18, 70, 8]); o.extendTrail([13, 70, 2])
    // Back within reach of the point at x 12: the loop through x 18–24 is dropped.
    expect(o.memory.trail!.points.map(p => p[0])).toEqual([0, 6, 12])
  })
  it('resumes from the trail point nearest the portal among those close to the bot', () => {
    const pts: [number, number, number][] = [[0, 70, 0], [6, 70, 0], [12, 70, 0], [12, 70, 6], [6, 70, 6]]
    expect(trailIndex(pts, [7, 70, 4])).toBe(1)
    expect(trailIndex(pts, [30, 70, 0])).toBe(2)
    expect(trailIndex(pts, [100, 70, 0])).toBe(-1)
  })
})

describe('C report statistics', () => {
  it('counts barter, blaze, search and trail events', () => {
    const ev = [
      { t: 1, type: 'fortress', data: { kind: 'search' } },
      { t: 2, type: 'fortress', data: { kind: 'leg', for: 'fortress', via: 'path', ok: true } },
      { t: 3, type: 'barter', data: { kind: 'give' } }, { t: 4, type: 'barter', data: { kind: 'give' } },
      { t: 5, type: 'barter', data: { kind: 'pearls', gained: 6 } },
      { t: 5.5, type: 'item_delta', data: { delta: { ender_pearl: 6, gravel: 9 } } },
      { t: 5.6, type: 'item_delta', data: { delta: { ender_pearl: -6 } } },
      { t: 6, type: 'blaze', data: { kind: 'kill' } }, { t: 7, type: 'blaze', data: { kind: 'retreat' } },
      { t: 8, type: 'objective', data: { id: 'c_pearls', strategy: 'endermen' } },
      { t: 9, type: 'trail', data: { kind: 'done' } },
      { t: 10, type: 'recovery_step', data: { action: 'resupply' } },
    ]
    expect(cRunStats(ev)).toMatchObject({ searchLegs: 1, barterGiven: 2, barterPearls: 6, blazeKills: 1, blazeRetreats: 1, endermenStrategy: true, trail: { done: 1 }, resupplies: 1, legsVia: { 'fortress:path:ok': 1 } })
  })
})

describe('C round 2 helpers: replacement kit, barter spot, anger box, chest loot, route', () => {
  it('the kit takes spares only: never the best sword, the trip tables, the trip food or the last 32 cobblestone', async () => {
    const { stashPlan } = await import('../../src/skills/progression/stash.js')
    const inv = { iron_sword: 1, stone_sword: 1, stone_pickaxe: 5, crafting_table: 3, cooked_beef: 10, cooked_porkchop: 3, cobblestone: 100, golden_helmet: 1, golden_boots: 1, shield: 1 }
    expect(stashPlan(inv, ['golden_helmet', null, null, 'iron_boots'])).toEqual({ stone_sword: 1, stone_pickaxe: 2, crafting_table: 1, cooked_beef: 4, cobblestone: 32, golden_boots: 1 })
    // Only sword a stone one, no surplus food, one golden piece: none of those go in.
    expect(stashPlan({ stone_sword: 1, cooked_beef: 8, cobblestone: 40, golden_helmet: 1 }, ['golden_helmet'])).toEqual({ cobblestone: 8 })
  })
  it('barter spot: stay on a safe cell, else step to the nearest one away from lava', async () => {
    const { barterSpot } = await import('../../src/skills/progression/nether-plan.js')
    const floor = (x: number, y: number, z: number) => (y <= 69 ? 'netherrack' : 'air')
    expect(barterSpot(mapView(floor), [0, 70, 0])).toEqual([0, 70, 0])
    const lava = mapView((x, y, z) => (y === 69 && x <= 1 ? 'lava' : y <= 69 ? 'netherrack' : 'air'))
    const spot = barterSpot(lava, [0, 70, 0])
    expect(spot).not.toBeNull()
    expect(spot![0]).toBeGreaterThanOrEqual(5)
  })
  it('anger box (1.16.1 player box grown by 16) and chest loot', async () => {
    const { piglinsInBox, wantedLoot } = await import('../../src/skills/progression/bastion.js')
    const pig = (pos: V3, los?: boolean): EntityInfo => ({ id: 1, name: 'piglin', kind: 'hostile', pos, dist: 0, los })
    const s = (e: EntityInfo[]) => ({ pos: [0, 70, 0] as V3, nearby: { entities: e, interestBlocks: {}, hazards: [] } })
    expect(piglinsInBox(s([pig([17, 70, 17])]))).toBe(1)
    expect(piglinsInBox(s([pig([19, 70, 0])]))).toBe(0)
    // A chest angers only piglins that see the player.
    expect(piglinsInBox(s([pig([5, 70, 0], false)]), true)).toBe(0)
    expect(piglinsInBox(s([pig([5, 70, 0], true)]), true)).toBe(1)
    expect(wantedLoot('gold_block', {})).toBe(true)
    expect(wantedLoot('string', {})).toBe(false)
    expect(wantedLoot('golden_boots', { golden_helmet: 1 })).toBe(true)
    expect(wantedLoot('golden_boots', { golden_helmet: 1, golden_boots: 1 })).toBe(false)
  })
  it('report: the route a run took and the death → re-entry time', () => {
    const ev = (t: number, type: string, data: Record<string, unknown>) => ({ t, type, data })
    const evs = [
      ev(10, 'objective', { id: 'c_food', skill: 'obtain' }),
      ev(20, 'dimension_change', { to: 'the_nether', cause: 'portal' }),
      ev(21, 'location_discovered', { kind: 'bastion', dim: 'the_nether' }),
      ev(22, 'objective', { id: 'c_structure', skill: 'findFortress' }),
      ev(30, 'objective', { id: 'c_gold', skill: 'bastionGold' }),
      ev(31, 'bastion', { kind: 'gold_block', picked: true }),
      ev(32, 'bastion', { kind: 'chest', ingots: 5 }),
      ev(40, 'death', {}),
      ev(400, 'dimension_change', { to: 'the_nether', cause: 'portal' }),
    ]
    expect(cRunStats(evs)).toMatchObject({ route: 'search→bastion-first', firstStructure: { kind: 'bastion', t: 21 }, bastionBlocks: 1, bastionChestIngots: 5, cDeaths: 1, recoveries: [360] })
    // Fortress known, gold from ore for the fire resistance potion first: still the fortress route.
    const entry = [ev(0, 'objective', { id: 'c_food', skill: 'obtain' }), ev(0.5, 'dimension_change', { to: 'the_nether', cause: 'portal' })]
    expect(cRunStats([...entry, ev(1, 'objective', { id: 'c_gold', skill: 'obtain' }), ev(2, 'objective', { id: 'c_fire_res', skill: 'barterPearls' })]).route).toBe('fortress-first')
    expect(cRunStats([...entry, ev(1, 'objective', { id: 'c_gold', skill: 'obtain' }), ev(2, 'objective', { id: 'c_pearls', skill: 'barterPearls' })]).route).toBe('piglins/ore')
    // The structure search never ends a run (persistent, like c_fortress).
    expect(C_REQUIREMENTS.find(r => r.id === 'c_structure')?.persistent).toBe(true)
  })
})
