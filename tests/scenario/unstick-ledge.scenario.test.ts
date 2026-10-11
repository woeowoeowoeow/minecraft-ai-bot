// The navigator's unstick move next to a ledge (labeled fixture, development only). ckit-r2b r03
// and ckit-r2c r01: an unstick jump-step toward a safe next cell carried the bot 3.5 blocks, off
// the ledge beyond it and 6.7 blocks down into lava. The move must stop within the next cell.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixture, Y, type Fixture } from './harness.js'

let f: Fixture
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  f = await startFixture('unstick-ledge', { difficulty: 'peaceful', keepInventory: true })
}, 300_000)
afterAll(async () => { await f?.close() }, 60_000)

describe('unstick move beside a ledge over lava', () => {
  for (const attempt of [1, 2]) {
    it(`attempt ${attempt}: moves at most into the next cell, never off the ledge`, async () => {
      await f.reset(24, Y(10))
      // A raised stone platform x −4 … 1 (top at Y(7), the bot at x 0 on it), then an 8-block drop
      // onto lava from x 2 on (the flat world is too shallow to dig a pit).
      await f.cmd(`fill -4 ${Y(0)} -4 1 ${Y(7)} 4 minecraft:stone`)
      await f.cmd(`fill 2 ${Y(0)} -4 8 ${Y(0)} 4 minecraft:lava`)
      await f.place(0, Y(8), 0, {})
      await sleep(1000)
      // Face east (toward the pit) so that attempt 1 prefers forward; attempt 2 prefers back (west).
      await f.bot.look(Math.atan2(-1, 0), 0, true)
      const y0 = f.bot.entity.position.y
      await (f.nav as unknown as { unstick (a: number): Promise<void> }).unstick(attempt)
      await sleep(1500)
      const p = f.bot.entity.position
      console.log('unstick', attempt, p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2))
      console.log('  ', JSON.stringify(f.events.filter(e => e.type === 'stuck_detected').slice(-1).map(e => e.data)))
      expect(p.y).toBeGreaterThanOrEqual(y0 - 0.01)
      expect(p.x).toBeLessThan(2)
    }, 60_000)
  }
  it('magma on three sides: the only way is toward the ledge, and the move stops in the next cell', async () => {
    await f.reset(24, Y(10))
    await f.cmd(`fill -4 ${Y(0)} -4 1 ${Y(7)} 4 minecraft:stone`)
    await f.cmd(`fill 2 ${Y(0)} -4 8 ${Y(0)} 4 minecraft:lava`)
    // Magma on the other three sides (stepHazard: harmful floor), so east is the only safe direction.
    for (const [x, z] of [[-1, 0], [0, -1], [0, 1]]) await f.cmd(`setblock ${x} ${Y(8)} ${z} minecraft:magma_block`)
    await f.place(0, Y(8), 0, {})
    await sleep(1000)
    await f.bot.look(Math.atan2(-1, 0), 0, true)
    const y0 = f.bot.entity.position.y
    await (f.nav as unknown as { unstick (a: number): Promise<void> }).unstick(1)
    await sleep(1500)
    const p = f.bot.entity.position
    console.log('unstick walled', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), JSON.stringify(f.events.filter(e => e.type === 'stuck_detected').slice(-1).map(e => e.data)))
    expect(p.y).toBeGreaterThanOrEqual(y0 - 0.01)
    expect(p.x).toBeLessThan(2)
  }, 60_000)
})
