// Bucket and block primitives for portal work (milestone B). A bucket is used by
// the server's own raytrace from the player's look (Item.raycast, 5 blocks), so
// every use is aimed with a client-side replica of that ray (portal-plan.ts
// bucketRay) from the bot's actual eye, and its effect is verified from the
// block updates the server sends back.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { liveView, type BlockView } from '../../nav/blocks.js'
import type { V3 } from '../../schema/index.js'
import type { Location } from '../../observer/types.js'
import { awaitInventory } from '../../bot/inventory-sync.js'
import { equipItem, waitFor, withTimeout } from '../acts.js'
import { sleep } from '../runner.js'
import type { SkillCtx } from '../types.js'
import { aimPickup, aimPlace, bucketRay } from './portal-plan.js'

/** Standing eye height (1.16.1, not sneaking): the server's camera position for the raytrace. */
export const EYE = 1.62

export function count (bot: Bot, name: string): number {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

export function eyeOf (bot: Bot): V3 {
  const p = bot.entity.position
  return [p.x, p.y + ((bot.entity as { eyeHeight?: number }).eyeHeight ?? EYE), p.z]
}

export function blockName (bot: Bot, c: V3): string | null {
  return bot.blockAt(new Vec3(...c), false)?.name ?? null
}

export function isSource (bot: Bot, c: V3, fluid: 'water' | 'lava'): boolean {
  const b = bot.blockAt(new Vec3(...c), false)
  return !!b && b.name === fluid && b.metadata === 0
}

/**
 * Step to the middle of the current cell (bucket rays are planned from the cell centre; smoke
 * batch 1: 6 lava fetches failed with no ray from where the pathfinder stopped). Never sneaks
 * (that would lower the eye) and stays inside the cell.
 */
export async function centre (bot: Bot, signal: AbortSignal): Promise<void> {
  const c = bot.entity.position.floored()
  const end = Date.now() + 1200
  while (Date.now() < end) {
    const p = bot.entity.position
    const dx = c.x + 0.5 - p.x
    const dz = c.z + 0.5 - p.z
    if (Math.hypot(dx, dz) < 0.15) break
    await bot.look(Math.atan2(-dx, -dz), 0, true)
    bot.setControlState('forward', true)
    await sleep(50, signal)
    bot.setControlState('forward', false)
    await sleep(50, signal)
  }
  bot.clearControlStates()
}

/** Stop and wait until the bot stands still on the ground (the raytrace starts at its eye). */
export async function settle (bot: Bot, signal: AbortSignal): Promise<void> {
  bot.clearControlStates()
  await waitFor(() => bot.entity.onGround && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.01, 1200, signal)
  await sleep(100, signal)
}

/** A view that reports `overlay` cells (e.g. a water source about to be placed) instead of the world. */
export function overlayView (base: BlockView, overlay: Map<string, ReturnType<BlockView['at']>>): BlockView {
  return { at: (x, y, z) => overlay.get(`${x},${y},${z}`) ?? base.at(x, y, z) }
}

export const WATER_SOURCE = { name: 'water', kind: 'water', gravity: false, digMs: 0, wantsPickaxe: false, source: true, outline: false } as const

export type BucketUse = { ok: boolean; why: string }

/**
 * Use a bucket item aimed so the server's raytrace lands on `target`: place its fluid
 * into `target` (full bucket) or pick up the source at `target` (empty bucket). The
 * ray is re-checked from the eye after the look; `done` decides success from the
 * block updates that follow.
 */
export async function useBucket (ctx: SkillCtx, item: 'water_bucket' | 'lava_bucket' | 'bucket', target: V3, done: () => boolean, ms = 1500): Promise<BucketUse> {
  const bot = ctx.bot
  if (!count(bot, item)) return { ok: false, why: `no ${item}` }
  const mode = item === 'bucket' ? 'pickup' : 'place'
  const view = liveView(bot)
  const eye = eyeOf(bot)
  const pt = mode === 'place' ? aimPlace(view, eye, target) : aimPickup(view, eye, target)
  if (!pt) return { ok: false, why: 'no ray to the target from here' }
  await equipItem(bot, item, 'hand')
  bot.clearControlStates()
  await bot.lookAt(new Vec3(...pt), true)
  await sleep(150, ctx.signal) // the look reaches the server with the next movement packet
  // Re-check along the look actually held (yaw/pitch → direction) from the current eye.
  const e2 = eyeOf(bot)
  const dir = lookDir(bot.entity.yaw, bot.entity.pitch)
  const hit = bucketRay(liveView(bot), e2, dir, 5, mode)
  const lands = hit && (mode === 'pickup' ? same(hit.cell, target) : same([hit.cell[0] + hit.face[0], hit.cell[1] + hit.face[1], hit.cell[2] + hit.face[2]], target))
  if (!lands) return { ok: false, why: 'ray drifted off the target' }
  const held = count(bot, item)
  bot.activateItem()
  const ok = await waitFor(done, ms, ctx.signal)
  // The block update can arrive before the server's `set_slot` for the used bucket; the next
  // swap would then click a stale slot and be rejected (B gate 20261002: 20 portal-build
  // INFRA failures). Wait for the slot itself before returning.
  if (ok) await awaitInventory(bot, () => count(bot, item) < held, 1500)
  return { ok, why: ok ? 'ok' : 'no block change' }
}

/** Mineflayer yaw/pitch → unit look vector (yaw 0 faces −z, increasing counter-clockwise). */
export function lookDir (yaw: number, pitch: number): V3 {
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
}

function same (a: readonly number[], b: readonly number[]): boolean { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }

const PLACE_FACES: V3[] = [[0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]

/** Place one `item` block at `target` against any solid neighbour (block placement needs no line of sight). */
export async function placeAt (ctx: SkillCtx, item: string, target: V3): Promise<boolean> {
  const bot = ctx.bot
  const t = new Vec3(...target)
  if (bot.blockAt(t, false)?.name === item) return true
  for (const [dx, dy, dz] of PLACE_FACES) {
    const ref = bot.blockAt(t.offset(dx, dy, dz), false)
    if (!ref || ref.boundingBox !== 'block') continue
    await equipItem(bot, item, 'hand')
    bot.clearControlStates()
    try {
      await bot.lookAt(t.offset(0.5, 0.5, 0.5), true)
      await withTimeout(bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)), 5000, 'place')
    } catch { /* checked below */ }
    await sleep(100, ctx.signal)
    if (bot.blockAt(t, false)?.name === item) return true
  }
  return false
}

/** Upsert a location in the bot's memory (skills own built locations: mine entries, portals, sites). */
export function rememberLoc (ctx: SkillCtx, kind: Location['kind'], pos: V3, source: Location['source'], detail: Location['detail'], radius = 3): Location {
  const s = ctx.state()
  const ex = s.memory.locations.find(l => l.kind === kind && l.dim === s.dim && Math.hypot(l.pos[0] - pos[0], l.pos[1] - pos[1], l.pos[2] - pos[2]) <= radius)
  if (ex) {
    ex.lastSeen = s.t
    ex.source = source === 'built' ? 'built' : ex.source
    ex.detail = { ...ex.detail, ...detail }
    return ex
  }
  const loc: Location = { kind, dim: s.dim, pos, confidence: 1, source, lastSeen: s.t, detail }
  s.memory.locations.push(loc)
  ctx.log('location_discovered', { kind, pos, source, detail })
  return loc
}
