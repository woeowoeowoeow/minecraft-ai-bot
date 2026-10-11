// Guarded fight against hoglins and zoglins (milestone C). They outrun a walking bot, a dig-in
// under their knock-up hits does not finish, and a pillar perch takes too long once they are close
// (C dev batch 20261007-110334: 3 deaths and a 2 000-s pin; nether-hazards fixture: knocked off
// a 4-high pillar while building it). A 1.16 shield raised toward a hoglin blocks its hit, and a
// blocked hit throws nothing (HoglinBase.hurtAndThrowTarget throws only on damage). Every hoglin
// attack is broadcast as entity event 4 and is followed by its melee cooldown, so the bot keeps
// the shield up and strikes only while every hoglin in reach has just attacked.
import type { Entity } from 'prismarine-entity'
import { WEAPONS } from '../../version.js'
import { eyeToBox } from '../progression/blaze-plan.js'
import { equipItem } from '../acts.js'
import type { SkillCtx } from '../types.js'
import { armUp } from './combat.js'
import { guard, lower } from './guard.js'

export const GUARD_FIGHT = {
  /** The fight is left (perch, dig-in or flight) at or below this health. */
  quitHp: 7,
  /** Strike window after a hoglin's attack (its next one comes ≥ 2 s later; the shield needs 5 ticks). */
  safeMs: 1200,
  maxMs: 60_000,
  /** Hoglins this close are fought; within `reachIn` they count for the strike window. */
  engage: 10, reachIn: 4.5,
} as const

const BOX: Record<string, { w: number; h: number }> = { hoglin: { w: 1.3965, h: 1.4 }, zoglin: { w: 1.3965, h: 1.4 } }
/** Mobs fought this way (melee, knock-up hits, faster than a walking bot). */
export const GUARD_FIGHT_MOBS: ReadonlySet<string> = new Set(Object.keys(BOX))

export type GuardFightResult = { ok: boolean; kills: number; strikes: number; blocked: number; reason: string }

/** True when every mob in reach attacked within `safeMs` (none can attack again before the shield is back up). Pure. */
export function strikeWindow (inReach: number[], lastAttack: ReadonlyMap<number, number>, now: number, safeMs: number = GUARD_FIGHT.safeMs): boolean {
  return inReach.length > 0 && inReach.every(id => now - (lastAttack.get(id) ?? -Infinity) <= safeMs)
}

export async function guardFight (ctx: SkillCtx): Promise<GuardFightResult> {
  const bot = ctx.bot
  const names = GUARD_FIGHT_MOBS
  const weapon = await armUp(bot)
  const cool = (WEAPONS[weapon] ?? WEAPONS.hand!).cooldownMs
  if (bot.inventory.slots[45]?.name !== 'shield') await equipItem(bot, 'shield', 'off-hand').catch(() => {})
  const lastAttack = new Map<number, number>()
  let blocked = 0
  const client = (bot as unknown as { _client: { on: (ev: string, f: (p: { entityId: number; entityStatus: number }) => void) => void; removeListener: (ev: string, f: unknown) => void } })._client
  const onStatus = (p: { entityId: number; entityStatus: number }) => {
    if (p.entityStatus === 4 && names.has(bot.entities[p.entityId]?.name ?? '')) lastAttack.set(p.entityId, Date.now())
    // 29: the bot's shield blocked a hit.
    if (p.entityStatus === 29 && p.entityId === bot.entity.id) blocked++
  }
  client.on('entity_status', onStatus)
  let kills = 0
  let strikes = 0
  let lastHit = 0
  let focus: number | null = null
  const seen = new Set<number>()
  const t0 = Date.now()
  try {
    while (Date.now() - t0 < GUARD_FIGHT.maxMs) {
      ctx.checkAbort()
      if (ctx.state().vitals.health <= GUARD_FIGHT.quitHp) { lower(ctx); return { ok: false, kills, strikes, blocked, reason: `health ${Math.round(ctx.state().vitals.health)}` } }
      const me = bot.entity.position
      const mobs = (Object.values(bot.entities) as Entity[]).filter(e => names.has(e.name ?? '') && e.isValid && e.position.distanceTo(me) <= GUARD_FIGHT.engage)
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
      for (const id of seen) if (!bot.entities[id]?.isValid) { seen.delete(id); kills++ }
      for (const m of mobs) seen.add(m.id)
      if (!mobs.length) break
      // Focus one target until it dies (fixture: 8 strikes spread over three hoglins killed none).
      const focused = focus === null ? undefined : mobs.find(m => m.id === focus && m.position.distanceTo(me) <= GUARD_FIGHT.reachIn)
      const t: Entity = focused ?? mobs[0]!
      const box = BOX[t.name!]!
      const eye: [number, number, number] = [me.x, me.y + 1.62, me.z]
      const d = eyeToBox(eye, [t.position.x, t.position.y, t.position.z], box.w, box.h)
      const inReach = mobs.filter(m => m.position.distanceTo(me) <= GUARD_FIGHT.reachIn).map(m => m.id)
      const now = Date.now()
      if (d <= 3 && now - lastHit >= cool && strikeWindow(inReach, lastAttack, now)) {
        lower(ctx)
        await bot.lookAt(t.position.offset(0, box.h * 0.6, 0), true)
        bot.attack(t)
        focus = t.id
        lastHit = Date.now()
        strikes++
        ctx.progress('guard_strikes', strikes)
      } else {
        // Shield up toward the nearest; never chase (it comes to the bot).
        await guard(ctx, t, 100, 0.8)
        ctx.progress('guard', Date.now() - t0)
      }
    }
  } finally {
    client.removeListener('entity_status', onStatus)
    lower(ctx)
  }
  for (const id of seen) if (!bot.entities[id]?.isValid) kills++
  return { ok: true, kills, strikes, blocked, reason: kills ? 'killed' : 'none left near' }
}
