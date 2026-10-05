// Survival interrupts on the real 1.16.1 server (difficulty easy, keepInventory
// off): P1 defend and flee chosen by the threat score, P0 lava escape and
// surfacing for air, and the death flow of the progression controller
// (abort, bundle, respawn, reset, item recovery, re-plan from the inventory).
// Labeled fixtures: development only.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cooldowns, selectInterrupt } from '../../src/controller/interrupts.js'
import { ProgressionController } from '../../src/controller/progression.js'
import { A_FLAGS } from '../../src/planner/milestones.js'
import { A_MILESTONES, A_REQUIREMENTS } from '../../src/planner/policy.js'
import { assessThreat } from '../../src/skills/survival/threat.js'
import { placeNear } from '../../src/skills/acts.js'
import { Telemetry } from '../../src/telemetry/telemetry.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime

beforeAll(async () => {
  f = await startFixture('surv', { difficulty: 'easy', keepInventory: false, spawnAnimals: false })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const noActive = { skill: null, priority: null }
const mobs = (name: string) => Object.values(f.bot.entities).filter(e => e.name === name && e.isValid)

async function heal (): Promise<void> {
  await f.cmd('effect give Bot minecraft:instant_health 1 5')
  await f.cmd('effect give Bot minecraft:saturation 1 5')
  await sleep(500)
}

describe('P1 threats', () => {
  it('defends against a zombie with a sword (threat ≤ capacity) and kills it', async () => {
    await f.reset(20, Y(30))
    await f.place(0, Y(0), 0, { stone_sword: 1 })
    await heal()
    await f.cmd(`summon minecraft:zombie 6 ${Y(0)} 0 {PersistenceRequired:1b}`)
    await sleep(1500)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'defend', priority: 1 })
    const r = await rt.run('defend', i!.params)
    expect(r.status).toBe('success')
    expect(mobs('zombie')).toHaveLength(0)
    expect(f.bot.health).toBeGreaterThan(6)
  }, 120_000)

  it('wins against two zombies with a stone sword without dropping to retreat health', async () => {
    await f.reset(20, Y(30))
    await f.place(0, Y(0), 0, { stone_sword: 1 })
    await heal()
    for (const z of [2, -2]) await f.cmd(`summon minecraft:zombie 6 ${Y(0)} ${z} {PersistenceRequired:1b}`)
    await sleep(1500)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'defend' })
    const r = await rt.run('defend', i!.params)
    expect(r.status).toBe('success')
    expect(mobs('zombie')).toHaveLength(0)
    expect(f.bot.health).toBeGreaterThan(8)
  }, 120_000)

  it('shelters at night when it has nothing to fight with: a sealed dig-in, even with no block carried', async () => {
    await f.reset(20, Y(30))
    await f.cmd('time set night')
    await f.place(0, Y(0), 0, {})
    await heal()
    await f.cmd(`summon minecraft:zombie 14 ${Y(0)} 0 {PersistenceRequired:1b,NoAI:1b}`)
    await sleep(1500)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'shelter', priority: 2 })
    const r = await rt.run('shelter', { maxMs: 4000 })
    expect(r.status).toBe('success')
    expect(Math.floor(f.bot.entity.position.y + 0.05)).toBe(Y(-3))
    // Capped with one of the dug blocks: enclosed, so P1 does not pull it out.
    expect(f.bot.blockAt(f.bot.entity.position.floored().offset(0, 2, 0))?.name).toBe('dirt')
    expect(rt.obs.state().body.enclosed).toBe(true)
    await f.cmd(`tp @e[type=zombie] 1 ${Y(0)} 0`)
    await sleep(800)
    expect(selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)?.priority ?? 3).toBeGreaterThan(1)
    await f.cmd('kill @e[type=zombie]')
    await f.cmd('time set day')
    // The pathfinder digs and towers back out of the pocket.
    const out = await f.nav.goto({ kind: 'near', target: [6, Y(0), 0], range: 1.5 }, { profile: 'overworld', timeoutMs: 30_000, signal: new AbortController().signal })
    expect(out.ok).toBe(true)
  }, 120_000)

  it('flees a crowd it cannot fight (threat > capacity)', async () => {
    await f.reset(24, Y(30))
    await f.place(0, Y(0), 0, {})
    await heal()
    for (const [x, z] of [[4, 1], [4, -1], [5, 0], [4, 2], [5, -2]]) await f.cmd(`summon minecraft:zombie ${x} ${Y(0)} ${z} {PersistenceRequired:1b}`)
    await sleep(1500)
    const th = assessThreat(rt.obs.state())
    expect(th.action).toBe('flee')
    const r = await rt.run('flee', { targetId: th.primary!.e.id })
    expect(r.status).toBe('success')
    // Clear of the crowd, or (B round 2) weak with the crowd still about: sealed in a pocket after the flight.
    const me = f.bot.entity.position
    const sealed = rt.obs.state().body.enclosed === true
    if (!sealed) for (const z of mobs('zombie')) expect(z.position.distanceTo(me)).toBeGreaterThan(9)
    const hp = f.bot.health
    await sleep(5000)
    expect(f.bot.health).toBeGreaterThanOrEqual(hp)
    await f.cmd('kill @e[type=zombie]')
  }, 120_000)
})

const SKELETON = (x: number, z: number) => `summon minecraft:skeleton ${x} ${Y(0)} ${z} {PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",Count:1b}]}`

describe('ranged threats and creepers (gate 20260929 death classes)', () => {
  it('takes terrain cover from a skeleton behind a nearby wall', async () => {
    await f.reset(24, Y(30))
    await f.fill(2, Y(0), -3, 2, Y(2), 3, 'stone')
    await f.place(5, Y(0), 0, { stone_sword: 1 })
    await heal()
    await f.cmd(SKELETON(16, 0))
    await sleep(2000)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'cover', priority: 1 })
    const r = await rt.run('cover', { ...i!.params, holdMs: 3000 })
    expect(r.status).toBe('success')
    expect(f.bot.entity.position.x).toBeLessThan(2)
    expect(f.bot.health).toBeGreaterThan(10)
    const ev = f.events.filter(e => e.type === 'cover').at(-1)
    expect(ev?.data).toMatchObject({ ok: true })
    await f.cmd('kill @e[type=skeleton]')
  }, 120_000)

  it('digs in on open ground under skeleton fire, then leaves the pocket', async () => {
    await f.reset(24, Y(30))
    await f.place(0, Y(0), 0, {})
    await heal()
    await f.cmd(SKELETON(13, 0))
    await sleep(2000)
    const r = await rt.run('cover', { holdMs: 3000 })
    expect(r.status).toBe('success')
    expect((r.outputs as { method: string }).method).toMatch(/dig_in|enclosed/)
    expect(Math.floor(f.bot.entity.position.y + 0.05)).toBe(Y(-3))
    expect(rt.obs.state().body.enclosed).toBe(true)
    expect(f.bot.health).toBeGreaterThan(8)
    await f.cmd('kill @e[type=skeleton]')
    // Crafting or smelting inside the 1×2 pocket: a niche is dug for the block (dev batch 6 r02).
    await f.cmd('give Bot minecraft:crafting_table 1')
    await sleep(500)
    const at = await placeNear(f.bot, 'crafting_table', new AbortController().signal)
    expect(f.bot.blockAt(at)?.name).toBe('crafting_table')
    const out = await f.nav.goto({ kind: 'near', target: [6, Y(0), 0], range: 1.5 }, { profile: 'overworld', timeoutMs: 30_000, signal: new AbortController().signal })
    expect(out.ok).toBe(true)
  }, 120_000)

  it('keeps its distance from a creeper even when armed (never melee), and survives', async () => {
    await f.reset(24, Y(30))
    await f.place(0, Y(0), 0, { iron_sword: 1, shield: 1 })
    await heal()
    await f.cmd(`summon minecraft:creeper 4 ${Y(0)} 0 {PersistenceRequired:1b}`)
    await sleep(1200)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'flee', priority: 1 })
    const r = await rt.run('flee', i!.params)
    expect(r.status).toBe('success')
    expect(f.bot.health).toBeGreaterThan(10)
    const c = mobs('creeper')[0]
    if (c) expect(c.position.distanceTo(f.bot.entity.position)).toBeGreaterThan(7)
    await f.cmd('kill @e[type=creeper]')
  }, 120_000)
})

describe('P0 emergencies', () => {
  it('escapes a lava pool (the unstick/lava open item)', async () => {
    await f.reset(12, Y(30))
    await f.fill(-2, Y(-1), -2, 2, Y(-1), 2, 'lava')
    await f.place(0, Y(-1), 0, {})
    await heal()
    await f.cmd('effect give Bot minecraft:resistance 20 3')
    await sleep(300)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'escape_lava', priority: 0 })
    const r = await rt.run('escapeLava', {})
    expect(r.status).toBe('success')
    expect(rt.obs.state().body.feet).not.toBe('lava')
    expect(f.bot.health).toBeGreaterThan(0)
    await f.cmd('effect clear Bot')
  }, 60_000)

  it('surfaces before drowning', async () => {
    await f.reset(12, Y(30))
    await f.fill(-3, Y(-3), -3, 3, Y(8), 3, 'stone')
    await f.fill(-1, Y(-2), -1, 1, Y(7), 1, 'water')
    await f.fill(-1, Y(8), -1, 1, Y(8), 1, 'air')
    await f.place(0, Y(-2), 0, {})
    await heal()
    // Wait until the air reflex threshold is crossed (bot holds still at the bottom).
    const t0 = Date.now()
    while (rt.obs.state().vitals.air >= 12 && Date.now() - t0 < 12_000) await sleep(200)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'surface', priority: 0 })
    const r = await rt.run('surfaceForAir', {})
    expect(r.status).toBe('success')
    expect(rt.obs.state().body.head).not.toBe('water')
  }, 60_000)
})

describe('death flow (architecture §7.4)', () => {
  it('aborts the objective, bundles, respawns, recovers the drops and re-plans from the real inventory', async () => {
    await f.reset(24, Y(30))
    await f.cmd('setworldspawn 12 4 0')
    await f.place(0, Y(0), 0, { stone_pickaxe: 1, stone_sword: 1, stick: 4, oak_log: 3 })
    await heal()
    const dir = mkdtempSync(join(tmpdir(), 'death-'))
    const telemetry = new Telemetry(dir, f.bus, { state: () => rt.obs.state(), digest: () => rt.obs.digest(), navRecent: () => [], voxels: () => null })
    const ctl = new ProgressionController({
      runner: rt.runner, bus: f.bus, telemetry,
      state: () => rt.obs.state(), setObjective: o => rt.obs.setObjective(o),
      requirements: A_REQUIREMENTS, milestones: A_MILESTONES, flags: A_FLAGS, target: 'A', deadline: Date.now() + 150_000,
      waitForRespawn: async () => { await sleep(2500) },
      resync: async () => {},
      afterDeath: () => { f.nav.stop(); rt.obs.afterDeath() },
    })
    const n0 = f.events.length
    const done = ctl.run()
    // Let it start its first objective (food: nothing to hunt on this flat world), then die by magic.
    await sleep(4000)
    await f.cmd('effect give Bot minecraft:instant_damage 1 10')
    const until = Date.now() + 90_000
    while (Date.now() < until && !f.events.slice(n0).some(e => e.type === 'recovery_step' && e.data.action === 'recover_items_end')) await sleep(500)
    ctl.stop()
    await done
    const evs = f.events.slice(n0)
    const kinds = evs.filter(e => e.type === 'recovery_step' && e.data.level === 'death').map(e => e.data.action)
    for (const e of evs) if (['death', 'recovery_step', 'objective', 'skill_end', 'chat'].includes(e.type)) console.log('DEATHFLOW', e.type, JSON.stringify(e.data).slice(0, 300))
    expect(evs.some(e => e.type === 'death')).toBe(true)
    // The death record carries the vanilla message even though it arrives before the death event.
    expect(rt.obs.memory.deaths.at(-1)?.cause).toMatch(/^Bot /)
    expect(kinds).toEqual(['reset', 'recover_items', 'recover_items_end'])
    expect(evs.find(e => e.type === 'recovery_step' && e.data.action === 'recover_items_end')?.data.status).toBe('success')
    // Everything valuable came back from the death point.
    const inv = rt.inv()
    expect(inv.stone_pickaxe).toBe(1)
    expect(inv.stone_sword).toBe(1)
    await f.cmd('setworldspawn 0 4 0')
  }, 180_000)
})
