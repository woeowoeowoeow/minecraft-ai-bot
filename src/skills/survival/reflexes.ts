// P0 emergency skills (architecture §4.2): leave lava or fire, surface for air,
// dig out of a block. They end when the condition clears; they never pick objectives.
import { Vec3 } from 'vec3'
import { z } from 'zod'
import { liveView } from '../../nav/blocks.js'
import { safeCells } from '../../nav/hazards.js'
import type { V3 } from '../../schema/index.js'
import { dig } from '../acts.js'
import { useBucket } from '../progression/buckets.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillDef } from '../types.js'

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

const inDanger = (b: { feet: string; head: string }, inLiquid: string) => b.feet === 'lava' || b.head === 'lava' || b.feet === 'fire' || b.head === 'fire' || inLiquid === 'lava'

/**
 * Get out of lava or fire: head for the nearest safe standable cell (safeCells)
 * with sprint and jump (jumping swims up in lava), re-targeting every 100 ms.
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
    try {
      while (Date.now() - t0 < 9000) {
        ctx.checkAbort()
        const s = ctx.state()
        if (!inDanger(s.body, s.inLiquid)) return { ms: Date.now() - t0, target }
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
