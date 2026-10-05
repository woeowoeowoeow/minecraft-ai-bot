// P2 maintenance skills (architecture §4.2): eat, wear better gear, free
// inventory space, pick up useful drops, hold safe. Short, goal-shaped, and
// safe to preempt and reissue.
import { z } from 'zod'
import { armorUpgrades, chooseFood, wantsShield } from '../food.js'
import { surplus } from '../inventory.js'
import { equipItem, waitFor, withTimeout } from '../acts.js'
import { digIn } from './cover.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillDef } from '../types.js'

const None = z.object({}).passthrough()
type N = z.infer<typeof None>

/** Eat one item chosen by `chooseFood` (safe non-goal food first, never poisonous food). */
export const eat: SkillDef<N, { ate: string; food: number }> = {
  id: 'eat',
  level: 'survival',
  params: None,
  preconditions: (s) => chooseFood(s.inventory, s.vitals.food, s.vitals.health) ? { ok: true } : { ok: false, reason: 'no edible food', missing: [{ item: 'cooked_food', count: 1 }] },
  timeoutMs: () => 8000,
  stallMs: 8000,
  async run (ctx) {
    const bot = ctx.bot
    const s = ctx.state()
    const food = chooseFood(s.inventory, s.vitals.food, s.vitals.health)!
    if (bot.food >= 20) return { ate: 'nothing (full)', food: bot.food }
    ctx.env.nav.stop()
    bot.clearControlStates()
    await equipItem(bot, food, 'hand')
    const before = bot.food
    try {
      await withTimeout(bot.consume(), 5000, 'consume')
    } catch (e) {
      if (bot.food <= before) throw new SkillFailure('STATE_INCONSISTENT', `eating ${food} failed: ${(e as Error).message}`, { key: `food=${food}` })
    }
    ctx.progress('food', bot.food)
    return { ate: food, food: bot.food }
  },
  async onCancel (ctx) { try { ctx.bot.deactivateItem() } catch { /* ignore */ } },
}

/** Wear the best armor carried and hold a shield in the off-hand. */
export const equipGear: SkillDef<N, { equipped: string[] }> = {
  id: 'equipGear',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 10_000,
  stallMs: 10_000,
  async run (ctx) {
    const s = ctx.state()
    const done: string[] = []
    for (const u of armorUpgrades(s.inventory, s.equipment)) {
      await equipItem(ctx.bot, u.item, u.slot)
      done.push(u.item)
      ctx.progress('equipped', done.length)
    }
    if (wantsShield(ctx.state().inventory, ctx.state().equipment.offHand)) {
      await equipItem(ctx.bot, 'shield', 'off-hand')
      done.push('shield')
    }
    return { equipped: done }
  },
}

/** Toss junk and surplus (inventory.ts) to free slots. */
export const manageInventory: SkillDef<N, { tossed: Record<string, number> }> = {
  id: 'manageInventory',
  level: 'survival',
  params: None,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 20_000,
  stallMs: 10_000,
  async run (ctx) {
    const bot = ctx.bot
    const plan = surplus(ctx.state().inventory)
    const tossed: Record<string, number> = {}
    const free0 = bot.inventory.emptySlotCount()
    ctx.env.nav.stop()
    for (const [name, n] of Object.entries(plan)) {
      ctx.checkAbort()
      const item = bot.registry.itemsByName[name]
      if (!item) continue
      await withTimeout(bot.toss(item.id, null, n), 5000, `toss ${name}`).catch(() => {})
      tossed[name] = n
      ctx.progress('tossed', Object.keys(tossed).length)
    }
    // Tossing part of a stack frees nothing: say so, so the interrupt's cooldown applies
    // (dev batch 8 r03: 26 no-op fires, each cancelling the running hunt).
    await sleep(300, ctx.signal)
    if (bot.inventory.emptySlotCount() <= free0) throw new SkillFailure('STATE_INCONSISTENT', 'no inventory slot freed', { key: 'inventory=full', tossed })
    return { tossed }
  },
}

const Pick = z.object({ entityId: z.number().int() })

/** Walk onto a dropped item stack until it is collected. */
export const pickupDrops: SkillDef<z.infer<typeof Pick>, { picked: boolean }> = {
  id: 'pickupDrops',
  level: 'survival',
  params: Pick,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 15_000,
  stallMs: 12_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const gone = () => !bot.entities[p.entityId]?.isValid
    for (let i = 0; i < 2 && !gone(); i++) {
      const e = bot.entities[p.entityId]
      if (!e) break
      const t = e.position
      const r = await ctx.nav.goto({ kind: 'near', target: [Math.floor(t.x), Math.floor(t.y), Math.floor(t.z)], range: 0.8 }, { timeoutMs: 10_000 })
      if (await waitFor(gone, 1500, ctx.signal)) break
      if (!r.ok && r.class !== 'SKILL_TIMEOUT') throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, 'drop unreachable', { key: 'target=item' })
    }
    if (!gone()) throw new SkillFailure('NOT_FOUND', 'drop not collected', { key: 'target=item' })
    ctx.progress('picked', 1)
    return { picked: true }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

const Hold = z.object({ ms: z.number().int().positive().default(5000) })

/** Stand still (interrupts still fire). Used while an objective is suspended or a decision is pending. */
export const holdSafe: SkillDef<z.infer<typeof Hold>, { ms: number }> = {
  id: 'holdSafe',
  level: 'survival',
  params: Hold,
  preconditions: () => ({ ok: true }),
  timeoutMs: (_s, p) => p.ms + 5000,
  stallMs: 120_000,
  async run (ctx, p) {
    ctx.env.nav.stop()
    await sleep(p.ms, ctx.signal)
    return { ms: p.ms }
  },
}

const Shelter = z.object({ maxMs: z.number().int().positive().default(150_000), untilDay: z.boolean().default(false), whileThreat: z.boolean().default(false), near: z.number().positive().default(16) })

/**
 * Night or mob-pressure response when the bot cannot fight, and the night idle
 * when no underground work is available (architecture §4.2 P2 `shelter`): a
 * sealed dig-in (cover.ts `digIn`: three blocks down, the top one re-placed),
 * then wait until day and no hostile near, or `maxMs`. Inside the sealed pocket
 * no mob can reach or see the bot, so P1 does not pull it out (interrupts.ts).
 * Not a base: the pocket is left behind. Gate 20260929: the old two-block hole
 * capped only with a block already carried and was cancelled 56 of 74 times.
 */
export const shelter: SkillDef<z.infer<typeof Shelter>, { waitedMs: number; capped: boolean }> = {
  id: 'shelter',
  level: 'survival',
  params: Shelter,
  preconditions: () => ({ ok: true }),
  timeoutMs: (_s, p) => p.maxMs + 30_000,
  stallMs: 400_000,
  async run (ctx, p) {
    ctx.env.nav.stop()
    let capped = ctx.state().body.enclosed === true
    if (!capped) {
      const r = await digIn(ctx, 10)
      ctx.log('location_discovered', { kind: 'shelter', pos: r.pos, capped: r.capped, reason: r.reason })
      if (!r.ok) throw new SkillFailure('PRECONDITION_FAILED', `cannot dig in: ${r.reason}`, { key: 'shelter=ground' })
      capped = r.capped
    }
    const t0 = Date.now()
    while (Date.now() - t0 < p.maxMs) {
      ctx.checkAbort()
      const s = ctx.state()
      const night = s.vitals.timeOfDay >= NIGHT_SHELTER.start && s.vitals.timeOfDay < NIGHT_SHELTER.end
      const near = s.nearby.entities.some(e => e.kind === 'hostile' && e.dist < p.near)
      if (p.whileThreat ? !near : !night && (!near || p.untilDay)) break
      ctx.progress('sheltered', Date.now() - t0)
      await sleep(2000, ctx.signal)
    }
    return { waitedMs: Date.now() - t0, capped }
  },
}

/**
 * Night for the shelter wait (ticks): the same window as the controller's schedule
 * (controller/schedule.ts SCHEDULE.nightFrom/nightUntil). Narrower, it made the scheduled
 * night shelter return at once at dusk and dawn and be reissued several times a second
 * (dev batch 20261002-225340 r05/r06).
 */
const NIGHT_SHELTER = { start: 12_500, end: 23_300 } as const

const Rest = z.object({ maxMs: z.number().int().positive().default(40_000) })

/** Stand still while natural regeneration (food ≥ 18) restores health; ends at 16 HP, on hunger, or after maxMs. */
export const rest: SkillDef<z.infer<typeof Rest>, { hp: number }> = {
  id: 'rest',
  level: 'survival',
  params: Rest,
  preconditions: () => ({ ok: true }),
  timeoutMs: (_s, p) => p.maxMs + 5000,
  stallMs: 60_000,
  async run (ctx, p) {
    ctx.env.nav.stop()
    const t0 = Date.now()
    while (Date.now() - t0 < p.maxMs) {
      const s = ctx.state()
      if (s.vitals.health >= 16 || s.vitals.food < 18) break
      ctx.progress('hp', s.vitals.health)
      await sleep(1000, ctx.signal)
    }
    return { hp: ctx.state().vitals.health }
  },
}
