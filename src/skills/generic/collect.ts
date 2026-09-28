import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { z } from 'zod'
import type { WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import { dig, waitFor } from '../acts.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'

/** Block groups: a group name matches several block names; the dropped item has the block's name. */
const GROUPS: Record<string, (name: string) => boolean> = {
  log: n => n.endsWith('_log'),
}

export function blockMatcher (block: string): (name: string) => boolean {
  return GROUPS[block] ?? (n => n === block)
}

const Params = z.object({
  block: z.string(),                       // block name or group ('log')
  count: z.number().int().positive(),      // goal: have ≥ count of the dropped item(s)
  maxDist: z.number().positive().default(64),
  searchSteps: z.number().int().min(0).default(6),
})
type P = z.infer<typeof Params>

function have (s: WorldState, p: P): number {
  const m = blockMatcher(p.block)
  return Object.entries(s.inventory).reduce((n, [k, v]) => (m(k) ? n + v : n), 0)
}

const MAX_TARGET_FAILURES = 5
const SEARCH_STEP_BLOCKS = 48

function candidates (bot: Bot, p: P, isBlacklisted: (k: string) => boolean): Vec3[] {
  const m = blockMatcher(p.block)
  const ids = bot.registry.blocksArray.filter(b => m(b.name)).map(b => b.id)
  const me = bot.entity.position
  return bot.findBlocks({ matching: ids, maxDistance: p.maxDist, count: 96 })
    .filter(v => !isBlacklisted(blockKey(v)))
    // Prefer near and low targets: high logs need towering (no scaffolding at M0).
    .map(v => ({ v, score: v.distanceTo(me) + 4 * Math.max(0, v.y - me.y - 2) }))
    .sort((a, b) => a.score - b.score)
    .map(x => x.v)
}

function blockKey (v: { x: number; y: number; z: number }): string {
  return `block:${v.x},${v.y},${v.z}`
}

/**
 * Goal-shaped collect: ensure inventory has ≥ count of the block's drop.
 * Finds the nearest visible target in loaded chunks, navigates within reach,
 * digs, and picks up the drop. Unreachable targets are blacklisted (10 min).
 * If nothing is visible, takes bounded search steps in new directions.
 */
export const collect: SkillDef<P, { collected: number; targetsTried: number; searchSteps: number }> = {
  id: 'collect',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => have(s, p) >= p.count,
  preconditions: () => ({ ok: true }),
  timeoutMs: (_s, p) => 60_000 + 15_000 * p.count + 30_000 * p.searchSteps,
  stallMs: 60_000,
  async run (ctx, p) {
    const { bot } = ctx
    const start = have(ctx.state(), p)
    let targetsTried = 0
    let targetFailures = 0
    let searchSteps = 0
    let heading = ctx.env.random() * Math.PI * 2

    while (have(ctx.state(), p) < p.count) {
      ctx.checkAbort()
      const list = candidates(bot, p, k => ctx.env.isBlacklisted(k))
      if (list.length === 0) {
        if (searchSteps >= p.searchSteps) {
          throw new SkillFailure(searchSteps > 0 ? 'SEARCH_EXHAUSTED' : 'NOT_FOUND', `no reachable ${p.block} within ${p.maxDist} blocks after ${searchSteps} search steps`, { key: `target=${p.block}`, searchSteps, targetsTried })
        }
        searchSteps++
        await searchStep(ctx, heading, searchSteps)
        heading += Math.PI / 2 + ctx.env.random() * 0.5
        continue
      }
      const target = list[0]!
      targetsTried++
      const r = await ctx.nav.goto({ kind: 'reach', target: [target.x, target.y, target.z], range: 4.5 })
      if (!r.ok) {
        targetFailures++
        ctx.env.blacklist(blockKey(target), r.class)
        ctx.localRecovery(`blacklist target after ${r.class}`)
        if (targetFailures >= MAX_TARGET_FAILURES) {
          throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, `${targetFailures} targets failed to reach; last ${r.class}`, { key: `target=${p.block}`, lastNav: r.detail, targetsTried })
        }
        continue
      }
      const block = bot.blockAt(target, false)
      if (!block || !blockMatcher(p.block)(block.name)) continue // changed meanwhile
      const before = have(ctx.state(), p)
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
      await pickup(ctx, target, () => have(ctx.state(), p) > before)
      const now = have(ctx.state(), p)
      if (now > before) ctx.progress('items', now)
      else ctx.log('item_delta', { note: 'drop not picked up', block: block.name, pos: [target.x, target.y, target.z] })
    }
    return { collected: have(ctx.state(), p) - start, targetsTried, searchSteps }
  },
  async onCancel (ctx) {
    try { ctx.bot.stopDigging() } catch { /* ignore */ }
    ctx.env.nav.stop()
  },
}

async function pickup (ctx: SkillCtx, at: Vec3, gained: () => boolean): Promise<void> {
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

async function searchStep (ctx: SkillCtx, heading: number, n: number): Promise<void> {
  const me = ctx.state().pos
  const target: V3 = [Math.round(me[0] + Math.sin(heading) * SEARCH_STEP_BLOCKS), 0, Math.round(me[2] - Math.cos(heading) * SEARCH_STEP_BLOCKS)]
  ctx.log('search_step', { n, heading: Math.round((heading * 180) / Math.PI) % 360, from: me.map(Math.round), target })
  const r = await ctx.nav.goto({ kind: 'xz', target, range: 4 })
  if (r.ok) ctx.progress('searchSteps', n)
}

export { Vec3 }
