// 1.16.1 protocol behaviour Mineflayer does not cover, on the real server: inventory
// resync (pre-stateId protocol) and block-break acknowledgements (ghost blocks).
// Labeled fixture: development only.
import { Vec3 } from 'vec3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseInventoryData } from '../../src/evaluation/groundtruth.js'
import { resyncInventory } from '../../src/skills/generic/craft.js'
import { startFixture, Y, type Fixture } from './harness.js'

let f: Fixture
beforeAll(async () => { f = await startFixture('inv') }, 300_000)
afterAll(async () => { await f?.close() }, 60_000)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const logs = () => f.bot.inventory.items().filter(i => i.name === 'oak_log').reduce((n, i) => n + i.count, 0)
async function serverInventory (): Promise<Record<string, number>> {
  const m = await f.server.query('data get entity Bot Inventory', /Bot has the following entity data: (\[.*\])$/, 5000)
  return m?.[1] ? parseInventoryData(m[1]) : {}
}

describe('inventory resync (1.16.1)', () => {
  it('restores a drifted client inventory from the server without changing it', async () => {
    await f.reset(8, Y(6))
    await f.place(0, Y(0), 0, { oak_log: 3 })
    expect(logs()).toBe(3)
    // Simulate drift: the client model loses the logs the server still has.
    const slot = f.bot.inventory.items().find(i => i.name === 'oak_log')!.slot
    f.bot.inventory.updateSlot(slot, null as never)
    expect(logs()).toBe(0)

    expect(await resyncInventory(f.bot)).toBe(true)
    expect(logs()).toBe(3)
    await sleep(1000)
    expect(Object.values(f.bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(f.bot.entity.position) < 6)).toHaveLength(0)
    expect(await serverInventory()).toEqual({ oak_log: 3 })

    // The server keeps accepting clicks after the rejected probe: a 2×2 craft still works.
    const planks = f.bot.registry.itemsByName.oak_planks!.id
    const recipe = f.bot.recipesFor(planks, null, 1, null)[0]!
    await f.bot.craft(recipe, 1, undefined)
    await sleep(500)
    expect(await resyncInventory(f.bot)).toBe(true)
    expect(await serverInventory()).toEqual({ oak_log: 2, oak_planks: 4 })
    expect(logs()).toBe(2)
  }, 120_000)
})

describe('block-break acknowledgement (1.16.1 ghost blocks)', () => {
  it('restores a block the server refused to break, so the client never walks into a ghost cell', async () => {
    await f.reset(8, Y(6))
    await f.cmd(`setblock 2 ${Y(0)} 0 minecraft:stone`)
    await f.cmd(`setblock 2 ${Y(0)} 2 minecraft:stone`)
    await f.place(0, Y(0), 0, { stone_pickaxe: 1 })
    await f.bot.equip(f.bot.inventory.items().find(i => i.name === 'stone_pickaxe')!, 'hand')
    const a = new Vec3(2, Y(0), 0)
    const b = new Vec3(2, Y(0), 2)
    const client = f.bot._client
    const n0 = f.events.filter(e => e.type === 'dig_ack_correction').length
    // What Mineflayer does when its dig timer fires before the server's tick count
    // agrees, twice in a row (the excavator digs a step's cells back to back): send
    // "finish" and mark the block air locally. The 1.16 server delays the first break
    // and completes it later; the second is acknowledged unbroken and never scheduled.
    const setAir = (p: Vec3) => (f.bot as unknown as { _updateBlockState (p: Vec3, s: number): void })._updateBlockState(p, 0)
    for (const p of [a, b]) {
      await f.bot.lookAt(p.offset(0.5, 0.5, 0.5), true)
      client.write('block_dig', { status: 0, location: p, face: 1 })
      client.write('block_dig', { status: 2, location: p, face: 1 })
      setAir(p)
    }
    await sleep(8000) // well past the delayed break of the first block

    const serverHas = async (p: Vec3) => (await f.server.query(`execute if block ${p.x} ${p.y} ${p.z} minecraft:stone`, /Test (passed|failed)/, 5000))?.[1] === 'passed'
    expect(await serverHas(a)).toBe(false) // delayed break completed: client and server agree on air
    expect(f.bot.blockAt(a)?.name).toBe('air')
    expect(await serverHas(b)).toBe(true) // the server never broke the second block
    expect(f.bot.blockAt(b)?.name).toBe('stone') // and the client knows it: no ghost cell
    expect(f.events.filter(e => e.type === 'dig_ack_correction').length).toBeGreaterThan(n0)
  }, 120_000)
})
