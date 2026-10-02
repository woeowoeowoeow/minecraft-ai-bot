import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { z } from 'zod'
import type { WorldState } from '../../observer/types.js'
import { countOf } from '../sources.js'
import { dig, placeNear, waitFor } from '../acts.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { nextSearchHeading, Searcher, toSurface } from './explore.js'

/** Block groups: a group name matches several block names; the dropped item has the block's name. */
const GROUPS: Record<string, (name: string) => boolean> = {
  log: n => n.endsWith('_log'),
}

export function blockMatcher (block: string): (name: string) => boolean {
  return GROUPS[block] ?? (n => n === block)
}

const Params = z.object({
  block: z.string(),                       // block name or group ('log')
  /** Item (or item group) to count; defaults to the block's own drop. */
  item: z.string().optional(),
  count: z.number().int().positive(),      // goal: have ≥ count of the item
  maxDist: z.number().positive().default(64),
  searchSteps: z.number().int().min(0).default(6),
  /** The item is a chance drop (flint from gravel): when no block is left, place the block item and dig it again. */
  chance: z.boolean().default(false),
})
type P = z.infer<typeof Params>

function have (s: WorldState, p: P): number {
  if (p.item) return countOf(s.inventory, p.item)
  const m = blockMatcher(p.block)
  return Object.entries(s.inventory).reduce((n, [k, v]) => (m(k) ? n + v : n), 0)
}

const MAX_TARGET_FAILURES = 5
/** Re-placements of a chance-drop block per run (gravel gives flint 10 % of the time). */
const MAX_REPLACES = 40

export { nextSearchHeading }

function candidates (bot: Bot, p: P, isBlacklisted: (k: string) => boolean): Vec3[] {
  const m = blockMatcher(p.block)
  const ids = bot.registry.blocksArray.filter(b => m(b.name)).map(b => b.id)
  const me = bot.entity.position
  return bot.findBlocks({ matching: ids, maxDistance: p.maxDist, count: 96 })
    .filter(v => !isBlacklisted(blockKey(v)))
    // Never dive for a block: one with water above it is under water (river and lake floors).
    .filter(v => !/water|kelp|seagrass|bubble_column/.test(bot.blockAt(v.offset(0, 1, 0), false)?.name ?? ''))
    // Prefer near and low targets: high logs need towering (no scaffolding at M0).
    .map(v => ({ v, score: v.distanceTo(me) + 4 * Math.max(0, v.y - me.y - 2) }))
    .sort((a, b) => a.score - b.score)
    .map(x => x.v)
}

export function blockKey (v: { x: number; y: number; z: number }): string {
  return `block:${v.x},${v.y},${v.z}`
}

/**
 * Goal-shaped collect: ensure inventory has ≥ count of the block's drop (or of
 * `item`). Finds the nearest target in loaded chunks, navigates within reach,
 * digs, and picks up the drop. Unreachable targets are blacklisted (10 min).
 * If nothing is visible, takes bounded search steps in new directions.
 */
export const collect: SkillDef<P, { collected: number; targetsTried: number; searchSteps: number; replaced: number }> = {
  id: 'collect',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => have(s, p) >= p.count,
  preconditions: () => ({ ok: true }),
  timeoutMs: (_s, p) => 60_000 + (p.chance ? 60_000 : 15_000) * p.count + 30_000 * p.searchSteps,
  stallMs: 60_000,
  async run (ctx, p) {
    const { bot } = ctx
    const start = have(ctx.state(), p)
    let targetsTried = 0
    let targetFailures = 0
    let replaced = 0
    const search = new Searcher(p.block)
    // Trees grow on the surface: leave the mine first.
    if (p.block === 'log' && ctx.state().body.covered && !candidates(bot, p, k => ctx.env.isBlacklisted(k)).some(v => Math.abs(v.y - bot.entity.position.y) < 4)) await toSurface(ctx)

    while (have(ctx.state(), p) < p.count) {
      ctx.checkAbort()
      const list = candidates(bot, p, k => ctx.env.isBlacklisted(k))
      if (list.length === 0 || (p.chance && list[0]!.distanceTo(bot.entity.position) > 8 && (ctx.state().inventory[p.block] ?? 0) > 0)) {
        // Chance drops: re-place the block item beside the bot and dig it again.
        if (p.chance && (ctx.state().inventory[p.block] ?? 0) > 0 && replaced < MAX_REPLACES) {
          try {
            const at = await placeNear(bot, p.block, ctx.signal)
            replaced++
            await sleep(400) // gravel may fall a block
            const fallen = bot.findBlocks({ matching: bot.registry.blocksByName[p.block]!.id, maxDistance: 5, count: 1 })[0] ?? at
            const b = bot.blockAt(fallen, false)
            if (b && b.name === p.block) {
              const before = have(ctx.state(), p)
              await dig(bot, b, ctx.signal)
              await pickup(ctx, fallen, () => have(ctx.state(), p) > before || (ctx.state().inventory[p.block] ?? 0) > 0)
              ctx.progress('replaced', replaced)
            }
            continue
          } catch (e) {
            ctx.checkAbort()
            ctx.localRecovery(`re-place failed: ${(e as Error).message}`)
          }
        }
        if (list.length === 0) {
          if (search.steps >= p.searchSteps) {
            throw new SkillFailure(search.steps > 0 ? 'SEARCH_EXHAUSTED' : 'NOT_FOUND', `no reachable ${p.block} within ${p.maxDist} blocks after ${search.steps} search steps`, { key: `target=${p.block}`, searchSteps: search.steps, targetsTried })
          }
          await search.step(ctx)
          continue
        }
      }
      const target = list[0]!
      targetsTried++
      const r = await ctx.nav.goto({ kind: 'reach', target: [target.x, target.y, target.z], range: 4.5 })
      if (!r.ok) {
        targetFailures++
        ctx.env.blacklist(blockKey(target), r.class)
        ctx.localRecovery(`blacklist target after ${r.class}`)
        if (targetFailures >= MAX_TARGET_FAILURES) {
          throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, `${targetFailures} targets failed to reach; last ${r.class}`, { key: `target=${p.block}`, lastNav: r.detail, targetsTried, searchTarget: true }, r.detail.missing)
        }
        continue
      }
      const block = bot.blockAt(target, false)
      if (!block || !blockMatcher(p.block)(block.name)) continue // changed meanwhile
      // Never dig with the head under water (5× slower, and the air runs out): a target reached
      // only from water is left (dev batch 11 r01: 68 dig/surface cycles on one log in 10 min).
      if (ctx.state().body.head === 'water') {
        ctx.env.blacklist(blockKey(target), 'reached_from_water', 600)
        ctx.localRecovery('target reachable only from water')
        continue
      }
      const before = have(ctx.state(), p)
      const beforeBlockItems = ctx.state().inventory[p.block] ?? 0
      try {
        await dig(bot, block, ctx.signal)
      } catch (e) {
        ctx.checkAbort()
        targetFailures++
        ctx.env.blacklist(blockKey(target), 'dig_failed')
        ctx.localRecovery(`dig failed: ${(e as Error).message}`)
        if (targetFailures >= MAX_TARGET_FAILURES) throw new SkillFailure('STATE_INCONSISTENT', `dig failed repeatedly: ${(e as Error).message}`, { key: `target=${p.block}` })
        continue
      }
      await pickup(ctx, target, () => have(ctx.state(), p) > before || (p.chance && (ctx.state().inventory[p.block] ?? 0) > beforeBlockItems))
      const now = have(ctx.state(), p)
      if (now > before) ctx.progress('items', now)
      else if (p.chance) ctx.progress('digs', targetsTried)
      else ctx.log('item_delta', { note: 'drop not picked up', block: block.name, pos: [target.x, target.y, target.z] })
    }
    return { collected: have(ctx.state(), p) - start, targetsTried, searchSteps: search.steps, replaced }
  },
  async onCancel (ctx) {
    try { ctx.bot.stopDigging() } catch { /* ignore */ }
    ctx.env.nav.stop()
  },
}

export async function pickup (ctx: SkillCtx, at: Vec3, gained: () => boolean): Promise<void> {
  if (await waitFor(gained, 1200, ctx.signal)) return
  for (let attempt = 0; attempt < 2 && !gained(); attempt++) {
    const item = nearestDrop(ctx.bot, at)
    if (!item) {
      if (await waitFor(gained, 800, ctx.signal)) return
      continue
    }
    const p = item.position
    await ctx.nav.goto({ kind: 'near', target: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], range: 0.8 }, { timeoutMs: 12_000 })
    if (await waitFor(gained, 1500, ctx.signal)) return
  }
}

function nearestDrop (bot: Bot, at: Vec3): Entity | null {
  let best: Entity | null = null
  let bestD = 8
  for (const e of Object.values(bot.entities)) {
    if (e.name !== 'item' || !e.position) continue
    const d = e.position.distanceTo(at)
    if (d < bestD) { bestD = d; best = e }
  }
  return best
}

function sleep (ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

export { Vec3 }
