// Continuous shield guard (milestone C fights). A 1.16 shield blocks only after 5 ticks of
// continuous use, so a shield pulsed every few hundred ms barely blocks (C blaze fixture).
// The guard stays raised, facing the threat, and is lowered only to strike, eat, swap items
// or walk.
import type { Entity } from 'prismarine-entity'
import { sleep } from '../runner.js'
import type { SkillCtx } from '../types.js'

const raised = new WeakMap<object, boolean>()

/** Raise (if not already) the off-hand shield facing `at` (eye height × `h`), then wait `ms`. */
export async function guard (ctx: SkillCtx, at: Entity | null, ms: number, h = 1.1): Promise<void> {
  const bot = ctx.bot
  if (at) await bot.lookAt(at.position.offset(0, h, 0), true)
  if (bot.inventory.slots[45]?.name === 'shield' && !raised.get(bot)) { bot.activateItem(true); raised.set(bot, true) }
  await sleep(ms, ctx.signal)
}

/** Lower the guard (before a strike, an item swap, eating or walking). */
export function lower (ctx: SkillCtx): void {
  if (raised.get(ctx.bot)) { try { ctx.bot.deactivateItem() } catch { /* ignore */ } raised.set(ctx.bot, false) }
}
