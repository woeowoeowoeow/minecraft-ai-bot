// collectBlazeRods (milestone C, architecture §6.3): get into the fortress (a camp next to
// a blaze spawner, or any fortress floor), then fight blazes with sword and shield:
// strike only within vanilla reach (3 blocks eye to hitbox), keep the shield raised
// toward the nearest blaze between strikes, step under a hovering blaze to reach it,
// pick up the rods. At low health the bot retreats out of the blazes' sight (terrain,
// else a sealed dig-in), eats and waits, then re-enters. A fire resistance potion from
// bartering is drunk before a fight. Wither skeletons and other mobs stay with the P1
// interrupt; only blazes are this skill's own (interrupts.ts).
import type { Entity } from 'prismarine-entity'
import { z } from 'zod'
import { liveView } from '../../nav/blocks.js'
import { fortressKnown } from '../../planner/milestones.js'
import type { WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import { METADATA, WEAPONS } from '../../version.js'
import { equipItem, waitFor, withTimeout } from '../acts.js'
import { sleep } from '../runner.js'
import { chooseFood } from '../food.js'
import { armUp } from '../survival/combat.js'
import { bestWeapon } from '../survival/threat.js'
import { digIn, findCoverCells, hiddenAt } from '../survival/cover.js'
import { fireResPotion as carriedFireRes, useFireRes } from '../survival/potion.js'
import { guard as guardAt, lower } from '../survival/guard.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { BLAZE_BOX, campCells, eyeToBox, fortressFloors, REACH, strikeCell } from './blaze-plan.js'
import { netherLeg } from './nether-move.js'

const Params = z.object({
  count: z.number().int().positive(),
  /** `spawner`: camp at a known blaze spawner; `roam`: walk the fortress floors toward blazes (alternate). */
  mode: z.enum(['spawner', 'roam']).default('spawner'),
})
type P = z.infer<typeof Params>

/** Retreat at or below this health; resume at RESUME_HP (natural regeneration needs food ≥ 18). */
export const BLAZE = { retreatHp: 14, fireproofRetreatHp: 8, resumeHp: 18, crowd: 3, healWaitMs: 90_000, engageR: 16, idleMoveMs: 45_000, coverR: 12, trailBack: 16, unreachMs: 12_000, skipMs: 30_000 } as const

/** A blaze about to shoot (flags byte 0x01: it glows while charged). */
export function charging (e: Entity): boolean {
  return (Number(((e as unknown as { metadata?: unknown[] }).metadata ?? [])[METADATA.blazeFlags] ?? 0) & 0x01) !== 0
}

const hd = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)
const rods = (s: WorldState) => s.inventory.blaze_rod ?? 0

function nearestLoc (s: WorldState, kind: 'blaze_spawner' | 'fortress'): V3 | null {
  return s.memory.locations.filter(l => l.kind === kind && l.dim === 'the_nether')
    .sort((a, b) => hd(a.pos, s.pos) - hd(b.pos, s.pos))[0]?.pos ?? null
}

function blazes (ctx: SkillCtx, r: number): Entity[] {
  const me = ctx.bot.entity.position
  return Object.values(ctx.bot.entities).filter(e => e.name === 'blaze' && e.isValid !== false && e.position && e.position.distanceTo(me) <= r)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

const eye = (ctx: SkillCtx): V3 => { const p = ctx.bot.entity.position; return [p.x, p.y + 1.62, p.z] }
const reachOf = (ctx: SkillCtx, e: Entity) => eyeToBox(eye(ctx), [e.position.x, e.position.y, e.position.z], BLAZE_BOX.w, BLAZE_BOX.h)

export const fireResPotion = (ctx: SkillCtx) => carriedFireRes(ctx.bot)

const guard = (ctx: SkillCtx, at: Entity | null, ms: number) => guardAt(ctx, at, ms, BLAZE_BOX.h * 0.6)

async function drinkFireRes (ctx: SkillCtx): Promise<boolean> {
  const s = ctx.state()
  if (s.vitals.effects.includes('FireResistance')) return false
  if (!fireResPotion(ctx)) return false
  const bot = ctx.bot
  lower(ctx)
  const used = await useFireRes(bot, ctx.signal)
  if (!used) return false
  const ok = await waitFor(() => ctx.state().vitals.effects.includes('FireResistance'), 2000, ctx.signal)
  ctx.log('blaze', { kind: 'potion', ok, splash: used === 'splash' })
  await armUp(bot)
  return ok
}

/** Pick up blaze rods lying within `r` of the bot (dropped by kills). */
async function pickRods (ctx: SkillCtx, r: number): Promise<number> {
  const bot = ctx.bot
  let got = 0
  for (let i = 0; i < 4; i++) {
    const me = bot.entity.position
    const drop = Object.values(bot.entities).find(e => e.name === 'item' && e.position && e.position.distanceTo(me) <= r &&
      (() => { try { return e.getDroppedItem()?.name === 'blaze_rod' } catch { return false } })())
    if (!drop) break
    const before = rods(ctx.state())
    const t = drop.position
    lower(ctx)
    await ctx.nav.goto({ kind: 'near', target: [Math.floor(t.x), Math.floor(t.y), Math.floor(t.z)], range: 0.8, mode: 'walk' }, { timeoutMs: 6000 })
    await waitFor(() => rods(ctx.state()) > before || !drop.isValid, 1200, ctx.signal)
    if (rods(ctx.state()) > before) got += rods(ctx.state()) - before
  }
  return got
}

/**
 * Out of the blazes' sight, then heal: hidden terrain within BLAZE.coverR, else back along the
 * Nether trail (the way in leads out of the room), else a sealed dig-in, else away from the
 * blazes. Eats while healing (natural regeneration needs food ≥ 18) and keeps the shield up
 * toward any blaze that comes into sight.
 */
async function retreat (ctx: SkillCtx): Promise<boolean> {
  const bot = ctx.bot
  const s = ctx.state()
  const near = blazes(ctx, 24)
  const shooters = near.map(e => [e.position.x, e.position.y + 1.6, e.position.z] as V3)
  const feet: V3 = [Math.floor(s.pos[0]), Math.floor(s.pos[1] + 0.05), Math.floor(s.pos[2])]
  let method = 'none'
  let why = ''
  lower(ctx)
  // Out of sight, in this order: a trail point ≥ 16 blocks back (the spawner stops spawning beyond
  // 16) that no blaze can see; hidden terrain nearby; a sealed dig-in; only then an unhidden trail
  // point or plain distance (a straight corridor stays in the blazes' sight: fixture, burned).
  const pts = ctx.memory.trail?.points ?? []
  const i = pts.findIndex(q => Math.hypot(q[0] - s.pos[0], q[1] - s.pos[1], q[2] - s.pos[2]) <= 8)
  const view = liveView(bot)
  const behind = i > 0 ? pts.slice(0, i).reverse().filter(q => Math.hypot(q[0] - s.pos[0], q[2] - s.pos[2]) >= BLAZE.trailBack && Math.hypot(q[0] - s.pos[0], q[2] - s.pos[2]) <= 48) : []
  const hiddenBack = behind.find(q => hiddenAt(view, q, shooters))
  const go = async (target: V3, ms: number, range = 1.2): Promise<boolean> => {
    const r = await ctx.nav.goto({ kind: 'near', target, range, mode: 'walk' }, { profile: 'nether', timeoutMs: ms })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    return r.ok
  }
  if (hiddenBack && await go(hiddenBack, 12_000)) method = 'trail_hidden'
  if (method === 'none' && shooters.length) {
    for (const c of findCoverCells(view, feet, shooters, BLAZE.coverR).slice(0, 2)) if (await go(c, 8000, 0.6)) { method = 'terrain'; break }
  }
  if (method === 'none' && shooters.length) {
    const d = await digIn(ctx, 1)
    if (d.ok) method = 'dig_in'
    else why = d.reason
  }
  const back = behind[behind.length - 1]
  if (method === 'none' && back && await go(back, 12_000)) method = 'trail'
  if (method === 'none' && shooters.length) {
    const c: V3 = [0, 0, 0]
    for (const q of shooters) for (let k = 0; k < 3; k++) c[k]! += q[k]! / shooters.length
    const r = await ctx.nav.goto({ kind: 'away', target: c.map(Math.floor) as V3, range: 18 }, { profile: 'nether', timeoutMs: 10_000 })
    if (r.ok) method = 'away'
    else if (r.class === 'CANCELLED') ctx.checkAbort()
  }
  ctx.log('blaze', { kind: 'retreat', method, why, hp: Math.round(s.vitals.health * 10) / 10, blazes: shooters.length })
  const end = Date.now() + BLAZE.healWaitMs
  while (Date.now() < end) {
    ctx.checkAbort()
    if (ctx.state().dim !== 'the_nether') throw new SkillFailure('PRECONDITION_FAILED', 'left the Nether', { key: 'dim=overworld' })
    const st = ctx.state()
    if (st.vitals.health >= BLAZE.resumeHp) break
    const food = chooseFood(st.inventory, st.vitals.food, st.vitals.health)
    if (food && st.vitals.food < 20) {
      lower(ctx)
      try { await equipItem(bot, food, 'hand'); await withTimeout(bot.consume(), 5000, 'eat') } catch { /* retried next turn */ }
      continue
    }
    ctx.progress('healing', st.vitals.health)
    const seen = blazes(ctx, 16).find(e => ctx.state().nearby.entities.some(x => x.id === e.id && x.los !== false))
    await guard(ctx, seen ?? null, 500)
  }
  lower(ctx)
  await armUp(bot)
  return ctx.state().vitals.health >= BLAZE.resumeHp
}

/** Reach the fortress: a camp beside the nearest known spawner, else the nearest fortress floor. */
async function approach (ctx: SkillCtx, p: P, avoid: V3[]): Promise<V3> {
  for (let attempt = 0; attempt < 10; attempt++) {
    ctx.checkAbort()
    const s = ctx.state()
    const spawner = p.mode === 'spawner' ? nearestLoc(s, 'blaze_spawner') : null
    const target = spawner ?? nearestLoc(s, 'fortress')
    if (!target) throw new SkillFailure('PRECONDITION_FAILED', 'no fortress remembered', { key: 'fortress=unknown' })
    const view = liveView(ctx.bot)
    const far = (c: V3) => !avoid.some(a => hd(a, c) < 8)
    const cells = (spawner ? campCells(view, spawner) : fortressFloors(view, target, 24, 12, s.pos)).filter(far)
    ctx.log('blaze', { kind: 'approach', target, spawner: spawner !== null, cells: cells.length, dist: Math.round(hd(target, s.pos)) })
    lower(ctx)
    for (const c of cells.slice(0, 3)) {
      const r = await ctx.nav.goto({ kind: 'near', target: c, range: 1, mode: 'path' }, { profile: 'nether_travel', timeoutMs: 90_000 })
      if (r.ok) {
        ctx.progress('approach', 1)
        // On the fortress floor without a known spawner: one is often in view from here (the
        // observer scans every 5 s); camp there instead.
        if (p.mode === 'spawner' && !spawner && await waitFor(() => nearestLoc(ctx.state(), 'blaze_spawner') !== null, 6000, ctx.signal)) break
        return c
      }
      if (r.class === 'CANCELLED') ctx.checkAbort()
      avoid.push(c)
    }
    if (p.mode === 'spawner' && !spawner && nearestLoc(ctx.state(), 'blaze_spawner')) continue
    // Not loaded or not reachable yet: a leg toward it (pathfinder, then tunnel).
    const heading = Math.atan2(target[2] - s.pos[2], target[0] - s.pos[0])
    const leg = await netherLeg(ctx, [Math.round(s.pos[0] + Math.cos(heading) * Math.min(48, hd(target, s.pos))), Math.round(s.pos[2] + Math.sin(heading) * Math.min(48, hd(target, s.pos)))], heading, 'fortress_approach')
    if (leg.ok) ctx.progress('approach_leg', attempt)
    else if (!cells.length && hd(target, ctx.state().pos) < 12) break
  }
  throw new SkillFailure('NAV_UNREACHABLE', 'could not reach the fortress floor', { key: `fortress=unreachable,mode=${p.mode}` })
}

export const collectBlazeRods: SkillDef<P, { rods: number; kills: number; hits: number; retreats: number }> = {
  id: 'collectBlazeRods',
  level: 'progression',
  params: Params,
  isSatisfied: (s, p) => rods(s) >= p.count,
  preconditions: (s) => {
    if (s.dim !== 'the_nether') return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'not in the Nether' }
    if (!fortressKnown(s)) return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'no fortress remembered' }
    if (!bestWeapon(s.inventory)) return { ok: false, reason: 'no weapon for blazes', missing: [{ item: 'stone_sword', count: 1 }] }
    return { ok: true }
  },
  timeoutMs: () => 12 * 60_000,
  stallMs: 150_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const start = rods(ctx.state())
    let kills = 0
    let hits = 0
    let retreats = 0
    const hit = new Set<number>()
    const onDead = (e: Entity) => { if (hit.has(e.id)) { kills++; hit.delete(e.id); ctx.log('blaze', { kind: 'kill', kills, rods: rods(ctx.state()) }) } }
    bot.on('entityDead', onDead)
    const avoid: V3[] = []
    try {
      let camp = await approach(ctx, p, avoid)
      ctx.log('blaze', { kind: 'camp', pos: camp, mode: p.mode })
      const weapon = await armUp(bot)
      const cool = (WEAPONS[weapon] ?? WEAPONS.hand!).cooldownMs
      let lastHit = 0
      let idleSince = Date.now()
      let lastState = 0
      let rodChecks = 0
      // Blazes hovering where no standable cell reaches them: left alone for a while.
      const unreach = new Map<number, number>()
      const skipUntil = new Map<number, number>()
      while (rods(ctx.state()) < p.count) {
        ctx.checkAbort()
        // Yield to timers every pass (a navigator answer that settles at once must not spin the loop: see huntEndermen).
        await sleep(25, ctx.signal)
        const s = ctx.state()
        if (s.dim !== 'the_nether') throw new SkillFailure('PRECONDITION_FAILED', 'left the Nether', { key: 'dim=overworld' })
        const inSight = blazes(ctx, BLAZE.engageR).filter(e => s.nearby.entities.some(x => x.id === e.id && x.los !== false))
        // Fire resistance first, before any crowd or retreat rule: drink on arrival at a spawner camp or as
        // soon as blazes are near (ckit13 r01: carried three, drank none, the crowd rule always came first).
        if (!s.vitals.effects.includes('FireResistance') && fireResPotion(ctx) && (p.mode === 'spawner' || blazes(ctx, BLAZE.engageR).length)) await drinkFireRes(ctx)
        if (Date.now() - lastState > 10_000) {
          lastState = Date.now()
          ctx.log('blaze', { kind: 'state', near: blazes(ctx, BLAZE.engageR).length, inSight: inSight.length, hp: Math.round(ctx.state().vitals.health), fr: ctx.state().vitals.effects.includes('FireResistance'), potions: fireResPotion(ctx) ? 1 : 0, kills, rods: rods(ctx.state()) })
        }
        // Fire resistance: blaze fireballs are fire damage (harmless); only their touch hurts.
        const fireproof = ctx.state().vitals.effects.includes('FireResistance')
        // Without it, never stay in the sight of 3+ blazes (fixture: burned to death among six).
        const crowded = !fireproof && inSight.length >= BLAZE.crowd
        if (s.vitals.health <= (fireproof ? BLAZE.fireproofRetreatHp : BLAZE.retreatHp) || crowded) {
          retreats++
          if (!(await retreat(ctx)) && !chooseFood(ctx.state().inventory, ctx.state().vitals.food, ctx.state().vitals.health)) {
            throw new SkillFailure('COMBAT_DANGER', `health ${Math.round(ctx.state().vitals.health)} and no food to heal`, { key: 'target=blaze,why=no_food', kills })
          }
          camp = await approach(ctx, p, avoid)
          idleSince = Date.now()
          continue
        }
        const near = blazes(ctx, BLAZE.engageR).filter(e => (skipUntil.get(e.id) ?? 0) <= Date.now())
        if (!near.length) {
          const got = await pickRods(ctx, 10)
          if (got) ctx.progress('rods', rods(ctx.state()) - start)
          // Spawners fire every 10–40 s with a player within 16 blocks; roaming blazes come and go.
          if (Date.now() - idleSince > BLAZE.idleMoveMs) {
            avoid.push(camp)
            ctx.log('blaze', { kind: 'idle_move', from: camp, mode: p.mode })
            camp = await approach(ctx, p.mode === 'spawner' && avoid.length > 3 ? { ...p, mode: 'roam' } : p, avoid)
            idleSince = Date.now()
            continue
          }
          await guard(ctx, null, 400)
          continue
        }
        idleSince = Date.now()
        if (kills > rodChecks && (inSight.length <= 2 || fireproof)) { rodChecks = kills; await pickRods(ctx, 6) }
        const target = near[0]!
        // The shield faces the blaze about to shoot (one in sight), else the target.
        const shooter = inSight.find(charging) ?? target
        const d = reachOf(ctx, target)
        if (d <= REACH) unreach.delete(target.id)
        else if (!unreach.has(target.id)) unreach.set(target.id, Date.now())
        else if (Date.now() - unreach.get(target.id)! > BLAZE.unreachMs) {
          skipUntil.set(target.id, Date.now() + BLAZE.skipMs)
          unreach.delete(target.id)
          ctx.log('blaze', { kind: 'skip_unreachable', id: target.id, dist: Math.round(target.position.distanceTo(bot.entity.position)) })
          continue
        }
        if (d <= REACH) {
          if (Date.now() - lastHit >= cool) {
            if (bot.heldItem?.name !== weapon && weapon !== 'hand') { lower(ctx); await armUp(bot); lastHit = Date.now(); continue }
            lower(ctx)
            await bot.lookAt(target.position.offset(0, BLAZE_BOX.h * 0.5, 0), true)
            bot.attack(target)
            hit.add(target.id)
            hits++
            lastHit = Date.now()
            ctx.progress('hits', hits)
          } else {
            await guard(ctx, shooter, Math.max(50, Math.min(300, cool - (Date.now() - lastHit) - 30)))
          }
          continue
        }
        // Out of reach: step to where a strike lands (blazes hover; they do not come down to melee).
        const me = ctx.state().pos
        const cell = strikeCell(liveView(bot), me, [target.position.x, target.position.y, target.position.z], BLAZE.engageR)
        if (cell) {
          lower(ctx)
          const r = await ctx.nav.goto({ kind: 'block', target: cell, mode: 'walk' }, { profile: 'nether', timeoutMs: 2500 + 400 * Math.hypot(cell[0] - me[0], cell[2] - me[2]) })
          if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
          continue
        }
        await guard(ctx, shooter, 400)
      }
      await pickRods(ctx, 10)
      return { rods: rods(ctx.state()), kills, hits, retreats }
    } finally {
      bot.removeListener('entityDead', onDead)
      lower(ctx)
    }
  },
  async onCancel (ctx) {
    lower(ctx)
    try { ctx.bot.deactivateItem() } catch { /* ignore */ }
    ctx.env.nav.stop()
  },
}

