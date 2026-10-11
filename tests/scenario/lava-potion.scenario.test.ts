// The lava escape reflex uses a carried fire resistance potion first (labeled fixture, development
// only; ckit-r2b r02: fell into lava holding a splash potion of fire resistance, 13 → 0 HP in 1.8 s).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  f = await startFixture('lava-potion', { difficulty: 'easy', keepInventory: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

/** A 5 × 5 lava pool, 2 deep, in a stone basin; the bot is dropped into its centre. */
async function intoLava (potion: string): Promise<number> {
  await f.reset(24, Y(10))
  await f.cmd(`fill -3 ${Y(-3)} -3 3 ${Y(-1)} 3 minecraft:stone`)
  await f.cmd(`fill -2 ${Y(-2)} -2 2 ${Y(-1)} 2 minecraft:lava`)
  await f.place(10, Y(0), 0, {})
  await f.cmd('effect clear Bot')
  // Full health (the previous test's burn is not healed by the reset).
  await f.cmd('effect give Bot minecraft:instant_health 1 5 true')
  await f.cmd(`give Bot ${potion} 1`)
  await sleep(1500)
  await f.cmd('effect clear Bot')
  await sleep(500)
  console.log('before', JSON.stringify(rt.obs.state().vitals.effects), 'hp', f.bot.health, JSON.stringify(rt.inv()))
  const t0 = f.events.length
  await f.cmd(`tp Bot 0.5 ${Y(-1)} 0.5`)
  await sleep(150)
  return t0
}

describe('lava escape with a fire resistance potion', () => {
  beforeEach(async () => { await f.cmd('kill @e[type=!player]') })
  it('throws a splash potion of fire resistance at once, then leaves the lava', async () => {
    const t0 = await intoLava('minecraft:splash_potion{Potion:"minecraft:fire_resistance"}')
    const r = await rt.run('escapeLava', {})
    const ev = f.events.slice(t0).filter(e => e.type === 'lava_potion')
    console.log('splash', r.status, JSON.stringify(ev.map(e => e.data)), 'hp', f.bot.health)
    expect(ev[0]?.data).toMatchObject({ kind: 'splash', ok: true })
    expect(r.status).toBe('success')
    expect(f.bot.health).toBeGreaterThan(10)
  }, 60_000)
  it('drinks a fire resistance potion when healthy (above LAVA_DRINK_HP)', async () => {
    const t0 = await intoLava('minecraft:potion{Potion:"minecraft:fire_resistance"}')
    const r = await rt.run('escapeLava', {})
    const ev = f.events.slice(t0).filter(e => e.type === 'lava_potion')
    console.log('drink', r.status, JSON.stringify(ev.map(e => e.data)), 'hp', f.bot.health)
    expect(ev[0]?.data).toMatchObject({ kind: 'drink', ok: true })
    expect(r.status).toBe('success')
    // Marginal: lava keeps burning for the 1.6 s of drinking (18 → 2 HP in the first run).
    expect(f.bot.health).toBeGreaterThan(0)
  }, 60_000)
})
