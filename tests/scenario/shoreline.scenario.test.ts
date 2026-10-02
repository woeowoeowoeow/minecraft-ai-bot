// Shoreline food risk on the real 1.16.1 server (A re-gate 20260930: 6 of 11 deaths were
// drowned at sea level during food work). Difficulty easy (drowned exist), animals allowed
// (with spawn-animals=false vanilla removes animals and fish every tick). Development only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cooldowns, selectInterrupt } from '../../src/controller/interrupts.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime

beforeAll(async () => {
  f = await startFixture('shore', { difficulty: 'easy', keepInventory: false, spawnAnimals: true })
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

describe('shoreline food risk (A re-gate 20260930: 6 of 11 deaths were drowned during food work)', () => {
  // A 3-deep sea at x ≤ -2 (the superflat floor allows no deeper), land at x > -2.
  const sea = () => f.fill(-16, Y(-3), -10, -2, Y(-1), 10, 'water')

  it('with a drowned in the sea: moves inland, skips the cod and the cow at the edge, hunts the inland cow', async () => {
    await f.reset(30, Y(30))
    await sea()
    await f.cmd(`summon minecraft:drowned -8 ${Y(-3)} 0 {PersistenceRequired:1b,NoAI:1b}`)
    await f.cmd(`summon minecraft:cod -4 ${Y(-2)} 3 {PersistenceRequired:1b,NoAI:1b}`)
    await f.cmd(`summon minecraft:cow 0 ${Y(0)} -4 {PersistenceRequired:1b,NoAI:1b}`)
    await f.cmd(`summon minecraft:cow 20 ${Y(0)} 0 {PersistenceRequired:1b,NoAI:1b}`)
    await f.place(0, Y(0), 0, { stone_sword: 1 })
    await sleep(1000)
    const mark = f.events.length
    const h = await rt.run('hunt', { item: 'raw_meat', count: 1, mobs: ['cow', 'cod'], searchSteps: 0 })
    expect(h.status).toBe('success')
    expect(rt.inv().beef ?? 0).toBeGreaterThanOrEqual(1)
    expect(rt.inv().cod ?? 0).toBe(0)
    const risk = f.events.slice(mark).filter(e => e.type === 'food_risk')
    expect(risk.some(e => e.data.kind === 'inland_relocation')).toBe(true)
    // The edge cow is alive; the inland one was taken.
    const cows = mobs('cow')
    expect(cows).toHaveLength(1)
    expect(cows[0]!.position.x).toBeLessThan(5)
    expect(mobs('cod')).toHaveLength(1)
    await f.cmd('kill @e[type=!player]')
  }, 180_000)

  it('in the sea with a drowned: flees onto land and inland (planned dry), never defends', async () => {
    await f.reset(30, Y(30))
    await sea()
    await f.place(-5, Y(-3), 0, { iron_sword: 1, shield: 1 })
    await heal()
    await f.cmd(`summon minecraft:drowned -10 ${Y(-3)} 0 {PersistenceRequired:1b,NoAI:1b}`)
    await sleep(1500)
    const s = rt.obs.state()
    expect(s.inLiquid).toBe('water')
    const i = selectInterrupt(s, new Cooldowns(() => 0), noActive)
    expect(i).toMatchObject({ id: 'flee', priority: 1 })
    const r = await rt.run('flee', i!.params)
    expect(r.status).toBe('success')
    expect(rt.obs.state().inLiquid).toBe('none')
    expect(f.bot.entity.position.x).toBeGreaterThan(5)
    await f.cmd('kill @e[type=!player]')
  }, 120_000)
})
