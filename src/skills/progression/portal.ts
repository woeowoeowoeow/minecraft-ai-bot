// buildNetherPortal (architecture §6.3, milestone B): a lit Overworld portal the
// bot built, remembered as `portal_ow` (source 'built').
//
// Strategies, in catalog order (deterministic, first applicable):
// 1. lava_cast: a water bucket, an empty bucket and a remembered usable lava pool.
//    Each obsidian cell is cast where it stands: water into a neighbouring cell,
//    lava from the pool into the frame cell (lava beside water turns to obsidian at
//    once), the water picked back up. The frame is cast top-down against a solid
//    back wall that every bucket is aimed at (portal-plan.ts).
// 2. obsidian: ≥ 10 obsidian carried (or, with a diamond pickaxe, mined first) and
//    placed into the same frame.
//
// The site is chosen on loaded terrain near the pool's safe access, never from
// coordinates or seed knowledge. Partial work is remembered (`portal_site`) and
// resumed after an interruption; a site that keeps failing is blacklisted.
import { Vec3 } from 'vec3'
import { z } from 'zod'
import progression from '../../../config/progression.json' with { type: 'json' }
import { liveView } from '../../nav/blocks.js'
import { digReleasesLiquid } from '../../nav/hazards.js'
import type { Location, WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import { dig, waitFor } from '../acts.js'
import { toSurface } from '../generic/explore.js'
import { AbortError, sleep } from '../runner.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { blockName, centre, count, eyeOf, isSource, overlayView, placeAt, rememberLoc, settle, useBucket, WATER_SOURCE } from './buckets.js'
import {
  aimPickup, aimPlace, cellAt, findSites, FRAME_UV, frameStatus, geomDetail, geomFrom, lastAccess, lastRejections, lavaAccess,
  planFor, poolCells, resumeCheck, waterCandidates, type PortalGeom, type SitePlan,
} from './portal-plan.js'

const A = progression.A
const B = progression.B

export type PortalStrategy = 'lava_cast' | 'obsidian'
const Params = z.object({ strategy: z.enum(['auto', 'lava_cast', 'obsidian']).default('auto') })
type P = z.infer<typeof Params>

const n = (s: WorldState, item: string) => s.inventory[item] ?? 0

/** Remembered Overworld lava pools that can still feed a cast, nearest first. */
export function usablePools (s: WorldState): Location[] {
  return s.memory.locations
    .filter(l => l.kind === 'lava_pool' && l.dim === 'overworld' && Number(l.detail?.sources ?? 0) >= A.lavaPoolMinSources && l.detail?.unusable !== true)
    .sort((a, b) => Math.hypot(a.pos[0] - s.pos[0], a.pos[2] - s.pos[2]) - Math.hypot(b.pos[0] - s.pos[0], b.pos[2] - s.pos[2]))
}

function canMineObsidian (s: WorldState): boolean {
  return (n(s, 'diamond_pickaxe') > 0 || n(s, 'netherite_pickaxe') > 0) && (s.nearby.interestBlocks.obsidian?.length ?? 0) >= A.obsidian
}

/**
 * Applicable strategies in catalog order (lava cast first: the normal 1.16.1 route).
 * `requested` narrows the list (Recovery's alternate strategy).
 */
export function portalStrategies (s: WorldState, requested: P['strategy'] = 'auto'): PortalStrategy[] {
  const out: PortalStrategy[] = []
  if (n(s, 'water_bucket') >= 1 && (n(s, 'bucket') + n(s, 'lava_bucket')) >= 1 && usablePools(s).length) out.push('lava_cast')
  if (n(s, 'obsidian') >= A.obsidian || canMineObsidian(s)) out.push('obsidian')
  return requested === 'auto' ? out : out.filter(x => x === requested)
}

/** The lit portal this bot built, if remembered. */
export function builtLit (s: WorldState): Location | null {
  return s.memory.locations.find(l => l.kind === 'portal_ow' && l.dim === 'overworld' && l.source === 'built' && l.detail?.lit === true) ?? null
}

/** Blocks the back wall and floor are built from, in order of preference. */
const BUILD_BLOCKS = ['cobblestone', 'dirt', 'stone', 'netherrack', 'andesite', 'diorite', 'granite', 'cobbled_deepslate', 'sandstone']
function buildBlock (ctx: SkillCtx): string | null {
  return BUILD_BLOCKS.find(b => count(ctx.bot, b) > 0) ?? null
}
function buildBlocks (ctx: SkillCtx): number {
  return BUILD_BLOCKS.reduce((a, b) => a + count(ctx.bot, b), 0)
}

const siteKey = (o: V3) => `portal_site:${o.join(',')}`
/** Origins of blacklisted sites; candidates within 2 blocks of one are skipped (a neighbour shares its terrain). */
function badSites (ctx: SkillCtx): V3[] {
  const now = ctx.state().t
  return ctx.memory.blacklist.filter(b => b.key.startsWith('portal_site:') && b.until > now).map(b => b.key.slice(12).split(',').map(Number) as V3)
}
const nearBad = (bad: V3[], o: V3) => bad.some(b => Math.max(Math.abs(b[0] - o[0]), Math.abs(b[1] - o[1]), Math.abs(b[2] - o[2])) <= 2)
const feetOf = (ctx: SkillCtx): V3 => { const p = ctx.bot.entity.position; return [Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)] }
const center = (c: V3): V3 => [c[0] + 0.5, c[1] + 0.5, c[2] + 0.5]
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const isAir = (name: string | null) => name === 'air' || name === 'cave_air' || name === 'void_air'

type Run = {
  strategy: PortalStrategy
  plan: SitePlan
  site: Location
  pool: Location | null
  /** Lava cells of the pool, refreshed as sources are used. */
  lava: V3[]
  casts: number
  fetches: number
}

/** Move to a stand cell of the work area: walking first (the area is open), then the digging pathfinder. */
async function standAt (ctx: SkillCtx, stand: V3, walk: boolean): Promise<boolean> {
  const at = () => { const g = feetOf(ctx); return g[0] === stand[0] && g[1] === stand[1] && g[2] === stand[2] }
  const ready = async () => { await centre(ctx.bot, ctx.signal); await settle(ctx.bot, ctx.signal); return at() }
  if (at()) return ready()
  // Short moves inside the site: the pathfinder, never controlled excavation, whose strict liquid
  // checks refuse cave floors next to a lava pool (bkit1 r01: 14 failures reaching a site 4 blocks
  // away). Short budgets: a stand the walk cannot enter costs 8 s, not 25 (fixture: 10 × 25 s).
  for (const mode of walk ? ['walk', 'path'] as const : ['path'] as const) {
    const r = await ctx.nav.goto({ kind: 'block', target: stand, mode }, { profile: 'overworld_cautious', timeoutMs: mode === 'walk' ? 8000 : 15_000 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    await settle(ctx.bot, ctx.signal)
    if (at()) return ready()
  }
  return false
}

/** The nearest stand from which `cell` is within reach. */
async function reach (ctx: SkillCtx, run: Run, cell: V3, max = 4.3): Promise<void> {
  if (dist(eyeOf(ctx.bot), center(cell)) <= max) return
  const occupied = (st: V3) => (st[0] === cell[0] && st[2] === cell[2] && (st[1] === cell[1] || st[1] + 1 === cell[1]))
  const stands = run.plan.stands.filter(st => !occupied(st)).sort((a, b) => dist(center(a), center(cell)) - dist(center(b), center(cell)))
  for (const st of stands.slice(0, 3)) {
    if (dist([st[0] + 0.5, st[1] + 1.62, st[2] + 0.5], center(cell)) > max) continue
    if (await standAt(ctx, st, false)) return
  }
  throw new SkillFailure('NAV_UNREACHABLE', 'cannot get within reach of a site cell', { key: 'step=reach_cell', cell })
}

/** Pick up water this skill left in the site (an interrupted cast). */
async function recoverWater (ctx: SkillCtx, run: Run): Promise<void> {
  const g = run.plan.geom
  for (let u = 0; u < 4; u++) {
    for (let v = 0; v <= 4; v++) {
      for (const d of [0, 1]) {
        const c = cellAt(g, u, v, d)
        if (!isSource(ctx.bot, c, 'water') || !count(ctx.bot, 'bucket')) continue
        const before = count(ctx.bot, 'water_bucket')
        for (const st of run.plan.stands) {
          if (!aimPickup(liveView(ctx.bot), [st[0] + 0.5, st[1] + 1.62, st[2] + 0.5], c)) continue
          if (!await standAt(ctx, st, true)) continue
          const r = await useBucket(ctx, 'bucket', c, () => count(ctx.bot, 'water_bucket') > before)
          if (r.ok) { ctx.localRecovery('picked up water left in the portal site'); break }
        }
      }
    }
  }
}

/** Choose or resume a site. Lava cast: near the pool's safe access; obsidian: near the bot. */
async function resolveSite (ctx: SkillCtx, strategy: PortalStrategy): Promise<Run> {
  const s = ctx.state()
  const prev = s.memory.locations.find(l => l.kind === 'portal_site' && l.dim === 'overworld' && l.detail?.strategy === strategy && !ctx.env.isBlacklisted(siteKey(l.pos)))
  let pool: Location | null = null
  if (strategy === 'lava_cast') {
    // A pool where the bot died in lava is given up (its surroundings proved deadly).
    for (const p of usablePools(s)) if (s.memory.deaths.some(d => d.dim === 'overworld' && /lava/.test(d.cause ?? '') && dist(d.pos as V3, p.pos) <= 24)) markPool(ctx, p, 'the bot died in lava near this pool')
    const pools = usablePools(s)
    pool = (prev && pools.find(p => p.pos.join(',') === prev.detail?.pool)) ?? pools[0] ?? null
    if (!pool) throw new SkillFailure('NOT_FOUND', 'no usable lava pool remembered', { key: 'target=lava_pool' })
  }
  const prevGeom = prev ? geomFrom(prev.detail) : null
  if (prev && prevGeom) {
    // A site where the bot died is not resumed (dev2 r03: died in the same lava twice).
    const diedHere = s.memory.deaths.some(d => d.dim === 'overworld' && dist(d.pos as V3, prev.pos) <= 12 && d.t >= prev.lastSeen - 600)
    let rc = diedHere ? { ok: false as const, reason: 'the bot died at this site' } : resumeCheck(liveView(ctx.bot), prevGeom)
    if (!rc.ok && rc.reason === 'unloaded') {
      const r = await ctx.nav.goto({ kind: 'near', target: cellAt(prevGeom, 1, 0, 2), range: 2 })
      if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
      rc = resumeCheck(liveView(ctx.bot), prevGeom)
    }
    if (rc.ok) {
      ctx.log('portal', { kind: 'site_resume', strategy, origin: prevGeom.origin })
      const lava = pool ? await poolLava(ctx, pool) : []
      return { strategy, plan: planFor(prevGeom), site: prev, pool, lava, casts: 0, fetches: 0 }
    }
    ctx.log('portal', { kind: 'site_dead', origin: prevGeom.origin, reason: rc.reason })
    ctx.env.blacklist(siteKey(prev.pos), 'site cannot be finished', 3600)
    s.memory.locations = s.memory.locations.filter(l => l !== prev)
  }

  let centerAt: V3
  let lava: V3[] = []
  if (pool) {
    lava = await poolLava(ctx, pool)
    const view = liveView(ctx.bot)
    const sources = lava.filter(c => view.at(...c).source)
    if (!sources.length) throw markPool(ctx, pool, 'no lava sources left')
    let access = lavaAccess(view, sources, feetOf(ctx))
    // Geometry is judged up close: from 50–100 blocks every pool of dev2 r02 was rejected at once.
    if (!access.length && dist(feetOf(ctx), pool.pos) > 16) {
      ctx.log('lava_search', { kind: 'approach_pool', pos: pool.pos, dist: Math.round(dist(feetOf(ctx), pool.pos)) })
      await surfaceFor(ctx, pool.pos)
      const r = await ctx.nav.goto({ kind: 'near', target: pool.pos, range: 8 })
      if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
      lava = await poolLava(ctx, pool)
      const v2 = liveView(ctx.bot)
      access = lavaAccess(v2, lava.filter(c => v2.at(...c).source), feetOf(ctx))
    }
    if (!access.length) throw markPool(ctx, pool, 'no safe stand reaches an open source')
    centerAt = access[0]!.stand
  } else {
    centerAt = feetOf(ctx)
    lava = s.nearby.interestBlocks.lava ?? []
  }
  const t0 = Date.now()
  const bad = badSites(ctx)
  const sites = findSites(liveView(ctx.bot), centerAt, B.portalSiteRadius, 2, { lava, clearance: pool ? B.lavaClearance : 3, rejected: o => nearBad(bad, o) })
  ctx.log('portal', { kind: 'site_search', strategy, center: centerAt, found: sites.length, ms: Date.now() - t0, rejections: lastRejections })
  if (!sites.length) {
    if (pool) throw markPool(ctx, pool, 'no portal site near the pool')
    throw new SkillFailure('NOT_FOUND', 'no site for a portal here', { key: 'target=portal_site' })
  }
  const plan = sites[0]!.plan
  const site = rememberLoc(ctx, 'portal_site', plan.geom.origin, 'built', { strategy, fails: 0, pool: pool?.pos.join(',') ?? '', ...geomDetail(plan.geom) }, 0)
  ctx.log('portal', { kind: 'site', strategy, origin: plan.geom.origin, U: plan.geom.U, F: plan.geom.F, digs: plan.digs, places: plan.places, existing: plan.existing, exposure: plan.exposure, pool: pool?.pos ?? null })
  return { strategy, plan, site, pool, lava, casts: 0, fetches: 0 }
}

/**
 * Mine-to-surface first when the target is well above a bot under cover: long pathfinder routes
 * out of a mine get stuck (dev2 r02: 250 s from y 20 to a site at y 67, 90 blocks away), while the
 * dug staircase (`toSurface`) is a known way up.
 */
async function surfaceFor (ctx: SkillCtx, target: V3): Promise<void> {
  const s = ctx.state()
  if (s.body.covered && target[1] > s.pos[1] + 10 && Math.hypot(target[0] - s.pos[0], target[2] - s.pos[2]) > 24) await toSurface(ctx)
}

/** Lava cells of a remembered pool (travelling close enough to load them first). */
async function poolLava (ctx: SkillCtx, pool: Location): Promise<V3[]> {
  let view = liveView(ctx.bot)
  if (view.at(...pool.pos).kind === 'unknown') {
    await surfaceFor(ctx, pool.pos)
    const r = await ctx.nav.goto({ kind: 'near', target: pool.pos, range: 8 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    view = liveView(ctx.bot)
    if (view.at(...pool.pos).kind === 'unknown') throw new SkillFailure('NAV_UNREACHABLE', 'cannot get near the lava pool', { key: 'target=lava_pool' })
  }
  // The anchor may have been bucketed already: start from the nearest lava cell around it.
  let start: V3 | null = null
  for (let r = 0; r <= 4 && !start; r++) {
    for (let dx = -r; dx <= r && !start; dx++) for (let dy = -r; dy <= r && !start; dy++) for (let dz = -r; dz <= r && !start; dz++) {
      const c: V3 = [pool.pos[0] + dx, pool.pos[1] + dy, pool.pos[2] + dz]
      if (view.at(...c).kind === 'lava') start = c
    }
  }
  return start ? poolCells(view, start).lava : []
}

/** Reject a pool for casting (unusable geometry, exhausted): lava_pool becomes unmet and the search moves on. */
function markPool (ctx: SkillCtx, pool: Location, why: string): SkillFailure {
  pool.detail = { ...pool.detail, unusable: true, reason: why }
  ctx.log('lava_search', { kind: 'pool_rejected', pos: pool.pos, why, access: lastAccess, bot: ctx.state().pos.map(Math.round) })
  return new SkillFailure('NOT_FOUND', `lava pool unusable: ${why}`, { key: 'target=lava_pool', pool: pool.pos })
}

/** Clear the frame, interior and work area; build the floor and back wall. */
async function prepareSite (ctx: SkillCtx, run: Run): Promise<void> {
  const g = run.plan.geom
  const first = cellAt(g, 1, 0, 2)
  // A distant site (often deep under the surface) is reached with the navigator's own strategy
  // (controlled excavation for buried targets); the work-area moves below are short.
  if (dist(feetOf(ctx), first) > 8) {
    await surfaceFor(ctx, first)
    const r = await ctx.nav.goto({ kind: 'near', target: first, range: 3 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
  }
  if (!await standAt(ctx, first, false)) {
    const r = await ctx.nav.goto({ kind: 'near', target: first, range: 1.5, mode: 'path' })
    if (!r.ok) throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, 'cannot reach the portal site', { key: 'step=reach_site', nav: r.detail })
  }
  await recoverWater(ctx, run)
  // Building blocks for the floor and back wall: count what is missing first.
  const missingSolid = run.plan.solid.filter(c => ctx.bot.blockAt(new Vec3(...c), false)?.boundingBox !== 'block').length
  if (buildBlocks(ctx) < missingSolid + 2) {
    ctx.log('portal', { kind: 'blocks_short', need: missingSolid + 2, have: buildBlocks(ctx) })
    const r = await ctx.run('obtain', { item: 'cobblestone', count: count(ctx.bot, 'cobblestone') + missingSolid + 4 - buildBlocks(ctx) })
    if (r.status !== 'success') throw new SkillFailure('MISSING_RESOURCE', 'not enough blocks for the portal back wall', { key: 'item=cobblestone', child: r.failure?.detail ?? null }, [{ item: 'cobblestone', count: missingSolid + 2 }])
    if (!await standAt(ctx, first, false)) throw new SkillFailure('NAV_UNREACHABLE', 'cannot return to the portal site', { key: 'step=reach_site' })
  }
  // Dig order: the stands first (d 2), then the column in front (d 1), then the frame plane, each top-down.
  const depth = (c: V3) => (c[0] - g.origin[0]) * g.F[0] + (c[2] - g.origin[2]) * g.F[2]
  const order = [...run.plan.clear].sort((a, b) => depth(b) - depth(a) || b[1] - a[1])
  let dug = 0
  for (const c of order) {
    ctx.checkAbort()
    const b = ctx.bot.blockAt(new Vec3(...c), false)
    if (!b || isAir(b.name) || b.name === 'obsidian' && run.plan.frame.some(f => f.join() === c.join())) continue
    if (b.name === 'water') { if (b.metadata === 0) await recoverWater(ctx, run); continue }
    if (b.name === 'lava') throw new SkillFailure('STATE_INCONSISTENT', 'lava in the portal site', { key: 'step=clear', cell: c })
    if (b.name === 'nether_portal') continue
    await reach(ctx, run, c)
    if (digReleasesLiquid(liveView(ctx.bot), c)) throw new SkillFailure('STATE_INCONSISTENT', 'digging would release liquid into the site', { key: 'step=clear', cell: c })
    await dig(ctx.bot, b, ctx.signal)
    dug++
    ctx.progress('site_dug', dug)
  }
  // Solid cells bottom-up, so each has something to be placed against.
  const solid = [...run.plan.solid].sort((a, b) => a[1] - b[1] || depth(b) - depth(a))
  let placed = 0
  for (const c of solid) {
    ctx.checkAbort()
    const b = ctx.bot.blockAt(new Vec3(...c), false)
    if (b && b.boundingBox === 'block') continue
    const item = buildBlock(ctx)
    if (!item) throw new SkillFailure('MISSING_RESOURCE', 'out of building blocks', { key: 'item=cobblestone' }, [{ item: 'cobblestone', count: 8 }])
    const f = feetOf(ctx)
    if (f[0] === c[0] && f[2] === c[2] && (f[1] === c[1] || f[1] + 1 === c[1] || f[1] - 1 === c[1])) {
      const other = run.plan.stands.find(st => st[0] !== c[0] || st[2] !== c[2])
      if (other) await standAt(ctx, other, true)
    }
    await reach(ctx, run, c)
    if (!await placeAt(ctx, item, c)) throw new SkillFailure('STATE_INCONSISTENT', `could not place ${item} into the portal wall`, { key: 'step=wall', cell: c })
    placed++
    ctx.progress('site_placed', placed)
  }
  ctx.log('portal', { kind: 'site_ready', dug, placed })
}

/** Fill the empty bucket at the pool (a safe stand whose ray reaches an open source). */
async function fetchLava (ctx: SkillCtx, run: Run): Promise<void> {
  if (count(ctx.bot, 'lava_bucket')) return
  if (!count(ctx.bot, 'bucket')) throw new SkillFailure('MISSING_RESOURCE', 'no empty bucket for lava', { key: 'item=bucket' }, [{ item: 'bucket', count: 1 }])
  const pool = run.pool!
  run.lava = await poolLava(ctx, pool)
  const view = liveView(ctx.bot)
  const sources = run.lava.filter(c => view.at(...c).source)
  if (!sources.length) throw markPool(ctx, pool, 'no lava sources left')
  let access = lavaAccess(view, sources, feetOf(ctx))
  if (!access.length && dist(feetOf(ctx), pool.pos) > 16) {
    const r = await ctx.nav.goto({ kind: 'near', target: pool.pos, range: 8 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    run.lava = await poolLava(ctx, pool)
    const v2 = liveView(ctx.bot)
    access = lavaAccess(v2, run.lava.filter(c => v2.at(...c).source), feetOf(ctx))
  }
  for (const a of access.slice(0, 4)) {
    ctx.checkAbort()
    if (!await standAt(ctx, a.stand, false)) continue
    const r = await useBucket(ctx, 'bucket', a.source, () => count(ctx.bot, 'lava_bucket') > 0)
    ctx.log('portal', { kind: 'lava_fetch', ok: r.ok, why: r.why, stand: a.stand, source: a.source })
    if (r.ok) { run.fetches++; ctx.progress('lava_fetched', run.fetches); return }
  }
  if (!access.length) throw markPool(ctx, pool, 'no safe stand reaches an open source')
  throw new SkillFailure('STATE_INCONSISTENT', 'could not fill a lava bucket', { key: 'step=fetch_lava' })
}

/** Stand cells from which the whole cast of one cell can be aimed (water in, lava in, water out). */
function castStands (ctx: SkillCtx, run: Run, cell: V3, water: V3): V3[] {
  const view = overlayView(liveView(ctx.bot), new Map([[water.join(','), WATER_SOURCE]]))
  return run.plan.stands.filter(st => {
    const eye: V3 = [st[0] + 0.5, st[1] + 1.62, st[2] + 0.5]
    return aimPlace(view, eye, water) && aimPlace(view, eye, cell) && aimPickup(view, eye, water)
  })
}

/**
 * Cast one frame cell: water beside or above it, lava into it (obsidian at once),
 * then the water back into the bucket. Up to 3 attempts; leftovers are cleaned up.
 */
async function castCell (ctx: SkillCtx, run: Run, u: number, v: number): Promise<void> {
  const bot = ctx.bot
  const g = run.plan.geom
  const cell = cellAt(g, u, v)
  for (let attempt = 1; attempt <= 3; attempt++) {
    ctx.checkAbort()
    const name = blockName(bot, cell)
    if (name === 'obsidian') return
    if (name && !isAir(name) && name !== 'water' && name !== 'lava') { await reach(ctx, run, cell); const b = bot.blockAt(new Vec3(...cell), false); if (b) await dig(bot, b, ctx.signal) }
    await recoverWater(ctx, run)
    if (!count(bot, 'water_bucket')) {
      const r = await ctx.run('obtain', { item: 'water_bucket', count: 1 })
      if (r.status !== 'success') throw new SkillFailure('MISSING_RESOURCE', 'lost the water bucket', { key: 'item=water_bucket' }, [{ item: 'water_bucket', count: 1 }])
    }
    if (!isSource(bot, cell, 'lava')) await fetchLava(ctx, run)
    const water = waterCandidates(u, v).map(([wu, wv]) => cellAt(g, wu, wv)).find(w => { const nm = blockName(bot, w); return isAir(nm) || nm === 'water' })
    if (!water) throw new SkillFailure('STATE_INCONSISTENT', 'no free cell for the cast water', { key: 'step=cast', cell })
    const stands = castStands(ctx, run, cell, water)
    if (!stands.length) throw new SkillFailure('STATE_INCONSISTENT', 'no stand can aim this cast', { key: 'step=cast_aim', cell })
    let placedWater = false
    for (const st of stands.slice(0, 3)) {
      if (!await standAt(ctx, st, true)) continue
      const w = await useBucket(ctx, 'water_bucket', water, () => isSource(bot, water, 'water'))
      if (w.ok) { placedWater = true; break }
      ctx.log('portal', { kind: 'cast_step', step: 'water', ok: false, why: w.why, cell })
    }
    if (!placedWater) { ctx.localRecovery('water placement failed'); continue }
    const t0 = Date.now()
    // A cell already holding a lava source (an earlier pour) turns as soon as the water is beside it.
    const l = blockName(bot, cell) === 'obsidian'
      ? { ok: true, why: 'cooled in place' }
      : isSource(bot, water, 'water')
        ? await useBucket(ctx, 'lava_bucket', cell, () => blockName(bot, cell) === 'obsidian' || isSource(bot, cell, 'lava'))
        : { ok: false, why: 'water vanished' }
    // The water always comes back, whatever happened to the lava.
    const before = count(bot, 'water_bucket')
    let back = false
    for (let i = 0; i < 3 && !back; i++) back = (await useBucket(ctx, 'bucket', water, () => count(bot, 'water_bucket') > before)).ok
    if (!back) await recoverWater(ctx, run)
    // Lava that did not turn (no water beside it): cool it with a second pour, or bucket it back.
    if (isSource(bot, cell, 'lava')) {
      ctx.localRecovery('lava did not turn to obsidian')
      const again = count(bot, 'water_bucket') ? await useBucket(ctx, 'water_bucket', water, () => blockName(bot, cell) === 'obsidian') : { ok: false, why: 'no water' }
      if (again.ok) { const b2 = count(bot, 'water_bucket'); await useBucket(ctx, 'bucket', water, () => count(bot, 'water_bucket') > b2) } else await useBucket(ctx, 'bucket', cell, () => !isSource(bot, cell, 'lava'))
    }
    const ok = blockName(bot, cell) === 'obsidian'
    ctx.log('portal', { kind: 'cast', cell, u, v, ok, attempt, lava: l.why, ms: Date.now() - t0, waterBack: back })
    if (ok) { run.casts++; ctx.progress('frame_cast', run.casts); return }
    ctx.localRecovery(`cast failed (${l.why})`)
  }
  throw new SkillFailure('STATE_INCONSISTENT', 'frame cell would not cast', { key: 'step=cast', cell })
}

/** Obsidian strategy: place carried obsidian into every missing frame cell (bottom-up). */
async function placeFrame (ctx: SkillCtx, run: Run): Promise<void> {
  const g = run.plan.geom
  if (count(ctx.bot, 'obsidian') < frameStatus(liveView(ctx.bot), g).missing.length) {
    const r = await ctx.run('obtain', { item: 'obsidian', count: A.obsidian })
    if (r.status !== 'success') throw new SkillFailure('MISSING_RESOURCE', 'not enough obsidian', { key: 'item=obsidian' }, [{ item: 'obsidian', count: A.obsidian }])
  }
  for (const [u, v] of [...FRAME_UV].reverse()) {
    ctx.checkAbort()
    const c = cellAt(g, u, v)
    const name = blockName(ctx.bot, c)
    if (name === 'obsidian') continue
    await reach(ctx, run, c)
    if (name && !isAir(name)) { const b = ctx.bot.blockAt(new Vec3(...c), false); if (b) await dig(ctx.bot, b, ctx.signal) }
    if (!await placeAt(ctx, 'obsidian', c)) throw new SkillFailure('STATE_INCONSISTENT', 'could not place obsidian', { key: 'step=place_obsidian', cell: c })
    ctx.progress('frame_placed', ++run.casts)
  }
}

/** Flint and steel on the top face of a bottom frame block; true once the interior is portal. */
export async function lightPortal (ctx: SkillCtx, g: PortalGeom): Promise<boolean> {
  const bot = ctx.bot
  const base = bot.blockAt(new Vec3(...cellAt(g, 1, 0)), false)
  if (!base || base.name !== 'obsidian') return false
  const it = bot.inventory.items().find(i => i.name === 'flint_and_steel')
  if (!it) throw new SkillFailure('MISSING_RESOURCE', 'no flint and steel', { key: 'item=flint_and_steel' }, [{ item: 'flint_and_steel', count: 1 }])
  await bot.equip(it, 'hand')
  bot.clearControlStates()
  try { await bot.activateBlock(base, new Vec3(0, 1, 0)) } catch { /* verified below */ }
  return waitFor(() => frameStatus(liveView(bot), g).portal >= 6, 2500, ctx.signal)
}

/** Verify the frame, clear the interior, light it and remember the portal. */
async function finish (ctx: SkillCtx, run: Run): Promise<V3> {
  const g = run.plan.geom
  // Cast water drains from the interior within a few seconds; fire cannot be lit in water.
  await waitFor(() => frameStatus(liveView(ctx.bot), g).blockers.every(c => blockName(ctx.bot, c) !== 'water'), 8000, ctx.signal)
  let st = frameStatus(liveView(ctx.bot), g)
  if (st.missing.length) throw new SkillFailure('STATE_INCONSISTENT', `frame incomplete (${st.obsidian}/10)`, { key: 'step=verify', missing: st.missing })
  for (const c of st.blockers) {
    const b = ctx.bot.blockAt(new Vec3(...c), false)
    if (!b || b.name === 'water' || b.name === 'fire') continue
    if (b.name === 'obsidian' || b.name === 'lava') throw new SkillFailure('STATE_INCONSISTENT', `${b.name} inside the portal frame`, { key: 'step=verify', cell: c })
    await reach(ctx, run, c)
    await dig(ctx.bot, b, ctx.signal)
  }
  let lit = st.portal >= 6
  for (let i = 0; i < 3 && !lit; i++) {
    await reach(ctx, run, cellAt(g, 1, 0), 4)
    lit = await lightPortal(ctx, g)
    ctx.log('portal', { kind: 'light', attempt: i + 1, ok: lit })
    if (!lit) { ctx.localRecovery('portal did not light'); await sleep(1000, ctx.signal) }
  }
  st = frameStatus(liveView(ctx.bot), g)
  if (!lit || st.portal < 6) throw new SkillFailure('STATE_INCONSISTENT', 'portal frame did not activate', { key: 'step=light', obsidian: st.obsidian, portal: st.portal })
  const at = cellAt(g, 1, 1)
  rememberLoc(ctx, 'portal_ow', at, 'built', { lit: true, builtAt: ctx.state().t, strategy: run.strategy, ...geomDetail(g) })
  const s = ctx.state()
  s.memory.locations = s.memory.locations.filter(l => l !== run.site)
  return at
}

export const buildNetherPortal: SkillDef<P, { strategy: PortalStrategy; portal: V3; casts: number; fetches: number; ms: number }> = {
  id: 'buildNetherPortal',
  level: 'progression',
  params: Params,
  isSatisfied: s => builtLit(s) !== null,
  preconditions: (s, p) => {
    if (s.dim !== 'overworld') return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'portals are built in the Overworld' }
    if (!n(s, 'flint_and_steel')) return { ok: false, reason: 'no flint and steel', missing: [{ item: 'flint_and_steel', count: 1 }] }
    if (!Object.keys(s.inventory).some(k => k.endsWith('_pickaxe'))) return { ok: false, reason: 'no pickaxe', missing: [{ item: 'stone_pickaxe', count: 1 }] }
    if (portalStrategies(s, p.strategy).length) return { ok: true }
    if (!n(s, 'water_bucket') && n(s, 'obsidian') < A.obsidian) return { ok: false, reason: 'no water bucket', missing: [{ item: 'water_bucket', count: 1 }] }
    if (!n(s, 'bucket') && !n(s, 'lava_bucket')) return { ok: false, reason: 'no empty bucket', missing: [{ item: 'bucket', count: 1 }] }
    return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'no usable lava pool remembered and < 10 obsidian' }
  },
  timeoutMs: () => 12 * 60_000,
  stallMs: 150_000,
  async run (ctx, p) {
    const t0 = Date.now()
    const strategy = portalStrategies(ctx.state(), p.strategy)[0]!
    ctx.log('portal', { kind: 'strategy', strategy, applicable: portalStrategies(ctx.state(), 'auto') })
    const run = await resolveSite(ctx, strategy)
    try {
      await prepareSite(ctx, run)
      if (strategy === 'lava_cast') {
        for (const [u, v] of FRAME_UV) await castCell(ctx, run, u, v)
      } else {
        await placeFrame(ctx, run)
      }
      const portal = await finish(ctx, run)
      ctx.log('portal', { kind: 'built', strategy, portal, casts: run.casts, fetches: run.fetches, ms: Date.now() - t0 })
      return { strategy, portal, casts: run.casts, fetches: run.fetches, ms: Date.now() - t0 }
    } catch (e) {
      // A site that fails twice (not counting interruptions) is given up for another one.
      if (e instanceof SkillFailure && e.cls !== 'MISSING_RESOURCE' && !(e instanceof AbortError)) {
        const fails = Number(run.site.detail?.fails ?? 0) + 1
        run.site.detail = { ...run.site.detail, fails }
        ctx.log('portal', { kind: 'site_failure', origin: run.plan.geom.origin, fails, reason: e.reason })
        if (fails >= 2) {
          ctx.env.blacklist(siteKey(run.site.pos), e.reason, 3600)
          const s = ctx.state()
          s.memory.locations = s.memory.locations.filter(l => l !== run.site)
          // A pool whose surroundings keep defeating sites is given up: the lava search moves on.
          if (run.pool) {
            const poolFails = Number(run.pool.detail?.siteFails ?? 0) + 1
            run.pool.detail = { ...run.pool.detail, siteFails: poolFails }
            if (poolFails >= 3) markPool(ctx, run.pool, `${poolFails} portal sites failed (last: ${e.reason})`)
          }
        }
      }
      throw e
    }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
