// Nether hazards from C dev batch 20261007-110334 on the real 1.16.1 server (labeled fixtures,
// development only): hoglins (two deaths and a 2 000-s pin with the dig-in cover; now a perch),
// and `nether` profile bridges over deep drops (three falls into the lava sea).
import { Vec3 } from 'vec3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cooldowns, selectInterrupt, type Priority } from '../../src/controller/interrupts.js'
import { startFixture, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const n = (c: string) => f.cmd(`execute in minecraft:the_nether run ${c}`)

beforeAll(async () => {
  // Hoglins are animals to the server: with spawn-animals=false a summoned one is removed at once.
  f = await startFixture('nether-hazards', { difficulty: 'normal', spawnMonsters: true, spawnAnimals: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

async function nfill (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Promise<void> {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
  const slab = Math.max(1, Math.floor(32_768 / ((y2 - y1 + 1) * (bz - az + 1))))
  for (let x = ax; x <= bx; x += slab) await n(`fill ${x} ${y1} ${az} ${Math.min(bx, x + slab - 1)} ${y2} ${bz} ${block}`)
}

async function toNether (x: number, y: number, z: number, items: Record<string, number>): Promise<void> {
  await f.cmd('clear Bot')
  await f.cmd('effect clear Bot')
  await n(`tp Bot ${x + 0.5} ${y} ${z + 0.5} 0 0`)
  await sleep(3000)
  await f.bot.waitForChunksToLoad()
  for (const [item, k] of Object.entries(items)) await f.cmd(`give Bot minecraft:${item} ${k}`)
  await f.cmd('replaceitem entity Bot armor.head minecraft:golden_helmet')
  await f.cmd('replaceitem entity Bot weapon.offhand minecraft:shield')
  await f.cmd('effect give Bot minecraft:instant_health 1 5')
  await f.cmd('effect give Bot minecraft:saturation 1 20')
  await sleep(1500)
}

/** The interrupt set over idle objective time; a strictly higher-priority interrupt preempts (100 ms checks). */
async function interruptLoop (ms: number): Promise<{ ids: string[]; minHp: number; deaths: number }> {
  const cd = new Cooldowns(() => rt.obs.state().t)
  const ids: string[] = []
  let minHp = 20
  const deaths0 = rt.obs.state().counters.deaths
  const end = Date.now() + ms
  const pick = (below: Priority, skill: string | null = null) => {
    const i = selectInterrupt(rt.obs.state(), cd, { skill, priority: below })
    return i && i.priority < below ? i : null
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
    if (r.status !== 'success' && r.status !== 'cancelled') cd.set(['cover', 'flee', 'defend'].includes(i.id) ? `${i.id}:${String(i.params.targetId)}` : i.id, i.id === 'cover' ? 10 : 15)
  }
  return { ids, minHp, deaths: rt.obs.state().counters.deaths - deaths0 }
}

describe('hoglins', () => {
  it('fights two hoglins behind the shield (or perches) instead of digging in, and survives', async () => {
    await n('forceload add -20 -20 20 20')
    await sleep(2500)
    await nfill(-20, 95, -20, 20, 115, 20, 'netherrack')
    await nfill(-19, 100, -19, 19, 114, 19, 'air')
    await f.cmd('kill @e[type=!player]')
    await toNether(0, 100, 0, { iron_sword: 1, netherrack: 32, stone_pickaxe: 1, cooked_beef: 16 })
    for (const x of [7, -7]) await n(`summon hoglin ${x} 100 3 {IsImmuneToZombification:1b,PersistenceRequired:1b}`)
    await sleep(1500)
    console.log('after summon', JSON.stringify(Object.values(f.bot.entities).filter(e => e !== f.bot.entity).map(e => [e.name, e.position.toString()])), f.bot.entity.position.toString(), rt.obs.dim())
    const t0 = f.events.length
    const r = await interruptLoop(100_000)
    const covers = f.events.slice(t0).filter(e => e.type === 'cover').map(e => e.data)
    const hoglins = Object.values(f.bot.entities).filter(e => e.name === 'hoglin').map(e => e.position.distanceTo(f.bot.entity.position).toFixed(1))
    console.log('hoglin perch', JSON.stringify({ minHp: r.minHp, deaths: r.deaths, ids: [...new Set(r.ids)], n: r.ids.length, y: f.bot.entity.position.y, hoglins, covers: covers.slice(0, 10) }))
    expect(r.deaths).toBe(0)
    expect(covers.some(c => (c.method === 'guard_fight' || c.method === 'perch') && c.ok === true && c.step === true)).toBe(true)
    expect(r.minHp).toBeGreaterThanOrEqual(6)
  }, 240_000)
})

describe('hoglins, harder', () => {
  it('three hoglins with a stone sword (the kit after a death): survives', async () => {
    await n('forceload add -20 -20 20 20')
    await sleep(2500)
    await nfill(-20, 95, -20, 20, 115, 20, 'netherrack')
    await nfill(-19, 100, -19, 19, 114, 19, 'air')
    await f.cmd('kill @e[type=!player]')
    await toNether(0, 100, 0, { stone_sword: 1, netherrack: 32, stone_pickaxe: 1, cooked_beef: 16 })
    for (const [x, z] of [[7, 3], [-7, 3], [0, -8]] as const) await n(`summon hoglin ${x} 100 ${z} {IsImmuneToZombification:1b,PersistenceRequired:1b}`)
    await sleep(1500)
    const t0 = f.events.length
    const r = await interruptLoop(120_000)
    const covers = f.events.slice(t0).filter(e => e.type === 'cover').map(e => e.data)
    console.log('hoglin x3', JSON.stringify({ minHp: r.minHp, deaths: r.deaths, n: r.ids.length, covers: covers.slice(0, 8) }))
    expect(r.deaths).toBe(0)
  }, 300_000)
})

describe('nether profile bridges', () => {
  it('never bridges over a deep pit: it walks around (or fails), never falls', async () => {
    // A 30-deep pit (x 3..7) across a 7-wide netherrack strip, a walkway around it at z 6..7.
    await n('forceload add -12 -12 20 12')
    await sleep(2500)
    await nfill(-12, 60, -12, 20, 112, 12, 'netherrack')
    await nfill(-11, 100, -4, 19, 108, 7, 'air')
    await nfill(3, 70, -4, 7, 99, 5, 'air')
    await f.cmd('kill @e[type=!player]')
    await toNether(0, 100, 0, { cobblestone: 64, stone_pickaxe: 1 })
    const deaths0 = rt.obs.state().counters.deaths
    const cobble0 = rt.inv().cobblestone ?? 0
    const t0 = f.events.length
    const r = await rt.env.nav.goto({ kind: 'near', target: [12, 100, 0], range: 1, mode: 'path' }, { profile: 'nether', timeoutMs: 60_000, signal: new AbortController().signal })
    const falls = f.events.slice(t0).filter(e => e.type === 'fall')
    console.log('bridge test', JSON.stringify({ ok: r.ok, cls: r.ok ? null : r.class, placed: cobble0 - (rt.inv().cobblestone ?? 0), y: f.bot.entity.position.y, falls: falls.length }))
    expect(rt.obs.state().counters.deaths).toBe(deaths0)
    expect(f.bot.entity.position.y).toBeGreaterThanOrEqual(99.5)
    expect(falls).toHaveLength(0)
    expect(cobble0 - (rt.inv().cobblestone ?? 0)).toBe(0)
    if (r.ok) expect(f.bot.entity.position.distanceTo(new Vec3(12.5, 100, 0.5))).toBeLessThan(3)
  }, 180_000)
})
