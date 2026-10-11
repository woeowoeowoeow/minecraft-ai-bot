// Upstream pathfinder's `fullStop` re-centres the bot on the column it stands over (labeled
// fixture, development only). ckit-r2d r02: twice in the Nether the bot stood on a ledge edge,
// held up by the neighbouring block, when a dig or a reached goal called `fullStop`; the snap to
// the centre put it over open air and it fell 35–50 blocks. The snap must not leave the floor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as pfNs from 'mineflayer-pathfinder'
import { startFixture, Y, type Fixture } from './harness.js'

type PF = typeof import('mineflayer-pathfinder')
const pf: PF = ((pfNs as unknown as { default?: PF }).default ?? pfNs) as PF
const { Movements } = pf
let f: Fixture
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  f = await startFixture('recentre-ledge', { difficulty: 'peaceful', keepInventory: true })
}, 300_000)
afterAll(async () => { await f?.close() }, 60_000)

describe('pathfinder re-centring on a ledge edge', () => {
  it('a reached goal at the edge does not snap the bot over the drop', async () => {
    await f.reset(24, Y(10))
    // A raised stone platform x −4 … 0 (top at Y(7)); from x 1 on, an 8-block drop.
    await f.cmd(`fill -4 ${Y(0)} -4 0 ${Y(7)} 4 minecraft:stone`)
    await f.place(-1, Y(8), 0, {})
    await sleep(800)
    // Stand at x 1.1: the hitbox (0.8 … 1.4) still rests on the x 0 column, the centre is over air.
    await f.cmd(`tp Bot 1.1 ${Y(8)} 0.5`)
    await sleep(1500)
    const y0 = f.bot.entity.position.y
    expect(f.bot.entity.onGround).toBe(true)
    // The goal is the cell the bot is in: the next tick emits goal_reached and calls fullStop.
    f.bot.pathfinder.setMovements(new Movements(f.bot))
    f.bot.pathfinder.setGoal(new pf.goals.GoalBlock(1, Y(8), 0))
    await sleep(2000)
    f.bot.pathfinder.setGoal(null)
    const p = f.bot.entity.position
    console.log('recentre', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), JSON.stringify(f.events.filter(e => e.type === 'fall_guard' && e.data.kind === 'recentre').map(e => e.data)))
    expect(p.y).toBeGreaterThanOrEqual(y0 - 0.01)
    expect(f.events.some(e => e.type === 'fall_guard' && e.data.kind === 'recentre')).toBe(true)
  }, 60_000)
  it('re-centring on a supported column still happens', async () => {
    await f.reset(24, Y(10))
    await f.cmd(`fill -4 ${Y(0)} -4 0 ${Y(7)} 4 minecraft:stone`)
    await f.place(-1, Y(8), 0, {})
    await sleep(800)
    await f.cmd(`tp Bot -1.1 ${Y(8)} 0.5`)
    await sleep(1500)
    const before = f.events.filter(e => e.type === 'fall_guard' && e.data.kind === 'recentre').length
    f.bot.pathfinder.setMovements(new Movements(f.bot))
    f.bot.pathfinder.setGoal(new pf.goals.GoalBlock(-2, Y(8), 0))
    await sleep(2000)
    f.bot.pathfinder.setGoal(null)
    const p = f.bot.entity.position
    console.log('supported', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2))
    expect(p.x).toBeCloseTo(-1.5, 1)
    expect(f.events.filter(e => e.type === 'fall_guard' && e.data.kind === 'recentre').length).toBe(before)
  }, 60_000)

  it('a jump toward the drop is not made; a jump up a block still is', async () => {
    await f.reset(24, Y(10))
    await f.cmd(`fill -4 ${Y(0)} -4 0 ${Y(7)} 4 minecraft:stone`)
    // A one-block step at z −3 … −4 on the platform (the legitimate jump).
    await f.cmd(`fill -4 ${Y(8)} -4 0 ${Y(8)} -3 minecraft:stone`)
    await f.place(-1, Y(8), 0, {})
    await sleep(1000)
    const y0 = f.bot.entity.position.y
    // East, toward the 8-block drop, jumping (pathfinder's walk-jump beside a ledge).
    await f.bot.look(Math.atan2(-1, 0), 0, true)
    f.bot.setControlState('forward', true)
    f.bot.setControlState('jump', true)
    await sleep(1500)
    f.bot.clearControlStates()
    await sleep(800)
    let p = f.bot.entity.position
    const g = f.events.filter(e => e.type === 'fall_guard' && e.data.kind === 'controls').map(e => e.data)
    console.log('jump east', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), JSON.stringify(g))
    expect(p.y).toBeGreaterThanOrEqual(y0 - 0.01)
    expect(g.length).toBeGreaterThan(0)
    // North onto the step: allowed.
    await f.place(-1, Y(8), -1, {})
    await sleep(1000)
    await f.bot.look(0, 0, true)
    f.bot.setControlState('forward', true)
    f.bot.setControlState('jump', true)
    await sleep(1200)
    f.bot.clearControlStates()
    await sleep(800)
    p = f.bot.entity.position
    console.log('jump up', p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), JSON.stringify(f.events.filter(e => e.type === 'fall_guard').slice(g.length).map(e => e.data)))
    expect(p.y).toBeGreaterThanOrEqual(y0 + 0.99)
  }, 60_000)
})
