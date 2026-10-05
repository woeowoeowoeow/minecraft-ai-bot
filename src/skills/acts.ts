// Primitives (architecture §6.1 `ctx.act`): thin Mineflayer wrappers with abort + timeout.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { isRejection, isUnanswered, safeEquip } from '../bot/inventory-sync.js'
import { equipFor } from '../nav/tools.js'
import { sleep } from './runner.js'
import { SkillFailure } from './types.js'

export function withTimeout<T> (p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(h); resolve(v) }, e => { clearTimeout(h); reject(e) })
  })
}

export { bestTool, equipFor } from '../nav/tools.js'

/**
 * Longest single dig a skill waits for. Mineflayer only sends "finish digging" after its
 * own predicted break time, so a pathological prediction (Mining Fatigue III makes a log
 * take ~1000 s bare-handed) used to hold a skill until its stall watchdog fired.
 */
export const DIG_MAX_MS = 20_000

/** Mining Fatigue on the client (an elder guardian nearby, or a stale effect). */
export function miningFatigue (bot: Bot): boolean {
  const id = bot.registry.effectsByName?.MiningFatigue?.id
  return id !== undefined && Boolean((bot.entity?.effects as unknown as Record<string, unknown> | undefined)?.[id])
}

export async function dig (bot: Bot, block: Block, signal: AbortSignal): Promise<void> {
  const tool = await equipFor(bot, block)
  // Digging while airborne is 5× slower (vanilla rule): settle first, e.g. at the end of a path.
  bot.clearControlStates()
  await waitFor(() => bot.entity.onGround, 1500, signal)
  const inWater = Boolean((bot.entity as { isInWater?: boolean }).isInWater)
  const expected = block.digTime(tool?.type ?? null, false, inWater, !bot.entity.onGround, [], bot.entity.effects as never)
  if (!(expected <= DIG_MAX_MS)) {
    const fatigue = miningFatigue(bot)
    throw new SkillFailure('PRECONDITION_FAILED', `digging ${block.name} would take ${Math.round(expected / 1000)} s${fatigue ? ' (mining fatigue)' : ''}`, { key: fatigue ? 'effect=mining_fatigue' : `dig=slow,block=${block.name}` })
  }
  const onAbort = () => { try { bot.stopDigging() } catch { /* ignore */ } }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await withTimeout(bot.dig(block, true), expected * 1.5 + 4000, 'dig')
  } catch (e) {
    onAbort()
    throw e
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function findItem (bot: Bot, name: string): Item | null {
  return bot.inventory.items().find(i => i.name === name) ?? null
}

/**
 * Equip through the serialized, rejection-tolerant path (bot/inventory-sync.ts). A click
 * the server still rejects after the bounded retries is a client/server inventory
 * mismatch: STATE_INCONSISTENT (Recovery resyncs), never an uncaught INFRA error.
 */
export async function equipItem (bot: Bot, name: string, dest: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet' = 'hand'): Promise<Item> {
  if (!findItem(bot, name) && !(dest === 'off-hand' && bot.inventory.slots[45]?.name === name)) throw new Error(`no ${name} in inventory`)
  try {
    return await safeEquip(bot, name, dest)
  } catch (e) {
    if (isRejection(e) || isUnanswered(e)) throw new SkillFailure('STATE_INCONSISTENT', `equip ${name}: ${(e as Error).message}`, { key: 'inventory=rejected' })
    throw e
  }
}

const FACES: [number, number, number][] = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]

/**
 * Cells near the bot where a block can be placed: replaceable (air, plants),
 * not overlapping the bot, with a solid neighbour to place against, within reach,
 * not in or next to lava or water. Nearest first, ties broken by position.
 */
export function placementSpots (bot: Bot, radius = 2): { pos: Vec3; ref: Vec3; face: Vec3 }[] {
  const me = bot.entity.position
  const feet = me.floored()
  const out: { pos: Vec3; ref: Vec3; face: Vec3; d: number }[] = []
  const replaceable = (b: Block | null) => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'grass' || b.name === 'tall_grass' || b.name === 'fern' || b.name === 'snow')
  // Lava beside a spot ignites wooden blocks; water beside a table or furnace is harmless
  // (dev batch 11 r04: 6 bucket crafts failed with "no place" at a water edge).
  const liquid = (b: Block | null) => !!b && b.name === 'lava'
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (Math.abs(dx) <= 0 && Math.abs(dz) <= 0) continue // the bot's own column
        const pos = feet.offset(dx, dy, dz)
        if (!replaceable(bot.blockAt(pos, false))) continue
        if (FACES.some(([x, y, z]) => liquid(bot.blockAt(pos.offset(x, y, z), false)))) continue
        const center = pos.offset(0.5, 0.5, 0.5)
        const d = center.distanceTo(me.offset(0, 1.62, 0))
        if (d > 4) continue
        for (const [x, y, z] of FACES) {
          const ref = pos.offset(x, y, z)
          const rb = bot.blockAt(ref, false)
          if (!rb || rb.boundingBox !== 'block') continue
          out.push({ pos, ref, face: new Vec3(-x, -y, -z), d: d + (dy !== 0 ? 0.5 : 0) + (y === -1 ? 0 : 0.3) })
          break
        }
      }
    }
  }
  out.sort((a, b) => a.d - b.d || a.pos.x - b.pos.x || a.pos.z - b.pos.z || a.pos.y - b.pos.y)
  return out.map(({ pos, ref, face }) => ({ pos, ref, face }))
}

/**
 * No free cell around the bot (a 1×2 pocket such as the sealed dig-in, dev batch 6 r02):
 * dig one head-level wall block whose other neighbours are all solid, so the niche opens
 * nothing and the placed block fills it again. False if no wall qualifies.
 */
async function makeRoom (bot: Bot, signal: AbortSignal): Promise<boolean> {
  const feet = bot.entity.position.floored()
  const cands: { b: import('prismarine-block').Block; closed: boolean }[] = []
  for (const dy of [1, 0]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = feet.offset(dx, dy, dz)
      const b = bot.blockAt(c, false)
      if (!b || b.boundingBox !== 'block' || !b.diggable || /lava|water|chest|furnace|crafting_table|bedrock/.test(b.name)) continue
      const floor = bot.blockAt(c.offset(0, -1, 0), false)
      if (!floor || floor.boundingBox !== 'block') continue
      let liquid = false
      const closed = FACES.every(([x, y, z]) => {
        const n = c.offset(x, y, z)
        if (n.equals(feet.offset(0, dy, 0))) return true
        const nb = bot.blockAt(n, false)
        if (nb && /lava|water/.test(nb.name)) liquid = true
        return !!nb && nb.boundingBox === 'block'
      })
      if (liquid) continue
      let ms = b.digTime(null, false, false, false, [], bot.entity.effects as never)
      for (const it of bot.inventory.items()) ms = Math.min(ms, b.digTime(it.type, false, false, false, [], bot.entity.effects as never))
      if (ms > 3000) continue
      cands.push({ b, closed })
    }
  }
  // Prefer a closed niche (opens nothing; the placed block seals it again).
  const pick = cands.find(c => c.closed) ?? cands[0]
  if (!pick) return false
  await dig(bot, pick.b, signal)
  return true
}

/** No room to place a block: a structured precondition failure (Recovery relocates), not a crash. */
export class NoRoomError extends SkillFailure {
  constructor (readonly item: string) { super('PRECONDITION_FAILED', `no place to put ${item}`, { key: `place=${item}` }) }
}

/** Place `itemName` from inventory next to the bot; returns the placed block's position. */
export async function placeNear (bot: Bot, itemName: string, signal: AbortSignal): Promise<Vec3> {
  let spots = placementSpots(bot)
  if (!spots.length && await makeRoom(bot, signal)) spots = placementSpots(bot)
  if (!spots.length) throw new NoRoomError(itemName)
  let lastErr: unknown = null
  for (const spot of spots.slice(0, 4)) {
    if (signal.aborted) throw signal.reason
    await equipItem(bot, itemName, 'hand')
    bot.clearControlStates()
    try {
      await bot.lookAt(spot.ref.offset(0.5 + spot.face.x * 0.5, 0.5 + spot.face.y * 0.5, 0.5 + spot.face.z * 0.5), true)
      await withTimeout(bot.placeBlock(bot.blockAt(spot.ref, false)!, spot.face), 6000, 'place')
      const b = bot.blockAt(spot.pos, false)
      if (b && b.name === itemName) return spot.pos
    } catch (e) {
      lastErr = e
      await sleep(250, signal)
      const b = bot.blockAt(spot.pos, false)
      if (b && b.name === itemName) return spot.pos
    }
  }
  throw new Error(`could not place ${itemName}: ${String((lastErr as Error)?.message ?? lastErr)}`)
}

/** Resolves true when `pred` holds, polling every 100 ms until `ms` passes. */
export async function waitFor (pred: () => boolean, ms: number, signal: AbortSignal): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(100, signal)
  }
  return pred()
}
