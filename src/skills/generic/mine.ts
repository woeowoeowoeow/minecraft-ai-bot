// Goal-shaped mining of ores and stone (architecture §6.3, milestone A): reach
// target blocks by controlled excavation (never unrestricted cave pathfinding),
// dig them with a tool that makes them drop, pick up the drop. Targets that
// would open lava or water are skipped; targets at or below the 1.16.1 lava
// level are avoided. The first descent from the surface is remembered as a
// `mine_entry`, so later surface work can walk back up the dug staircase.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { z } from 'zod'
import { liveView } from '../../nav/blocks.js'
import { digReleasesLiquid } from '../../nav/hazards.js'
import type { V3 } from '../../schema/index.js'
import { UNDERGROUND } from '../../version.js'
import { dig } from '../acts.js'
import { countOf } from '../sources.js'
import { SkillFailure, type Precondition, type SkillCtx, type SkillDef } from '../types.js'
import { blockKey, pickup } from './collect.js'
import { Searcher } from './explore.js'

const Params = z.object({
  blocks: z.array(z.string()).min(1),
  item: z.string(),
  count: z.number().int().positive(),
  maxDist: z.number().positive().default(40),
  searchSteps: z.number().int().min(0).default(6),
})
type P = z.infer<typeof Params>

const PICKS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
const MAX_TARGET_FAILURES = 6
/** Descend this far at a time when no target is in range. */
const DESCEND = 8

/** Cheapest pickaxe that makes `block` drop, or null if any tool (or the hand) does. */
export function pickaxeFor (bot: Bot, block: string): string | null {
  const b = bot.registry.blocksByName[block]
  const ht = b?.harvestTools as Record<string, boolean> | undefined
  if (!ht) return null
  for (const n of PICKS) { const id = bot.registry.itemsByName[n]?.id; if (id !== undefined && ht[id]) return n }
  return null
}

function canHarvest (bot: Bot, block: string): boolean {
  const b = bot.registry.blocksByName[block]
  const ht = b?.harvestTools as Record<string, boolean> | undefined
  if (!ht) return true
  return bot.inventory.items().some(it => ht[it.type])
}

type Cand = { v: Vec3; exposed: boolean; score: number }

function exposedCell (bot: Bot, v: Vec3): boolean {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const b = bot.blockAt(v.offset(dx, dy, dz), false)
    if (b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava') return true
  }
  return false
}

export function candidates (bot: Bot, p: P, isBlacklisted: (k: string) => boolean): Cand[] {
  const ids = p.blocks.map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  const me = bot.entity.position
  const view = liveView(bot)
  const out: Cand[] = []
  const fx = Math.floor(me.x); const fz = Math.floor(me.z)
  for (const v of bot.findBlocks({ matching: ids, maxDistance: p.maxDist, count: 80 })) {
    if (v.y < 5 || isBlacklisted(blockKey(v))) continue
    // Never dig out the bot's own column below its feet (a blind shaft); excavation handles descent.
    if (v.x === fx && v.z === fz && v.y < me.y) continue
    if (digReleasesLiquid(view, [v.x, v.y, v.z])) continue
    const exposed = exposedCell(bot, v)
    const lavaZone = Math.max(0, UNDERGROUND.lavaLevel + 1 - v.y)
    out.push({ v, exposed, score: v.distanceTo(me) + 6 * lavaZone - (exposed ? 3 : 0) })
  }
  return out.sort((a, b) => a.score - b.score || a.v.y - b.v.y || a.v.x - b.v.x || a.v.z - b.v.z)
}

function inReach (bot: Bot, v: Vec3): boolean {
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(v.offset(0.5, 0.5, 0.5)) <= 4.3
}

function rememberEntry (ctx: SkillCtx): void {
  const s = ctx.state()
  if (s.body.covered || s.dim !== 'overworld') return
  const pos = s.pos.map(Math.floor) as V3
  if (s.memory.locations.some(l => l.kind === 'mine_entry' && Math.hypot(l.pos[0] - pos[0], l.pos[2] - pos[2]) < 16)) return
  s.memory.locations.push({ kind: 'mine_entry', dim: s.dim, pos, confidence: 1, source: 'built', lastSeen: s.t })
  ctx.log('location_discovered', { kind: 'mine_entry', pos, source: 'built' })
}

export const mine: SkillDef<P, { mined: number; targets: number; descents: number }> = {
  id: 'mine',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => countOf(s.inventory, p.item) >= p.count,
  preconditions: (_s, p, env): Precondition => {
    if (canHarvest(env.bot, p.blocks[0]!)) return { ok: true }
    const pick = pickaxeFor(env.bot, p.blocks[0]!) ?? 'wooden_pickaxe'
    return { ok: false, reason: `${p.blocks[0]} needs ${pick}`, missing: [{ item: pick, count: 1 }] }
  },
  timeoutMs: (s, p) => 120_000 + 45_000 * Math.max(1, p.count - countOf(s.inventory, p.item)),
  stallMs: 120_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const have = () => countOf(ctx.state().inventory, p.item)
    const start = have()
    const search = new Searcher(p.blocks[0]!)
    let failures = 0
    let targets = 0
    let descents = 0
    while (have() < p.count) {
      ctx.checkAbort()
      if (!canHarvest(bot, p.blocks[0]!)) {
        const pick = pickaxeFor(bot, p.blocks[0]!) ?? 'wooden_pickaxe'
        throw new SkillFailure('MISSING_RESOURCE', `tool broke: ${p.blocks[0]} needs ${pick}`, { key: `tool=${pick}` }, [{ item: pick, count: 1 }])
      }
      const list = candidates(bot, p, k => ctx.env.isBlacklisted(k))
      const s = ctx.state()
      if (!list.length) {
        // Nothing in range: go deeper toward the mining level first, then tunnel into new rock.
        if (s.pos[1] > UNDERGROUND.miningY + 4 && descents < 8) {
          rememberEntry(ctx)
          descents++
          const r = await ctx.nav.goto({ kind: 'y', target: Math.max(UNDERGROUND.miningY, Math.floor(s.pos[1]) - DESCEND) })
          if (r.ok) { ctx.progress('descended', descents); continue }
          if (r.class === 'MISSING_RESOURCE') throw new SkillFailure('MISSING_RESOURCE', r.detail.reason ?? 'no pickaxe', { key: 'tool=pickaxe' }, r.detail.missing)
          failures++
          ctx.localRecovery(`descend failed: ${r.class}`)
          if (failures >= MAX_TARGET_FAILURES) throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, `descend failed: ${r.detail.reason ?? r.class}`, { key: `target=${p.blocks[0]}`, nav: r.detail })
        }
        if (search.steps >= p.searchSteps) throw new SkillFailure('SEARCH_EXHAUSTED', `no ${p.blocks.join('/')} within ${p.maxDist} after ${search.steps} search steps`, { key: `target=${p.blocks[0]}` })
        await search.step(ctx)
        continue
      }
      const c = list[0]!
      targets++
      if (!inReach(bot, c.v)) {
        rememberEntry(ctx)
        const t: V3 = [c.v.x, c.v.y, c.v.z]
        // Exposed and roughly level: walk (pathfinder). Buried: controlled excavation, never cave search.
        const r = c.exposed && Math.abs(c.v.y - s.pos[1]) < 5
          ? await ctx.nav.goto({ kind: 'reach', target: t, range: 4 })
          : await ctx.nav.goto({ kind: 'near', target: t, range: 2, mode: 'excavate' })
        if (!r.ok) {
          if (r.class === 'MISSING_RESOURCE') throw new SkillFailure('MISSING_RESOURCE', r.detail.reason ?? 'no pickaxe', { key: 'tool=pickaxe' }, r.detail.missing)
          failures++
          ctx.env.blacklist(blockKey(c.v), r.class)
          ctx.localRecovery(`blacklist ${p.blocks[0]} after ${r.class}`)
          if (failures >= MAX_TARGET_FAILURES) throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, `${failures} targets failed; last ${r.detail.reason ?? r.class}`, { key: `target=${p.blocks[0]}`, nav: r.detail })
          continue
        }
      }
      const block = bot.blockAt(c.v, false)
      if (!block || !p.blocks.includes(block.name)) continue // dug on the way (excavation) or changed
      if (!inReach(bot, c.v)) { ctx.env.blacklist(blockKey(c.v), 'out_of_reach'); failures++; continue }
      const before = have()
      try {
        await dig(bot, block, ctx.signal)
      } catch (e) {
        ctx.checkAbort()
        failures++
        ctx.env.blacklist(blockKey(c.v), 'dig_failed')
        ctx.localRecovery(`dig failed: ${(e as Error).message}`)
        if (failures >= MAX_TARGET_FAILURES) throw new SkillFailure('STATE_INCONSISTENT', `dig failed repeatedly: ${(e as Error).message}`, { key: `target=${p.blocks[0]}` })
        continue
      }
      await pickup(ctx, c.v, () => have() > before)
      if (have() > before) ctx.progress('mined', have() - start)
    }
    return { mined: have() - start, targets, descents }
  },
  async onCancel (ctx) {
    try { ctx.bot.stopDigging() } catch { /* ignore */ }
    ctx.env.nav.stop()
  },
}
