// Milestone B round 3 fixtures on the real 1.16.1 server (labeled fixtures; development only).
// A-phase resource acquisition on poor terrain (re-gate 20261003: 6 of 11 failed runs never
// reached nether_ready):
// - wood on an ocean start: head for the visible coast, walk to loaded logs, go back to
//   remembered trees after a long move (r12/r15 swam 1600–2100 blocks; a respawn re-searched);
// - gravel for flint: never lake-bed gravel from the water (r05), a dry bank is mined and the
//   flint knapped from one carried block; an unreachable bank is left whole (r09);
// - food: an animal ~100 blocks off is remembered and hunted (the old memory stopped at 32);
//   a hungry bot cooks its raw meat before eating it (105 raw items eaten in the gate);
// - nights: with only the food hunt left, the night fillers run instead of sheltering.
import { appendFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cooldowns, cookPlan, selectInterrupt } from '../../src/controller/interrupts.js'
import { schedule } from '../../src/controller/schedule.js'
import { B_REQUIREMENTS, candidateObjectives, fillerObjectives } from '../../src/planner/policy.js'
import { chooseFood, cookedCount } from '../../src/skills/food.js'
import { headingDeg, surfaceProbe, surveyHeadings } from '../../src/skills/generic/search.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** FIXTURE_LOG=<file>: measured values (vitest hides console output). */
const note = (...a: unknown[]) => { if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n') }
const evs = (type: string, since: number) => f.events.slice(since).filter(e => e.type === type)

beforeAll(async () => {
  f = await startFixture('bround3', { spawnAnimals: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

/** Forget what earlier tests taught the bot (tree and animal spots, searched regions, blacklists, explored chunks). */
function forgetAll (): void {
  rt.obs.memory.locations = rt.obs.memory.locations.filter(l => l.kind === 'spawn')
  rt.obs.memory.searched = []
  rt.obs.memory.blacklist = []
  rt.obs.memory.explored.overworld.clear()
}

/** Teleport until the client is there (a large /fill keeps the server busy and a tp can be lost). */
async function placeSure (x: number, y: number, z: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await f.place(x, y, z, {})
    if (Math.hypot(f.bot.entity.position.x - (x + 0.5), f.bot.entity.position.z - (z + 0.5)) < 2) return
    await sleep(3000)
  }
  throw new Error(`could not place the bot at ${x} ${y} ${z}`)
}

/** A small oak: a 4-log trunk with a leaf crown. */
async function tree (x: number, z: number): Promise<void> {
  await f.fill(x - 2, Y(3), z - 2, x + 2, Y(4), z + 2, 'oak_leaves')
  await f.fill(x, Y(0), z, x, Y(3), z, 'oak_log')
}

describe('wood on a treeless ocean start', () => {
  it('heads for the visible coast instead of out to sea, then walks to the loaded logs', async () => {
    forgetAll()
    await f.reset(20, Y(8))
    // Ocean everywhere west of x = 30; grassland east of it; a tree at x = 185 (outside the
    // 160-block scan from the start, so one relocation is needed).
    await f.cmd('forceload add -144 -144 48 144')
    await f.fill(-140, Y(-3), -140, 30, Y(-1), 140, 'water')
    await f.cmd('forceload add 176 -16 207 16')
    await tree(185, 0)
    await placeSure(0, Y(-1), 0)
    note('ocean start position', f.bot.entity.position, f.bot.blockAt(f.bot.entity.position.floored(), false)?.name)
    expect(Math.hypot(f.bot.entity.position.x, f.bot.entity.position.z)).toBeLessThan(3)
    {
      const s = rt.obs.state()
      const probe = surfaceProbe(f.bot)
      note('probe east', [24, 48, 72, 96, 120, 144].map(d => probe(d, 0)), 'north', [24, 48, 72, 96, 120, 144].map(d => probe(0, -d)))
      const st = surveyHeadings(probe, s.pos, 'log', (cx, cz) => s.memory.explored.overworld.has(`${cx},${cz}`), [])
      note('survey', st.map(x => `${headingDeg(x.heading)}:v${x.value.toFixed(2)} w${x.water.toFixed(2)} n${x.novelty.toFixed(2)} k${x.known}`).join(' | '))
    }
    const since = f.events.length
    const r = await rt.run('collect', { block: 'log', count: 1, searchSteps: 3 })
    const rel = evs('search_relocation', since).map(e => e.data)
    note('ocean start', r.status, JSON.stringify(rel), JSON.stringify(evs('search_step', since).map(e => e.data)))
    expect(r.status).toBe('success')
    expect(rel.length).toBeGreaterThanOrEqual(1)
    const h = Number(rel[0]!.heading)
    expect(h).toBeGreaterThanOrEqual(45) // east, toward the coast
    expect(h).toBeLessThanOrEqual(135)
    expect(rt.obs.memory.searched?.some(x => x.kind === 'log')).toBe(true)
    await f.fill(176, Y(0), -8, 194, Y(5), 8, 'air')
    await f.cmd('forceload remove all')
  }, 300_000)

  it('after a long move (a respawn far away), remembered trees are walked to directly', async () => {
    forgetAll()
    await f.reset(140, Y(8))
    await tree(120, 0)
    await f.place(0, Y(0), 0, {})
    await sleep(6000) // the observer's tree scan (every 5 s) sees the tree 120 blocks off
    expect(rt.obs.memory.locations.some(l => l.kind === 'trees' && Math.abs(l.pos[0] - 120) < 8)).toBe(true)
    await f.place(-240, Y(0), 0, {})
    const since = f.events.length
    const r = await rt.run('collect', { block: 'log', count: 1, searchSteps: 2 })
    const steps = evs('search_step', since).map(e => e.data)
    note('remembered trees', r.status, JSON.stringify(steps))
    expect(r.status).toBe('success')
    expect(steps[0]).toMatchObject({ mode: 'tree_spot' })
    expect(evs('search_relocation', since)).toHaveLength(0)
  }, 300_000)
})

describe('gravel for flint', () => {
  it('lake-bed gravel is never dug from the water; a dry bank is mined and flint knapped', async () => {
    forgetAll()
    await f.reset(24, Y(8))
    // A pond: gravel bed under water, beside the bot. A dry gravel mound 11 blocks the other way.
    await f.fill(3, Y(-2), -3, 9, Y(-2), 3, 'gravel')
    await f.fill(3, Y(-1), -3, 9, Y(-1), 3, 'water')
    await f.fill(-12, Y(0), -1, -10, Y(1), 1, 'gravel')
    await f.place(0, Y(0), 0, { iron_ingot: 1 })
    const r = await rt.run('obtain', { item: 'flint_and_steel', count: 1 })
    let bed = 0
    for (let x = 3; x <= 9; x++) for (let z = -3; z <= 3; z++) if (f.bot.blockAt(new Vec3(x, Y(-2), z), false)?.name === 'gravel') bed++
    note('pond gravel left', bed, 'of 49; result', r.status)
    expect(r.status).toBe('success')
    expect(rt.inv().flint_and_steel).toBe(1)
    expect(bed).toBe(49)
  }, 240_000)

  it('carried gravel is knapped where the bot stands, with no gravel in the world', async () => {
    forgetAll()
    await f.reset(24, Y(8))
    await f.place(0, Y(0), 0, { gravel: 1 })
    const r = await rt.run('obtain', { item: 'flint', count: 1 })
    expect(r.status).toBe('success')
    expect(rt.inv().flint).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('an unreachable gravel bank is blacklisted as a whole; a reachable block is mined', async () => {
    forgetAll()
    await f.reset(24, Y(10))
    await f.fill(4, Y(0), -2, 8, Y(4), 2, 'bedrock')
    await f.fill(5, Y(1), -1, 7, Y(3), 1, 'gravel')
    // Mining targets lie at y ≥ 5 (bedrock-level guard): the reachable block sits on a stone platform.
    await f.fill(-13, Y(0), -3, -6, Y(0), 3, 'stone')
    await f.fill(-9, Y(1), 0, -9, Y(1), 0, 'gravel')
    await f.place(0, Y(0), 0, { iron_pickaxe: 1 })
    const r = await rt.run('mine', { blocks: ['gravel'], item: 'gravel', count: 1, searchSteps: 0 })
    let listed = 0
    for (let x = 5; x <= 7; x++) for (let y = Y(1); y <= Y(3); y++) for (let z = -1; z <= 1; z++) if (rt.obs.isBlacklisted(`block:${x},${y},${z}`)) listed++
    note('sealed bank blacklisted', listed, 'of 27; result', r.status)
    expect(r.status).toBe('success')
    expect(listed).toBeGreaterThanOrEqual(9)
  }, 180_000)
})

describe('food on sparse terrain', () => {
  it('a cow ~100 blocks off is remembered and hunted', async () => {
    forgetAll()
    await f.reset(120, Y(6))
    await f.cmd(`summon minecraft:cow 100 ${Y(0)} 0 {NoAI:1b,PersistenceRequired:1b}`)
    await f.place(0, Y(0), 0, { iron_sword: 1 })
    await sleep(1500)
    rt.obs.state()
    const spot = rt.obs.memory.locations.find(l => l.kind === 'animals')
    note('far cow spot', spot?.pos)
    expect(spot && Math.abs(spot.pos[0] - 100) < 4).toBe(true)
    const since = f.events.length
    const r = await rt.run('hunt', { item: 'raw_meat', count: 1, mobs: ['cow'], searchSteps: 1 })
    expect(r.status).toBe('success')
    expect(evs('search_step', since).some(e => e.data.mode === 'animal_spot')).toBe(true)
    expect(evs('search_relocation', since)).toHaveLength(0)
  }, 180_000)

  it('a hungry bot with only raw meat cooks it before eating', async () => {
    forgetAll()
    await f.reset(16, Y(6))
    await f.place(0, Y(0), 0, { porkchop: 6, furnace: 1, oak_planks: 8, stone_pickaxe: 1 })
    await f.cmd('difficulty easy') // food never drops in peaceful
    await f.cmd('effect give Bot minecraft:hunger 60 120')
    const until = Date.now() + 60_000
    while (f.bot.food > 13 && Date.now() < until) await sleep(500)
    await f.cmd('effect clear Bot')
    await f.cmd('difficulty peaceful')
    await sleep(500)
    const s = rt.obs.state()
    note('food', s.vitals.food, 'plan', cookPlan(s))
    const i = selectInterrupt(s, new Cooldowns(() => 0), { skill: null, priority: null })
    expect(i).toMatchObject({ id: 'cook', skill: 'obtain', params: { item: 'cooked_food', count: 4 } })
    const r = await rt.run(i!.skill, i!.params)
    expect(r.status).toBe('success')
    expect(cookedCount(rt.inv())).toBe(4)
    expect(rt.inv().porkchop).toBe(2)
    expect(rt.inv().furnace).toBe(1) // carried on
    // A hungry bot now eats cooked meat, not raw (peaceful has refilled the food bar meanwhile).
    expect(chooseFood(rt.inv(), 13)).toMatch(/^cooked_/)
  }, 180_000)
})

describe('night scheduling', () => {
  it('at night with only the food hunt left: cook the carried meat, mine the golden helmet, then shelter', async () => {
    forgetAll()
    await f.reset(24, Y(12))
    // Gold ore inside a stone hill (mining targets lie at y ≥ 5).
    await f.fill(5, Y(0), -3, 10, Y(5), 3, 'stone')
    await f.fill(7, Y(1), -1, 8, Y(2), 1, 'gold_ore')
    const kit = { iron_pickaxe: 1, iron_sword: 1, bucket: 1, water_bucket: 1, flint_and_steel: 1, crafting_table: 1, furnace: 1, coal: 8, stone_pickaxe: 2, stick: 4, beef: 3 }
    await f.place(0, Y(0), 0, kit)
    await f.cmd('replaceitem entity Bot armor.head minecraft:iron_helmet')
    await f.cmd('replaceitem entity Bot armor.feet minecraft:iron_boots')
    await f.cmd('replaceitem entity Bot weapon.offhand minecraft:shield')
    await sleep(500)
    expect(rt.obs.state().armor).toBe(4)
    await f.cmd('time set 14000')
    await sleep(1500)
    // A remembered lava pool completes the A kit except the cooked food.
    rt.obs.memory.locations.push({ kind: 'lava_pool', dim: 'overworld', pos: [40, 12, 40], confidence: 1, source: 'observed', lastSeen: 0, detail: { sources: 20, open: 4 } })
    const pick = () => { const s = rt.obs.state(); return schedule(candidateObjectives(B_REQUIREMENTS, s), s, fillerObjectives(B_REQUIREMENTS, s)) }
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      const sch = pick()
      note('night schedule', JSON.stringify({ chosen: sch.objective?.id ?? null, shelter: sch.shelter, filler: sch.filler, deferred: sch.deferred }))
      if (sch.shelter || !sch.objective) { order.push('shelter'); break }
      order.push(sch.objective.id)
      const r = await rt.run(sch.objective.skill, sch.objective.params)
      expect(r.status).toBe('success')
    }
    expect(order).toEqual(['cook_raw', 'pre_gold_armor', 'shelter'])
    expect(cookedCount(rt.inv())).toBe(3)
    expect(rt.inv().golden_helmet).toBe(1)
    await f.cmd('time set day')
  }, 300_000)
})

describe('burning after a lava escape (b3-smoke1 r01)', () => {
  it('the on-fire state is seen, and the water bucket puts it out and is scooped back', async () => {
    forgetAll()
    await f.reset(16, Y(6))
    await f.place(0, Y(0), 0, { water_bucket: 1 })
    await f.cmd('effect give Bot minecraft:fire_resistance 60 0 true')
    await f.cmd(`setblock 0 ${Y(0)} 0 minecraft:fire`)
    const until = Date.now() + 5000
    while (!rt.obs.state().vitals.onFire && Date.now() < until) await sleep(100)
    await f.cmd(`setblock 0 ${Y(0)} 0 minecraft:air`)
    await f.cmd('tp Bot 2.5 4 0.5')
    await sleep(300)
    expect(rt.obs.state().vitals.onFire).toBe(true)
    const r = await rt.run('extinguish', {})
    expect(r.status).toBe('success')
    expect(rt.obs.state().vitals.onFire).toBe(false)
    expect(rt.inv().water_bucket).toBe(1)
    await f.cmd('effect clear Bot')
  }, 120_000)
})
