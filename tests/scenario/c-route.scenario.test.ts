// Milestone C round 2 on the real 1.16.1 server (labeled fixtures, development only, never a
// gate): the opportunity order from live observation (a fortress or a bastion already known),
// bastion gold under the piglin anger rules, bartering that stops the moment 14 pearls are held,
// wool from white sheep only (the bed), and the cheap death recovery: respawn at the bed beside
// the portal, take the staged kit, re-enter wearing golden armor. Every test builds its own
// arena, kills every non-player entity and resets the bot's memory first (no order dependence).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ProgressionController } from '../../src/controller/progression.js'
import { C_FLAGS, bastionKnown, fortressKnown } from '../../src/planner/milestones.js'
import { C_MILESTONES, C_REQUIREMENTS, cDeath } from '../../src/planner/policy.js'
import type { Transition } from '../../src/observer/types.js'
import { Telemetry } from '../../src/telemetry/telemetry.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const n = (c: string) => f.cmd(`execute in minecraft:the_nether run ${c}`)
const TAG = '{IsImmuneToZombification:1b,PersistenceRequired:1b}'

beforeAll(async () => {
  f = await startFixture('c-route', { difficulty: 'easy', keepInventory: false, spawnMonsters: false, spawnAnimals: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

/** Fresh bot memory and run state for every test (the isolation the old C fixtures lacked). */
function resetRunState (): void {
  const m = rt.obs.memory
  m.locations = m.locations.filter(l => l.kind === 'spawn')
  m.netherFailed = []
  m.blacklist = []
  m.transitions = []
  m.deaths = []
  m.excursions = []
  m.trail = undefined
  m.stash = undefined
  m.cLedger = undefined
  m.explored.the_nether.clear()
  for (const k of Object.keys(rt.obs.milestones)) delete rt.obs.milestones[k]
}
beforeEach(async () => {
  await f.cmd('kill @e[type=!player]')
  resetRunState()
})

async function nfill (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Promise<void> {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
  const slab = Math.max(1, Math.floor(32_768 / ((by - ay + 1) * (bz - az + 1))))
  for (let x = ax; x <= bx; x += slab) await n(`fill ${x} ${ay} ${az} ${Math.min(bx, x + slab - 1)} ${by} ${bz} ${block}`)
}

/** Walled netherrack arena far from the other fixtures' areas: floor top y 99, air to 110. */
async function arena (x0: number, x1: number, z0: number, z1: number): Promise<void> {
  await n(`forceload add ${x0 - 1} ${z0 - 1} ${x1 + 1} ${z1 + 1}`)
  await sleep(2500)
  await nfill(x0 - 1, 95, z0 - 1, x1 + 1, 112, z1 + 1, 'netherrack')
  await nfill(x0, 100, z0, x1, 110, z1, 'air')
  await f.cmd('kill @e[type=!player]')
}

async function toNether (x: number, y: number, z: number, items: Record<string, number>, head = 'golden_helmet'): Promise<void> {
  await f.cmd('clear Bot')
  await f.cmd('effect clear Bot')
  await n(`tp Bot ${x + 0.5} ${y} ${z + 0.5} 0 0`)
  await sleep(3000)
  await f.bot.waitForChunksToLoad()
  // Memory reset only once the bot stands here: at the previous spot the observer would see that test's structures again.
  resetRunState()
  for (const [item, k] of Object.entries(items)) await f.cmd(`give Bot minecraft:${item} ${k}`)
  if (head) await f.cmd(`replaceitem entity Bot armor.head minecraft:${head}`)
  await f.cmd('effect give Bot minecraft:instant_health 1 5')
  await f.cmd('effect give Bot minecraft:saturation 1 20')
  await sleep(1500)
}

const tr = (from: Transition['from'], to: Transition['to'], t: number, cause: Transition['cause'] = 'portal'): Transition => ({ from, to, t, fromPos: [0, 4, 0], toPos: [0, 100, 0], cause })

/** B recorded and a C entry made (the C list then works in the Nether). */
function inCTrip (): void {
  const t = rt.obs.state().t
  rt.obs.milestones.A = Math.max(0, t - 300)
  rt.obs.milestones.B = Math.max(0, t - 200)
  rt.obs.memory.transitions.push(tr('overworld', 'the_nether', t - 100))
}

function controller (deadlineMs: number, target = 'C'): ProgressionController {
  const telemetry = new Telemetry(mkdtempSync(join(tmpdir(), 'croute-')), f.bus, { state: () => rt.obs.state(), digest: () => rt.obs.digest(), navRecent: () => [], voxels: () => null })
  return new ProgressionController({
    runner: rt.runner, bus: f.bus, telemetry,
    state: () => rt.obs.state(), setObjective: o => rt.obs.setObjective(o),
    requirements: C_REQUIREMENTS, milestones: C_MILESTONES, flags: C_FLAGS, target, deadline: Date.now() + deadlineMs,
    waitForRespawn: async () => { await sleep(3000) },
    resync: async () => {},
    afterDeath: () => { f.nav.stop(); rt.obs.afterDeath() },
  })
}

/** Run the controller until `until` holds for the events since start (or the deadline), then stop it. */
async function runUntil (ms: number, until: (evs: typeof f.events) => boolean): Promise<typeof f.events> {
  const n0 = f.events.length
  const ctl = controller(ms)
  const done = ctl.run()
  const end = Date.now() + ms
  while (Date.now() < end && !until(f.events.slice(n0))) await sleep(500)
  ctl.stop()
  await done
  return f.events.slice(n0)
}
const firstObjective = (evs: typeof f.events, ids: string[]) => evs.find(e => e.type === 'objective' && ids.includes(String(e.data.id)))?.data

describe('opportunity order from live observation', () => {
  it('a fortress in the loaded chunks: blaze rods are the first C objective', async () => {
    await arena(1000, 1060, -20, 20)
    // A fortress room: natural nether bricks (the observer's fortress test) and a blaze spawner.
    await nfill(1040, 99, -8, 1056, 99, 8, 'nether_bricks')
    await nfill(1040, 100, -8, 1040, 104, 8, 'nether_bricks')
    await n('setblock 1048 101 0 minecraft:spawner{SpawnData:{id:"minecraft:blaze"},Delay:20000}')
    await toNether(1005, 100, 0, { iron_sword: 1, shield: 1, iron_pickaxe: 1, cooked_beef: 16, crafting_table: 1 })
    await sleep(6000)
    expect(fortressKnown(rt.obs.state())).toBe(true)
    inCTrip()
    const evs = await runUntil(30_000, e => !!firstObjective(e, ['c_rods', 'c_gold', 'c_pearls', 'c_structure']))
    const o = firstObjective(evs, ['c_rods', 'c_gold', 'c_pearls', 'c_structure'])
    console.log('first C objective (fortress)', JSON.stringify(o))
    expect(o?.id).toBe('c_rods')
  }, 240_000)

  it('a bastion in the loaded chunks and no fortress: bastion gold is the first C objective', async () => {
    await arena(2000, 2060, -20, 20)
    await nfill(2040, 100, -6, 2040, 105, 6, 'polished_blackstone_bricks')
    await n('setblock 2039 101 0 minecraft:gold_block')
    await toNether(2005, 100, 0, { iron_sword: 1, shield: 1, iron_pickaxe: 1, cooked_beef: 16, crafting_table: 1 })
    rt.obs.memory.locations.push({ kind: 'portal_nether', dim: 'the_nether', pos: [2003, 100, 0], confidence: 1, source: 'observed', lastSeen: rt.obs.state().t })
    await sleep(6000)
    expect(bastionKnown(rt.obs.state())).toBe(true)
    expect(fortressKnown(rt.obs.state())).toBe(false)
    inCTrip()
    const evs = await runUntil(30_000, e => !!firstObjective(e, ['c_rods', 'c_gold', 'c_pearls', 'c_structure']))
    const o = firstObjective(evs, ['c_rods', 'c_gold', 'c_pearls', 'c_structure'])
    console.log('first C objective (bastion)', JSON.stringify(o))
    expect(o).toMatchObject({ id: 'c_gold', skill: 'bastionGold' })
  }, 240_000)
})

describe('bastion gold', () => {
  it('loots a chest no piglin can see, mines a gold block outside every anger box, skips the guarded one', async () => {
    await arena(3000, 3080, -12, 12)
    // Bastion walls (polished blackstone bricks) along the arena.
    await nfill(3000, 100, 12, 3080, 104, 12, 'polished_blackstone_bricks')
    // Guarded end (x 3005): a gold block beside two piglins. Open end (x 3070): a gold block and,
    // behind a wall from the piglins' side, a chest with gold.
    await n('setblock 3005 100 11 minecraft:gold_block')
    await n('setblock 3070 100 11 minecraft:gold_block')
    await nfill(3060, 100, -12, 3060, 105, 12, 'polished_blackstone_bricks')
    await nfill(3060, 100, -1, 3060, 101, 1, 'air')
    await n('setblock 3066 100 -11 minecraft:chest{Items:[{Slot:0b,id:"minecraft:gold_ingot",Count:5b},{Slot:1b,id:"minecraft:golden_boots",Count:1b},{Slot:2b,id:"minecraft:string",Count:4b}]}')
    await toNether(3040, 100, 0, { iron_sword: 1, shield: 1, iron_pickaxe: 1, cooked_beef: 16, crafting_table: 1 })
    rt.obs.memory.locations.push({ kind: 'portal_nether', dim: 'the_nether', pos: [3040, 100, 0], confidence: 1, source: 'observed', lastSeen: rt.obs.state().t })
    await n(`summon piglin 3007 100 8 {NoAI:1b,${TAG.slice(1)}`)
    await n(`summon piglin 3003 100 6 {NoAI:1b,${TAG.slice(1)}`)
    await sleep(6000)
    expect(bastionKnown(rt.obs.state())).toBe(true)
    const t0 = f.events.length
    const r = await rt.run('bastionGold', { count: 30 })
    const bev = f.events.slice(t0).filter(e => e.type === 'bastion').map(e => e.data)
    console.log('bastion', r.status, JSON.stringify(bev), JSON.stringify(rt.inv()))
    // 5 ingots from the chest + 9 from the open block; the guarded block stays.
    expect(rt.inv().gold_ingot ?? 0).toBeGreaterThanOrEqual(14)
    expect(bev.some(d => d.kind === 'chest' && Number(d.ingots) === 5)).toBe(true)
    expect(bev.some(d => d.kind === 'gold_block' && d.picked)).toBe(true)
    expect(bev.some(d => d.kind === 'guarded' && d.target === 'gold_block')).toBe(true)
    expect(f.bot.blockAt(new (await import('vec3')).Vec3(3005, 100, 11))?.name).toBe('gold_block')
    // The spare golden armor piece came with the chest loot; the string did not.
    expect(rt.inv().golden_boots ?? 0).toBe(1)
    expect(rt.inv().string ?? 0).toBe(0)
    expect(f.events.slice(t0).filter(e => e.type === 'barter' && e.data.kind === 'provoked')).toHaveLength(0)
    expect(rt.obs.state().counters.deaths).toBe(0)
  }, 360_000)
})

describe('progressive bartering', () => {
  it('stops the moment 14 pearls are held, keeping the gold not yet given', async () => {
    await arena(4000, 4030, -15, 15)
    await toNether(4015, 100, 0, { gold_ingot: 20, ender_pearl: 12, iron_sword: 1, cooked_beef: 8 })
    await n(`summon piglin 4020 100 3 ${TAG}`)
    await n(`summon piglin 4010 100 -3 ${TAG}`)
    await sleep(2500)
    const t0 = f.events.length
    const run = rt.run('barterPearls', { count: 14, searchLegs: 0 })
    // A lucky barter: two pearls arrive right after the first hand-over (given into the inventory:
    // an item summoned at the bot's feet was missed once while the bot walked to a piglin).
    const until = Date.now() + 60_000
    while (Date.now() < until && !f.events.slice(t0).some(e => e.type === 'barter' && e.data.kind === 'give')) await sleep(200)
    await f.cmd('give Bot minecraft:ender_pearl 2')
    const r = await run
    const giveEv = f.events.slice(t0).filter(e => e.type === 'barter' && e.data.kind === 'give')
    const gives = giveEv.length
    console.log('early stop', r.status, 'gives', gives, JSON.stringify(rt.inv()))
    expect(r.status).toBe('success')
    expect(rt.inv().ender_pearl ?? 0).toBeGreaterThanOrEqual(14)
    // No ingot is handed over once 14 pearls are held; only the hand-overs already made before the
    // pearls arrived (one per piglin, each admiring for ~6 s) are spent.
    expect(giveEv.every(e => (e.data.pearlsHeld as number) < 14)).toBe(true)
    expect(gives).toBeLessThanOrEqual(6)
    expect(rt.inv().gold_ingot ?? 0).toBeGreaterThanOrEqual(14)
    // The ledger the adaptive budget reads.
    expect(rt.obs.memory.cLedger?.given).toBe(gives)
  }, 240_000)
})

describe('bed wool', () => {
  it('a white-wool hunt kills the white sheep and leaves the coloured one', async () => {
    await f.reset(24, Y(10))
    await f.place(0, Y(0), 0, { iron_sword: 1 })
    await f.cmd(`summon sheep 6 ${Y(0)} 0 {Color:14b,PersistenceRequired:1b}`)
    await f.cmd(`summon sheep 9 ${Y(0)} 4 {Color:0b,PersistenceRequired:1b}`)
    await sleep(2000)
    const sheep = Object.values(f.bot.entities).filter(e => e.name === 'sheep')
    console.log('sheep metadata 16', JSON.stringify(sheep.map(e => (e as unknown as { metadata: unknown[] }).metadata[16])))
    const r = await rt.run('hunt', { item: 'white_wool', count: 1, mobs: ['sheep'], searchSteps: 0 })
    console.log('wool hunt', r.status, JSON.stringify(rt.inv()))
    expect(r.status).toBe('success')
    expect(rt.inv().white_wool ?? 0).toBeGreaterThanOrEqual(1)
    expect(rt.inv().red_wool ?? 0).toBe(0)
    expect(Object.values(f.bot.entities).filter(e => e.name === 'sheep' && e.isValid)).toHaveLength(1)
  }, 180_000)
})

describe('C death recovery', () => {
  it('bed + kit at the portal: respawn beside it, take the kit, re-enter wearing golden armor', async () => {
    await f.reset(24, Y(12))
    await f.cmd('time set day')
    // A lit obsidian portal the bot "built" (frame x −1..2 at z 10, opening x 0..1, y +1..+3).
    await f.fill(-1, Y(0), 10, 2, Y(4), 10, 'obsidian')
    await f.fill(0, Y(1), 10, 1, Y(3), 10, 'air')
    await f.cmd(`setblock 0 ${Y(1)} 10 minecraft:fire`)
    await sleep(1500)
    rt.obs.memory.locations.push({ kind: 'portal_ow', dim: 'overworld', pos: [0, Y(1), 10], confidence: 1, source: 'built', lastSeen: rt.obs.state().t, detail: { lit: true, builtAt: rt.obs.state().t } })
    await f.place(3, Y(0), 6, { iron_sword: 1, iron_pickaxe: 1, stone_pickaxe: 3, oak_planks: 24, stick: 8, cobblestone: 96, crafting_table: 3, cooked_beef: 14, golden_boots: 1, white_bed: 1, shield: 1 })
    await f.cmd('replaceitem entity Bot armor.head minecraft:golden_helmet')
    await sleep(1000)
    // B recorded; the replacement kit and the bed come before the first C entry.
    rt.obs.milestones.A = rt.obs.state().t - 300
    rt.obs.milestones.B = rt.obs.state().t - 200
    const bed = await rt.run('setSpawnBed', {})
    expect(bed.status).toBe('success')
    const kit = await rt.run('stashKit', {})
    console.log('kit', kit.status, JSON.stringify(rt.obs.memory.stash))
    expect(kit.status).toBe('success')
    expect(rt.obs.memory.stash?.items).toMatchObject({ stone_sword: 1, stone_pickaxe: 2, golden_boots: 1 })
    // The C entry happened; then a death in the Nether (here: in place, by console).
    rt.obs.memory.transitions.push(tr('overworld', 'the_nether', rt.obs.state().t - 50))
    await f.cmd('tp Bot 20 4 -20')
    await sleep(1500)
    const tDeath = Date.now()
    await f.cmd('kill Bot')
    await sleep(3500)
    if (f.bot.health <= 0) f.bot.respawn?.()
    await sleep(2500)
    const p = f.bot.entity.position
    console.log('respawned at', p)
    expect(Math.hypot(p.x - 3, p.z - 6)).toBeLessThanOrEqual(8)
    rt.obs.memory.deaths.push({ pos: [20, 4, -20], dim: 'overworld', t: rt.obs.state().t - 5, cause: 'Bot was killed' })
    rt.obs.afterDeath()
    expect(cDeath(rt.obs.state())).toBe(true)
    const evs = await runUntil(150_000, e => e.some(x => x.type === 'dimension_change' && x.data.to === 'the_nether'))
    const reentry = (Date.now() - tDeath) / 1000
    const objs = evs.filter(e => e.type === 'objective').map(e => e.data.id)
    console.log('recovery objectives', JSON.stringify(objs), 'death → Nether s', Math.round(reentry), 'inv', JSON.stringify(rt.inv()))
    expect(objs[0]).toBe('c_unstash')
    expect(evs.some(e => e.type === 'stash' && e.data.kind === 'taken')).toBe(true)
    expect(evs.some(e => e.type === 'dimension_change' && e.data.to === 'the_nether')).toBe(true)
    // Golden armor worn on arrival (piglins stay neutral).
    const worn = [f.bot.inventory.slots[5]?.name, f.bot.inventory.slots[6]?.name, f.bot.inventory.slots[7]?.name, f.bot.inventory.slots[8]?.name]
    expect(worn.some(w => w?.startsWith('golden_'))).toBe(true)
    expect(reentry).toBeLessThan(150)
    await f.cmd('execute in minecraft:overworld run tp Bot 0.5 4 0.5')
  }, 420_000)
})
