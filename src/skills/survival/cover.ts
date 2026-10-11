// Ranged-threat response (P1 `cover`) and the sealed dig-in shared with `shelter`.
// Running in the open does not outpace arrows or tridents (gate 20260929: 11 of 36
// deaths mid-flee from skeletons, pillagers and drowned). Breaking line of sight
// does: first existing terrain a few steps away, then a 3-deep shaft capped with
// one block, then the shield, then plain flight. Pure planners take a BlockView.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { z } from 'zod'
import { HARMFUL_FLOOR, liveView, type BlockView } from '../../nav/blocks.js'
import { CARDINALS, digReleasesLiquid, isProtected } from '../../nav/hazards.js'
import type { EntityInfo, WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import { GHAST, MOB_THREATS } from '../../version.js'
import { dig, equipItem, withTimeout } from '../acts.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { wantsDeflect, shieldUp } from './ghast.js'
import { GUARD_FIGHT, GUARD_FIGHT_MOBS, guardFight } from './hoglin.js'
import { assessThreat, hasShield, menacing, RANGED_MELEE_DIST, weakState } from './threat.js'

/** Mob eye height used for sight lines (skeleton 1.74, pillager and drowned 1.62). */
const SHOOTER_EYE = 1.62
const BOT_EYE = 1.62
/** Terrain cover is looked for this far (blocks, horizontal). */
export const COVER_RADIUS = 6
/** Dig time (best tool carried) under which a block is quick enough to dig in through. */
export const DIG_IN_MS = 1600
/** Blocks that make a cap: full, non-falling, common. */
export const CAP_BLOCKS = ['cobblestone', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'netherrack', 'sandstone', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cobblestone_slab']

function blocked (view: BlockView, a: V3, b: V3): boolean {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len = Math.hypot(...d)
  const n = Math.max(1, Math.ceil(len / 0.2))
  let last = ''
  for (let i = 1; i < n; i++) {
    const x = Math.floor(a[0] + (d[0] * i) / n); const y = Math.floor(a[1] + (d[1] * i) / n); const z = Math.floor(a[2] + (d[2] * i) / n)
    const k = `${x},${y},${z}`
    if (k === last) continue
    last = k
    const c = view.at(x, y, z)
    if (c.kind === 'solid' || c.kind === 'unknown') return true
  }
  return false
}

/** True when no shooter (eye positions) can see the bot's eye or chest standing at `cell`. */
export function hiddenAt (view: BlockView, cell: V3, shooters: V3[]): boolean {
  const eye: V3 = [cell[0] + 0.5, cell[1] + BOT_EYE, cell[2] + 0.5]
  const chest: V3 = [cell[0] + 0.5, cell[1] + 1.1, cell[2] + 0.5]
  return shooters.every(s => blocked(view, s, eye) && blocked(view, s, chest))
}

/**
 * Standable cells within COVER_RADIUS where no shooter can see the bot, nearest
 * first: solid non-harmful floor, air at feet and head, no lava beside the body,
 * and not closer than 3 blocks to a shooter. Pure.
 */
export function findCoverCells (view: BlockView, feet: V3, shooters: V3[], r = COVER_RADIUS): V3[] {
  const [x0, y0, z0] = feet.map(Math.floor) as V3
  const out: { c: V3; score: number }[] = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.hypot(dx, dz) > r) continue
      for (let dy = -2; dy <= 1; dy++) {
        const c: V3 = [x0 + dx, y0 + dy, z0 + dz]
        const floor = view.at(c[0], c[1] - 1, c[2])
        if (floor.kind !== 'solid' || HARMFUL_FLOOR.has(floor.name)) continue
        if (view.at(c[0], c[1], c[2]).kind !== 'air' || view.at(c[0], c[1] + 1, c[2]).kind !== 'air') continue
        let bad = false
        for (const hy of [0, 1]) for (const [ax, az] of CARDINALS) if (view.at(c[0] + ax, c[1] + hy, c[2] + az).kind === 'lava') bad = true
        if (bad || shooters.some(s => Math.hypot(s[0] - c[0] - 0.5, s[2] - c[2] - 0.5) < 3)) continue
        if (!hiddenAt(view, c, shooters)) continue
        out.push({ c, score: Math.hypot(dx, dz) + 1.5 * Math.abs(dy) })
      }
    }
  }
  out.sort((a, b) => a.score - b.score || a.c[0] - b.c[0] || a.c[2] - b.c[2] || a.c[1] - b.c[1])
  return out.map(o => o.c)
}

export type DigInPlan = { stand: V3; ref: [number, number] | null }

/**
 * A column to dig in: standing at `stand`, dig the three blocks below and re-cap
 * the top one against a side wall. Each dug block is quick to dig and releases no
 * liquid, the shaft walls at the bot's feet and head are solid, and the floor is
 * solid and harmless. Current cell first, then rings out to `r`. Pure.
 */
export function planDigIn (view: BlockView, feet: V3, r = 0): DigInPlan | null {
  const [x0, y0, z0] = feet.map(Math.floor) as V3
  for (let ring = 0; ring <= r; ring++) {
    const found: { p: DigInPlan; score: number }[] = []
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
        for (const dy of ring === 0 ? [0] : [0, 1, -1]) {
          const p = columnPlan(view, [x0 + dx, y0 + dy, z0 + dz])
          if (p) found.push({ p, score: Math.hypot(dx, dz) + Math.abs(dy) + (p.ref ? 0 : 4) })
        }
      }
    }
    found.sort((a, b) => a.score - b.score || a.p.stand[0] - b.p.stand[0] || a.p.stand[2] - b.p.stand[2])
    if (found.length) return found[0]!.p
  }
  return null
}

function columnPlan (view: BlockView, [x, y, z]: V3): DigInPlan | null {
  if (view.at(x, y, z).kind !== 'air' || view.at(x, y + 1, z).kind !== 'air') return null
  // No falling blocks in the shaft or its walls: a pocket in sand cannot be left again (the
  // pathfinder never breaks a block under a falling one; dev batch 14 r03: entombed 35 min).
  for (const d of [1, 2, 3]) {
    const c = view.at(x, y - d, z)
    if (c.kind !== 'solid' || c.gravity || !(c.digMs <= DIG_IN_MS)) return null
    if (digReleasesLiquid(view, [x, y - d, z])) return null
  }
  const floor = view.at(x, y - 4, z)
  if (floor.kind !== 'solid' || HARMFUL_FLOOR.has(floor.name)) return null
  for (const d of [1, 2, 3]) for (const [ax, az] of CARDINALS) if (view.at(x + ax, y - d, z + az).gravity) return null
  for (const d of [2, 3]) for (const [ax, az] of CARDINALS) if (view.at(x + ax, y - d, z + az).kind !== 'solid') return null
  const ref = CARDINALS.find(([ax, az]) => view.at(x + ax, y - 1, z + az).kind === 'solid') ?? null
  return { stand: [x, y, z], ref }
}

/** A carried block to cap the shaft with (non-falling). */
export function capBlock (inv: Record<string, number>): string | null {
  return CAP_BLOCKS.find(n => (inv[n] ?? 0) > 0) ?? null
}

async function centre (bot: Bot, cell: V3, signal: AbortSignal): Promise<boolean> {
  const end = Date.now() + 2500
  try {
    while (Date.now() < end) {
      if (signal.aborted) throw signal.reason
      const p = bot.entity.position
      const dx = cell[0] + 0.5 - p.x
      const dz = cell[2] + 0.5 - p.z
      if (Math.hypot(dx, dz) <= 0.2 && Math.floor(p.y + 0.05) === cell[1]) return true
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('sneak', true)
      await sleep(50, signal)
    }
    return false
  } finally {
    bot.clearControlStates()
  }
}

export type DigInResult = { ok: boolean; capped: boolean; pos: V3 | null; reason: string }

/**
 * Dig in: walk to the planned column (≤ `walkR` blocks), drop three blocks down and
 * cap the shaft. The bot's eye is below ground after the second block, so it is
 * exposed for about two dig times. Leaves an enclosed 1×2 pocket (body.enclosed);
 * the pathfinder can dig and tower back out with the dug blocks.
 */
export async function digIn (ctx: SkillCtx, walkR: number, between?: () => Promise<void>): Promise<DigInResult> {
  const bot = ctx.bot
  const start = ctx.state().pos
  const plan = planDigIn(liveView(bot), [Math.floor(start[0]), Math.floor(start[1] + 0.05), Math.floor(start[2])], walkR)
  if (!plan) return { ok: false, capped: false, pos: null, reason: 'no diggable column' }
  const [x, y, z] = plan.stand
  const here = bot.entity.position.floored()
  if (here.x !== x || here.z !== z || Math.floor(bot.entity.position.y + 0.05) !== y) {
    const r = await ctx.nav.goto({ kind: 'near', target: plan.stand, range: 0.5, mode: 'walk' }, { timeoutMs: 5000 })
    if (!r.ok) return { ok: false, capped: false, pos: plan.stand, reason: `walk failed: ${r.class}` }
  }
  if (!(await centre(bot, plan.stand, ctx.signal))) return { ok: false, capped: false, pos: plan.stand, reason: 'could not centre' }
  for (const d of [1, 2, 3]) {
    ctx.checkAbort()
    if (between) await between()
    const b = bot.blockAt(new Vec3(x, y - d, z), false)
    if (b && isProtected(b.name)) return { ok: false, capped: false, pos: plan.stand, reason: `would dig ${b.name}` }
    if (b && b.boundingBox === 'block') await dig(bot, b, ctx.signal)
    const end = Date.now() + 1500
    while (Date.now() < end && !(bot.entity.onGround && bot.entity.position.y < y - d + 0.5)) await sleep(50, ctx.signal)
    ctx.progress('dug_in', d)
  }
  if (Math.floor(bot.entity.position.y + 0.05) !== y - 3) return { ok: false, capped: false, pos: plan.stand, reason: 'did not drop into the shaft' }
  await sleep(300, ctx.signal) // pick up the dug blocks
  let capped = false
  const cap = capBlock(ctx.state().inventory)
  if (cap && plan.ref) {
    const ref = bot.blockAt(new Vec3(x + plan.ref[0], y - 1, z + plan.ref[1]), false)
    if (ref && ref.boundingBox === 'block') {
      try {
        await equipItem(bot, cap, 'hand')
        const face = new Vec3(-plan.ref[0], 0, -plan.ref[1])
        await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5, 0.5 + face.z * 0.5), true)
        await withTimeout(bot.placeBlock(ref, face), 4000, 'cap')
      } catch { /* checked below */ }
      await sleep(150, ctx.signal)
      capped = bot.blockAt(new Vec3(x, y - 1, z), false)?.boundingBox === 'block'
    }
  }
  return { ok: true, capped, pos: [x, y - 3, z], reason: capped ? 'sealed' : cap ? 'no cap placed' : 'no cap block' }
}

/** Ranged mobs that can reach the bot (within their range, a little beyond when out of sight). */
export function shooters (s: WorldState): EntityInfo[] {
  return s.nearby.entities.filter(e => {
    if (!menacing(e, s)) return false
    const info = MOB_THREATS[e.name]
    // Same reading as the threat score (threat.ts): a crossbow piglin shoots (ckit3 r01: 30 instant covers in 2 s).
    const ranged = Boolean(info?.ranged) || (e.name === 'drowned' && e.held === 'trident') || (e.name === 'piglin' && e.held === 'crossbow')
    if (!ranged) return false
    return e.dist <= Math.max(info?.range ?? 12, 12) + (e.los === false ? 4 : 0)
  })
}

const eyeOf = (e: EntityInfo): V3 => [e.pos[0], e.pos[1] + (e.name === 'ghast' ? GHAST.eye : SHOOTER_EYE), e.pos[2]]

async function raiseShield (bot: Bot, at: EntityInfo, ms: number, signal: AbortSignal): Promise<void> {
  await bot.lookAt(new Vec3(at.pos[0], at.pos[1] + SHOOTER_EYE, at.pos[2]), true)
  bot.activateItem(true)
  try { await sleep(ms, signal) } finally { bot.deactivateItem() }
}

const Params = z.object({ targetId: z.number().int().optional(), holdMs: z.number().int().positive().default(8000) })
type P = z.infer<typeof Params>
export type CoverMethod = 'none' | 'hidden' | 'enclosed' | 'terrain' | 'dig_in' | 'shield' | 'guard_fight'

/**
 * P1 response to shooters in sight: get out of their line of sight and stay out
 * of it for `holdMs` (they strafe and re-approach). Order: existing terrain within
 * COVER_RADIUS (short walk), a sealed dig-in in place, the shield raised toward
 * the nearest shooter. Fails with COMBAT_DANGER when none works, so the controller
 * falls back to `flee`. Emits one `cover` event per attempt (outcome tracking).
 */
export const cover: SkillDef<P, { method: CoverMethod; waitedMs: number }> = {
  id: 'cover',
  level: 'survival',
  params: Params,
  preconditions: () => ({ ok: true }),
  // A guarded hoglin fight lasts up to GUARD_FIGHT.maxMs (A/B paths end well inside 40 s, as before).
  timeoutMs: () => GUARD_FIGHT.maxMs + 30_000,
  stallMs: 20_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const t0 = Date.now()
    let method: CoverMethod = 'none'
    let terrainTries = 0
    let dug = false
    let shieldMs = 0
    let hiddenSince = 0
    const report = (ok: boolean, why: string) => ctx.log('cover', { ok, method, why, ms: Date.now() - t0, hp: Math.round(ctx.state().vitals.health * 10) / 10, shooters: shooters(ctx.state()).map(e => `${e.name}@${Math.round(e.dist)}`) })
    try {
      // Ghast fire is blocked here, between steps (the P0 reflex leaves a running cover alone).
      const block = async () => { if (wantsDeflect(ctx.state())) { await shieldUp(ctx); method = method === 'none' ? 'shield' : method } }
      for (;;) {
        ctx.checkAbort()
        await block()
        const s = ctx.state()
        if (s.body.enclosed) { if (method === 'none') method = 'enclosed'; report(true, 'enclosed'); return { method, waitedMs: Date.now() - t0 } }
        const sh = shooters(s)
        const seen = sh.filter(e => e.los !== false)
        if (!sh.length) {
          // Melee pressure on a weak bot (threat.ts `weak: dig in`): seal a pocket instead of running.
          const th = assessThreat(s)
          // Weak, or an avoided mob (hoglin, magma cube: never fought) closing in.
          if (!dug && s.inLiquid === 'none' && (weakState(s) || th.mobs.some(m => MOB_THREATS[m.e.name]?.avoid && m.e.dist <= 10)) && th.mobs.some(m => !m.ranged && m.e.dist <= 10)) {
            dug = true
            // Hoglins: a guarded fight with sword and shield (hoglin.ts); a dig-in under their
            // knock-up hits does not finish (C dev batch 20261007-110334 r05, two deaths).
            if (th.mobs.some(m => GUARD_FIGHT_MOBS.has(m.e.name) && m.e.dist <= 10) && hasShield(s) && s.vitals.health > GUARD_FIGHT.quitHp) {
              const r = await guardFight(ctx)
              ctx.log('cover', { ok: r.ok, method: 'guard_fight', why: r.reason, kills: r.kills, strikes: r.strikes, blocked: r.blocked, step: true, hp: Math.round(ctx.state().vitals.health * 10) / 10 })
              if (r.ok) { method = 'guard_fight'; dug = false; continue }
            }
            const r = await digIn(ctx, 1)
            ctx.log('cover', { ok: r.ok, method: 'dig_in', why: r.reason, capped: r.capped, step: true, vs: 'melee' })
            if (r.ok) { method = 'dig_in'; continue }
            report(false, `melee: ${r.reason}`)
            throw new SkillFailure('COMBAT_DANGER', `no dig-in from melee: ${r.reason}`, { key: `target=${th.primary?.e.name ?? '?'}` })
          }
          if (method === 'none') method = 'hidden'
          report(true, 'no shooter in range')
          return { method, waitedMs: Date.now() - t0 }
        }
        // A shooter that came into melee range is fought by `defend` (the interrupt re-evaluates).
        if (seen.length && seen.every(e => e.dist <= RANGED_MELEE_DIST) && assessThreat(s).action === 'defend') { report(true, 'shooter in melee range'); return { method, waitedMs: Date.now() - t0 } }
        if (!seen.length) {
          hiddenSince ||= Date.now()
          if (method === 'none') method = 'hidden'
          ctx.progress('hidden', Date.now() - hiddenSince)
          if (Date.now() - hiddenSince >= p.holdMs) { report(true, 'held cover'); return { method, waitedMs: Date.now() - t0 } }
          await sleep(250, ctx.signal)
          continue
        }
        hiddenSince = 0
        const feet: V3 = [Math.floor(s.pos[0]), Math.floor(s.pos[1] + 0.05), Math.floor(s.pos[2])]
        // A ghast flies around terrain cover: only ghasts in sight → dig in first.
        const ghastsOnly = seen.every(e => e.name === 'ghast')
        if (ghastsOnly && !dug && s.inLiquid === 'none') {
          dug = true
          const r = await digIn(ctx, 1, block)
          ctx.log('cover', { ok: r.ok, method: 'dig_in', why: r.reason, capped: r.capped, step: true, vs: 'ghast' })
          if (r.ok) { method = 'dig_in'; continue }
        }
        if (terrainTries < 2 && s.inLiquid === 'none') {
          terrainTries++
          const cells = findCoverCells(liveView(bot), feet, seen.map(eyeOf))
          const cell = cells[0]
          if (cell) {
            const r = await ctx.nav.goto({ kind: 'near', target: cell, range: 0.6, mode: 'walk' }, { timeoutMs: 5000 })
            if (r.ok) { method = 'terrain'; ctx.progress('cover', terrainTries); continue }
          }
        }
        if (!dug && s.inLiquid === 'none') {
          dug = true
          const r = await digIn(ctx, 1, block)
          ctx.log('cover', { ok: r.ok, method: 'dig_in', why: r.reason, capped: r.capped, step: true })
          if (r.ok) { method = 'dig_in'; continue }
        }
        const off = bot.inventory.slots[45]?.name === 'shield' || (s.inventory.shield ?? 0) > 0
        if (off && shieldMs < 12_000) {
          if (bot.inventory.slots[45]?.name !== 'shield') await equipItem(bot, 'shield', 'off-hand').catch(() => {})
          const nearest = [...seen].sort((a, b) => a.dist - b.dist)[0]!
          await raiseShield(bot, nearest, 1000, ctx.signal)
          shieldMs += 1000
          method = 'shield'
          ctx.progress('shield', shieldMs)
          continue
        }
        report(false, 'no cover')
        throw new SkillFailure('COMBAT_DANGER', 'no cover from shooters', { key: `target=${seen[0]?.name ?? '?'}` })
      }
    } catch (e) {
      if (!(e instanceof SkillFailure) && !ctx.signal.aborted) report(false, (e as Error)?.message ?? String(e))
      throw e
    }
  },
  async onCancel (ctx) {
    try { ctx.bot.deactivateItem() } catch { /* ignore */ }
    ctx.bot.clearControlStates()
    ctx.env.nav.stop()
  },
}
