// 1.16.1 enderman anger as the client sees it (labeled fixture, development only), verified on the
// real server before the threat model relies on it: which metadata index flips when an enderman
// turns on the bot (ckit-r2b r02: two deaths to an angry enderman while bartering; the bot left
// its sealed pocket while the enderman was still angry, 20 → 0 HP in 2 s each time).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { METADATA } from '../../src/version.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  f = await startFixture('enderman-anger', { difficulty: 'easy', keepInventory: true })
  rt = runtime(f)
  await f.reset(24, Y(10))
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

const md = (e: unknown) => ((e as { metadata?: unknown[] }).metadata ?? []).map((v, i) => `${i}=${JSON.stringify(v)}`).join(' ')

describe('enderman anger (1.16.1)', () => {
  it('an enderman hit by the bot flips the screaming flag, and the observer marks it aggro', async () => {
    await f.place(0, Y(0), 0, { iron_sword: 1 })
    await f.cmd('effect give Bot minecraft:resistance 60 4 true')
    await f.cmd(`summon enderman 3 ${Y(0)} 0 {PersistenceRequired:1b}`)
    await sleep(2000)
    const e = Object.values(f.bot.entities).find(x => x.name === 'enderman')!
    expect(e).toBeTruthy()
    console.log('calm', md(e))
    const calm = rt.obs.state().nearby.entities.find(x => x.name === 'enderman')
    expect(calm?.aggro).toBeFalsy()
    await f.bot.lookAt(e.position.offset(0, 1.5, 0), true)
    f.bot.attack(e)
    await sleep(1500)
    console.log('hit', md(e))
    expect(((e as unknown as { metadata: unknown[] }).metadata)[METADATA.endermanScreaming]).toBe(true)
    const angry = rt.obs.state().nearby.entities.find(x => x.name === 'enderman')
    expect(angry?.aggro).toBe(true)
    await f.cmd('kill @e[type=enderman]')
  }, 60_000)
})
