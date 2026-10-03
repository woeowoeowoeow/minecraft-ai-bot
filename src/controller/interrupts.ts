// Survival interrupts (architecture §4.2): P0 emergency > P1 threat > P2
// maintenance > P3 objective. Pure selection over WorldState; the controller
// preempts the active skill when a strictly higher-priority interrupt appears.
import type { WorldState } from '../observer/types.js'
import { chooseFood, armorUpgrades, foodPoints, wantsShield } from '../skills/food.js'
import { isUsefulDrop, surplus } from '../skills/inventory.js'
import { assessThreat, capacity, isNight, RETREAT_HP } from '../skills/survival/threat.js'
import { AQUATIC, aquaticThreats, isAquatic, waterCellsNear } from '../skills/survival/aquatic.js'
import { countOf } from '../skills/sources.js'
import { cookedCount } from '../skills/food.js'
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
/** Health at or below which the bot rests (when fed) instead of pursuing its objective. */
export const REST_BELOW = 10

/** Bulk blocks: picked up by the skills that dig them, never worth preempting an objective for. */
const BULK = /^(cobblestone|dirt|stone|gravel|sand|grass_block|coarse_dirt|netherrack|.*_planks|stick)$/
/** Objective skills that collect their own drops, or dig bulk blocks not worth a detour (portal site work). */
const SELF_COLLECTING = new Set(['collect', 'mine', 'hunt', 'obtain', 'buildNetherPortal', 'netherExcursion', 'usePortal'])

export function selectInterrupt (s: WorldState, cd: Cooldowns, active: { skill: string | null; priority: Priority | null }): Interrupt | null {
  const b = s.body
  // ── P0 emergency ─────────────────────────────────────────────────────────
  if (b.feet === 'lava' || b.head === 'lava' || s.inLiquid === 'lava') {
    return { id: 'escape_lava', priority: P.emergency, skill: 'escapeLava', params: {}, reason: 'in lava' }
  }
  if (b.feet === 'fire' || b.head === 'fire') {
    return { id: 'escape_fire', priority: P.emergency, skill: 'escapeLava', params: {}, reason: 'in fire' }
  }
  if (b.head === 'water' && s.vitals.air < P0_AIR && !cd.active('surface')) {
    return { id: 'surface', priority: P.emergency, skill: 'surfaceForAir', params: {}, reason: `air ${s.vitals.air}` }
  }
  if (b.head === 'solid' && !cd.active('suffocation')) {
    return { id: 'suffocation', priority: P.emergency, skill: 'escapeSuffocation', params: {}, reason: 'head inside a block' }
  }

  // ── P1 threat ────────────────────────────────────────────────────────────
  // Inside a sealed dig-in no mob can reach or see the bot: stay put (leaving is the danger).
  const th = assessThreat(s)
  if (th.engage && th.primary && !s.body.enclosed) {
    const id = th.primary.e.id
    const creeper = MOB_THREATS[th.primary.e.name]?.explosive === true
    let action = th.action as 'defend' | 'flee' | 'cover'
    if (action === 'cover' && cd.active(`cover:${id}`)) action = 'flee'
    if (action === 'defend' && cd.active(`defend:${id}`)) action = 'flee'
    // In water an aquatic hostile is never fought (threat.ts): fleeing to land stays the answer.
    const wet = s.inLiquid === 'water' && isAquatic(th.primary.e.name)
    if (action === 'flee' && cd.active(`flee:${id}`) && !creeper && !wet) action = s.vitals.health > RETREAT_HP && !cd.active(`defend:${id}`) ? 'defend' : 'flee'
    const blocked = cd.active(`${action}:${id}`) && !wet
    if (!blocked) {
      return { id: action, priority: P.threat, skill: action, params: { targetId: id }, reason: `${th.primary.e.name}@${th.primary.e.dist}: ${th.reason}` }
    }
  }

  // ── P2 maintenance ───────────────────────────────────────────────────────
  // Night with hostiles about and nothing to fight with: hide until it passes.
  if (isNight(s) && !s.body.covered && !s.body.enclosed && s.inLiquid === 'none' && capacity(s) < SHELTER_BELOW &&
    s.nearby.entities.some(e => e.kind === 'hostile' && e.dist < 20) && !cd.active('shelter')) {
    return { id: 'shelter', priority: P.maintenance, skill: 'shelter', params: {}, reason: `night, capacity ${capacity(s)}` }
  }
  const food = chooseFood(s.inventory, s.vitals.food, s.vitals.health)
  // Hungry, or hurt and below the regeneration threshold (18) with food worth eating for it.
  if (food && (s.vitals.food <= EAT_FOOD || (s.vitals.health <= 14 && s.vitals.food < 18 && (foodPoints(food) >= 5 || s.vitals.health <= 8))) && !cd.active('eat')) {
    return { id: 'eat', priority: P.maintenance, skill: 'eat', params: {}, reason: `food ${s.vitals.food}, hp ${s.vitals.health}` }
  }
  // Hurt with a full stomach: stand still while natural regeneration works (P1 still preempts).
  if (s.vitals.health <= REST_BELOW && s.vitals.food >= 18 && !th.engage && !cd.active('rest')) {
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
    if (s.nearby.entities.some(e => e.kind === 'hostile' && e.dist < HOLD_HOSTILE_DIST) && !cd.active('hold')) {
      return { id: 'hold', priority: P.maintenance, skill: 'shelter', params: { maxMs: 30_000, whileThreat: true, near: HOLD_HOSTILE_DIST }, reason: 'sealed in, hostiles near' }
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
    return { id: 'forage', priority: P.maintenance, skill: 'hunt', params: { item: 'raw_meat', count: countOf(s.inventory, 'raw_meat') + 1, mobs: [prey.name], maxDist: FORAGE.maxDist, searchSteps: 0, targetId: prey.id }, reason: `${prey.name}@${prey.dist}` }
  }
  return null
}

/** Opportunistic food (gate 20260929: hunt objectives 12 % success, long surface searches). */
export const FORAGE = { maxDist: 12, dayFrom: 23_300, dayUntil: 12_000, until: 14 } as const

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
  const e = s.nearby.entities.find(x => x.kind === 'passive' && FOOD_ANIMALS[x.name] && !FISH.has(x.name) && !x.baby && x.dist <= FORAGE.maxDist && x.los !== false && Math.abs(x.pos[1] - s.pos[1]) <= 3 &&
    !(shoreUnsafe && waterCellsNear(s, x.pos, AQUATIC.shore).length))
  return e ? { id: e.id, name: e.name, dist: e.dist } : null
}
