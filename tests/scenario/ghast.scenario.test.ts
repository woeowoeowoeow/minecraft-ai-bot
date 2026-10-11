// Ghast fire on the real 1.16.1 server (labeled fixture, development only): a ghast 45 blocks
// off in a tall Nether arena, the bot with sword, shield and a golden helmet. C smoke 20261006
// r01 lost two lives to ghasts the observer never saw (entities stopped at 32 blocks). Checks:
// the observer sees the ghast and its charge at 45 blocks, the P0 `deflect` reflex blocks the
// fireballs, and the interrupt set (deflect, cover, escape_fire) keeps the bot alive.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cooldowns, selectInterrupt, type Priority } from '../../src/controller/interrupts.js'
import { startFixture, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const n = (c: string) => f.cmd(`execute in minecraft:the_nether run ${c}`)

beforeAll(async () => {
  f = await startFixture('ghast', { difficulty: 'normal', spawnMonsters: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

async function nfill (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Promise<void> {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
  const slab = Math.max(1, Math.floor(32_768 / ((y2 - y1 + 1) * (bz - az + 1))))
  for (let x = ax; x <= bx; x += slab) await n(`fill ${x} ${y1} ${az} ${Math.min(bx, x + slab - 1)} ${y2} ${bz} ${block}`)
}

/** A netherrack hall 70 × 24 blocks, floor top y 99, air to y 107: a ghast (4 high) stays within 4 blocks of the bot's height, as it must to pick a target. */
async function hall (): Promise<void> {
  await n('forceload add -13 -13 61 13')
  await sleep(2500)
  await nfill(-13, 95, -13, 61, 110, 13, 'netherrack')
  await nfill(-12, 100, -12, 60, 107, 12, 'air')
  await f.cmd('kill @e[type=!player]')
}

async function setup (): Promise<void> {
  await hall()
  await f.cmd('clear Bot')
  await f.cmd('effect clear Bot')
  await n('tp Bot 0.5 100 0.5 -90 0')
  await sleep(3000)
  await f.bot.waitForChunksToLoad()
  for (const [item, k] of Object.entries({ iron_sword: 1, shield: 1, stone_pickaxe: 1, netherrack: 32, cooked_beef: 16 })) await f.cmd(`give Bot minecraft:${item} ${k}`)
  await f.cmd('replaceitem entity Bot armor.head minecraft:golden_helmet')
  await f.cmd('replaceitem entity Bot weapon.offhand minecraft:shield')
  await f.cmd('effect give Bot minecraft:instant_health 1 5')
  await f.cmd('effect give Bot minecraft:saturation 1 20')
  await sleep(1500)
  await n('summon ghast 45 101 0 {PersistenceRequired:1b}')
  await sleep(1500)
}

/**
 * A minimal controller over the interrupt set: the selected interrupt runs, one of strictly
 * higher priority preempts it (checked every 100 ms), objective time is idle. `only` limits the ids.
 */
async function interruptLoop (ms: number, only?: string[]): Promise<{ ids: string[]; minHp: number; deaths: number }> {
  const cd = new Cooldowns(() => rt.obs.state().t)
  const ids: string[] = []
  let minHp = 20
  const deaths0 = rt.obs.state().counters.deaths
  const end = Date.now() + ms
  const pick = (below: Priority, skill: string | null = null) => {
    const i = selectInterrupt(rt.obs.state(), cd, { skill, priority: below })
    return i && i.priority < below && (!only || only.includes(i.id)) ? i : null
  }
  while (Date.now() < end) {
    minHp = Math.min(minHp, f.bot.health)
    if (rt.obs.state().counters.deaths > deaths0) break
    const i = pick(3)
    if (!i) { await sleep(100); continue }
    ids.push(i.id)
    const watch = setInterval(() => { minHp = Math.min(minHp, f.bot.health); if (pick(i.priority, i.skill)) rt.runner.cancel('preempt') }, 100)
    const r = await rt.runner.run(i.skill, i.params)
    clearInterval(watch)
    if (r.status !== 'success' && r.status !== 'cancelled') cd.set(['cover', 'flee', 'defend'].includes(i.id) ? `${i.id}:${String(i.params.targetId)}` : i.id, 5)
  }
  return { ids, minHp, deaths: rt.obs.state().counters.deaths - deaths0 }
}

describe('ghast fire', () => {
  it('sees the ghast and its charge at 45 blocks; the shield reflex blocks the fireballs', async () => {
    await setup()
    const g = rt.obs.state().nearby.entities.find(e => e.name === 'ghast')
    expect(g).toBeDefined()
    expect(g!.dist).toBeGreaterThan(40)
    expect(g!.los).toBe(true)
    let fireballs = 0
    const seen = new Set<number>()
    const onSpawn = (e: { id: number; name?: string }) => { if (e.name === 'fireball' && !seen.has(e.id)) { seen.add(e.id); fireballs++ } }
    f.bot.on('entitySpawn', onSpawn)
    const t0 = f.events.length
    // Reflex only: the bot stands in the open and blocks.
    const r = await interruptLoop(30_000, ['deflect', 'escape_fire'])
    f.bot.off('entitySpawn', onSpawn)
    const deflects = f.events.slice(t0).filter(e => e.type === 'deflect').map(e => e.data)
    console.log('timeline', f.events.slice(t0).filter(e => ['damage', 'deflect', 'interrupt_start', 'skill_end'].includes(e.type)).map(e => `${e.t.toFixed(1)} ${e.type} ${JSON.stringify(e.data).slice(0, 90)}`).join('\n'))
    console.log('deflect only', JSON.stringify({ fireballs, minHp: r.minHp, deaths: r.deaths, ids: r.ids.length, deflects: deflects.slice(0, 12) }))
    expect(fireballs).toBeGreaterThanOrEqual(3) // the ghast did shoot
    expect(deflects.length).toBeGreaterThanOrEqual(2)
    // Without the reflex an idle bot here dies in ~13 s (5 fireballs, debug run 2026-10-07). With it
    // the hits are blocked, but each blocked fireball still explodes beside the bot and its fire burns.
    expect(r.deaths).toBe(0)
    expect(r.minHp).toBeGreaterThan(0)
  }, 180_000)

  it('the full interrupt set (deflect, cover, fire) keeps the bot alive under ghast fire', async () => {
    await setup()
    const t0 = f.events.length
    const probe = setInterval(() => { const g = Object.values(f.bot.entities).find(e => e.name === 'ghast'); console.log('probe', f.bot.entity.position.toString(), g?.position?.toString(), JSON.stringify(rt.obs.state().nearby.entities.find(e => e.name === 'ghast'))) }, 5000)
    const r = await interruptLoop(45_000)
    clearInterval(probe)
    const covers = f.events.slice(t0).filter(e => e.type === 'cover' && !e.data.step).map(e => e.data)
    console.log('full set', JSON.stringify({ minHp: r.minHp, deaths: r.deaths, ids: r.ids, covers: covers.slice(0, 6) }))
    expect(r.deaths).toBe(0)
    expect(r.ids.some(id => id === 'cover' || id === 'deflect')).toBe(true)
    // Fire on netherrack never burns out: in this closed hall the floor slowly fills with it
    // (one of three development runs fell to 4.8 HP between fire escapes).
    expect(r.minHp).toBeGreaterThanOrEqual(3)
  }, 180_000)
})
