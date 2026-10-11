// P1 threat skills (architecture §4.2, §6.3): defend and flee. The choice between
// them is the deterministic threat score (threat.ts); these skills only execute it.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { z } from 'zod'
import type { V3 } from '../../schema/index.js'
import { CREEPER, MOB_THREATS, WEAPONS } from '../../version.js'
import { equipItem } from '../acts.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { assessThreat, bestWeapon, CREEPER_SPACING, hasShield, isNight, menacing, RANGED_MELEE_DIST, RETREAT_HP, weakState } from './threat.js'
import { digIn } from './cover.js'
import { atWater, isAquatic, waterCellsNear } from './aquatic.js'

const Params = z.object({ targetId: z.number().int().optional() })
type P = z.infer<typeof Params>

/** Melee reach used for attacks (vanilla survival reach is 3 blocks for entities). */
const REACH = 3.0
/** Threats beyond this distance end the engagement. */
const DISENGAGE = 16
/** The bot closes in on a melee target only this far; beyond, it waits for the mob to come. */
const CHASE_MAX = 6
/** Longest shield standoff with a creeper (it approaches, swells 1.5 s, explodes). */
const STANDOFF_MS = 8000
/** A melee target that has not come closer in this long is left (the objective resumes). */
const WAIT_FOR_MELEE_MS = 5000

function dist (bot: Bot, e: Entity): number {
  return bot.entity.position.distanceTo(e.position)
}

/** Main-hand weapon and off-hand shield (if carried). */
export async function armUp (bot: Bot): Promise<string> {
  const inv: Record<string, number> = {}
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] ?? 0) + it.count
  const w = bestWeapon(inv)
  if (w && bot.heldItem?.name !== w) await equipItem(bot, w, 'hand').catch(() => {})
  const off = bot.inventory.slots[45]
  if ((inv.shield ?? 0) > 0 && off?.name !== 'shield') await equipItem(bot, 'shield', 'off-hand').catch(() => {})
  return bot.heldItem?.name ?? 'hand'
}

async function raiseShield (bot: Bot, ms: number, signal: AbortSignal): Promise<void> {
  if (bot.inventory.slots[45]?.name !== 'shield') return
  bot.activateItem(true)
  try { await sleep(ms, signal) } finally { bot.deactivateItem() }
}

/**
 * Fight the primary threat: close to melee reach through the navigator (entity
 * goal), attack on the weapon's full cooldown, block with a shield while the
 * cooldown recovers, and back off after every hit on a creeper. Ends when no
 * threat remains within 16 blocks. Health ≤ RETREAT_HP → COMBAT_DANGER.
 */
export const defend: SkillDef<P, { hits: number; kills: number }> = {
  id: 'defend',
  level: 'survival',
  params: Params,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 45_000,
  stallMs: 15_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const weapon = await armUp(bot)
    const cool = (WEAPONS[weapon] ?? WEAPONS.hand!).cooldownMs
    let targetId = p.targetId ?? null
    let hits = 0
    let kills = 0
    let navFails = 0
    let lastHit = 0
    let bestD = Infinity
    let lastApproach = Date.now()
    for (;;) {
      ctx.checkAbort()
      const s = ctx.state()
      if (s.vitals.health <= RETREAT_HP) throw new SkillFailure('COMBAT_DANGER', `health ${s.vitals.health} while fighting`, { key: `target=${targetId !== null ? bot.entities[targetId]?.name ?? '?' : '?'}`, hits })
      // Never trade blows next to a creeper: end here and let the interrupt re-evaluate (flee, creeper spacing).
      if (s.nearby.entities.some(e => e.name === 'creeper' && (e.los !== false || e.dist <= 3) && e.dist <= CREEPER_SPACING)) return { hits, kills }
      let target = targetId !== null ? bot.entities[targetId] : undefined
      if (targetId !== null && (!target || !target.isValid)) { kills++; targetId = null; target = undefined }
      if (!target || dist(bot, target) > DISENGAGE) {
        const th = assessThreat(s)
        if (!th.primary || th.primary.e.dist > DISENGAGE) return { hits, kills }
        if (th.action !== 'defend') return { hits, kills }
        targetId = th.primary.e.id
        target = bot.entities[targetId]
        bestD = Infinity
        if (!target) continue
      }
      const d = dist(bot, target)
      if (d < bestD - 0.5) { bestD = d; lastApproach = Date.now(); ctx.progress('closing', -d) }
      const creeper = target.name === 'creeper'
      if (d > REACH) {
        // No long chases (dev batch 7 r01: a zombie chase at 8 blocks walked off a ravine edge into
        // lava). Melee mobs come to the bot: wait facing them. A shooter backing off is left to `cover`.
        const ranged = Boolean(MOB_THREATS[target.name ?? '']?.ranged) || (target.name === 'drowned' && (target as unknown as { heldItem?: { name?: string } }).heldItem?.name === 'trident')
        if (ranged && d > RANGED_MELEE_DIST) return { hits, kills }
        if (d > CHASE_MAX) {
          await bot.lookAt(target.position.offset(0, (target.height ?? 1.6) * 0.85, 0), true)
          if (Date.now() - lastApproach > WAIT_FOR_MELEE_MS) return { hits, kills }
          await sleep(200, ctx.signal)
          continue
        }
        lastApproach = Date.now()
        const r = await ctx.nav.goto({ kind: 'entity', target: target.id, range: 2, mode: 'walk' }, { timeoutMs: 2500 })
        if (!r.ok && r.class !== 'SKILL_TIMEOUT') {
          if (++navFails >= 3) throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, `cannot reach ${target.name}`, { key: `target=${target.name}`, hits })
        }
        await sleep(50, ctx.signal)
        continue
      }
      await bot.lookAt(target.position.offset(0, (target.height ?? 1.6) * 0.85, 0), true)
      // Any item swap resets the server's attack-strength timer: re-arm and wait a full cooldown.
      if (weapon !== 'hand' && bot.heldItem?.name !== weapon) { await armUp(bot); lastHit = Date.now(); continue }
      const since = Date.now() - lastHit
      if (since >= cool) {
        bot.attack(target)
        lastHit = Date.now()
        hits++
        ctx.progress('hits', hits)
        if (creeper) await backOff(ctx, target, 700)
      } else if (!creeper && cool - since > 300) {
        await raiseShield(bot, Math.min(400, cool - since - 50), ctx.signal)
      } else {
        await sleep(50, ctx.signal)
      }
    }
  },
  async onCancel (ctx) {
    try { ctx.bot.deactivateItem() } catch { /* ignore */ }
    ctx.bot.clearControlStates()
  },
}

async function backOff (ctx: SkillCtx, target: Entity, ms: number): Promise<void> {
  const bot = ctx.bot
  const dx = bot.entity.position.x - target.position.x
  const dz = bot.entity.position.z - target.position.z
  await bot.look(Math.atan2(-dx, -dz), 0, true)
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  try { await sleep(ms, ctx.signal) } finally { bot.clearControlStates() }
}

/**
 * Run from the threats: navigate away from their weighted centre (pathfinder,
 * sprinting, hazard-aware), then check. A creeper dominates the centre and sets
 * the distance (beyond its 7-block defuse range); one swelling within reach of
 * its blast is blocked with a raised shield when one is carried (a shield facing
 * the explosion takes the damage). Success when no scoring threat is within 10
 * blocks; otherwise COMBAT_DANGER so the controller can switch response.
 */
export const flee: SkillDef<P, { dist: number }> = {
  id: 'flee',
  level: 'survival',
  params: Params,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 30_000,
  stallMs: 15_000,
  async run (ctx) {
    const bot = ctx.bot
    for (let leg = 0; leg < 2; leg++) {
      ctx.checkAbort()
      const th = assessThreat(ctx.state())
      if (!th.mobs.length) return { dist: Infinity }
      const creeper = th.mobs.find(m => m.e.name === 'creeper' && m.e.dist <= CREEPER_SPACING + 2)
      // With a shield, a creeper is not outrun (dev batch 9: two equipped bots blown up after it
      // followed them through 5 flee/resume cycles). Face it with the shield raised: a blocked
      // explosion does no damage, and the creeper is gone.
      if (creeper && hasShield(ctx.state())) {
        await armUp(bot)
        bot.activateItem(true)
        const end = Date.now() + STANDOFF_MS
        try {
          for (;;) {
            const c = bot.entities[creeper.e.id]
            if (!c?.isValid || c.position.distanceTo(bot.entity.position) > CREEPER.defuseRange + 3 || Date.now() > end) break
            await bot.lookAt(c.position.offset(0, 1, 0), true)
            ctx.progress('standoff', Date.now())
            await sleep(100, ctx.signal)
          }
        } finally { bot.deactivateItem() }
        ctx.log('cover', { ok: true, method: 'shield_creeper', why: bot.entities[creeper.e.id]?.isValid ? 'creeper left or timed out' : 'creeper gone', hp: Math.round(ctx.state().vitals.health * 10) / 10, shooters: [] })
        continue
      }
      const wt = (m: (typeof th.mobs)[number]) => m === creeper ? m.t * 3 : m.t
      // Aquatic hostiles at the shore: the water they come from repels too, and the route is
      // planned dry, so the flight goes inland instead of along the beach or into the sea
      // (re-gate 20260930: every drowned death was mid-flee at y 58–63, drowned following).
      const st = ctx.state()
      const aquatic = th.mobs.some(m => isAquatic(m.e.name)) && atWater(st, 8)
      const masses = th.mobs.map(m => ({ p: m.e.pos, w: wt(m) }))
      if (aquatic) {
        const water = waterCellsNear(st, st.pos, 10)
        const mw = masses.reduce((a, m) => a + m.w, 0)
        for (const p of water) masses.push({ p, w: mw / water.length })
      }
      const w = masses.reduce((a, m) => a + m.w, 0)
      const c: V3 = [0, 0, 0]
      for (const m of masses) for (let i = 0; i < 3; i++) c[i]! += (m.p[i]! * m.w) / w
      const r = await ctx.nav.goto({ kind: 'away', target: c.map(Math.floor) as V3, range: creeper ? CREEPER.defuseRange + 7 : aquatic ? 24 : 18, ...(aquatic ? { dry: true } : {}) }, { timeoutMs: 12_000 })
      ctx.progress('fled', leg + 1)
      if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
      const after = assessThreat(ctx.state())
      // A creeper only has to be beyond its defuse range and not swelling; anything else beyond 10.
      const near = after.mobs.filter(m => m.e.name === 'creeper' ? m.e.dist <= CREEPER.defuseRange || m.e.swelling : m.e.dist <= 10)
      if (!near.length) {
        // Safe for now, but weak: stay safe (seal a pocket) rather than walk back out at night or
        // with the mobs still about (B gate 20261002 r11: rested at 4 HP with the zombie at 9.7 blocks).
        const st2 = ctx.state()
        if (weakState(st2) && st2.inLiquid === 'none' && !st2.body.enclosed && (isNight(st2) || st2.nearby.entities.some(e => menacing(e, st2) && e.dist < 20))) {
          const d = await digIn(ctx, 1)
          ctx.log('cover', { ok: d.ok, method: 'dig_in', why: d.reason, capped: d.capped, step: true, after: 'flee' })
        }
        return { dist: Math.min(...after.mobs.map(m => m.e.dist), 99) }
      }
    }
    throw new SkillFailure('COMBAT_DANGER', 'threat still close after fleeing', { key: `target=${assessThreat(ctx.state()).primary?.e.name ?? '?'}` })
  },
  async onCancel (ctx) {
    try { ctx.bot.deactivateItem() } catch { /* ignore */ }
    ctx.env.nav.stop()
  },
}
