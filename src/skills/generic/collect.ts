import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { z } from 'zod'
import type { WorldState } from '../../observer/types.js'
import { countOf } from '../sources.js'
import { dig, placeNear, waitFor } from '../acts.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { nextSearchHeading, Searcher, toSurface } from './explore.js'
import { Relocator } from './search.js'
import type { V3 } from '../../schema/index.js'
import { naturalTreeFilter } from '../../observer/trees.js'
import { AQUATIC, aquaticThreats, atWater, inlandPoint } from '../survival/aquatic.js'

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
/** A failed target takes its neighbours of the same kind with it (a trunk, a gravel bank): re-gate 20261003 r09 tried 40 blocks of one unreachable bank, 5 per attempt. */
const CLUSTER_R = 3
/** Logs: remembered tree spots worth walking to (the nearest first), per run and in all. */
export const TREE_SPOT = { maxDist: 1200, minDist: 32, perRun: 3, forgetS: 600, range: 10 } as const
/** Logs anywhere in the loaded chunks (view distance 10: ~160 blocks) are walked to before any search. */
export const WIDE_LOG_SCAN = 160
/** Re-placements of a chance-drop block per run (gravel gives flint 10 % of the time). */
const MAX_REPLACES = 40

export { nextSearchHeading }

function candidates (bot: Bot, p: P, isBlacklisted: (k: string) => boolean, zones: V3[] = []): Vec3[] {
  const m = blockMatcher(p.block)
  const ids = bot.registry.blocksArray.filter(b => m(b.name)).map(b => b.id)
  const me = bot.entity.position
  const isTree = p.block === 'log' ? naturalTreeFilter(bot) : null
  return bot.findBlocks({ matching: ids, maxDistance: p.maxDist, count: 96 })
    .filter(v => !isBlacklisted(blockKey(v)))
    // Never dive for a block: one with water above it is under water (river and lake floors).
    .filter(v => !/water|kelp|seagrass|bubble_column/.test(bot.blockAt(v.offset(0, 1, 0), false)?.name ?? ''))
    // Wood: only logs of natural surface trees (round-3 gate r02/r08: shipwreck timbers on the
    // sea floor), and none near a wood target abandoned under threat.
    .filter(v => !isTree || (!inWoodZone(zones, v.x, v.z) && isTree(v)))
    // Prefer near and low targets: high logs need towering (no scaffolding at M0).
    .map(v => ({ v, score: v.distanceTo(me) + 4 * Math.max(0, v.y - me.y - 2) }))
    .sort((a, b) => a.score - b.score)
    .map(x => x.v)
}

export function blockKey (v: { x: number; y: number; z: number }): string {
  return `block:${v.x},${v.y},${v.z}`
}

/** Blacklist a failed target and the loaded blocks of the same kind within CLUSTER_R of it. */
export function blacklistCluster (bot: Bot, target: Vec3, matches: (name: string) => boolean, blacklist: (key: string, reason: string) => void, reason: string): number {
  blacklist(blockKey(target), reason)
  let n = 1
  for (let dx = -CLUSTER_R; dx <= CLUSTER_R; dx++) {
    for (let dy = -CLUSTER_R; dy <= CLUSTER_R; dy++) {
      for (let dz = -CLUSTER_R; dz <= CLUSTER_R; dz++) {
        if (!dx && !dy && !dz) continue
        const v = target.offset(dx, dy, dz)
        const b = bot.blockAt(v, false)
        if (b && matches(b.name)) { blacklist(blockKey(v), `${reason}_cluster`); n++ }
      }
    }
  }
  return n
}

/**
 * A wood target abandoned under threat (round-3 gate r02/r08: re-chosen after every flee and
 * respawn): the area around it is left for WOOD_DANGER.ttlS, across deaths. Interrupts that
 * mean danger there; an aquatic hostile about or the head under water count too.
 */
export const WOOD_DANGER = { r: 24, ttlS: 1800, interrupts: ['flee', 'surface', 'death'], inlandMoves: AQUATIC.maxRelocations } as const
const ZONE_PREFIX = 'wood_zone:'

/** Active wood danger zones (blacklist entries outlive deaths). */
export function woodZones (s: WorldState): V3[] {
  return s.memory.blacklist
    .filter(b => b.key.startsWith(ZONE_PREFIX) && b.until > s.t)
    .map(b => b.key.slice(ZONE_PREFIX.length).split(',').map(Number) as V3)
}

export function inWoodZone (zones: V3[], x: number, z: number): boolean {
  return zones.some(c => Math.hypot(c[0] - x, c[2] - z) <= WOOD_DANGER.r)
}

/** Why a cancelled walk to (or dig of) a wood target leaves that area, or null when it was a plain preemption. */
export function woodDanger (s: WorldState, by: string | undefined): string | null {
  if (by && (WOOD_DANGER.interrupts as readonly string[]).includes(by)) return by
  if (aquaticThreats(s).length > 0) return 'aquatic'
  if (s.body.head === 'water') return 'water'
  return null
}

export function woodZoneKey (t: V3): string {
  return `${ZONE_PREFIX}${Math.floor(t[0])},${Math.floor(t[1])},${Math.floor(t[2])}`
}

/** Nearest remembered tree spot worth walking to (same dimension, not just visited, within TREE_SPOT.maxDist). */
export function treeSpot (s: WorldState, isBlacklisted: (k: string) => boolean): V3 | null {
  const zones = woodZones(s)
  const spots = s.memory.locations
    .filter(l => l.kind === 'trees' && l.dim === s.dim && !isBlacklisted(`trees:${l.pos[0]},${l.pos[2]}`))
    .filter(l => !inWoodZone(zones, l.pos[0], l.pos[2]))
    .map(l => ({ l, d: Math.hypot(l.pos[0] - s.pos[0], l.pos[2] - s.pos[2]) }))
    .filter(x => x.d >= TREE_SPOT.minDist && x.d <= TREE_SPOT.maxDist)
    .sort((a, b) => a.d - b.d)
  return spots[0]?.l.pos ?? null
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
    const isLog = p.block === 'log'
    // Logs: remembered trees, then decisive relocation into new terrain (search.ts). Other
    // surface blocks keep the plain search steps.
    const search = isLog ? new Relocator('log') : new Searcher(p.block)
    let spotVisits = 0
    // A target the watchdog aborts on (stalled or timed out mid-dig or mid-pickup) is never chosen
    // again by the retry: B gate 20261002 part2-r01 went back to one log 12 times.
    let current: Vec3 | null = null
    // The wood target being walked to or dug (near, loaded far log, or tree spot).
    let wood: V3 | null = null
    const onAbort = () => {
      const reason = ctx.signal.reason as { why?: string; by?: string } | undefined
      const why = reason?.why
      if (current && (why === 'stalled' || why === 'timeout')) ctx.env.blacklist(blockKey(current), `collect_${why}`)
      // Interrupted by danger on the way to wood: never re-chosen after the flee or the respawn.
      const danger = wood && why === 'cancelled' ? woodDanger(ctx.state(), reason?.by) : null
      if (wood && danger) {
        ctx.env.blacklist(woodZoneKey(wood), `wood_${danger}`, WOOD_DANGER.ttlS)
        // ctx.log is silent once aborted: straight to the bus.
        ctx.env.bus.emit('search_step', { skill: 'collect', n: 0, for: p.block, target: wood.map(Math.floor), mode: 'wood_danger', why: danger, r: WOOD_DANGER.r }, 'warn')
      }
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const zones = () => isLog ? woodZones(ctx.state()) : []
    let inlandMoves = 0
    // Trees grow on the surface: leave the mine first.
    if (p.block === 'log' && ctx.state().body.covered && !candidates(bot, p, k => ctx.env.isBlacklisted(k), zones()).some(v => Math.abs(v.y - bot.entity.position.y) < 4)) await toSurface(ctx)

    while (have(ctx.state(), p) < p.count) {
      ctx.checkAbort()
      wood = null
      // Aquatic hostiles about and the bot at the water: move inland before choosing any wood (bounded).
      if (isLog && inlandMoves < WOOD_DANGER.inlandMoves) {
        const st = ctx.state()
        const to = aquaticThreats(st).length > 0 && atWater(st) ? inlandPoint(st) : null
        if (to) {
          inlandMoves++
          ctx.log('search_step', { n: 0, for: p.block, from: st.pos.map(Math.round), target: to, mode: 'inland', aquatic: aquaticThreats(st).length })
          const r = await ctx.nav.goto({ kind: 'xz', target: to, range: 4, dry: true })
          if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
          continue
        }
      }
      const list = candidates(bot, p, k => ctx.env.isBlacklisted(k), zones())
      // Chance drops (flint): a carried gravel block is re-placed and dug where the bot stands,
      // before any gravel in the world (re-gate 20261003 r05: lake-bed gravel dug from the
      // water trapped the bot; 18 stalls and 21 unreachable targets across the gate).
      if (list.length === 0 || (p.chance && (ctx.state().inventory[p.block] ?? 0) > 0)) {
        // Chance drops: re-place the block item beside the bot and dig it again.
        if (p.chance && (ctx.state().inventory[p.block] ?? 0) > 0 && replaced < MAX_REPLACES) {
          try {
            const at = await placeNear(bot, p.block, ctx.signal)
            replaced++
            await sleep(400) // gravel may fall a block
            // The placed block, or where it fell (never some other block of its kind nearby).
            const fallen = [0, 1, 2, 3, 4].map(dy => at.offset(0, -dy, 0)).find(v => bot.blockAt(v, false)?.name === p.block) ?? at
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
          // Logs beyond the normal target range but loaded: walk over first (the area is not treeless).
          const far = isLog && spotVisits < TREE_SPOT.perRun ? candidates(bot, { ...p, maxDist: WIDE_LOG_SCAN }, k => ctx.env.isBlacklisted(k), zones())[0] : undefined
          if (far) {
            spotVisits++
            wood = [far.x, far.y, far.z]
            const from = ctx.state().pos
            ctx.log('search_step', { n: 0, for: p.block, from: from.map(Math.round), target: [far.x, far.y, far.z], mode: 'loaded_logs', dist: Math.round(far.distanceTo(bot.entity.position)) })
            const r = await ctx.nav.goto({ kind: 'xz', target: [far.x, far.y, far.z], range: 8, dry: true })
            if (!r.ok) {
              if (r.class === 'CANCELLED') ctx.checkAbort()
              blacklistCluster(bot, far, blockMatcher(p.block), (k, why) => ctx.env.blacklist(k, why), r.class)
            } else ctx.progress('loaded_logs', spotVisits)
            continue
          }
          // Trees seen earlier (loaded chunks, up to 160 blocks; kept across deaths): go back
          // there before searching new ground (re-gate 20261003 r12: re-searched after a death).
          const spot = isLog && spotVisits < TREE_SPOT.perRun ? treeSpot(ctx.state(), k => ctx.env.isBlacklisted(k)) : null
          if (spot) {
            spotVisits++
            wood = spot
            ctx.env.blacklist(`trees:${spot[0]},${spot[2]}`, 'visited', TREE_SPOT.forgetS)
            const from = ctx.state().pos
            ctx.log('search_step', { n: 0, for: p.block, from: from.map(Math.round), target: spot, mode: 'tree_spot', dist: Math.round(Math.hypot(spot[0] - from[0], spot[2] - from[2])) })
            const r = await ctx.nav.goto({ kind: 'xz', target: spot, range: TREE_SPOT.range, dry: true })
            if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
            if (r.ok) ctx.progress('tree_spot', spotVisits)
            continue
          }
          if (search.steps >= p.searchSteps) {
            throw new SkillFailure(search.steps > 0 ? 'SEARCH_EXHAUSTED' : 'NOT_FOUND', `no reachable ${p.block} within ${p.maxDist} blocks after ${search.steps} search steps`, { key: `target=${p.block}`, searchSteps: search.steps, targetsTried })
          }
          if (search instanceof Relocator && await search.settle(ctx)) continue
          await search.step(ctx)
          // A new area: loaded logs and remembered trees may be visited again.
          spotVisits = 0
          continue
        }
      }
      const target = list[0]!
      current = target
      if (isLog) wood = [target.x, target.y, target.z]
      targetsTried++
      const r = await ctx.nav.goto({ kind: 'reach', target: [target.x, target.y, target.z], range: 4.5 })
      if (!r.ok) {
        targetFailures++
        const n = blacklistCluster(bot, target, blockMatcher(p.block), (k, why) => ctx.env.blacklist(k, why), r.class)
        ctx.localRecovery(`blacklist target (+${n - 1} beside it) after ${r.class}`)
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
        // Every block is equally slow under Mining Fatigue: leave the area instead (Recovery relocates).
        if (e instanceof SkillFailure && e.detail.key === 'effect=mining_fatigue') throw e
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
