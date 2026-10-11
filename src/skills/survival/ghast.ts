// Ghast fire (milestone C). A ghast shoots at a player it can see within 64 blocks; the
// fireball hits for 6 and explodes (C smoke 20261006 r01: two deaths, the ghasts 32–64
// blocks off and never observed). A 1.16 shield raised toward the fireball blocks the hit
// and the explosion (both damage sources sit in front of the bot) once it has been up for
// 5 ticks. P1 `cover` breaks the line of sight; this P0 reflex covers the shots that come
// before, or while, it does: a charging ghast in sight (its fireball leaves ~0.5 s later)
// or a fireball flying at the bot.
import { Vec3 } from 'vec3'
import { z } from 'zod'
import type { EntityInfo, WorldState } from '../../observer/types.js'
import { GHAST } from '../../version.js'
import { equipItem } from '../acts.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { hasShield } from './threat.js'

/**
 * The reflex lasts at most `maxMs` (a fireball from 64 blocks arrives within ~2 s of the charge).
 * The shield stays up `clearMs` after the last threat, and `afterChargeMs` after a charge: the
 * fireball leaves as the charge ends and has no measured speed yet (ghast fixture: lowering the
 * shield in that gap cost 1–5 HP per shot). Fire at the bot ends the reflex (escape_fire next).
 */
export const DEFLECT = { maxMs: 6000, clearMs: 500, afterChargeMs: 1500 } as const

/** What to raise the shield toward: an incoming fireball first, else a charging ghast in sight. Pure. */
export function deflectTarget (s: WorldState): EntityInfo | null {
  const fireball = s.nearby.entities
    .filter(e => e.name === GHAST.fireball && e.dist <= GHAST.fireballWatch && (e.closing ?? 0) >= GHAST.fireballClosing)
    .sort((a, b) => a.dist - b.dist)[0]
  if (fireball) return fireball
  return s.nearby.entities
    .filter(e => e.name === 'ghast' && e.charging === true && e.los !== false && e.dist <= GHAST.range)
    .sort((a, b) => a.dist - b.dist)[0] ?? null
}

/** While the shield is up: any fireball in range that is not flying away, else a charging ghast in sight. Pure. */
export function holdTarget (s: WorldState): EntityInfo | null {
  const fireball = s.nearby.entities
    .filter(e => e.name === GHAST.fireball && e.dist <= GHAST.fireballWatch && (e.closing ?? 0) > -GHAST.fireballClosing)
    .sort((a, b) => a.dist - b.dist)[0]
  return fireball ?? deflectTarget(s)
}

/** P0 `deflect` applies: something to block and a shield to block it with. Pure. */
export function wantsDeflect (s: WorldState): EntityInfo | null {
  if (!hasShield(s) || s.inLiquid !== 'none') return null
  return deflectTarget(s)
}

const Params = z.object({ targetId: z.number().int().optional() }).passthrough()

/**
 * Raise the shield toward incoming ghast fire and hold it until the shot has passed (or fire
 * reaches the bot). Shared by the P0 `deflect` reflex and `cover`, which blocks between its own
 * steps instead of being preempted (ghast fixture: a ghast charges every ~3 s, and a cover cut
 * off by each deflect never finished its dig-in).
 */
export async function shieldUp (ctx: SkillCtx): Promise<{ ms: number; hpLost: number; target: string | null }> {
  const bot = ctx.bot
  const t0 = Date.now()
  const hp0 = ctx.state().vitals.health
  bot.clearControlStates()
  if (bot.inventory.slots[45]?.name !== 'shield') {
    try { await equipItem(bot, 'shield', 'off-hand') } catch (e) { throw new SkillFailure('STATE_INCONSISTENT', `shield equip failed: ${(e as Error).message}`, { key: 'item=shield' }) }
  }
  let raised = false
  let holdUntil = Date.now() + DEFLECT.clearMs
  let target: string | null = null
  try {
    while (Date.now() - t0 < DEFLECT.maxMs && Date.now() < holdUntil) {
      ctx.checkAbort()
      const s = ctx.state()
      // A blocked fireball still explodes beside the bot and may light the ground: never hold in
      // fire (escape_fire is P0 too, so it cannot preempt this; the reflex ends and it runs next).
      if (s.body.inFire || s.body.feet === 'fire' || s.body.head === 'fire' || s.inLiquid === 'lava') break
      const t = holdTarget(s)
      if (t) {
        holdUntil = Math.max(holdUntil, Date.now() + (t.name === 'ghast' ? DEFLECT.afterChargeMs : DEFLECT.clearMs))
        target ??= `${t.name}@${Math.round(t.dist)}`
        // Aim at the middle of the fireball (1 high) or of the ghast (4 high).
        await bot.lookAt(new Vec3(t.pos[0], t.pos[1] + (t.name === 'ghast' ? 2 : 0.5), t.pos[2]), true)
      }
      if (!raised) { bot.activateItem(true); raised = true }
      await sleep(50, ctx.signal)
    }
  } finally {
    if (raised) { try { bot.deactivateItem() } catch { /* ignore */ } }
  }
  const out = { ms: Date.now() - t0, hpLost: Math.round((hp0 - ctx.state().vitals.health) * 10) / 10, target }
  ctx.log('deflect', out)
  return out
}

export const deflect: SkillDef<z.infer<typeof Params>, { ms: number; hpLost: number }> = {
  id: 'deflect',
  level: 'survival',
  params: Params,
  preconditions: (s) => hasShield(s) ? { ok: true } : { ok: false, reason: 'no shield', missing: [{ item: 'shield', count: 1 }] },
  timeoutMs: () => DEFLECT.maxMs + 1500,
  stallMs: DEFLECT.maxMs + 1500,
  async run (ctx) {
    ctx.env.nav.stop()
    const r = await shieldUp(ctx)
    return { ms: r.ms, hpLost: r.hpLost }
  },
  async onCancel (ctx) {
    try { ctx.bot.deactivateItem() } catch { /* ignore */ }
    ctx.bot.clearControlStates()
  },
}
