// Ender pearls for milestone C (architecture §6.3, §14.2). Primary: piglin bartering
// (1.16.1 table `gameplay/piglin_bartering.json`: ender pearls weight 20 of 423, 4–8
// per barter, ≈ 0.28 pearls per gold ingot; piglins are neutral to a player wearing
// golden armor). The bot hands one gold ingot at a time to an adult piglin (use on the
// entity: the vanilla interaction, which takes exactly one ingot), lets the piglin
// admire it (6 s) and picks up what it throws back, keeping count of gold given and
// pearls gained. Alternate: hunting endermen (0–1 pearl each). Both stop at the target.
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { z } from 'zod'
import progression from '../../../config/progression.json' with { type: 'json' }
import type { CLedger, WorldMemory, WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import { METADATA, WEAPONS } from '../../version.js'
import { equipItem, waitFor, withTimeout } from '../acts.js'
import { isUsefulDrop } from '../inventory.js'
import { sleep } from '../runner.js'
import { armUp } from '../survival/combat.js'
import { guard, lower } from '../survival/guard.js'
import { wearsGold } from '../survival/threat.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { eyeToBox } from './blaze-plan.js'
import { blockedHeading, chooseAxis } from './fortress-plan.js'
import { netherLeg, rememberFailed } from './nether-move.js'
import { barterSpot } from './nether-plan.js'
import { liveView } from '../../nav/blocks.js'

const C = progression.C

/** Barter timing: a piglin admires an ingot for 120 ticks, then throws its loot toward the player. */
export const BARTER = { admireMs: 6000, busyMs: 7500, giveR: 2.6, seekR: 128, tossR: 12, ackMs: 1500, maxFails: 3, collectR: 10 } as const
/**
 * Approach budget per piglin (piglins walk to a gold holder on their own when they can): a leg that
 * does not bring it ≥ `closer` blocks nearer is stale; after `stale` of them, or `legs` in all, the piglin is left for `skipMs` (ckit4 r01: piglins across
 * a gap; 380 s of 2–7-block legs and no trade).
 */
export const APPROACH = { closer: 4, stale: 1, legs: 2, skipMs: 60_000, buildR: 16, buildDy: 8, deepDrop: 10 } as const

/** Any column on the straight line from `a` to `b` open for ≥ APPROACH.deepDrop blocks below the lower end (a fall a bridge must not risk). */
export function deepDropBetween (ctx: SkillCtx, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z))
  const y0 = Math.floor(Math.min(a.y, b.y))
  for (let i = 1; i < n; i++) {
    const x = Math.floor(a.x + ((b.x - a.x) * i) / n)
    const z = Math.floor(a.z + ((b.z - a.z) * i) / n)
    let open = 0
    for (let y = y0 - 1; y >= y0 - APPROACH.deepDrop; y--) {
      const blk = ctx.bot.blockAt(new Vec3(x, y, z), false)
      if (!blk || blk.boundingBox === 'block') break
      open++
    }
    if (open >= APPROACH.deepDrop) return true
  }
  return false
}
/** Piglin metadata (1.16.1, protocol 736): is_baby. Babies never barter. */
export const PIGLIN_BABY_INDEX = METADATA.piglinBaby

const pearls = (s: WorldState) => s.inventory.ender_pearl ?? 0
/** Fire resistance potions held: the only potions the bot gets are barter ones (drinkable or splash fire resistance). */
export const fireResHeld = (s: Pick<WorldState, 'inventory'>) => (s.inventory.potion ?? 0) + (s.inventory.splash_potion ?? 0)
const gold = (s: WorldState) => s.inventory.gold_ingot ?? 0
const hd = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)

export function isBabyPiglin (e: { metadata?: unknown[] }): boolean {
  return (e.metadata ?? [])[PIGLIN_BABY_INDEX] === true
}

/**
 * Barter bookkeeping kept in bot memory (across skill runs and deaths): what was given and what
 * came back. The policy's adaptive pearl budget reads it (planner/policy.ts `barterUnproductive`).
 */
export type BarterStats = CLedger
export function barterStats (memory: WorldMemory): CLedger {
  return (memory.cLedger ??= { given: 0, pearls: 0, refused: 0, tossed: 0, potions: 0, gold: { ore: 0, bastionBlock: 0, chest: 0 }, oreS: 0 })
}

/** Pick up useful loot items lying within `r` (pearls, potions, obsidian; never the barter junk). */
async function collectLoot (ctx: SkillCtx, r: number, max = 4): Promise<number> {
  const bot = ctx.bot
  let n = 0
  for (let i = 0; i < max; i++) {
    const me = bot.entity.position
    const inv = ctx.state().inventory
    const drop = Object.values(bot.entities).filter(e => e.name === 'item' && e.position && e.position.distanceTo(me) <= r)
      .map(e => { let name = ''; try { name = e.getDroppedItem()?.name ?? '' } catch { /* unknown */ } return { e, name } })
      .filter(x => x.name && x.name !== 'gold_ingot' && isUsefulDrop(x.name, inv))
      .sort((a, b) => a.e.position.distanceTo(me) - b.e.position.distanceTo(me))[0]
    if (!drop) break
    const t = drop.e.position
    await ctx.nav.goto({ kind: 'near', target: [Math.floor(t.x), Math.floor(t.y), Math.floor(t.z)], range: 0.8, mode: 'walk' }, { timeoutMs: 5000 })
    if (await waitFor(() => !drop.e.isValid, 1200, ctx.signal)) n++
  }
  return n
}

/**
 * Search for a kind of Nether mob: its remembered spots first (observer, recent, not just
 * visited), then a leg toward the least-seen direction. False when the budget is spent.
 */
async function seek (ctx: SkillCtx, kind: 'piglins' | 'endermen', visited: V3[]): Promise<boolean> {
  const s = ctx.state()
  const spot = s.memory.locations
    .filter(l => l.kind === kind && l.dim === 'the_nether' && s.t - l.lastSeen <= C.piglinMemoryS && hd(l.pos, s.pos) >= 24 && hd(l.pos, s.pos) <= 256 && !visited.some(v => hd(v, l.pos) < 24))
    .sort((a, b) => hd(a.pos, s.pos) - hd(b.pos, s.pos))[0]
  if (spot) {
    visited.push(spot.pos)
    const heading = Math.atan2(spot.pos[2] - s.pos[2], spot.pos[0] - s.pos[0])
    ctx.log(kind === 'piglins' ? 'barter' : 'enderman', { kind: 'seek_spot', spot: spot.pos.map(Math.round), dist: Math.round(hd(spot.pos, s.pos)) })
    const r = await netherLeg(ctx, [spot.pos[0], spot.pos[2]], heading, kind)
    if (!r.ok) rememberFailed(ctx, heading)
    return true
  }
  const explored = ctx.memory.explored.the_nether
  const failed = ctx.memory.netherFailed ?? []
  // Out to 320 blocks: everything within view distance (~176) is always loaded, so a shorter look finds nothing unseen.
  const axis = chooseAxis(s.pos, (cx, cz) => explored.has(`${cx},${cz}`), 320, h => blockedHeading(failed, s.pos, h, s.t))
  if (!axis) return false
  ctx.log(kind === 'piglins' ? 'barter' : 'enderman', { kind: 'seek_leg', heading: Math.round((axis.heading * 180) / Math.PI), unexplored: axis.unexplored })
  const r = await netherLeg(ctx, [Math.round(s.pos[0] + Math.cos(axis.heading) * 64), Math.round(s.pos[2] + Math.sin(axis.heading) * 64)], axis.heading, kind)
  if (!r.ok) rememberFailed(ctx, axis.heading)
  return true
}

/** Step to a safe barter position nearby when the current cell is not one (nether-plan barterSpot). */
async function toBarterSpot (ctx: SkillCtx): Promise<void> {
  const me = ctx.state().pos
  const spot = barterSpot(liveView(ctx.bot), me)
  if (!spot || (spot[0] === Math.floor(me[0]) && spot[1] === Math.floor(me[1]) && spot[2] === Math.floor(me[2]))) return
  ctx.log('barter', { kind: 'safe_spot', from: me.map(Math.round), to: spot })
  const r = await ctx.nav.goto({ kind: 'block', target: spot, mode: 'walk' }, { profile: 'nether_travel', timeoutMs: 10_000 })
  if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
}

/** A trading partner is not chosen with a hoglin this close to it (hoglins are avoided, threat.ts). */
export const HOGLIN_CLEAR = 12

/**
 * Adult piglins in range, not skipped, with no hoglin or zoglin near them; nearest first with
 * height differences weighted (a piglin on another ledge is usually out of reach: ckit5 r01).
 */
function adultPiglins (ctx: SkillCtx, r: number, skip: Map<number, number>): Entity[] {
  const me = ctx.bot.entity.position
  const now = Date.now()
  const all = Object.values(ctx.bot.entities)
  const hoglins = all.filter(e => (e.name === 'hoglin' || e.name === 'zoglin') && e.position).map(e => e.position)
  const seen = new Set(ctx.state().nearby.entities.filter(x => x.los !== false).map(x => x.id))
  const cost = (e: Entity) => e.position.distanceTo(me) + 3 * Math.abs(e.position.y - me.y) + (seen.has(e.id) ? 0 : 10)
  return all
    .filter(e => e.name === 'piglin' && e.position && e.isValid !== false && e.position.distanceTo(me) <= r && !isBabyPiglin(e as never) && (skip.get(e.id) ?? 0) <= now &&
      !hoglins.some(h => h.distanceTo(e.position) <= HOGLIN_CLEAR))
    .sort((a, b) => cost(a) - cost(b))
}

/** Barter target reached: the pearls and fire resistance asked for (or only the potion, `untilFireRes`). */
function barterDone (s: WorldState, p: { count: number; fireRes: number; untilFireRes: boolean }): boolean {
  if (p.untilFireRes && p.fireRes > 0) return fireResHeld(s) >= p.fireRes
  return pearls(s) >= p.count && fireResHeld(s) >= p.fireRes
}

const Params = z.object({
  count: z.number().int().positive(),
  /** Keep bartering until this many fire resistance potions are held as well (milestone C, before blazes). */
  fireRes: z.number().int().min(0).default(0),
  /** Stop as soon as `fireRes` potions are held, pearls or not (fortress-first route: the potion before the blazes). */
  untilFireRes: z.boolean().default(false),
  /** Search legs for piglins per run when none is in sight. */
  searchLegs: z.number().int().min(0).default(6),
})
type P = z.infer<typeof Params>

export const barterPearls: SkillDef<P, BarterStats & { pearlsHeld: number }> = {
  id: 'barterPearls',
  level: 'progression',
  params: Params,
  isSatisfied: (s, p) => barterDone(s, p),
  preconditions: (s) => {
    if (s.dim !== 'the_nether') return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'piglins barter in the Nether' }
    const hasGold = Object.keys(s.inventory).some(k => /^golden_(helmet|chestplate|leggings|boots)$/.test(k) && (s.inventory[k] ?? 0) > 0)
    if (!hasGold) return { ok: false, reason: 'no golden armor (piglins would attack)', missing: [{ item: 'golden_helmet', count: 1 }] }
    return { ok: true }
  },
  timeoutMs: () => 10 * 60_000,
  stallMs: 150_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const st = barterStats(ctx.memory)
    const busy = new Map<number, number>()
    const skip = new Map<number, number>()
    const approach = new Map<number, { legs: number; stale: number; best: number }>()
    const visited: V3[] = []
    let legs = 0
    let fails = 0
    let lastPearls = pearls(ctx.state())
    let lastPotions = fireResHeld(ctx.state())
    const notePearls = () => {
      const now = pearls(ctx.state())
      if (now > lastPearls) {
        st.pearls += now - lastPearls
        ctx.log('barter', { kind: 'pearls', gained: now - lastPearls, held: now, given: st.given, pearlsFromBarter: st.pearls })
        ctx.progress('pearls', now)
      }
      lastPearls = now
      const pot = fireResHeld(ctx.state())
      if (pot > lastPotions) st.potions += pot - lastPotions
      lastPotions = pot
    }
    // Golden armor must be worn, not carried (the P2 equip prefers it at equal points).
    if (!wearsGold(ctx.state())) {
      const g = Object.keys(ctx.state().inventory).find(k => k === 'golden_helmet') ?? Object.keys(ctx.state().inventory).find(k => /^golden_(chestplate|leggings|boots)$/.test(k))
      if (g) await equipItem(bot, g, g.endsWith('helmet') ? 'head' : g.endsWith('chestplate') ? 'torso' : g.endsWith('leggings') ? 'legs' : 'feet')
    }
    const done = () => barterDone(ctx.state(), p)
    while (!done()) {
      ctx.checkAbort()
      notePearls()
      const s = ctx.state()
      if (ctx.env.isBlacklisted('provoked:piglin')) throw new SkillFailure('COMBAT_DANGER', 'piglins turned hostile', { key: 'piglins=hostile', given: st.given })
      const now = Date.now()
      const pending = [...busy.values()].some(t => t > now)
      if (gold(s) === 0) {
        if (pending) { await collectLoot(ctx, BARTER.collectR); await sleep(500, ctx.signal); continue }
        await collectLoot(ctx, BARTER.collectR)
        notePearls()
        throw new SkillFailure('MISSING_RESOURCE', 'out of gold ingots', { key: 'item=gold_ingot', given: st.given, pearls: st.pearls }, [{ item: 'gold_ingot', count: 1 }])
      }
      const piglins = adultPiglins(ctx, BARTER.seekR, skip)
      const free = piglins.filter(e => (busy.get(e.id) ?? 0) <= now)
      if (!piglins.length) {
        if (pending) { await collectLoot(ctx, BARTER.collectR); await sleep(500, ctx.signal); continue }
        if (legs >= p.searchLegs) throw new SkillFailure('NOT_FOUND', `no piglins after ${legs} search legs`, { key: 'target=piglins', given: st.given })
        legs++
        if (!(await seek(ctx, 'piglins', visited))) throw new SkillFailure('SEARCH_EXHAUSTED', 'no unseen direction left to look for piglins', { key: 'target=piglins' })
        continue
      }
      if (!free.length) {
        // Every piglin in reach is admiring: wait on a safe cell (no lava within 3, no cliff edge),
        // hold gold (piglins come to it) and gather what lands.
        await toBarterSpot(ctx)
        await equipItem(bot, 'gold_ingot', 'hand').catch(() => {})
        await collectLoot(ctx, BARTER.collectR, 2)
        await sleep(400, ctx.signal)
        continue
      }
      const pig = free[0]!
      const dist = () => pig.position.distanceTo(bot.entity.position)
      if (dist() > BARTER.giveR) {
        await equipItem(bot, 'gold_ingot', 'hand').catch(() => {})
        const inSight = () => ctx.state().nearby.entities.some(e => e.id === pig.id && e.los !== false)
        if (dist() > BARTER.tossR || !inSight()) {
          // A 3D walk toward it (digging allowed, no scaffolding). Piglins often stand on another
          // level: x/z legs arrived beside them 15–20 blocks above or below (ckit7 r01: 1 trade in 20 min).
          const a = approach.get(pig.id) ?? { legs: 0, stale: 0, best: dist() }
          const t = pig.position
          const me0 = bot.entity.position
          const dy = Math.round(t.y - me0.y)
          // Close by, with no deep drop on the way: towering and short bridges may reach its ledge.
          const short = Math.hypot(t.x - me0.x, t.z - me0.z) <= APPROACH.buildR && Math.abs(dy) <= APPROACH.buildDy && !deepDropBetween(ctx, me0, t)
          const r = await ctx.nav.goto({ kind: 'near', target: [Math.floor(t.x), Math.floor(t.y), Math.floor(t.z)], range: 2, mode: 'path' }, { profile: short ? 'nether' : 'nether_travel', timeoutMs: Math.min(45_000, 8000 + 1500 * dist()) })
          if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
          const d1 = pig.isValid ? dist() : Infinity
          a.legs++
          if (d1 > a.best - APPROACH.closer && d1 > BARTER.tossR) a.stale++
          a.best = Math.min(a.best, d1)
          approach.set(pig.id, a)
          ctx.log('barter', { kind: 'approach', piglin: pig.id, dist: Number.isFinite(d1) ? Math.round(d1) : null, dy, build: short, legs: a.legs, stale: a.stale, ok: r.ok })
          if (d1 > BARTER.tossR && (a.stale >= APPROACH.stale || a.legs >= APPROACH.legs)) {
            skip.set(pig.id, Date.now() + APPROACH.skipMs)
            approach.delete(pig.id)
            ctx.log('barter', { kind: 'unreachable', piglin: pig.id, dist: Number.isFinite(d1) ? Math.round(d1) : null, dy, legs: a.legs })
          }
          if (d1 > BARTER.tossR) continue
        }
        if (pig.isValid && dist() > BARTER.giveR && inSight()) {
          // In sight but not walkable: toss one ingot toward it. A piglin that picks up gold barters it
          // just the same and throws the loot toward the nearest visible player.
          const before = gold(ctx.state())
          // Aim above it: a tossed item flies ~0.3 blocks/tick; an upward throw carries it further.
          await bot.lookAt(pig.position.offset(0, 1 + dist() * 0.25, 0), true)
          try { await withTimeout(bot.toss(bot.registry.itemsByName.gold_ingot!.id, null, 1), 3000, 'toss') } catch { /* checked below */ }
          if (await waitFor(() => gold(ctx.state()) < before, BARTER.ackMs, ctx.signal)) {
            st.given++
            st.tossed++
            busy.set(pig.id, Date.now() + BARTER.busyMs + 3000)
            ctx.log('barter', { kind: 'give', method: 'toss', piglin: pig.id, dist: Math.round(dist()), given: st.given, goldLeft: gold(ctx.state()), pearlsHeld: pearls(ctx.state()) })
            ctx.progress('given', st.given)
          }
          continue
        }
        if (!pig.isValid || dist() > BARTER.giveR + 0.5) { skip.set(pig.id, Date.now() + 20_000); continue }
      }
      const before = gold(ctx.state())
      await equipItem(bot, 'gold_ingot', 'hand')
      await bot.lookAt(pig.position.offset(0, 1.4, 0), true)
      try { bot.activateEntity(pig) } catch { /* checked below */ }
      const took = await waitFor(() => gold(ctx.state()) < before, BARTER.ackMs, ctx.signal)
      if (took) {
        st.given++
        fails = 0
        busy.set(pig.id, Date.now() + BARTER.busyMs)
        ctx.log('barter', { kind: 'give', method: 'hand', piglin: pig.id, given: st.given, goldLeft: gold(ctx.state()), pearlsHeld: pearls(ctx.state()) })
        ctx.progress('given', st.given)
      } else {
        // Admiring something else, a baby, or wary: leave it a while.
        st.refused++
        skip.set(pig.id, Date.now() + 15_000)
        ctx.log('barter', { kind: 'refused', piglin: pig.id, refused: st.refused })
        if (++fails >= BARTER.maxFails * 3) throw new SkillFailure('STATE_INCONSISTENT', 'piglins keep refusing gold', { key: 'barter=refused', refused: st.refused })
      }
      await collectLoot(ctx, BARTER.collectR, 2)
    }
    notePearls()
    await collectLoot(ctx, BARTER.collectR)
    ctx.log('barter', { kind: 'done', given: st.given, pearlsFromBarter: st.pearls, pearlsHeld: pearls(ctx.state()) })
    return { ...st, pearlsHeld: pearls(ctx.state()) }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

/** Enderman hitbox (1.16.1) and the health at which a fight is abandoned. */
const ENDERMAN = { w: 0.6, h: 2.9, quitHp: 8, seekR: 48 } as const

const HuntParams = z.object({ count: z.number().int().positive(), searchLegs: z.number().int().min(0).default(6) })
type HP = z.infer<typeof HuntParams>

/**
 * Alternate pearl source: hunt endermen (40 HP, 0–1 pearl each). Melee within vanilla reach
 * with the shield raised between strikes; a fight is given up at ENDERMAN.quitHp.
 */
export const huntEndermen: SkillDef<HP, { kills: number; pearlsHeld: number }> = {
  id: 'huntEndermen',
  level: 'progression',
  params: HuntParams,
  isSatisfied: (s, p) => pearls(s) >= p.count,
  preconditions: (s) => s.dim === 'the_nether' ? { ok: true } : { ok: false, cls: 'PRECONDITION_FAILED', reason: 'hunting endermen in the Nether' },
  timeoutMs: () => 10 * 60_000,
  stallMs: 150_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const visited: V3[] = []
    let legs = 0
    let kills = 0
    const unreachable = new Set<number>()
    const weapon = await armUp(bot)
    const cool = (WEAPONS[weapon] ?? WEAPONS.hand!).cooldownMs
    while (pearls(ctx.state()) < p.count) {
      ctx.checkAbort()
      const me = bot.entity.position
      const target = Object.values(bot.entities).filter(e => e.name === 'enderman' && e.position && e.position.distanceTo(me) <= ENDERMAN.seekR && !unreachable.has(e.id))
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (!target) {
        if (legs >= p.searchLegs) throw new SkillFailure('NOT_FOUND', `no endermen after ${legs} search legs`, { key: 'target=enderman', kills })
        legs++
        if (!(await seek(ctx, 'endermen', visited))) throw new SkillFailure('SEARCH_EXHAUSTED', 'no unseen direction left to look for endermen', { key: 'target=enderman' })
        continue
      }
      ctx.log('enderman', { kind: 'engage', id: target.id, dist: Math.round(target.position.distanceTo(me)) })
      let lastHit = 0
      let closeLegs = 0
      const t0 = Date.now()
      while (target.isValid && Date.now() - t0 < 45_000) {
        ctx.checkAbort()
        // Every pass yields to timers: a navigator answer that settles at once (goal "reached" by
        // its own range while the reach is still > 3) spun this loop with the event loop blocked,
        // so the enderman never moved and the bot froze (C fixture run 2026-10-08, 40 min at 100 % CPU).
        await sleep(25, ctx.signal)
        if (ctx.state().vitals.health <= ENDERMAN.quitHp) lower(ctx)
        if (ctx.state().vitals.health <= ENDERMAN.quitHp) throw new SkillFailure('COMBAT_DANGER', `health ${Math.round(ctx.state().vitals.health)} fighting an enderman`, { key: 'target=enderman', kills })
        const p0 = bot.entity.position
        const d = eyeToBox([p0.x, p0.y + 1.62, p0.z], [target.position.x, target.position.y, target.position.z], ENDERMAN.w, ENDERMAN.h)
        if (d > 3) {
          if (target.position.distanceTo(p0) > 24) break
          // Out of reach after several approaches (on a ledge, above the bot): leave it.
          if (++closeLegs > 6) { unreachable.add(target.id); ctx.log('enderman', { kind: 'unreachable', id: target.id }); break }
          lower(ctx)
          const r = await ctx.nav.goto({ kind: 'entity', target: target.id, range: 2, mode: 'walk' }, { timeoutMs: 4000 })
          if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
          continue
        }
        if (Date.now() - lastHit >= cool) {
          lower(ctx)
          await bot.lookAt(target.position.offset(0, ENDERMAN.h * 0.6, 0), true)
          bot.attack(target)
          lastHit = Date.now()
          ctx.progress('hits', lastHit)
        } else await guard(ctx, target, Math.max(50, Math.min(300, cool - (Date.now() - lastHit))), ENDERMAN.h * 0.6)
      }
      lower(ctx)
      if (!target.isValid) {
        kills++
        await sleep(500, ctx.signal)
        await collectLoot(ctx, 8)
        ctx.log('enderman', { kind: 'kill', kills, pearlsHeld: pearls(ctx.state()) })
        ctx.progress('kills', kills)
      }
    }
    return { kills, pearlsHeld: pearls(ctx.state()) }
  },
  async onCancel (ctx) {
    lower(ctx)
    try { ctx.bot.deactivateItem() } catch { /* ignore */ }
    ctx.env.nav.stop()
  },
}
