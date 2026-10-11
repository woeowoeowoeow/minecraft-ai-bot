// Survival interrupts (architecture §4.2): P0 emergency > P1 threat > P2
// maintenance > P3 objective. Pure selection over WorldState; the controller
// preempts the active skill when a strictly higher-priority interrupt appears.
import type { WorldState } from '../observer/types.js'
import { chooseFood, armorUpgrades, cookableRaw, EMERGENCY, foodPoints, wantsShield } from '../skills/food.js'
import { isUsefulDrop, surplus } from '../skills/inventory.js'
import { assessThreat, capacity, isNight, menacing, piglinsProvoked, RETREAT_HP, weakState } from '../skills/survival/threat.js'
import { AQUATIC, aquaticThreats, isAquatic, waterCellsNear } from '../skills/survival/aquatic.js'
import { wantsDeflect } from '../skills/survival/ghast.js'
import { countOf, GROUPS, planObtain } from '../skills/sources.js'
import { cookedCount } from '../skills/food.js'
import { hintsFrom } from '../skills/generic/obtain.js'
import { FISH, FOOD_ANIMALS, MOB_THREATS } from '../version.js'

export type Priority = 0 | 1 | 2 | 3
export const P = { emergency: 0, threat: 1, maintenance: 2, objective: 3 } as const

export type Interrupt = { id: string; priority: Priority; skill: string; params: Record<string, unknown>; reason: string }

/** Cooldown bookkeeping (keys like `defend:<entityId>`, `eat`); seconds on the bus clock. */
export class Cooldowns {
  private until = new Map<string, number>()
  constructor (private readonly now: () => number) {}
  set (key: string, seconds: number): void { this.until.set(key, this.now() + seconds) }
  active (key: string): boolean {
    const u = this.until.get(key)
    if (u === undefined) return false
    if (u <= this.now()) { this.until.delete(key); return false }
    return true
  }
  clear (): void { this.until.clear() }
}

/** Air (0–20) below which surfacing preempts everything. The navigator's own reflex acts earlier (14). */
export const P0_AIR = 12
/** Food level at or below which the bot eats (auto-eat default). */
export const EAT_FOOD = 14
/** Capacity (threat.ts scale) below which the bot shelters at night instead of fighting: no sword. */
export const SHELTER_BELOW = 1.2
/** Inside a sealed dig-in the bot stays while a hostile is this close (dev batch 8: 16 pinned bots for 30 min on mobs in nearby caves). */
export const HOLD_HOSTILE_DIST = 8
/** Nobody rests in the open with a hostile in sight this close. */
export const WEAK_HOLD_DIST = 16
/** A weak bot (threat.ts weakState) stays in its sealed pocket while a hostile is this close. */
export const WEAK_POCKET_DIST = 12
/**
 * An angry (screaming) enderman teleports back within seconds: the bot stays sealed in while one is
 * this close (ckit-r2b r02: twice dug in at 12 HP, left the pocket at once, killed 20 → 0 in 2 s).
 */
export const ENDERMAN_HOLD_DIST = 32
/** Health at or below which the bot rests (when fed) instead of pursuing its objective. */
export const REST_BELOW = 10

/** Skills that stand in a portal on purpose (they cross it, or build and light it). */
export const PORTAL_SKILLS: ReadonlySet<string> = new Set(['usePortal', 'netherExcursion', 'buildNetherPortal'])

/** Bulk blocks: picked up by the skills that dig them, never worth preempting an objective for. */
const BULK = /^(cobblestone|dirt|stone|gravel|sand|grass_block|coarse_dirt|netherrack|.*_planks|stick)$/
/** Objective skills that collect their own drops, or dig bulk blocks not worth a detour (portal site work). */
const SELF_COLLECTING = new Set(['collect', 'mine', 'hunt', 'obtain', 'buildNetherPortal', 'netherExcursion', 'usePortal', 'findFortress', 'collectBlazeRods', 'barterPearls', 'huntEndermen'])

/**
 * Milestone C skills that handle one kind of mob themselves (blazes with sword, shield and their
 * own retreat; piglins as trade partners; endermen as prey). While one runs above OWN_MOBS_HP,
 * P1 ignores that kind; every other mob, and any low-health state, stays with P1.
 */
export const OWN_MOBS: Record<string, ReadonlySet<string>> = {
  collectBlazeRods: new Set(['blaze']),
  barterPearls: new Set(['piglin']),
  huntEndermen: new Set(['enderman']),
}
export const OWN_MOBS_HP = 8

export function ignoredMobs (s: WorldState, skill: string | null): ReadonlySet<string> | undefined {
  const own = skill ? OWN_MOBS[skill] : undefined
  if (!own || s.vitals.health <= OWN_MOBS_HP) return undefined
  // Provoked piglins are enemies again, whatever the skill.
  if (own.has('piglin') && piglinsProvoked(s)) return undefined
  return own
}

export function selectInterrupt (s: WorldState, cd: Cooldowns, active: { skill: string | null; priority: Priority | null }): Interrupt | null {
  const b = s.body
  // ── P0 emergency ─────────────────────────────────────────────────────────
  if (b.feet === 'lava' || b.head === 'lava' || s.inLiquid === 'lava') {
    return { id: 'escape_lava', priority: P.emergency, skill: 'escapeLava', params: {}, reason: 'in lava' }
  }
  if (b.feet === 'fire' || b.head === 'fire' || b.inFire) {
    return { id: 'escape_fire', priority: P.emergency, skill: 'escapeLava', params: {}, reason: 'in fire' }
  }
  // Burning out of the lava with a water bucket: put the fire out (1 HP/s for up to 15 s). Only
  // standing clear of the lava: escapeLava can end at the edge, and an extinguish there held the
  // bot still in the lava (b3-smoke2 r01: died during it, 3.7 HP every half second).
  if (s.vitals.onFire && s.dim === 'overworld' && s.inLiquid === 'none' && s.onGround && !lavaWithin(s, EXTINGUISH_CLEAR) && (s.inventory.water_bucket ?? 0) > 0 && !cd.active('extinguish')) {
    return { id: 'extinguish', priority: P.emergency, skill: 'extinguish', params: {}, reason: `on fire, hp ${Math.round(s.vitals.health)}` }
  }
  // Standing on magma burns (1 HP every half second) unless sneaking; Nether only (ckit3 r01: died
  // mining at y 35 on a magma patch by the lava sea).
  if (s.dim === 'the_nether' && b.floor === 'magma_block' && s.onGround && !cd.active('magma')) {
    return { id: 'magma', priority: P.emergency, skill: 'stepOffMagma', params: {}, reason: 'standing on magma' }
  }
  if (b.head === 'water' && s.vitals.air < P0_AIR && !cd.active('surface')) {
    return { id: 'surface', priority: P.emergency, skill: 'surfaceForAir', params: {}, reason: `air ${s.vitals.air}` }
  }
  // Standing in a portal outside the portal skills: 4 s there teleports (ckit-r2d r02).
  if (b.inPortal && !PORTAL_SKILLS.has(active.skill ?? '') && !cd.active('leave_portal')) {
    return { id: 'leave_portal', priority: P.emergency, skill: 'leavePortal', params: {}, reason: 'standing in a portal' }
  }
  // A route failed on the water itself (no air, no exit) and the bot is still in it: out first.
  if (s.inLiquid === 'water' && s.memory.blacklist.some(x => x.key === 'water_trap' && x.until > s.t) && !cd.active('water_escape')) {
    return { id: 'water_escape', priority: P.emergency, skill: 'escapeWater', params: {}, reason: 'trapped in water' }
  }
  if (b.head === 'solid' && !cd.active('suffocation')) {
    return { id: 'suffocation', priority: P.emergency, skill: 'escapeSuffocation', params: {}, reason: 'head inside a block' }
  }
  // Ghast fire (milestone C): shield up toward an incoming fireball or a charging ghast in sight.
  // `cover` blocks between its own steps (ghast.ts shieldUp): never cut off mid-dig-in.
  const shot = s.dim === 'the_nether' && active.skill !== 'cover' ? wantsDeflect(s) : null
  if (shot && !cd.active('deflect')) {
    return { id: 'deflect', priority: P.emergency, skill: 'deflect', params: { targetId: shot.id }, reason: `${shot.name}@${shot.dist}${shot.charging ? ' charging' : ''}` }
  }

  // ── P1 threat ────────────────────────────────────────────────────────────
  // Inside a sealed dig-in no mob can reach or see the bot: stay put (leaving is the danger).
  const th = assessThreat(s, ignoredMobs(s, active.skill))
  if (th.engage && th.primary && !s.body.enclosed) {
    const id = th.primary.e.id
    const creeper = MOB_THREATS[th.primary.e.name]?.explosive === true
    let action = th.action as 'defend' | 'flee' | 'cover'
    const avoid = MOB_THREATS[th.primary.e.name]?.avoid === true
    // A shooter far off whose cover is cooling down: running gains nothing (ckit8 r01: a ghast at 30
    // blocks drew 30 instant flees in 4 s). Closer, the old flee fallback stays.
    const farShooter = action === 'cover' && th.primary.ranged && th.primary.e.dist > FAR_SHOOTER
    if (action === 'cover' && cd.active(`cover:${id}`)) action = farShooter ? 'none' as never : 'flee'
    if (action === 'defend' && cd.active(`defend:${id}`)) action = 'flee'
    // In water an aquatic hostile is never fought (threat.ts): fleeing to land stays the answer.
    const wet = s.inLiquid === 'water' && isAquatic(th.primary.e.name)
    // Avoided mobs (hoglins, magma cubes) are never fought, even when flight failed (ckit8 r01: died in the
    // `defend` that followed a failed flight from a hoglin).
    if (action === 'flee' && cd.active(`flee:${id}`) && !creeper && !wet && !avoid) action = s.vitals.health > RETREAT_HP && !cd.active(`defend:${id}`) ? 'defend' : 'flee'
    const blocked = (action as string) === 'none' || (cd.active(`${action}:${id}`) && !wet && !(avoid && action === 'flee'))
    if (!blocked) {
      return { id: action, priority: P.threat, skill: action, params: { targetId: id }, reason: `${th.primary.e.name}@${th.primary.e.dist}: ${th.reason}` }
    }
  }

  // ── P2 maintenance ───────────────────────────────────────────────────────
  // Night with hostiles about and nothing to fight with: hide until it passes.
  if (isNight(s) && !s.body.covered && !s.body.enclosed && s.inLiquid === 'none' && capacity(s) < SHELTER_BELOW &&
    s.nearby.entities.some(e => menacing(e, s) && e.dist < 20) && !cd.active('shelter')) {
    return { id: 'shelter', priority: P.maintenance, skill: 'shelter', params: {}, reason: `night, capacity ${capacity(s)}` }
  }
  // Hungry with only raw meat: cook a few first (a cooked porkchop restores 8, a raw one 3).
  // Re-gate 20261003: 105 raw items eaten or lost, 30–40 % of the meat in the food-timeout runs.
  const cook = !th.engage && s.inLiquid === 'none' && active.skill !== 'smelt' && !cd.active('cook') ? cookPlan(s) : null
  if (cook) {
    return { id: 'cook', priority: P.maintenance, skill: 'obtain', params: { item: 'cooked_food', count: cook.count }, reason: `food ${s.vitals.food}, raw ${cook.raw}` }
  }
  const food = chooseFood(s.inventory, s.vitals.food, s.vitals.health)
  // Hungry, or hurt and below the regeneration threshold (18) with food worth eating for it.
  if (food && (s.vitals.food <= EAT_FOOD || (s.vitals.health <= 14 && s.vitals.food < 18 && (foodPoints(food) >= 5 || s.vitals.health <= 8))) && !cd.active('eat')) {
    return { id: 'eat', priority: P.maintenance, skill: 'eat', params: {}, reason: `food ${s.vitals.food}, hp ${s.vitals.health}` }
  }
  // Hurt with a full stomach: stand still while natural regeneration works (P1 still preempts).
  // Never in the open with a hostile in sight (B gate 20261002 r11: rested at 4 HP with a zombie
  // at 9.7 blocks, outside the engage range, and died three seconds later).
  const exposed = !s.body.enclosed && s.nearby.entities.some(e => menacing(e, s) && e.dist < WEAK_HOLD_DIST && e.los !== false)
  if (s.vitals.health <= REST_BELOW && s.vitals.food >= 18 && !th.engage && !exposed && !cd.active('rest')) {
    return { id: 'rest', priority: P.maintenance, skill: 'rest', params: {}, reason: `hp ${s.vitals.health}` }
  }
  if ((armorUpgrades(s.inventory, s.equipment).length || wantsShield(s.inventory, s.equipment.offHand)) && !cd.active('equip')) {
    return { id: 'equip', priority: P.maintenance, skill: 'equipGear', params: {}, reason: 'better gear in inventory' }
  }
  if (s.freeSlots <= 1 && Object.keys(surplus(s.inventory)).length && !cd.active('inventory')) {
    return { id: 'inventory', priority: P.maintenance, skill: 'manageInventory', params: {}, reason: `${s.freeSlots} free slots` }
  }
  // Sealed in (sheltering or in cover): nothing outside is worth digging out for, and the
  // objective waits while hostiles are close (dev batch 6 r02: resumed mining next to the
  // skeleton it had just hidden from, at 7.5 HP).
  if (s.body.enclosed) {
    // A weak bot also waits out hostiles further off (from inside the pocket nothing is in sight).
    const weak = weakState(s, th.capacity)
    const near = s.nearby.entities.filter(e => menacing(e, s) && (e.dist < (weak ? WEAK_POCKET_DIST : HOLD_HOSTILE_DIST) || (e.name === 'enderman' && e.aggro === true && e.dist < ENDERMAN_HOLD_DIST)))
    if (near.length && !cd.active('hold')) {
      const r = Math.max(HOLD_HOSTILE_DIST, ...near.map(e => Math.ceil(e.dist) + 1))
      return { id: 'hold', priority: P.maintenance, skill: 'shelter', params: { maxMs: 30_000, whileThreat: true, near: r, ...(weak ? { weak: true } : {}) }, reason: `sealed in, hostiles near${weak ? ' (weak)' : ''}` }
    }
    return null
  }
  const selfCollecting = active.skill !== null && SELF_COLLECTING.has(active.skill)
  const drop = s.nearby.entities.find(e => e.kind === 'item' && e.item && e.dist <= 8 &&
    Math.abs(e.pos[1] - s.pos[1]) <= 3 && isUsefulDrop(e.item.name, s.inventory) &&
    (e.ageS ?? 0) >= (selfCollecting ? 6 : 1.5) && !(selfCollecting && BULK.test(e.item.name) && (s.inventory[e.item.name] ?? 0) >= 16) &&
    !cd.active(`pickup:${e.id}`))
  if (drop && s.freeSlots > 0) {
    return { id: 'pickup', priority: P.maintenance, skill: 'pickupDrops', params: { entityId: drop.id }, reason: `${drop.item!.name}×${drop.item!.count}@${drop.dist}` }
  }
  const prey = forageTarget(s, active, th.mobs.length > 0)
  if (prey && !cd.active('forage') && !cd.active(`forage:${prey.id}`)) {
    return { id: 'forage', priority: P.maintenance, skill: 'hunt', params: { item: 'raw_meat', count: countOf(s.inventory, 'raw_meat') + 1, mobs: [prey.name], maxDist: FORAGE.wideDist, searchSteps: 0, targetId: prey.id }, reason: `${prey.name}@${prey.dist}` }
  }
  return null
}

/** A shooter beyond this distance whose cover is cooling down draws no interrupt. */
export const FAR_SHOOTER = 16

/** Lava this close (blocks) rules out stopping to put a fire out. */
export const EXTINGUISH_CLEAR = 2.5
const lavaWithin = (s: WorldState, r: number) => s.nearby.hazards.some(h => h.kind === 'lava' && h.dist <= r) || s.body.feet === 'lava' || s.body.head === 'lava'

/** Raw food cooked per `cook` interrupt (10 s each in a furnace). */
export const COOK = { max: 4 } as const

/**
 * Cook before eating raw: hungry (food ≤ EAT_FOOD) but not in an emergency, nothing to eat
 * except raw meat, and the furnace work needs nothing gathered (a furnace or its cobblestone,
 * and fuel, are carried or a furnace stands nearby). Overworld only. Null when not applicable.
 */
export function cookPlan (s: WorldState): { count: number; raw: number } | null {
  if (s.dim !== 'overworld' || s.vitals.food > EAT_FOOD) return null
  if (s.vitals.health <= EMERGENCY.health || s.vitals.food <= EMERGENCY.food) return null
  const choice = chooseFood(s.inventory, s.vitals.food, s.vitals.health)
  if (choice && !GROUPS.raw_meat!(choice)) return null
  const raw = cookableRaw(s.inventory)
  if (raw < 1) return null
  const count = cookedCount(s.inventory) + Math.min(raw, COOK.max)
  try {
    const { steps } = planObtain('cooked_food', count, s.inventory, hintsFrom(s))
    if (steps.some(st => st.kind !== 'craft' && st.kind !== 'smelt')) return null
  } catch {
    return null
  }
  return { count, raw }
}

/** Opportunistic food (gate 20260929: hunt objectives 12 % success, long surface searches). */
export const FORAGE = { maxDist: 12, wideDist: 24, dayFrom: 23_300, dayUntil: 12_000, until: 14 } as const

/**
 * A food animal close by while the bot is on the surface in daylight, with no
 * threat about, cooked plus raw meat short of the food target, and no hunt or
 * survival skill already running: worth a short detour (one kill).
 */
export function forageTarget (s: WorldState, active: { skill: string | null; priority: Priority | null }, threatened: boolean): { id: number; name: string; dist: number } | null {
  if (threatened || s.dim !== 'overworld' || s.body.covered || s.inLiquid !== 'none') return null
  const t = s.vitals.timeOfDay
  if (t >= FORAGE.dayUntil && t < FORAGE.dayFrom) return null
  if (active.skill === 'hunt' || (active.priority !== null && active.priority < P.objective)) return null
  if (cookedCount(s.inventory) + countOf(s.inventory, 'raw_meat') >= FORAGE.until || s.freeSlots < 1) return null
  // Aquatic hostiles about: prey at the water's edge is left (re-gate 20260930, drowned deaths).
  const shoreUnsafe = aquaticThreats(s).length > 0
  // Short of the cooked-food stock: a wider detour while walking for something else (wood, gravel).
  const maxDist = cookedCount(s.inventory) + countOf(s.inventory, 'raw_meat') < FORAGE.until ? FORAGE.wideDist : FORAGE.maxDist
  const e = s.nearby.entities.find(x => x.kind === 'passive' && FOOD_ANIMALS[x.name] && !FISH.has(x.name) && !x.baby && x.dist <= maxDist && x.los !== false && Math.abs(x.pos[1] - s.pos[1]) <= 3 &&
    !(shoreUnsafe && waterCellsNear(s, x.pos, AQUATIC.shore).length))
  return e ? { id: e.id, name: e.name, dist: e.dist } : null
}
