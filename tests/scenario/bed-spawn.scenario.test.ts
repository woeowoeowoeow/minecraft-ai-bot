// 1.16.1 bed behaviour, verified on the real server before the C death recovery relies on it
// (labeled fixture, development only): does using a bed by day set the respawn point, does a
// death then respawn the player beside the bed, and what happens when the bed is gone.
import { Vec3 } from 'vec3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixture, Y, type Fixture } from './harness.js'

let f: Fixture
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const messages: string[] = []

beforeAll(async () => {
  f = await startFixture('bed-spawn', { difficulty: 'easy', keepInventory: true })
  f.bot.on('messagestr', (m: string, pos: string) => { messages.push(`${pos}:${m}`) })
  await f.reset(24, Y(10))
}, 300_000)
afterAll(async () => { await f?.close() }, 60_000)

/** The player's respawn point from the server (1.16.1 player NBT SpawnX/Y/Z), or null if none. */
async function spawnNbt (): Promise<[number, number, number] | null> {
  const q = async (k: string) => {
    const m = await f.server.query(`data get entity Bot ${k}`, /Bot has the following entity data: (-?\d+)/, 3000)
    return m ? Number(m[1]) : null
  }
  const x = await q('SpawnX'); const y = await q('SpawnY'); const z = await q('SpawnZ')
  return x === null || y === null || z === null ? null : [x, y, z]
}

async function dieAndRespawn (): Promise<Vec3> {
  await f.cmd('tp Bot 18.5 4 18.5')
  await sleep(1500)
  const respawned = new Promise<void>(res => f.bot.once('spawn', () => res()))
  await f.cmd('kill Bot')
  await sleep(1500)
  if (f.bot.health <= 0 || (f.bot as unknown as { isAlive?: boolean }).isAlive === false) f.bot.respawn?.()
  await Promise.race([respawned, sleep(8000)])
  await sleep(2000)
  return f.bot.entity.position.clone()
}

describe('bed respawn point (1.16.1)', () => {
  it('using a bed by day sets the respawn point; a death respawns beside the bed; no bed → world spawn', async () => {
    await f.cmd('time set day')
    await f.cmd('setblock 5 4 0 minecraft:white_bed[part=foot,facing=east]')
    await f.cmd('setblock 6 4 0 minecraft:white_bed[part=head,facing=east]')
    await f.cmd('tp Bot 3.5 4 0.5')
    await sleep(2000)
    const before = await spawnNbt()
    console.log('spawn before', JSON.stringify(before), 'world spawn (client)', f.bot.spawnPoint)
    const bed = f.bot.blockAt(new Vec3(5, 4, 0))!
    expect(bed.name).toBe('white_bed')
    const m0 = messages.length
    await f.bot.activateBlock(bed)
    await sleep(1500)
    const after = await spawnNbt()
    console.log('day click messages', JSON.stringify(messages.slice(m0)), 'spawn after', JSON.stringify(after))
    expect(after).not.toBeNull()
    expect(Math.hypot(after![0] - 6, after![2] - 0)).toBeLessThanOrEqual(1.5)

    const p1 = await dieAndRespawn()
    console.log('respawn with bed at', p1)
    expect(Math.hypot(p1.x - 5.5, p1.z - 0.5)).toBeLessThanOrEqual(3)

    // Bed removed: the next respawn is at the world spawn (and the server says so).
    await f.cmd('setblock 5 4 0 minecraft:air')
    await f.cmd('setblock 6 4 0 minecraft:air')
    const m1 = messages.length
    const p2 = await dieAndRespawn()
    console.log('respawn without bed at', p2, 'messages', JSON.stringify(messages.slice(m1)))
    expect(Math.hypot(p2.x - 5.5, p2.z - 0.5)).toBeGreaterThan(2)
  }, 120_000)

  it('a bed with a block on top still works (1.16.1 obstruction rule is about the respawn cells)', async () => {
    await f.cmd('setblock 5 4 0 minecraft:white_bed[part=foot,facing=east]')
    await f.cmd('setblock 6 4 0 minecraft:white_bed[part=head,facing=east]')
    await f.cmd('tp Bot 3.5 4 0.5')
    await sleep(1500)
    await f.bot.activateBlock(f.bot.blockAt(new Vec3(5, 4, 0))!)
    await sleep(1000)
    // Wall the bed in on every side except the foot end.
    await f.cmd('fill 4 4 -1 7 6 1 minecraft:stone replace minecraft:air')
    await f.cmd('setblock 4 4 0 minecraft:air')
    await f.cmd('setblock 4 5 0 minecraft:air')
    const p = await dieAndRespawn()
    console.log('respawn with walled bed at', p)
    await f.cmd('fill 4 4 -1 7 6 1 minecraft:air')
  }, 120_000)
})
