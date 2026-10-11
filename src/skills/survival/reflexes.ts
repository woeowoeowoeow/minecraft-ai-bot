// P0 emergency skills (architecture §4.2): leave lava or fire, surface for air,
// dig out of a block. They end when the condition clears; they never pick objectives.
import { Vec3 } from 'vec3'
import { z } from 'zod'
import { liveView } from '../../nav/blocks.js'
import { safeCells } from '../../nav/hazards.js'
import type { V3 } from '../../schema/index.js'
import { dig, waitFor } from '../acts.js'
import { useBucket } from '../progression/buckets.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillDef } from '../types.js'
import { useFireRes } from './potion.js'

const None = z.object({}).passthrough()

/**
 * Put out a fire on the bot (Overworld): pour the water bucket at the feet, wait for the fire
 * to go out, scoop the water back. After a lava escape the bot burns for up to 15 s at 1 HP/s
 * (b3-smoke1 r01: escaped lava at 8.9 HP, burned to death resting 15 s later with a water bucket).
 */
export const extinguish: SkillDef<z.infer<typeof None>, { out: boolean }> = {
  id: 'extinguish',
  level: 'survival',
  params: z.object({}).passthrough(),
  preconditions: (s) => s.dim !== 'overworld' ? { ok: false, reason: 'water does not stay outside the Overworld' } : (s.inventory.water_bucket ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'no water bucket', missing: [{ item: 'water_bucket', count: 1 }] },
  timeoutMs: () => 8000,
  stallMs: 8000,
  async run (ctx) {
    const bot = ctx.bot
    // Never stand still in or at lava: escapeLava comes first (same priority, so check here).
    const lava = () => { const s = ctx.state(); return inDanger(s.body, s.inLiquid) || s.nearby.hazards.some(h => h.kind === 'lava' && h.dist <= 2.5) }
    if (lava()) throw new SkillFailure('NAV_HAZARD', 'lava beside the bot', { key: 'hazard=lava' })
    const p = bot.entity.position
    const feet: V3 = [Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)]
    const poured = await useBucket(ctx, 'water_bucket', feet, () => bot.blockAt(new Vec3(...feet), false)?.name === 'water')
    if (!poured.ok) throw new SkillFailure('NAV_HAZARD', `could not pour water: ${poured.why}`, { key: 'hazard=fire' })
    const t0 = Date.now()
    while (ctx.state().vitals.onFire && !lava() && Date.now() - t0 < 1500) await sleep(100, ctx.signal)
    const before = ctx.state().inventory.water_bucket ?? 0
    await useBucket(ctx, 'bucket', feet, () => (ctx.state().inventory.water_bucket ?? 0) > before)
    return { out: !ctx.state().vitals.onFire }
  },
  async onCancel (ctx) { ctx.bot.clearControlStates() },
}
type P = z.infer<typeof None>

const inDanger = (b: { feet: string; head: string; inFire?: boolean }, inLiquid: string) => b.feet === 'lava' || b.head === 'lava' || b.feet === 'fire' || b.head === 'fire' || b.inFire === true || inLiquid === 'lava'

/**
 * Drink a fire resistance potion in lava only above this health, and only with no safe cell within
 * LAVA_EDGE: drinking takes 1.6 s and lava burns 4 per 0.5 s (fixture: drunk at 18 HP in a pool's
 * centre, took effect at 2 HP; not drunk, died escaping). Next to an edge the bot just steps out.
 */
export const LAVA_DRINK_HP = 10
export const LAVA_EDGE = 1.5

/**
 * Get out of lava or fire: head for the nearest safe standable cell (safeCells)
 * with sprint and jump (jumping swims up in lava), re-targeting every 100 ms. In lava with a
 * fire resistance potion carried, use it first: a splash potion at once, a drinkable one above
 * LAVA_DRINK_HP (ckit-r2b r02: fell into lava holding a splash potion, 13 → 0 HP in 1.8 s).
 */
export const escapeLava: SkillDef<P, { ms: number; target: V3 | null }> = {
  id: 'escapeLava',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 10_000,
  stallMs: 10_000,
  async run (ctx) {
    const bot = ctx.bot
    const t0 = Date.now()
    let target: V3 | null = null
    let potionTried = false
    try {
      while (Date.now() - t0 < 9000) {
        ctx.checkAbort()
        const s = ctx.state()
        if (!inDanger(s.body, s.inLiquid)) return { ms: Date.now() - t0, target }
        if (!potionTried && (s.inLiquid === 'lava' || s.body.feet === 'lava' || s.body.head === 'lava') && !s.vitals.effects.includes('FireResistance')) {
          potionTried = true
          bot.setControlState('jump', true)
          const q = bot.entity.position
          const edge = safeCells(liveView(bot), [Math.floor(q.x), Math.floor(q.y + 0.05), Math.floor(q.z)])[0]
          const nearEdge = !!edge && Math.hypot(edge[0] + 0.5 - q.x, edge[2] + 0.5 - q.z) <= LAVA_EDGE
          const used = await useFireRes(bot, ctx.signal, { splashOnly: nearEdge || s.vitals.health <= LAVA_DRINK_HP })
          if (used) {
            const ok = await waitFor(() => ctx.state().vitals.effects.includes('FireResistance'), 1000, ctx.signal)
            ctx.log('lava_potion', { kind: used, ok, hp: Math.round(ctx.state().vitals.health * 10) / 10 })
          }
        }
        const p = bot.entity.position
        const feet: V3 = [Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)]
        target = safeCells(liveView(bot), feet)[0] ?? null
        if (target) {
          const dx = target[0] + 0.5 - p.x
          const dz = target[2] + 0.5 - p.z
          await bot.look(Math.atan2(-dx, -dz), 0, true)
          bot.setControlState('forward', Math.hypot(dx, dz) > 0.3)
          bot.setControlState('sprint', true)
        } else {
          bot.setControlState('forward', true)
        }
        bot.setControlState('jump', true)
        ctx.progress('escape', Date.now() - t0)
        await sleep(100, ctx.signal)
      }
    } finally {
      bot.clearControlStates()
    }
    const s = ctx.state()
    if (inDanger(s.body, s.inLiquid)) throw new SkillFailure('NAV_HAZARD', 'still in lava or fire', { key: 'hazard=lava', target })
    return { ms: Date.now() - t0, target }
  },
  async onCancel (ctx) { ctx.bot.clearControlStates() },
}

/** Surface for air (the navigator's swim-up / route-to-air reflex). */
export const surfaceForAir: SkillDef<P, { air: number }> = {
  id: 'surfaceForAir',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 12_000,
  stallMs: 12_000,
  async run (ctx) {
    ctx.env.nav.stop()
    const ok = await ctx.env.nav.surface()
    if (!ok) throw new SkillFailure('NAV_HAZARD', 'cannot surface', { key: 'hazard=water' })
    return { air: ctx.state().vitals.air }
  },
}

/** Head inside a solid block (falling sand or gravel): dig the head cell, then the feet cell. */
export const escapeSuffocation: SkillDef<P, { dug: number }> = {
  id: 'escapeSuffocation',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 12_000,
  stallMs: 12_000,
  async run (ctx) {
    const bot = ctx.bot
    let dug = 0
    for (let i = 0; i < 6; i++) {
      ctx.checkAbort()
      const p = bot.entity.position
      const head = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y + 1.62), Math.floor(p.z)), false)
      const feet = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)), false)
      const target = head && head.boundingBox === 'block' ? head : feet && feet.boundingBox === 'block' ? feet : null
      if (!target) return { dug }
      if (!target.diggable) throw new SkillFailure('NAV_HAZARD', `stuck in ${target.name}`, { key: `block=${target.name}` })
      await dig(bot, target, ctx.signal)
      dug++
      ctx.progress('dug', dug)
      await sleep(200, ctx.signal)
    }
    throw new SkillFailure('NAV_HAZARD', 'still inside blocks', { key: 'hazard=suffocation' })
  },
  async onCancel (ctx) { try { ctx.bot.stopDigging() } catch { /* ignore */ } },
}

/**
 * Step off a magma floor (milestone C, Nether): to the nearest safe standable cell (safeCells
 * rejects harmful floors and lava beside the body), walking only.
 */
export const stepOffMagma: SkillDef<z.infer<typeof None>, { to: V3 | null }> = {
  id: 'stepOffMagma',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 8000,
  stallMs: 8000,
  async run (ctx) {
    const p = ctx.bot.entity.position
    const feet: V3 = [Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)]
    for (const c of safeCells(liveView(ctx.bot), feet, 4).slice(0, 3)) {
      const r = await ctx.nav.goto({ kind: 'block', target: c, mode: 'walk' }, { timeoutMs: 3000 })
      if (r.ok || ctx.state().body.floor !== 'magma_block') return { to: c }
      if (r.class === 'CANCELLED') ctx.checkAbort()
    }
    throw new SkillFailure('NAV_HAZARD', 'no safe cell off the magma', { key: 'hazard=magma' })
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

/**
 * Step out of a portal (any skill but the portal skills): 4 s standing in one teleports. ckit-r2d
 * r02: the bed staging stood in the portal and was sent to the Nether, where it then hunted sheep.
 * To the nearest safe standable cell whose feet and head are not portal cells, walking only.
 */
export const leavePortal: SkillDef<z.infer<typeof None>, { to: V3 | null }> = {
  id: 'leavePortal',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 8000,
  stallMs: 8000,
  async run (ctx) {
    const bot = ctx.bot
    const p = bot.entity.position
    const feet: V3 = [Math.floor(p.x), Math.floor(p.y + 0.05), Math.floor(p.z)]
    const portal = (c: V3) => [0, 1].some(dy => bot.blockAt(new Vec3(c[0], c[1] + dy, c[2]), false)?.name === 'nether_portal')
    const cells = safeCells(liveView(bot), feet, 3).filter(c => !portal(c))
    for (const c of cells.slice(0, 3)) {
      const r = await ctx.nav.goto({ kind: 'block', target: c, mode: 'walk' }, { timeoutMs: 3000 })
      if (r.ok || !ctx.state().body.inPortal) return { to: c }
      if (r.class === 'CANCELLED') ctx.checkAbort()
    }
    throw new SkillFailure('NAV_STUCK', 'cannot step out of the portal', { key: 'hazard=portal' })
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

/**
 * Water trap escape (P0, after a route failed on the water itself and the bot is still in it):
 * surface, dig an ice ceiling if needed, then climb out at an exit within 12, else within 40 along
 * the surface (notches cut into packed ice or snow). ckit-r2d r01: pinned at a packed-ice corner,
 * every route "repeatedly out of air", the objectives retried from the water for 1 200 s.
 */
export const escapeWater: SkillDef<z.infer<typeof None>, { dry: boolean }> = {
  id: 'escapeWater',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 75_000,
  stallMs: 40_000,
  async run (ctx) {
    ctx.env.nav.stop()
    const dry = await ctx.env.nav.escapeWater(ctx.signal)
    if (!dry) {
      ctx.checkAbort()
      throw new SkillFailure('NAV_HAZARD', 'no way out of the water', { key: 'hazard=water_trap' })
    }
    ctx.memory.blacklist = ctx.memory.blacklist.filter(b => b.key !== 'water_trap')
    return { dry }
  },
  async onCancel (ctx) { ctx.env.nav.stop(); ctx.bot.clearControlStates() },
}
