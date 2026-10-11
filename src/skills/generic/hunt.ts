// Goal-shaped hunting of food animals (milestone A food), plus the shared
// "back to the surface" move for skills that need open ground after mining.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { z } from 'zod'
import type { V3 } from '../../schema/index.js'
import { WEAPONS } from '../../version.js'
import { sleep } from '../runner.js'
import { countOf } from '../sources.js'
import { armUp } from '../survival/combat.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { toSurface } from './explore.js'
import { Relocator, SEARCH } from './search.js'
import { FISH, METADATA } from '../../version.js'
import { liveView, type BlockView } from '../../nav/blocks.js'
import { AQUATIC, aquaticThreats, atWater, inlandPoint, isAquatic, waterWithin } from '../survival/aquatic.js'

const Params = z.object({
  item: z.string(),                       // drop item or group (raw_meat)
  count: z.number().int().positive(),     // absolute target
  mobs: z.array(z.string()).min(1),
  maxDist: z.number().positive().default(48),
  searchSteps: z.number().int().min(0).default(4),
  /** Prefer this entity (opportunistic forage). */
  targetId: z.number().int().optional(),
})
type P = z.infer<typeof Params>

const MAX_CHASE_MS = 30_000
/** Search steps a hunt may use however wide the strategy (gate 20260929: 12 % hunt success, long exposure). */
export const HUNT_MAX_STEPS = 6
/**
 * Remembered animal spots worth walking back to. Animals are remembered as far as the server
 * tracks them (observer: 144 blocks), and 1.16.1 animals do not despawn, so a sighting stays
 * useful for a while (B round 3: 20 min, 256 blocks, up to 4 per hunt).
 */
export const ANIMAL_SPOT = { maxAgeS: 1200, maxDist: 256, minDist: 12, forgetS: 300, perHunt: 4 } as const
/** Search steps spent by hunts in this window and area count against the next hunt (preemption resumes the budget). */
const BUDGET_WINDOW_S = 600
/** A hunt this far from where its budget started searches a new area with a fresh budget (dev batch 8 r04). Two relocation steps. */
const BUDGET_AREA = 2 * SEARCH.step

/** Hunt search steps spent recently in this area, per bot memory: a preempted hunt resumes its budget instead of starting over. */
const budgets = new WeakMap<object, { steps: number; since: number; at: V3 }>()
function budget (ctx: SkillCtx): { steps: number; since: number; at: V3 } {
  const s = ctx.state()
  let b = budgets.get(ctx.memory)
  if (!b || s.t - b.since > BUDGET_WINDOW_S || Math.hypot(s.pos[0] - b.at[0], s.pos[2] - b.at[2]) > BUDGET_AREA) { b = { steps: 0, since: s.t, at: s.pos }; budgets.set(ctx.memory, b) }
  return b
}

/** Nearest remembered food-animal spot worth going back to (recent, not too far, not just visited). */
export function animalSpot (s: import('../../observer/types.js').WorldState, isBlacklisted: (k: string) => boolean): V3 | null {
  const spots = s.memory.locations
    .filter(l => l.kind === 'animals' && l.dim === s.dim && s.t - l.lastSeen <= ANIMAL_SPOT.maxAgeS && !isBlacklisted(`animals:${l.pos[0]},${l.pos[2]}`))
    .map(l => ({ l, d: Math.hypot(l.pos[0] - s.pos[0], l.pos[2] - s.pos[2]) }))
    .filter(x => x.d >= ANIMAL_SPOT.minDist && x.d <= ANIMAL_SPOT.maxDist)
    .sort((a, b) => a.d - b.d)
  return spots[0]?.l.pos ?? null
}

/** A fish is hunted only this close to the water surface (the bot swims at the surface, reach 3). */
const FISH_MAX_DEPTH = 2
const FISH_PENALTY = 24
/** Failed fish chases after which a hunt sticks to land animals (dev batch 10 r01: 12 salmon give-ups). */
const MAX_FISH_FAILS = 3

/** Water with air within FISH_MAX_DEPTH blocks above: reachable from the surface. */
function nearSurface (bot: Bot, p: import('vec3').Vec3): boolean {
  const f = p.floored()
  for (let dy = 1; dy <= FISH_MAX_DEPTH + 1; dy++) {
    const b = bot.blockAt(f.offset(0, dy, 0), false)
    if (!b) return false
    if (b.name === 'air' || b.name === 'cave_air') return true
    if (b.name !== 'water' && !/kelp|seagrass/.test(b.name)) return false
  }
  return false
}

/** Aquatic hostiles within the zone, straight from the entity table (cheap: runs on every chase tick). */
function aquaticNear (bot: Bot): number {
  const me = bot.entity.position
  let n = 0
  for (const e of Object.values(bot.entities)) if (e.name && isAquatic(e.name) && e.position.distanceTo(me) <= AQUATIC.zone) n++
  return n
}

/** A white, unsheared sheep (it drops white wool; a bed needs three of one colour). */
export function whiteSheep (e: Entity): boolean {
  const w = ((e as unknown as { metadata?: unknown[] }).metadata ?? [])[METADATA.sheepWool]
  return e.name === 'sheep' && (w === undefined || w === null || (Number(w) & 0x1f) === 0)
}

function isBaby (e: Entity): boolean {
  return ((e as unknown as { metadata?: unknown[] }).metadata ?? [])[METADATA.ageableBaby] === true
}

/**
 * While aquatic hostiles are about (`shore` set), fish and land animals at the water's edge
 * are rejected: each is reported once through `reject` (the caller blacklists it briefly).
 */
function pick (bot: Bot, p: P, isBlacklisted: (k: string) => boolean, shore: BlockView | null = null, reject: (e: Entity, why: string) => void = () => {}): Entity | null {
  const me = bot.entity.position
  const risky = (e: Entity): boolean => {
    if (!shore || e.position.distanceTo(me) > p.maxDist) return false
    if (FISH.has(e.name ?? '')) { reject(e, 'fish_unsafe_water'); return true }
    if (waterWithin(shore, [e.position.x, e.position.y, e.position.z], AQUATIC.shore)) { reject(e, 'shoreline'); return true }
    return false
  }
  const want = p.targetId !== undefined ? bot.entities[p.targetId] : undefined
  if (want?.isValid && want.position.distanceTo(me) <= p.maxDist && !isBlacklisted(`mob:${want.id}`) && !risky(want)) return want
  let best: Entity | null = null
  let bestD = p.maxDist
  for (const e of Object.values(bot.entities)) {
    if (!e.name || !p.mobs.includes(e.name) || !e.position || isBlacklisted(`mob:${e.id}`)) continue
    const fish = FISH.has(e.name)
    if (!fish && isBaby(e)) continue
    if (p.item === 'white_wool' && !whiteSheep(e)) continue
    const feet = bot.blockAt(e.position.floored(), false)
    if (fish ? !nearSurface(bot, e.position) : feet?.name === 'water' || feet?.name === 'lava') continue
    if (risky(e)) continue
    // Land animals first: a fish is worth a swim only when nothing walks nearby.
    const d = e.position.distanceTo(me) + Math.max(0, e.position.y - me.y - 3) * 3 + (fish ? FISH_PENALTY : 0)
    if (d < bestD) { bestD = d; best = e }
  }
  return best
}

export const hunt: SkillDef<P, { kills: number; searchSteps: number }> = {
  id: 'hunt',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => countOf(s.inventory, p.item) >= p.count,
  preconditions: () => ({ ok: true }),
  timeoutMs: (s, p) => Math.min(8 * 60_000, 60_000 + 25_000 * Math.max(1, p.count - countOf(s.inventory, p.item)) + 60_000 * Math.min(p.searchSteps, HUNT_MAX_STEPS) + 60_000),
  stallMs: 90_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const have = () => countOf(ctx.state().inventory, p.item)
    // Animals live on the surface: decisive relocation into new grassland, avoiding areas already
    // hunted out (search.ts). The old 48-block outward steps re-hunted the same ground.
    const search = new Relocator('animals')
    const maxSteps = Math.min(p.searchSteps, HUNT_MAX_STEPS)
    const spent = budget(ctx)
    let kills = 0
    let fails = 0
    let fishFails = 0
    let spots = 0
    let relocations = 0
    // Animals live on the surface. A bot still under cover would walk to remembered spots through
    // caves (b3-smoke1 r01: from y 29 under a mountain toward spots 52–103 blocks off, into lava at
    // y 10): fail instead, and Recovery retries and then relocates.
    if (!(await toSurface(ctx))) throw new SkillFailure('NAV_STUCK', 'could not reach the surface to hunt', { key: 'target=surface' })
    const rejected = (e: Entity, why: string) => {
      ctx.env.blacklist(`mob:${e.id}`, 'shoreline_risk', 60)
      ctx.log('food_risk', { kind: 'rejected', why, target: e.name, pos: [e.position.x, e.position.y, e.position.z].map(Math.round), aquatic: aquaticThreats(ctx.state()).length })
    }
    while (have() < p.count) {
      ctx.checkAbort()
      // Aquatic hostiles about and the bot at the water: move inland before anything else
      // (bounded; then this area is given up and the objective relocates).
      const st = ctx.state()
      const unsafe = aquaticThreats(st).length > 0
      if (unsafe && atWater(st)) {
        const to = relocations < AQUATIC.maxRelocations ? inlandPoint(st) : null
        if (!to) throw new SkillFailure('SEARCH_EXHAUSTED', `aquatic hostiles at the shore after ${relocations} inland moves`, { key: `target=${p.item},risk=aquatic` })
        relocations++
        ctx.log('food_risk', { kind: 'inland_relocation', from: st.pos.map(Math.round), to, aquatic: aquaticThreats(st).length })
        const r = await ctx.nav.goto({ kind: 'xz', target: to, range: 4, dry: true }, { timeoutMs: 30_000 })
        if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
        continue
      }
      const shore = unsafe ? liveView(bot) : null
      const target = pick(bot, fishFails >= MAX_FISH_FAILS ? { ...p, mobs: p.mobs.filter(m => !FISH.has(m)) } : p, k => ctx.env.isBlacklisted(k), shore, rejected)
      if (!target) {
        if (p.searchSteps === 0) throw new SkillFailure('NOT_FOUND', `no ${p.mobs.join('/')} within ${p.maxDist}`, { key: `target=${p.item}` })
        // Ordered, bounded: remembered animal spots first, then a few search steps.
        const spot = spots < ANIMAL_SPOT.perHunt ? animalSpot(ctx.state(), k => ctx.env.isBlacklisted(k)) : null
        if (spot && shore && waterWithin(shore, spot, AQUATIC.shore)) {
          ctx.env.blacklist(`animals:${spot[0]},${spot[2]}`, 'shoreline_risk', ANIMAL_SPOT.forgetS)
          ctx.log('food_risk', { kind: 'rejected', why: 'shoreline_spot', target: 'animal_spot', pos: spot, aquatic: aquaticThreats(ctx.state()).length })
          continue
        }
        if (spot) {
          spots++
          ctx.env.blacklist(`animals:${spot[0]},${spot[2]}`, 'visited', ANIMAL_SPOT.forgetS)
          const from = ctx.state().pos
          const dist = Math.hypot(spot[0] - from[0], spot[2] - from[2])
          ctx.log('search_step', { skill: 'hunt', n: 0, for: p.item, from: from.map(Math.round), target: spot, mode: 'animal_spot', dist: Math.round(dist) })
          const r = await ctx.nav.goto({ kind: 'near', target: spot, range: 6, dry: true }, { timeoutMs: Math.min(120_000, 20_000 + 400 * dist) })
          if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
          if (r.ok) ctx.progress('spot', spots)
          continue
        }
        if (spent.steps >= maxSteps) throw new SkillFailure('SEARCH_EXHAUSTED', `no ${p.mobs.join('/')} within ${p.maxDist} after ${spent.steps} search steps`, { key: `target=${p.item}` })
        if (await search.settle(ctx)) continue
        spent.steps++
        await search.step(ctx)
        spots = 0 // a new area: remembered spots may be visited again
        continue
      }
      const weapon = await armUp(bot)
      const cool = (WEAPONS[weapon] ?? WEAPONS.hand!).cooldownMs
      const t0 = Date.now()
      let lastHit = 0
      let navFails = 0
      let lastPos: V3 = [target.position.x, target.position.y, target.position.z]
      let abandoned = false
      while (target.isValid && Date.now() - t0 < MAX_CHASE_MS) {
        ctx.checkAbort()
        lastPos = [target.position.x, target.position.y, target.position.z]
        // A chase that leads into the water while aquatic hostiles are about is dropped.
        const wet = Boolean((bot.entity as unknown as { isInWater?: boolean }).isInWater)
        if ((wet || FISH.has(target.name ?? '') || bot.blockAt(target.position.floored(), false)?.name === 'water') && aquaticNear(bot)) {
          abandoned = true
          ctx.env.blacklist(`mob:${target.id}`, 'shoreline_risk', 120)
          ctx.log('food_risk', { kind: 'abandoned', why: wet ? 'bot_in_water' : 'target_in_water', target: target.name, pos: lastPos.map(Math.round), aquatic: aquaticNear(bot) })
          break
        }
        const d = bot.entity.position.distanceTo(target.position)
        if (d > 2.8) {
          // A fish is struck from the surface: get within reach, not on top of it.
          const r = await ctx.nav.goto({ kind: 'entity', target: target.id, range: FISH.has(target.name ?? '') ? 2.5 : 1.5, mode: 'walk' }, { timeoutMs: 6000 })
          if (!r.ok && r.class !== 'SKILL_TIMEOUT' && ++navFails >= 3) break
          await sleep(50, ctx.signal)
          continue
        }
        await bot.lookAt(target.position.offset(0, (target.height ?? 1) * 0.6, 0), true)
        if (weapon !== 'hand' && bot.heldItem?.name !== weapon) { await armUp(bot); lastHit = Date.now() }
        if (Date.now() - lastHit >= cool) { bot.attack(target); lastHit = Date.now() }
        await sleep(60, ctx.signal)
      }
      if (abandoned) continue
      if (target.isValid) {
        fails++
        if (FISH.has(target.name ?? '')) fishFails++
        ctx.env.blacklist(`mob:${target.id}`, 'chase_failed', 120)
        ctx.localRecovery(`gave up on ${target.name}`)
        if (fails >= 6) throw new SkillFailure('NAV_UNREACHABLE', `could not catch ${p.mobs.join('/')}`, { key: `target=${p.item}`, searchTarget: true })
        continue
      }
      kills++
      spent.steps = 0
      const before = have()
      await collectDrops(ctx, lastPos, p.item)
      if (have() > before) ctx.progress('food', have())
      else ctx.progress('kills', kills)
    }
    return { kills, searchSteps: search.steps }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

/** Walk over the drops around a kill (items within 6 blocks of it, for up to ~8 s). */
async function collectDrops (ctx: SkillCtx, at: V3, _item: string): Promise<void> {
  const bot = ctx.bot
  await sleep(600, ctx.signal)
  const end = Date.now() + 8000
  while (Date.now() < end) {
    ctx.checkAbort()
    const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position && Math.hypot(e.position.x - at[0], e.position.y - at[1], e.position.z - at[2]) < 6)
    if (!drops.length) return
    const d = drops.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]!
    const r = await ctx.nav.goto({ kind: 'near', target: [Math.floor(d.position.x), Math.floor(d.position.y), Math.floor(d.position.z)], range: 0.8 }, { timeoutMs: 6000 })
    if (!r.ok) return
    await sleep(300, ctx.signal)
  }
}
