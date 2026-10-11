// Milestone B Nether trip: use a remembered portal (enter the Nether through the
// portal the bot built, return through the portal it arrived at), and a controlled
// excursion away from the arrival portal. Dimension changes are verified from the
// client's own dimension state (respawn packets), never assumed.
import { Vec3 } from 'vec3'
import { z } from 'zod'
import progression from '../../../config/progression.json' with { type: 'json' }
import { liveView } from '../../nav/blocks.js'
import type { Location, WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import { equipItem, waitFor } from '../acts.js'
import { toSurface } from '../generic/explore.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { rememberLoc, settle } from './buckets.js'
import { arrivalHazards, excursionTargets, safeStand, tunnelTargets } from './nether-plan.js'
import { builtLit, lightPortal } from './portal.js'
import { frameStatus, geomFrom } from './portal-plan.js'

const B = progression.B

const Dest = z.enum(['the_nether', 'overworld'])
const UseParams = z.object({ to: Dest })
type UseP = z.infer<typeof UseParams>

const hdist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)

/** The portal to leave through: the built one in the Overworld, the nearest remembered one in the Nether. */
export function exitPortal (s: WorldState): Location | null {
  if (s.dim === 'overworld') return builtLit(s)
  return s.memory.locations.filter(l => l.kind === 'portal_nether' && l.dim === s.dim).sort((a, b) => hdist(a.pos, s.pos) - hdist(b.pos, s.pos))[0] ?? null
}

function portalBlocks (ctx: SkillCtx, around: V3, r = 4): Vec3[] {
  const id = ctx.bot.registry.blocksByName.nether_portal!.id
  return ctx.bot.findBlocks({ matching: id, maxDistance: r, count: 12, point: new Vec3(...around) })
}

/** Relight a portal whose frame is intact (an explosion or water put it out). */
async function relight (ctx: SkillCtx, loc: Location): Promise<boolean> {
  const g = geomFrom(loc.detail)
  if (g) {
    const st = frameStatus(liveView(ctx.bot), g)
    if (st.missing.length) return false
    return lightPortal(ctx, g)
  }
  // An arrival portal (game-built): try the top face of obsidian blocks with air above, nearest first.
  const id = ctx.bot.registry.blocksByName.obsidian!.id
  const cands = ctx.bot.findBlocks({ matching: id, maxDistance: 4, count: 24, point: new Vec3(...loc.pos) })
    .filter(p => ctx.bot.blockAt(p.offset(0, 1, 0), false)?.name === 'air')
    .sort((a, b) => a.y - b.y || a.distanceTo(new Vec3(...loc.pos)) - b.distanceTo(new Vec3(...loc.pos)))
  const it = ctx.bot.inventory.items().find(i => i.name === 'flint_and_steel')
  if (!it) return false
  for (const p of cands.slice(0, 6)) {
    await equipItem(ctx.bot, it.name, 'hand')
    try { await ctx.bot.activateBlock(ctx.bot.blockAt(p, false)!, new Vec3(0, 1, 0)) } catch { /* checked below */ }
    if (await waitFor(() => portalBlocks(ctx, loc.pos).length > 0, 1500, ctx.signal)) return true
  }
  return false
}

/** Walk into the portal cell and stand still until the dimension changes (portal time is 4 s in survival). */
async function stepIn (ctx: SkillCtx, cells: Vec3[], from: string): Promise<boolean> {
  const bot = ctx.bot
  for (let attempt = 0; attempt < 4; attempt++) {
    ctx.checkAbort()
    // Walk first; then a path that may dig (never the frame: obsidian is protected) and the other
    // portal cells (ckit-r2c r01: after mining beside its portal the bot stopped 1.5 blocks short,
    // above the portal's floor, six times in a row and the re-entry was suspended).
    const cell = cells[Math.min(cells.length - 1, attempt < 2 ? 0 : attempt - 1)]!
    const r = await ctx.nav.goto({ kind: 'block', target: [cell.x, cell.y, cell.z], mode: attempt === 0 ? 'walk' : 'path' }, { timeoutMs: 20_000 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    // The last half step by hand (the pathfinder may stop at the edge).
    const end = Date.now() + 2500
    while (Date.now() < end && !bot.entity.position.floored().equals(cell)) {
      await bot.lookAt(cell.offset(0.5, 0.5, 0.5), true)
      bot.setControlState('forward', true)
      await sleep(50, ctx.signal)
    }
    bot.clearControlStates()
    if (await waitFor(() => String(bot.game.dimension).replace('minecraft:', '') !== from, 9000, ctx.signal)) return true
    const q = bot.entity.position
    ctx.log('portal', { kind: 'step_in_failed', attempt, cell: [cell.x, cell.y, cell.z], at: [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10, Math.round(q.z * 10) / 10], nav: r.ok ? 'ok' : r.class, feet: bot.blockAt(q.floored(), false)?.name ?? null })
    ctx.localRecovery('no teleport after standing in the portal')
  }
  return false
}

/** The trail is followed only from this far from the portal (B excursions stay well inside it). */
export const TRAIL_FROM = 48

/**
 * Index of the trail point to resume from: the one nearest the portal (lowest index) among the
 * points within 8 blocks of `me`, else the nearest point within 32. -1 when the bot is off the trail.
 */
export function trailIndex (points: V3[], me: V3): number {
  const d = (q: V3) => Math.hypot(q[0] - me[0], q[1] - me[1], q[2] - me[2])
  const close = points.findIndex(q => d(q) <= 8)
  if (close >= 0) return close
  let best = -1
  for (let i = 0; i < points.length; i++) if (d(points[i]!) <= 32 && (best < 0 || d(points[i]!) < d(points[best]!))) best = i
  return best
}

/**
 * Milestone C: back toward the arrival portal along this visit's trail (observer memory.trail,
 * loop-free), several points per leg while they lie within 40 blocks. The cells were walked
 * or dug on the way out, so the pathfinder can take them again. False when off the trail or
 * stuck on it; the caller then tries the direct route.
 */
export async function followTrail (ctx: SkillCtx, portal: V3): Promise<boolean> {
  // A snapshot: walking back shortens the live trail (the observer erases the loop behind the bot).
  const pts = [...(ctx.memory.trail?.points ?? [])]
  if (pts.length < 2) return false
  let fails = 0
  let legs = 0
  ctx.log('trail', { kind: 'start', points: pts.length, dist: Math.round(hdist(ctx.state().pos, portal)) })
  for (let guard = 0; guard < 500; guard++) {
    ctx.checkAbort()
    const me = ctx.state().pos
    if (hdist(me, portal) <= 24) break
    const i = trailIndex(pts, me)
    if (i < 0) { ctx.log('trail', { kind: 'off_trail', legs, fails }); return false }
    if (i === 0) break
    let j = i - 1
    for (let k = i - 1; k >= Math.max(0, i - 12); k--) if (Math.hypot(pts[k]![0] - me[0], pts[k]![1] - me[1], pts[k]![2] - me[2]) <= 40) j = k
    // The navigator's own strategy first (the way out was often walked by controlled excavation
    // under the Nether's roof), then the pathfinder; then the next point only.
    let r = await ctx.nav.goto({ kind: 'near', target: pts[j]!, range: 2 }, { profile: 'nether_travel', timeoutMs: 45_000 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    if (!r.ok) {
      r = await ctx.nav.goto({ kind: 'near', target: pts[j]!, range: 2, mode: 'path' }, { profile: 'nether_travel', timeoutMs: 45_000 })
      if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    }
    if (!r.ok && j !== i - 1) {
      r = await ctx.nav.goto({ kind: 'near', target: pts[i - 1]!, range: 1.5 }, { profile: 'nether_travel', timeoutMs: 30_000 })
      if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    }
    legs++
    if (r.ok) { fails = 0; ctx.progress('trail', pts.length - j) } else if (++fails >= 3) { ctx.log('trail', { kind: 'stuck', legs, at: i }); return false }
  }
  ctx.log('trail', { kind: 'done', legs, dist: Math.round(hdist(ctx.state().pos, portal)) })
  return true
}

/** Step off the portal to a safe cell nearby, so the bot is not sent straight back. */
async function stepOut (ctx: SkillCtx): Promise<void> {
  const view = liveView(ctx.bot)
  const p = ctx.bot.entity.position.floored()
  const cands: V3[] = []
  for (let r = 1; r <= 4 && cands.length < 4; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
      const c: V3 = [p.x + dx, p.y + dy, p.z + dz]
      if (safeStand(view, c, 1) && ctx.bot.blockAt(new Vec3(...c), false)?.name !== 'nether_portal') cands.push(c)
    }
  }
  for (const c of cands) {
    const r = await ctx.nav.goto({ kind: 'block', target: c, mode: 'walk' }, { timeoutMs: 12_000 })
    if (r.ok) return
    if (r.class === 'CANCELLED') ctx.checkAbort()
  }
}

export const usePortal: SkillDef<UseP, { from: string; to: string; ms: number; arrival: V3 }> = {
  id: 'usePortal',
  level: 'progression',
  params: UseParams,
  isSatisfied: (s, p) => s.dim === p.to,
  preconditions: (s, p) => {
    if (s.dim === 'the_end') return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'no portal route from the End' }
    if (p.to === s.dim) return { ok: true }
    if (!exitPortal(s)) return { ok: false, cls: 'PRECONDITION_FAILED', reason: s.dim === 'overworld' ? 'no built portal remembered' : 'no Nether portal remembered' }
    return { ok: true }
  },
  // Milestone C walks back from a fortress hundreds of blocks away: 1.5 s per block beyond TRAIL_FROM.
  timeoutMs: (s) => { const l = exitPortal(s); return 4 * 60_000 + (l ? 1500 * Math.max(0, hdist(l.pos, s.pos) - TRAIL_FROM) : 0) },
  stallMs: 60_000,
  async run (ctx, p) {
    const t0 = Date.now()
    const s = ctx.state()
    const from = s.dim
    const loc = exitPortal(s)!
    ctx.log('portal', { kind: 'use_start', from, to: p.to, portal: loc.pos, dist: Math.round(hdist(loc.pos, s.pos)) })
    if (from === 'the_nether' && hdist(loc.pos, s.pos) > TRAIL_FROM) await followTrail(ctx, loc.pos)
    if (hdist(loc.pos, s.pos) > 3 || Math.abs(loc.pos[1] - s.pos[1]) > 2) {
      // Out of a mine by the dug staircase first when the portal is well above (see portal.ts surfaceFor).
      if (s.body.covered && s.dim === 'overworld' && loc.pos[1] > s.pos[1] + 10 && hdist(loc.pos, s.pos) > 24) await toSurface(ctx)
      // The navigator's own strategy first (excavation for a buried portal), then the pathfinder.
      let r = await ctx.nav.goto({ kind: 'near', target: loc.pos, range: 2 })
      if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
      if (!r.ok) r = await ctx.nav.goto({ kind: 'near', target: loc.pos, range: 2, mode: 'path' })
      if (!r.ok) {
        if (r.class === 'CANCELLED') ctx.checkAbort()
        if (r.class === 'MISSING_RESOURCE') throw new SkillFailure('MISSING_RESOURCE', 'a pickaxe is needed to reach the portal', { key: 'item=pickaxe' }, r.detail.missing ?? [{ item: 'wooden_pickaxe', count: 1 }])
        throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, 'cannot reach the portal', { key: `step=reach_portal|dim=${from}`, nav: r.detail })
      }
      ctx.progress('reached_portal', 1)
    }
    let cells = portalBlocks(ctx, loc.pos)
    if (!cells.length) {
      ctx.log('portal', { kind: 'unlit', dim: from, portal: loc.pos })
      const ok = await relight(ctx, loc)
      ctx.log('portal', { kind: 'relight', dim: from, ok })
      cells = portalBlocks(ctx, loc.pos)
      if (!ok || !cells.length) {
        // A broken built portal is forgotten (the policy rebuilds); a lost Nether portal leaves the bot stranded.
        loc.detail = { ...loc.detail, lit: false }
        throw new SkillFailure('STATE_INCONSISTENT', 'portal is out and cannot be relit', { key: `step=relight|dim=${from}` })
      }
    }
    // Enter at the lowest portal cell nearest the bot.
    const me = ctx.bot.entity.position
    const order = [...cells].sort((a, b) => a.y - b.y || a.distanceTo(me) - b.distanceTo(me))
    const moved = await stepIn(ctx, order, from)
    if (!moved) throw new SkillFailure('STATE_INCONSISTENT', 'stood in the portal but the dimension did not change', { key: `step=teleport|dim=${from}` })
    ctx.progress('teleported', 1)
    await Promise.race([ctx.bot.waitForChunksToLoad(), sleep(20_000, ctx.signal)]).catch(() => {})
    await settle(ctx.bot, ctx.signal)
    const now = ctx.state()
    if (now.dim !== p.to) throw new SkillFailure('STATE_INCONSISTENT', `arrived in ${now.dim}, expected ${p.to}`, { key: 'step=dimension' })
    const hz = arrivalHazards(liveView(ctx.bot), now.pos)
    ctx.log('nether', { kind: 'arrival', dim: now.dim, pos: now.pos.map(Math.round), ...hz })
    // Remember the arrival portal at once (the observer does too, asynchronously).
    const arr = portalBlocks(ctx, now.pos.map(Math.floor) as V3, 3)[0]
    if (arr) rememberLoc(ctx, now.dim === 'the_nether' ? 'portal_nether' : 'portal_ow', [arr.x, arr.y, arr.z], 'observed', { lit: true, arrival: true }, 8)
    await stepOut(ctx)
    return { from, to: now.dim, ms: Date.now() - t0, arrival: now.pos.map(Math.round) as V3 }
  },
  async onCancel (ctx) { ctx.env.nav.stop(); ctx.bot.clearControlStates() },
}

const ExcParams = z.object({ minDist: z.number().positive().default(B.excursionMin) })
type ExcP = z.infer<typeof ExcParams>

function visitStart (s: WorldState): number | null {
  const entry = [...s.memory.transitions].reverse().find(t => t.to === 'the_nether')
  return entry ? entry.t : null
}

/**
 * Controlled movement away from the arrival portal: to a safe standable cell at least
 * `minDist` blocks away (one per direction, fewest lava cells first), or, if the
 * surface routes fail, a straight 2-high tunnel through rock that never opens lava.
 * The farthest distance reached is recorded as the visit's excursion.
 */
export const netherExcursion: SkillDef<ExcP, { dist: number; via: string }> = {
  id: 'netherExcursion',
  level: 'progression',
  params: ExcParams,
  isSatisfied: (s, p) => { const t = visitStart(s); return s.dim === 'the_nether' && t !== null && s.memory.excursions.some(e => e.t >= t && e.dist >= p.minDist) },
  preconditions: s => s.dim === 'the_nether' ? { ok: true } : { ok: false, cls: 'PRECONDITION_FAILED', reason: 'not in the Nether' },
  timeoutMs: () => 5 * 60_000,
  stallMs: 75_000,
  async run (ctx, p) {
    const s = ctx.state()
    let portal = exitPortal(s)
    if (!portal) {
      const near = portalBlocks(ctx, s.pos.map(Math.floor) as V3, 6)[0]
      if (!near) throw new SkillFailure('PRECONDITION_FAILED', 'arrival portal not remembered or seen', { key: 'step=excursion_portal' })
      portal = rememberLoc(ctx, 'portal_nether', [near.x, near.y, near.z], 'observed', { lit: true }, 8)
    }
    const origin = portal.pos
    let best = hdist(ctx.state().pos, origin)
    const track = setInterval(() => { best = Math.max(best, hdist(ctx.state().pos, origin)) }, 250)
    const record = (via: string) => {
      const d = Math.round(best * 10) / 10
      ctx.state().memory.excursions.push({ t: ctx.state().t, dist: d, portal: origin })
      ctx.log('nether', { kind: 'excursion', dist: d, via, portal: origin })
      return { dist: d, via }
    }
    try {
      const view = liveView(ctx.bot)
      // Margin: the goal range and the distance from the portal cell's corner leave a leg short of
      // its target (bkit2 r02: four legs ended at 11.x blocks).
      const targets = excursionTargets(view, origin, p.minDist + 2)
      ctx.log('nether', { kind: 'excursion_plan', targets: targets.length, portal: origin, arrival: arrivalHazards(view, ctx.state().pos) })
      for (const t of targets.slice(0, 4)) {
        ctx.checkAbort()
        // Pathfinder legs: under the Nether's bedrock roof every target counts as covered, and
        // controlled excavation then fails to find a start (dev1 r05: 2 legs NAV_HAZARD, stalled).
        const r = await ctx.nav.goto({ kind: 'near', target: t, range: 1, mode: 'path' }, { profile: 'nether' })
        if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
        if (best >= p.minDist) return record('walk')
        ctx.log('nether', { kind: 'excursion_leg', ok: r.ok, class: r.ok ? null : r.class, target: t, best: Math.round(best) })
      }
      const tunnels = tunnelTargets(liveView(ctx.bot), [Math.floor(origin[0]), Math.floor(origin[1]), Math.floor(origin[2])], p.minDist + 2)
      for (const tt of tunnels) {
        ctx.checkAbort()
        const r = await ctx.nav.goto({ kind: 'near', target: tt, range: 1, mode: 'excavate' }, { profile: 'nether' })
        if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
        if (best >= p.minDist) return record('tunnel')
        ctx.log('nether', { kind: 'excursion_leg', ok: r.ok, class: r.ok ? null : r.class, target: tt, best: Math.round(best), tunnel: true })
      }
      throw new SkillFailure('NAV_HAZARD', `no safe way ${p.minDist} blocks from the portal (best ${Math.round(best)})`, { key: 'step=excursion', targets: targets.length, tunnel: tunnels.length > 0 })
    } finally {
      clearInterval(track)
    }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
