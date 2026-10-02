// Food and equipment choices (pure): what to eat, what to wear.
import mcData from 'minecraft-data'
import { ARMOR_POINTS, COOKED_FOODS, UNSAFE_FOODS } from '../version.js'
import { MC_VERSION } from '../version.js'

const FOODS = mcData(MC_VERSION).foodsByName

export function foodPoints (name: string): number {
  return FOODS[name]?.foodPoints ?? 0
}

export function isEdible (name: string): boolean {
  return foodPoints(name) > 0 && !UNSAFE_FOODS.has(name)
}

export function cookedCount (inv: Record<string, number>): number {
  let n = 0
  for (const [k, v] of Object.entries(inv)) if (COOKED_FOODS.has(k)) n += v
  return n
}

/** Emergency threshold shared by eating and the planner's `emergency_food` requirement. */
export const EMERGENCY = { health: 8, food: 6 } as const
/** Unsafe foods that still beat starving: raw chicken (30 % Hunger, but +2 food). */
const EMERGENCY_ONLY = new Set(['chicken'])

/**
 * What to eat, or null. Safe non-goal foods first (they do not count toward
 * nether_ready's cooked food), then cooked food (most nourishing), then safe raw
 * meat only when food ≤ 10 or health ≤ 8, then raw chicken and rotten flesh only
 * in an emergency (health ≤ 8 or food ≤ 6) when nothing else is left.
 */
export function chooseFood (inv: Record<string, number>, food: number, health = 20): string | null {
  const have = Object.keys(inv).filter(k => (inv[k] ?? 0) > 0)
  const byPoints = (a: string, b: string) => foodPoints(b) - foodPoints(a) || a.localeCompare(b)
  const other = have.filter(k => isEdible(k) && !COOKED_FOODS.has(k) && !/^(beef|porkchop|mutton|rabbit|cod|salmon|potato)$/.test(k)).sort(byPoints)
  if (other.length) return other[0]!
  const cooked = have.filter(k => COOKED_FOODS.has(k)).sort(byPoints)
  if (cooked.length) return cooked[0]!
  // Raw meat is the input for cooked food: eat it only when genuinely hungry.
  const raw = have.filter(k => isEdible(k)).sort(byPoints)
  // …unless health is low: regeneration needs food ≥ 18, and staying alive comes first.
  if (raw.length && (food <= 10 || health <= EMERGENCY.health)) return raw[0]!
  const emergency = health <= EMERGENCY.health || food <= EMERGENCY.food
  const last = have.filter(k => EMERGENCY_ONLY.has(k)).sort(byPoints)
  if (emergency && last.length) return last[0]!
  if (food <= EMERGENCY.food && (inv.rotten_flesh ?? 0) > 0) return 'rotten_flesh'
  return null
}

/**
 * Whether the bot holds anything it would eat in an emergency (health ≤ 8, food
 * ≤ 6). The planner's `emergency_food` requirement is met by exactly this, so it
 * agrees with `eat` and with every member of the `raw_meat` group its objective
 * obtains (gate 20260929 r09: raw chicken satisfied the objective but not the
 * requirement, and the controller spun for 36 minutes).
 */
export function hasEmergencyFood (inv: Record<string, number>): boolean {
  return chooseFood(inv, EMERGENCY.food, EMERGENCY.health) !== null
}

/** Food items the bot would eat when hungry (cooked, safe raw, other safe foods): the early buffer. */
export function foodItems (inv: Record<string, number>): number {
  let n = 0
  for (const [k, v] of Object.entries(inv)) if (v > 0 && isEdible(k)) n += v
  return n
}

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet'
const SLOT_RE: [RegExp, ArmorSlot][] = [[/_helmet$/, 'head'], [/_chestplate$/, 'torso'], [/_leggings$/, 'legs'], [/_boots$/, 'feet']]

export function armorSlot (name: string): ArmorSlot | null {
  for (const [re, slot] of SLOT_RE) if (re.test(name)) return slot
  return null
}

/** Armor in inventory that beats what is worn, one per slot (best first). */
export function armorUpgrades (inv: Record<string, number>, worn: { head: string | null; chest: string | null; legs: string | null; feet: string | null }): { item: string; slot: ArmorSlot }[] {
  const current: Record<ArmorSlot, string | null> = { head: worn.head, torso: worn.chest, legs: worn.legs, feet: worn.feet }
  const out: { item: string; slot: ArmorSlot }[] = []
  for (const slot of ['head', 'torso', 'legs', 'feet'] as ArmorSlot[]) {
    let best: string | null = null
    let pts = ARMOR_POINTS[current[slot] ?? ''] ?? 0
    for (const k of Object.keys(inv)) {
      if ((inv[k] ?? 0) <= 0 || armorSlot(k) !== slot) continue
      const p = ARMOR_POINTS[k] ?? 0
      if (p > pts) { pts = p; best = k }
    }
    if (best) out.push({ item: best, slot })
  }
  return out
}

/** A shield should be in the off-hand whenever one is carried. */
export function wantsShield (inv: Record<string, number>, offHand: string | null): boolean {
  return offHand !== 'shield' && (inv.shield ?? 0) > 0
}
