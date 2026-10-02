// Milestone A acquisition mechanics on the real 1.16.1 server: smelting, the
// crafting chain with table placement and retrieval, shield and armor
// equipment, excavation to buried iron, tool breakage and replacement, hunting
// and cooking, filling a water bucket. Labeled fixtures: development only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime

beforeAll(async () => {
  f = await startFixture('acq', { spawnAnimals: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('smelt (1.16.1: iron ore drops the ore block)', () => {
  it('smelts iron ore with coal in a placed furnace and takes the furnace back', async () => {
    await f.reset(12, Y(10))
    await f.place(0, Y(0), 0, { iron_ore: 3, coal: 1, furnace: 1, wooden_pickaxe: 1 })
    const r = await rt.run('smelt', { item: 'iron_ingot', count: 3, input: 'iron_ore' })
    expect(r.status).toBe('success')
    expect(rt.inv().iron_ingot).toBe(3)
    expect(rt.inv().furnace).toBe(1)
  }, 120_000)
})

describe('obtain: crafting chain', () => {
  it('wooden pickaxe from logs: planks, sticks, a placed table that is carried on', async () => {
    await f.reset(12, Y(10))
    await f.place(0, Y(0), 0, { oak_log: 3 })
    const r = await rt.run('obtain', { item: 'wooden_pickaxe', count: 1 })
    expect(r.status).toBe('success')
    const inv = rt.inv()
    expect(inv.wooden_pickaxe).toBe(1)
    expect(inv.crafting_table).toBe(1) // retrieved after use
  }, 120_000)

  it('shield from logs and one ingot, then worn in the off-hand with iron armor', async () => {
    await f.reset(12, Y(10))
    await f.place(0, Y(0), 0, { oak_log: 2, iron_ingot: 1, crafting_table: 1, iron_helmet: 1 })
    const r = await rt.run('obtain', { item: 'shield', count: 1 })
    expect(r.status).toBe('success')
    expect(rt.inv().shield).toBe(1)
    const e = await rt.run('equipGear', {})
    expect(e.status).toBe('success')
    await sleep(500)
    expect(f.bot.inventory.slots[45]?.name).toBe('shield')
    expect(f.bot.inventory.slots[5]?.name).toBe('iron_helmet')
    expect(rt.obs.state().armor).toBe(2)
  }, 120_000)
})

describe('mixed planks (vanilla #planks tag)', () => {
  it('crafts a shield from 3 oak and 3 spruce planks', async () => {
    await f.reset(12, Y(30))
    await f.place(0, Y(0), 0, { oak_planks: 3, spruce_planks: 3, iron_ingot: 1, crafting_table: 1 })
    const r = await rt.run('craft', { item: 'shield', count: 1 })
    expect(r.status).toBe('success')
    expect(rt.inv().shield).toBe(1)
  }, 90_000)
})

/** A stone hill with buried iron ore near its base: the bot starts on top. */
async function ironHill (f: Fixture): Promise<void> {
  await f.fill(-10, Y(0), -10, 10, Y(24), 10, 'stone')
  for (const [x, y, z] of [[6, 3, 5], [7, 3, 5], [6, 4, 5]]) await f.cmd(`setblock ${x} ${Y(y)} ${z} minecraft:iron_ore`)
}

describe('mining (controlled excavation, not cave search)', () => {
  it('excavates down to buried iron ore and mines it', async () => {
    await f.reset(14, Y(30))
    await ironHill(f)
    await f.place(0, Y(25), 0, { stone_pickaxe: 2 })
    const r = await rt.run('mine', { blocks: ['iron_ore'], item: 'iron_ore', count: 3 })
    expect(r.status).toBe('success')
    expect(rt.inv().iron_ore).toBe(3)
    expect(rt.obs.memory.locations.some(l => l.kind === 'mine_entry')).toBe(true)
  }, 240_000)

  it('recovers from a pickaxe breaking mid-excavation by crafting a replacement', async () => {
    await f.reset(14, Y(30))
    await ironHill(f)
    // 5 uses left: breaks during the descent.
    await f.place(0, Y(25), 0, { stick: 2, crafting_table: 1 })
    await f.cmd('give Bot minecraft:stone_pickaxe{Damage:126} 1')
    await sleep(800)
    const r = await rt.run('obtain', { item: 'iron_ore', count: 3 })
    expect(r.status).toBe('success')
    expect(rt.inv().iron_ore).toBe(3)
    expect(f.events.some(e => e.type === 'recovery_step' && /replan after MISSING_RESOURCE/.test(String(e.data.what)))).toBe(true)
  }, 300_000)
})

describe('food', () => {
  it('hunts cows (babies skipped) and cooks the meat', async () => {
    await f.reset(20, Y(30))
    for (const [x, z] of [[6, 4], [-5, 7], [4, -6]]) await f.cmd(`summon minecraft:cow ${x} ${Y(0)} ${z}`)
    await f.cmd(`summon minecraft:cow 2 ${Y(0)} 2 {Age:-24000}`)
    await f.place(0, Y(0), 0, { stone_sword: 1, furnace: 1, coal: 1, wooden_pickaxe: 1 })
    const h = await rt.run('hunt', { item: 'raw_meat', count: 2, mobs: ['cow'] })
    expect(h.status).toBe('success')
    expect(rt.inv().beef ?? 0).toBeGreaterThanOrEqual(2)
    const baby = Object.values(f.bot.entities).find(e => e.name === 'cow')
    expect(baby).toBeDefined() // the baby is still alive
    const c = await rt.run('smelt', { item: 'cooked_food', count: 2, input: 'raw_meat' })
    expect(c.status).toBe('success')
    expect(rt.inv().cooked_beef ?? 0).toBeGreaterThanOrEqual(2)
  }, 240_000)
})

describe('fish (animal-scarce worlds, dev batches 8–9)', () => {
  it('hunts a cod near the water surface, collects it and cooks it', async () => {
    await f.reset(20, Y(30))
    // A 5×5 pond, 2 deep, beside the bot; the cod swims 1 below the surface.
    await f.fill(3, Y(-2), -2, 7, Y(-1), 2, 'water')
    await f.cmd(`summon minecraft:cod 5 ${Y(-2)} 0 {PersistenceRequired:1b,NoAI:1b}`)
    await f.place(0, Y(0), 0, { stone_sword: 1, furnace: 1, coal: 1, wooden_pickaxe: 1 })
    const h = await rt.run('hunt', { item: 'raw_meat', count: 1, mobs: ['cod'], searchSteps: 0 })
    expect(h.status).toBe('success')
    expect(rt.inv().cod ?? 0).toBeGreaterThanOrEqual(1)
    await f.nav.goto({ kind: 'near', target: [0, Y(0), 0], range: 1 }, { profile: 'overworld', timeoutMs: 20_000, signal: new AbortController().signal })
    const c = await rt.run('smelt', { item: 'cooked_food', count: 1, input: 'raw_meat' })
    expect(c.status).toBe('success')
    expect(rt.inv().cooked_cod ?? 0).toBeGreaterThanOrEqual(1)
  }, 240_000)
})

describe('preempted smelt', () => {
  it('goes back to the furnace it left items in instead of gathering them again', async () => {
    await f.reset(40, Y(30))
    await f.place(0, Y(0), 0, { beef: 3, coal: 1, furnace: 1 })
    const run = rt.run('smelt', { item: 'cooked_food', count: 3, input: 'raw_meat' })
    await sleep(3500)
    rt.runner.cancel() // an interrupt took over mid-smelt
    expect((await run).status).toBe('cancelled')
    expect(rt.obs.memory.locations.some(l => l.kind === 'furnace' && Number(l.detail?.pending ?? 0) > 0)).toBe(true)
    await f.cmd('tp Bot 20 4 0')
    await sleep(1500)
    const n0 = f.events.length
    const r = await rt.run('obtain', { item: 'cooked_food', count: 3 })
    expect(r.status).toBe('success')
    expect(rt.inv().cooked_beef).toBe(3)
    expect(f.events.slice(n0).some(e => e.type === 'skill_start' && e.data.skill === 'smelt' && Array.isArray((e.data.params as { at?: unknown }).at))).toBe(true)
    expect(f.events.slice(n0).some(e => e.type === 'skill_start' && e.data.skill === 'hunt')).toBe(false)
  }, 180_000)
})

describe('water bucket', () => {
  it('fills a bucket from an open water source', async () => {
    await f.reset(14, Y(30))
    await f.fill(4, Y(-2), -2, 7, Y(-1), 2, 'water')
    await f.place(0, Y(0), 0, { bucket: 1 })
    const r = await rt.run('fillBucket', { count: 1 })
    expect(r.status).toBe('success')
    expect(rt.inv().water_bucket).toBe(1)
  }, 120_000)
})
