// Milestone B round 2 fixtures on the real 1.16.1 server (labeled fixtures; development only):
// - inventory click rejections during portal-site work (B gate 20261002: 20 INFRA failures
//   in 7 runs): digging with drops flowing in while equips move stacks into a full hotbar;
// - Mining Fatigue surviving a respawn on the client (wood stalls, r09 / part2-r01), and a
//   real fatigue zone failing fast instead of stalling;
// - a weak bot digging in from melee mobs instead of running, and staying sealed.
import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { safeEquip } from '../../src/bot/inventory-sync.js'
import { Cooldowns, selectInterrupt } from '../../src/controller/interrupts.js'
import { equipItem } from '../../src/skills/acts.js'
import { assessThreat } from '../../src/skills/survival/threat.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** FIXTURE_LOG=<file>: measured counts and event timelines (vitest hides console output). */
const note = (...a: unknown[]) => { if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n') }

beforeAll(async () => {
  f = await startFixture('bround2', { difficulty: 'easy', keepInventory: false })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

/** Hotbar full of distinct items (every equip of a main-inventory item is a click sequence), the swap items in the main inventory. */
const SITE_KIT: [string, number][] = [['iron_pickaxe', 1], ['granite', 3], ['diorite', 3], ['andesite', 3], ['gravel', 3], ['sand', 3], ['oak_planks', 3], ['stick', 3], ['torch', 3], ['cobblestone', 5], ['water_bucket', 1], ['bucket', 1], ['flint_and_steel', 1]]
const SWAP = ['cobblestone', 'water_bucket', 'bucket', 'flint_and_steel']

async function siteWall (): Promise<void> {
  await f.reset(16, Y(12))
  await f.fill(2, Y(0), -3, 2, Y(3), 3, 'cobblestone')
  await f.cmd('clear Bot')
  await f.cmd('tp Bot 0.5 4 0.5 -90 0')
  for (const [item, n] of SITE_KIT) await f.cmd(`give Bot minecraft:${item} ${n}`)
  await sleep(1500)
}

/**
 * Portal-site pattern: drops flow into the inventory (here a server-side give, as a picked-up
 * cobblestone drop would) while an equip moves a stack from the main inventory into the full
 * hotbar. Returns how many equips threw a server rejection (or anything else).
 */
async function siteWork (equip: (name: string) => Promise<unknown>, rounds: number): Promise<{ rejected: number; other: number }> {
  let rejected = 0
  let other = 0
  for (let i = 0; i < rounds; i++) {
    f.server.command('give Bot minecraft:cobblestone 1')
    await sleep((i % 4) * 15)
    for (const name of [SWAP[i % SWAP.length]!, SWAP[(i + 1) % SWAP.length]!]) {
      const cur = f.bot.inventory.selectedItem?.name ?? null
      try { await equip(name) } catch (e) { note('EQUIP_ERR', i, name, 'cursor before', cur, String((e as Error).message).slice(0, 160)); if (/rejected transaction|didn't respond/.test(String((e as Error).message))) rejected++; else other++ }
    }
  }
  await sleep(1000)
  return { rejected, other }
}

describe('inventory clicks during portal-site work (bucket and block swaps)', () => {
  it('portal-site swaps: plain Mineflayer equips can be rejected (recorded); the serialized retrying equip never fails', async () => {
    // Old path: Mineflayer's equip as the B gate code called it, without the cursor-slot fix.
    // The race is probabilistic (B round 2 fixture runs: 4, 6, 5, 0, 0 rejections), so its count
    // is recorded (FIXTURE_LOG) rather than asserted; the new path must never fail.
    f.cursorSync.enabled = false
    const old = { rejected: 0, other: 0, batches: 0 }
    while (old.rejected === 0 && old.batches < 2) {
      await siteWall()
      const r = await siteWork(async name => {
        const it = f.bot.inventory.items().find(i => i.name === name)
        if (it) await f.bot.equip(it, 'hand')
      }, 40)
      old.rejected += r.rejected
      old.other += r.other
      old.batches++
    }
    note('OLD PATH', old)
    f.cursorSync.enabled = true
    // New path: the same work through equipItem (safeEquip: serialized, waits for the resend, retries ≤ 3).
    await siteWall()
    note('CURSOR before new path', f.bot.inventory.selectedItem?.name ?? null)
    const n0 = f.events.length
    const neu = await siteWork(name => equipItem(f.bot, name, 'hand'), 40)
    const retries = f.events.slice(n0).filter(e => e.type === 'inventory_retry').length
    note('CURSOR after new path', f.bot.inventory.selectedItem?.name ?? null, 'held', f.bot.heldItem?.name)
    note('NEW PATH', JSON.stringify(neu), 'retries', retries)
    expect(neu).toEqual({ rejected: 0, other: 0 })
    // The client model agrees with the server afterwards (no lost bucket, no ghost stack).
    const inv = rt.inv()
    expect(inv.water_bucket).toBe(1)
    expect(inv.bucket).toBe(1)
    expect(inv.flint_and_steel).toBe(1)
    expect(f.bot.inventory.selectedItem).toBeNull()
    expect(f.bot.heldItem?.name).toBe(SWAP[0]) // the last equip of round 39 (SWAP[40 % 4]) is in hand
  }, 240_000)

  it('rapid back-to-back swaps from several callers never overlap and all land', async () => {
    await siteWall()
    const all = await Promise.allSettled(SWAP.flatMap(n => [safeEquip(f.bot, n), safeEquip(f.bot, n, 'hand')]))
    expect(all.filter(r => r.status === 'rejected')).toHaveLength(0)
    await sleep(500)
    expect(f.bot.heldItem?.name).toBe(SWAP.at(-1))
  }, 60_000)
})

describe('a container window the server closed but the client kept (dev batch 20261003-041048 r05)', () => {
  it('equips sent to the stale window go unanswered; the equip resets the windows and lands', async () => {
    await f.reset(12, Y(10))
    await f.cmd(`setblock 2 ${Y(0)} 0 crafting_table`)
    await f.place(0, Y(0), 0, { stone_pickaxe: 1, granite: 3, diorite: 3, andesite: 3, gravel: 3, sand: 3, oak_planks: 3, stick: 3, torch: 3, wooden_pickaxe: 1 })
    const table = f.bot.blockAt(new (await import('vec3')).Vec3(2, Y(0), 0))!
    const w = await f.bot.openBlock(table)
    // The server closes the container; the client keeps it (as after the unanswered craft click).
    f.bot.closeWindow(w)
    await sleep(500)
    ;(f.bot as unknown as { currentWindow: unknown }).currentWindow = w
    const plain = await f.bot.equip(f.bot.inventory.items().find(i => i.name === 'wooden_pickaxe')!, 'hand').then(() => 'ok', e => String(e.message))
    note('STALE WINDOW plain equip:', plain)
    ;(f.bot as unknown as { currentWindow: unknown }).currentWindow = w
    const n0 = f.events.length
    await equipItem(f.bot, 'wooden_pickaxe', 'hand')
    expect(f.bot.heldItem?.name).toBe('wooden_pickaxe')
    expect(f.bot.currentWindow).toBeNull()
    expect(f.events.slice(n0).some(e => e.type === 'inventory_retry' && e.data.windowsReset === true)).toBe(true)
  }, 120_000)
})

describe('Mining Fatigue and wood collection', () => {
  it('fatigue applied before a death is gone on the client after the respawn, and wood is collected at normal speed', async () => {
    await f.reset(16, Y(12))
    await f.fill(4, Y(0), 0, 4, Y(3), 0, 'oak_log')
    await f.place(0, Y(0), 0, {})
    await f.cmd('effect give Bot minecraft:mining_fatigue 600 2')
    await sleep(800)
    expect(rt.obs.state().vitals.effects).toContain('MiningFatigue')
    await f.cmd('kill Bot')
    const until = Date.now() + 15_000
    while (f.bot.health <= 0 && Date.now() < until) await sleep(200)
    await sleep(1500)
    await f.cmd('tp Bot 0.5 4 0.5')
    await sleep(1000)
    expect(rt.obs.state().vitals.effects).not.toContain('MiningFatigue')
    expect(f.events.some(e => e.type === 'effects_reset')).toBe(true)
    const t0 = Date.now()
    const r = await rt.run('collect', { block: 'log', count: 2, searchSteps: 0 })
    expect(r.status).toBe('success')
    expect(Date.now() - t0).toBeLessThan(30_000) // bare-handed logs: ~3 s each, not ~1000 s
  }, 120_000)

  it('real fatigue (alive, in range of the source) fails fast with a classified reason instead of a 60 s stall', async () => {
    await f.reset(16, Y(12))
    await f.fill(4, Y(0), 0, 4, Y(3), 0, 'oak_log')
    await f.place(0, Y(0), 0, {})
    await f.cmd('effect give Bot minecraft:mining_fatigue 600 2')
    await sleep(800)
    const t0 = Date.now()
    const r = await rt.run('collect', { block: 'log', count: 2, searchSteps: 0 })
    expect(r.status).toBe('failure')
    expect(r.failure?.signature).toMatch(/effect=mining_fatigue/)
    expect(Date.now() - t0).toBeLessThan(20_000)
    await f.cmd('effect clear Bot')
  }, 120_000)

  it('an unreachable tree is skipped and blacklisted; a reachable one is collected', async () => {
    await f.reset(20, Y(14))
    // A log sealed inside a bedrock box (the closest), and an open tree further away.
    await f.fill(3, Y(2), -1, 5, Y(4), 1, 'bedrock')
    await f.cmd(`setblock 4 ${Y(3)} 0 oak_log`)
    await f.fill(-9, Y(0), 0, -9, Y(2), 0, 'oak_log')
    await f.place(0, Y(0), 0, {})
    const r = await rt.run('collect', { block: 'log', count: 2, searchSteps: 0 })
    expect(r.status).toBe('success')
    expect(rt.obs.isBlacklisted(`block:4,${Y(3)},0`)).toBe(true)
  }, 180_000)
})

describe('weak-state threat response (easy, real mobs)', () => {
  it('bare-handed with a zombie 7 blocks off: digs a sealed pocket and is not hurt there', async () => {
    await f.reset(20, Y(20))
    await f.place(0, Y(0), 0, {})
    await f.cmd('effect give Bot minecraft:instant_health 1 5')
    await f.cmd(`summon minecraft:zombie 7 ${Y(0)} 0 {PersistenceRequired:1b}`)
    const until = Date.now() + 4000
    while (assessThreat(rt.obs.state()).action !== 'cover' && Date.now() < until) await sleep(100)
    const th = assessThreat(rt.obs.state())
    expect(th.action).toBe('cover')
    expect(th.reason).toMatch(/weak: dig in/)
    const i = selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), { skill: null, priority: null })
    expect(i).toMatchObject({ id: 'cover', priority: 1 })
    const n0 = f.events.length
    const r = await rt.run('cover', i!.params)
    for (const e of f.events.slice(n0)) if (['cover', 'skill_end', 'nav_end'].includes(e.type)) note('COVER', e.type, JSON.stringify(e.data).slice(0, 300))
    note('POS', f.bot.entity.position, rt.obs.state().body)
    expect(r.status).toBe('success')
    expect(rt.obs.state().body.enclosed).toBe(true)
    const hp = f.bot.health
    await sleep(8000) // the zombie stands over the pocket
    expect(f.bot.health).toBeGreaterThanOrEqual(hp)
    // Sealed and weak: the bot holds rather than resuming its objective next to the zombie.
    expect(selectInterrupt(rt.obs.state(), new Cooldowns(() => 0), { skill: null, priority: null })).toMatchObject({ id: 'hold' })
    await f.cmd('kill @e[type=zombie]')
  }, 120_000)
})
