// Deterministic threat score (architecture §4.2 P1): mob type, distance and
// count, the bot's health, armor, weapon and shield, and terrain. Pure over
// WorldState, so the controller's interrupt check and the combat skills agree.
import type { EntityInfo, WorldState } from '../../observer/types.js'
import { GOLDEN_ARMOR, MOB_THREATS, NIGHT, WEAPONS } from '../../version.js'
import { isAquatic } from './aquatic.js'

export type MobScore = { e: EntityInfo; t: number; ranged: boolean }

export type ThreatAssessment = {
  /** Sum of per-mob threat. 0 = no threat. */
  score: number
  /** The bot's fighting capacity on the same scale. */
  capacity: number
  mobs: MobScore[]
  primary: MobScore | null
  /** Whether the P1 interrupt should fire now. */
  engage: boolean
  action: 'none' | 'defend' | 'flee' | 'cover'
  reason: string
}

/** Below this capacity (no real weapon) the bot never starts a fight; it defends only when fleeing has failed. */
export const UNARMED_CAPACITY = 1
/** Health at or below which the bot disengages from melee (architecture §6.3 COMBAT_DANGER). */
export const RETREAT_HP = 6
/** A ranged mob this close is fought in melee; further away the bot breaks line of sight instead (cover). */
export const RANGED_MELEE_DIST = 4
/** A creeper in sight this close is never fought: the bot keeps its distance (swell starts at 3, stops beyond 7). */
export const CREEPER_SPACING = 6
/**
 * A weak bot (no real weapon, or badly hurt) with melee mobs no closer than this digs in
 * instead of running: a 3-deep capped pocket takes about 2.5 s bare-handed in dirt, and a
 * zombie covers ~2.3 blocks a second. Closer than this the bot flees, then digs in once
 * clear (combat.ts). B gate 20261002: 11 of 22 deaths were mid-flee, 15 at 0 armor.
 */
export const DIG_IN_MIN_DIST = 6

/** No real weapon, or at the retreat threshold: fights are lost, and long open flights too. */
export function weakState (s: WorldState, cap = capacity(s)): boolean {
  return cap < UNARMED_CAPACITY || s.vitals.health <= RETREAT_HP
}

/** Melee mobs start to count within this distance (they path to the bot from further away). */
const MELEE_ALERT = 10
/** The interrupt fires when the nearest scoring mob is this close (melee), or in its range (ranged). */
const ENGAGE_DIST = 8

/** Surface night (hostile spawning under the open sky): only the Overworld has one. */
export function isNight (s: WorldState): boolean {
  if (s.dim !== 'overworld') return false
  const t = s.vitals.timeOfDay
  return t >= NIGHT.start && t < NIGHT.end
}

/** Wearing any golden armor piece: piglins leave the bot alone. */
export function wearsGold (s: WorldState): boolean {
  return [s.equipment.head, s.equipment.chest, s.equipment.legs, s.equipment.feet].some(x => x !== null && GOLDEN_ARMOR.has(x))
}

/** Dark enough for spiders to be hostile (1.16.1: brightness below 0.5 ≈ light ≤ 11), approximated. */
function dark (s: WorldState): boolean {
  if (s.body.light) return Math.max(s.body.light.block, isNight(s) ? 0 : s.body.light.sky) <= 11
  return isNight(s) || s.body.covered
}

export function mobThreat (e: EntityInfo, s: WorldState): MobScore | null {
  if (e.kind !== 'hostile' || e.name === 'zombified_piglin') return null
  const info = MOB_THREATS[e.name] ?? { weight: 1, range: 2 }
  const ranged = Boolean(info.ranged) || (e.name === 'drowned' && e.held === 'trident') || (e.name === 'piglin' && e.held === 'crossbow')
  const range = ranged ? Math.max(info.range, 12) : MELEE_ALERT
  if (e.dist > range) return null
  if (e.name === 'piglin' && wearsGold(s) && e.dist > 3) return null
  if (info.neutral) {
    if (e.name === 'spider' ? !dark(s) && e.dist > 2.5 : e.dist > 3) return null
  }
  // Behind a wall a melee mob is no immediate danger; a ranged one cannot shoot.
  if (e.los === false && e.dist > 2.5) return null
  let t = info.weight
  if (!ranged && e.dist > 3) t *= Math.max(0.3, 1 - (e.dist - 3) / (MELEE_ALERT - 3))
  if ((e.closing ?? 0) > 0.8) t *= 1.2
  if (info.explosive && e.swelling) t *= 2
  return { e, t: Math.round(t * 100) / 100, ranged }
}

/** Best melee weapon in inventory (by damage per second). */
export function bestWeapon (inv: Record<string, number>): string | null {
  let best: string | null = null
  let dps = WEAPONS.hand!.damage / (WEAPONS.hand!.cooldownMs / 1000)
  for (const [name, w] of Object.entries(WEAPONS)) {
    if (name === 'hand' || !(inv[name] ?? 0)) continue
    const d = w.damage / (w.cooldownMs / 1000)
    if (d > dps) { dps = d; best = name }
  }
  return best
}

export function hasShield (s: WorldState): boolean {
  return (s.inventory.shield ?? 0) > 0 || s.equipment.offHand === 'shield'
}

export function capacity (s: WorldState): number {
  const w = WEAPONS[bestWeapon(s.inventory) ?? 'hand']!
  const dps = w.damage / (w.cooldownMs / 1000)
  const hp = s.vitals.health / 20
  const armor = 1 + s.armor / 12
  // Time-to-kill matters more than linearly: bare hands (4 dps) lose to a zombie trading 3 per second.
  const weapon = Math.pow(dps / 8, 1.5)
  const shield = hasShield(s) ? 1.25 : 1
  const water = s.inLiquid === 'water' ? 0.6 : 1
  return Math.round(2.2 * hp * armor * weapon * shield * water * 100) / 100
}

export function assessThreat (s: WorldState): ThreatAssessment {
  const mobs = s.nearby.entities.map(e => mobThreat(e, s)).filter((m): m is MobScore => m !== null).sort((a, b) => b.t - a.t || a.e.dist - b.e.dist)
  const score = Math.round(mobs.reduce((a, m) => a + m.t, 0) * 100) / 100
  const cap = capacity(s)
  const primary = mobs[0] ?? null
  if (!primary) return { score: 0, capacity: cap, mobs, primary, engage: false, action: 'none', reason: 'no threat' }
  const nearest = Math.min(...mobs.map(m => m.e.dist))
  const rangedInSight = mobs.some(m => m.ranged && m.e.los !== false)
  const engage = nearest <= ENGAGE_DIST || rangedInSight || (s.vitals.health <= 8 && nearest <= 12)
  const explosive = MOB_THREATS[primary.e.name]?.explosive
  const need = explosive ? 1.6 : 1
  // Shooters in sight: running in the open does not outpace arrows (gate: 11 of 36 deaths mid-flee
  // from ranged mobs). Breaking line of sight does.
  const shooting = mobs.some(m => m.ranged && m.e.los !== false && m.e.dist > RANGED_MELEE_DIST)
  const creeper = mobs.find(m => MOB_THREATS[m.e.name]?.explosive && (m.e.los !== false || m.e.dist <= 3) && m.e.dist <= CREEPER_SPACING)
  let action: 'defend' | 'flee' | 'cover'
  let reason: string
  if (creeper) { action = 'flee'; reason = `creeper spacing (${creeper.e.dist}${creeper.e.swelling ? ', swelling' : ''})`; return { score, capacity: cap, mobs, primary: creeper, engage, action, reason } }
  // Hurt: any shooter in sight means cover, however close (dev batch 7 r01: fled a skeleton at 2.8 at 2.6 HP).
  const shooterInSight = mobs.some(m => m.ranged && m.e.los !== false)
  // In water with an aquatic hostile about, neither melee nor cover works (re-gate 20260930: a
  // defend at sea level went 17 → 2 HP in two trident hits; cover from under water failed):
  // get onto land, away from the water (flee plans dry).
  const aquatic = mobs.find(m => isAquatic(m.e.name))
  if (aquatic && (s.inLiquid === 'water' || s.body.feet === 'water')) {
    return { score, capacity: cap, mobs, primary: aquatic, engage, action: 'flee', reason: 'in water with an aquatic hostile' }
  }
  if (s.vitals.health <= RETREAT_HP) { action = shooterInSight ? 'cover' : 'flee'; reason = `health ${s.vitals.health} ≤ ${RETREAT_HP}` }
  else if (cap < UNARMED_CAPACITY) { action = shooting ? 'cover' : 'flee'; reason = `unarmed (capacity ${cap})` }
  else if (score * need <= cap) {
    // A shooter is fought only once it is in melee range, never charged across open ground: dev
    // batch 7 lost two fully equipped bots (iron sword, shield, 4 armor) charging lone skeletons
    // from 13–15 blocks (18 → 0 HP in 11 s).
    const melee = !primary.ranged || primary.e.dist <= RANGED_MELEE_DIST
    action = melee ? 'defend' : 'cover'
    reason = `threat ${score} ≤ capacity ${cap}${explosive ? ' (explosive ×1.6)' : ''}${melee ? '' : ', ranged at range'}`
  } else { action = shooting ? 'cover' : 'flee'; reason = `threat ${score} > capacity ${cap}${explosive ? ' (explosive ×1.6)' : ''}` }
  // Weak, on land, only melee mobs and none of them close yet: dig in rather than run (cover's
  // melee path seals a pocket; if no column is diggable cover fails and its cooldown turns it into
  // flee). Aquatic mobs keep the inland flight of the shoreline fix (A round 3).
  if (action === 'flee' && weakState(s, cap) && s.inLiquid === 'none' && s.body.feet !== 'water' && !mobs.some(m => m.ranged || isAquatic(m.e.name))) {
    const near = mobs.filter(m => m.e.los !== false || m.e.dist <= 3)
    if (near.length && Math.min(...near.map(m => m.e.dist)) >= DIG_IN_MIN_DIST) { action = 'cover'; reason += '; weak: dig in' }
  }
  return { score, capacity: cap, mobs, primary, engage, action, reason }
}
