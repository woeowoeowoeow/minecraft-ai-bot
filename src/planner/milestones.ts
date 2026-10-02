// Milestone predicates (architecture §8.1): pure functions over WorldState,
// evaluated at 1 Hz; the first transition is recorded. Milestone A's runtime
// predicate is `nether_ready` (milestones.md); the flags before it form the
// funnel reported per batch.
import progression from '../../config/progression.json' with { type: 'json' }
import type { WorldState } from '../observer/types.js'
import { COOKED_FOODS, toolTier } from '../version.js'

const A = progression.A

export function cookedCount (inv: Record<string, number>): number {
  let c = 0
  for (const [k, v] of Object.entries(inv)) if (COOKED_FOODS.has(k)) c += v
  return c
}

const n = (s: WorldState, item: string) => s.inventory[item] ?? 0
const hasTier = (s: WorldState, tool: string, tier: number) => Object.keys(s.inventory).some(k => n(s, k) > 0 && k.endsWith(`_${tool}`) && (toolTier(k) ?? -1) >= tier)

export function ironArmorPieces (s: WorldState): number {
  return ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].filter(k => n(s, k) > 0).length
}

/** A remembered Overworld lava pool with enough source blocks for a later lava-cast portal. */
export function lavaPoolKnown (s: WorldState): boolean {
  return s.memory.locations.some(l => l.kind === 'lava_pool' && l.dim === 'overworld' && Number(l.detail?.sources ?? 0) >= A.lavaPoolMinSources)
}

/** nether_ready's obsidian clause: ≥ 10 obsidian, or a water bucket plus a known usable lava pool. */
export function obsidianReady (s: WorldState): boolean {
  return n(s, 'obsidian') >= A.obsidian || (n(s, 'water_bucket') >= 1 && lavaPoolKnown(s))
}

/**
 * nether_ready (milestones.md, milestone A): iron pickaxe, iron sword, shield,
 * an (empty) bucket, ≥ 2 iron armor pieces, flint and steel, ≥ 10 cooked food,
 * and ≥ 10 obsidian or a water bucket plus a known lava pool. Worn armor and
 * the off-hand shield count (WorldState.inventory includes equipped slots).
 */
export function netherReady (s: WorldState): boolean {
  return n(s, 'iron_pickaxe') >= 1 && n(s, 'iron_sword') >= 1 && n(s, 'shield') >= 1 && n(s, 'bucket') >= 1 &&
    ironArmorPieces(s) >= A.ironArmorPieces && n(s, 'flint_and_steel') >= 1 && cookedCount(s.inventory) >= A.cookedFood && obsidianReady(s)
}

/** Funnel flags in progression order, then the milestone predicates. */
export const A_FLAGS: Record<string, (s: WorldState) => boolean> = {
  has_wooden_pickaxe: s => hasTier(s, 'pickaxe', 0),
  has_stone_pickaxe: s => hasTier(s, 'pickaxe', 1),
  food_10: s => cookedCount(s.inventory) >= A.cookedFood,
  has_iron_ingot: s => n(s, 'iron_ingot') >= 1 || hasTier(s, 'pickaxe', 2),
  has_iron_pick: s => n(s, 'iron_pickaxe') >= 1,
  has_iron_sword: s => n(s, 'iron_sword') >= 1,
  has_shield: s => n(s, 'shield') >= 1,
  has_bucket: s => n(s, 'bucket') >= 1,
  iron_armor_2: s => ironArmorPieces(s) >= A.ironArmorPieces,
  has_flint_and_steel: s => n(s, 'flint_and_steel') >= 1,
  has_water_bucket: s => n(s, 'water_bucket') >= 1,
  lava_pool_known: lavaPoolKnown,
  obsidian_10: s => n(s, 'obsidian') >= A.obsidian,
  nether_ready: netherReady,
}
