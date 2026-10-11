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
import { blacklistCluster, blockKey, pickup } from './collect.js'
import { barterStats } from '../progression/barter.js'
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
/** Blocks found in banks (cluster blacklisting on an unreachable target). */
const BANKS = new Set(['gravel', 'sand'])
/**
 * Blocks piglins guard (1.16.1 tag `guarded_by_piglins`, incl. `#gold_ores`): breaking one angers
 * every adult piglin within 16 blocks that can see the player. Milestone C mines nether gold ore.
 */
export const PIGLIN_GUARDED = new Set(['gold_ore', 'nether_gold_ore', 'gilded_blackstone', 'gold_block'])
/**
 * Nether mining band: clear of the lava sea (y 31) and its magma patches (ckit3 r01: died on magma
 * at y 35), and below the roof ledges (ckit2 r01: gold mined at
 * y 112 led the bot onto ledges over an open cavern; it fell 50 blocks).
 */
export const NETHER_MINE_Y = [40, 100] as const
/** Piglins this close (with line of sight) forbid digging a guarded block. */
export const PIGLIN_GUARD_R = 16
/** Guarded targets this close to a piglin are not chosen at all (the bot would stand in sight of it). */
const PIGLIN_TARGET_R = 20
/** A guarded target skipped because piglins watch is left this long. */
const PIGLIN_SKIP_S = 60

/**
 * Piglins (any age) close enough to be angered by a guarded block broken now. 1.16.1
 * `PiglinAi.angerNearbyPiglins`: every piglin whose box meets the player's box inflated by 16, a
 * box, not a sphere (C dev batch 20261007-110334 r03: a dig with a piglin outside the old 18-block
 * sphere, killed 4 s later). Half-sizes: 0.3 + 16 + 0.3 across, −16 − 1.95 … +1.8 + 16 up, plus
 * PIGLIN_GUARD_MARGIN for movement. Without positions, the old sphere (tests, callers without pos).
 */
export const PIGLIN_GUARD_MARGIN = 1.5
export function piglinsWatching (s: { pos?: V3; nearby: { entities: { name: string; dist: number; los?: boolean; pos?: V3 }[] } }, r = PIGLIN_GUARD_R + 2): number {
  // Sight or not: the server's sight check differs from the client's estimate (ckit13 r01: piglins
  // angered by a dig the client thought unseen attacked 30 s later through the golden helmet).
  const me = s.pos
  return s.nearby.entities.filter(e => {
    if (e.name !== 'piglin') return false
    if (!me || !e.pos) return e.dist <= r
    const h = PIGLIN_GUARD_R + 0.6 + PIGLIN_GUARD_MARGIN
    const dy = e.pos[1] - me[1]
    return Math.abs(e.pos[0] - me[0]) <= h && Math.abs(e.pos[2] - me[2]) <= h && dy > -(PIGLIN_GUARD_R + 1.95 + PIGLIN_GUARD_MARGIN) && dy < PIGLIN_GUARD_R + 1.8 + PIGLIN_GUARD_MARGIN
  }).length
}

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

export function candidates (bot: Bot, p: P, isBlacklisted: (k: string) => boolean, nether = false): Cand[] {
  const ids = p.blocks.map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  const me = bot.entity.position
  const view = liveView(bot)
  const out: Cand[] = []
  const fx = Math.floor(me.x); const fz = Math.floor(me.z)
  const guarded = p.blocks.some(b => PIGLIN_GUARDED.has(b))
  const piglins = guarded ? Object.values(bot.entities).filter(e => e.name === 'piglin' && e.position && e.position.distanceTo(me) < 64).map(e => e.position) : []
  for (const v of bot.findBlocks({ matching: ids, maxDistance: p.maxDist, count: 80 })) {
    if (v.y < 5 || isBlacklisted(blockKey(v))) continue
    // Never dig out the bot's own column below its feet (a blind shaft); excavation handles descent.
    if (v.x === fx && v.z === fz && v.y < me.y) continue
    if (digReleasesLiquid(view, [v.x, v.y, v.z])) continue
    // The Nether: only the safe height band, and no ore a piglin stands near (milestone C).
    if (nether && (v.y > NETHER_MINE_Y[1] || v.y < NETHER_MINE_Y[0])) continue
    if (piglins.some(q => q.distanceTo(v) < PIGLIN_TARGET_R)) continue
    const exposed = exposedCell(bot, v)
    // Overworld: the lava level (y ≤ 10). Nether: height changes cost (cliffs, the lava sea below).
    const lavaZone = nether ? 0 : Math.max(0, UNDERGROUND.lavaLevel + 1 - v.y)
    const climb = nether ? Math.abs(v.y - me.y) : 0
    out.push({ v, exposed, score: v.distanceTo(me) + 6 * lavaZone + climb - (exposed ? 3 : 0) })
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
    // Milestone C: time spent on nether gold ore counts against the adaptive pearl budget (policy goldExhausted).
    if (ctx.state().dim === 'the_nether' && p.blocks.includes('nether_gold_ore')) {
      const t0 = Date.now()
      const nug0 = ctx.state().inventory.gold_nugget ?? 0
      try { return await mineRun(ctx, p) } finally {
        const l = barterStats(ctx.memory)
        l.oreS += (Date.now() - t0) / 1000
        l.gold.ore += Math.max(0, (ctx.state().inventory.gold_nugget ?? 0) - nug0) / 9
      }
    }
    return mineRun(ctx, p)
  },
  async onCancel (ctx) {
    try { ctx.bot.stopDigging() } catch { /* ignore */ }
    ctx.env.nav.stop()
  },
}

async function mineRun (ctx: SkillCtx, p: P): Promise<{ mined: number; targets: number; descents: number }> {
  {
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
      const s = ctx.state()
      const nether = s.dim === 'the_nether'
      const list = candidates(bot, p, k => ctx.env.isBlacklisted(k), nether)
      if (!list.length) {
        // Nothing in range: go deeper toward the mining level first, then tunnel into new rock.
        // Never in the Nether (the lava sea is at y 31): there the search tunnels at this level.
        if (!nether && s.pos[1] > UNDERGROUND.miningY + 4 && descents < 8) {
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
        // The Nether (milestone C): the bot stands in open caverns where excavation finds no safe step
        // (ckit1 r01: every target "drop too deep"), so the pathfinder (digging, no scaffolding) reaches
        // the target first and excavation is the fallback.
        let r = nether
          ? await ctx.nav.goto({ kind: 'reach', target: t, range: 4, mode: 'path' }, { profile: 'nether_travel', timeoutMs: 30_000 })
          : c.exposed && Math.abs(c.v.y - s.pos[1]) < 5
            ? await ctx.nav.goto({ kind: 'reach', target: t, range: 4 })
            : await ctx.nav.goto({ kind: 'near', target: t, range: 2, mode: 'excavate' })
        if (nether && !r.ok && r.class !== 'CANCELLED' && r.class !== 'MISSING_RESOURCE') r = await ctx.nav.goto({ kind: 'near', target: t, range: 2, mode: 'excavate' }, { profile: 'nether' })
        if (!r.ok) {
          if (r.class === 'MISSING_RESOURCE') throw new SkillFailure('MISSING_RESOURCE', r.detail.reason ?? 'no pickaxe', { key: 'tool=pickaxe' }, r.detail.missing)
          failures++
          // Gravel lies in banks: an unreachable one is left whole (re-gate 20261003 r09: 40 blocks
          // of one bank tried five at a time). Ores keep per-block blacklisting.
          let n = 1
          if (BANKS.has(bot.blockAt(c.v, false)?.name ?? '')) n = blacklistCluster(bot, c.v, name => BANKS.has(name), (k, why) => ctx.env.blacklist(k, why), r.class)
          else ctx.env.blacklist(blockKey(c.v), r.class)
          ctx.localRecovery(`blacklist ${p.blocks[0]}${n > 1 ? ` (+${n - 1} beside it)` : ''} after ${r.class}`)
          if (failures >= MAX_TARGET_FAILURES) throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, `${failures} targets failed; last ${r.detail.reason ?? r.class}`, { key: `target=${p.blocks[0]}`, nav: r.detail })
          continue
        }
      }
      const block = bot.blockAt(c.v, false)
      if (!block || !p.blocks.includes(block.name)) continue // dug on the way (excavation) or changed
      if (!inReach(bot, c.v)) { ctx.env.blacklist(blockKey(c.v), 'out_of_reach'); failures++; continue }
      // Breaking a guarded block in a piglin's sight turns every piglin around on the bot.
      if (PIGLIN_GUARDED.has(block.name) && piglinsWatching(ctx.state())) {
        ctx.env.blacklist(blockKey(c.v), 'piglins_watching', PIGLIN_SKIP_S)
        ctx.log('barter', { kind: 'gold_skip', why: 'piglins_watching', block: block.name, piglins: piglinsWatching(ctx.state()) })
        ctx.localRecovery('piglins watching a guarded block: skipped')
        continue
      }
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
  }
}
