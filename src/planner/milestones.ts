// Milestone predicates (architecture §8.1): pure functions over WorldState,
// evaluated at 1 Hz; the first transition is recorded. Milestone A's runtime
// predicate is `nether_ready` (milestones.md); the flags before it form the
// funnel reported per batch.
import progression from '../../config/progression.json' with { type: 'json' }
import type { WorldState } from '../observer/types.js'
import { COOKED_FOODS, toolTier } from '../version.js'

const A = progression.A
const B = progression.B

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

/**
 * A remembered Overworld lava pool with enough source blocks for a later lava-cast portal.
 * Pools the portal builder rejected (unusable geometry, exhausted) no longer count.
 */
export function lavaPoolKnown (s: WorldState): boolean {
  return s.memory.locations.some(l => l.kind === 'lava_pool' && l.dim === 'overworld' && Number(l.detail?.sources ?? 0) >= A.lavaPoolMinSources && l.detail?.unusable !== true)
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

// ── Milestone B: reliable Nether entry (milestones.md) ──────────────────────
// All from the bot's own memory: the portal it built (portal_ow, source 'built',
// lit), the dimension transitions the client saw (observer), the portal it
// arrived at in the Nether (portal_nether) and its excursions there.

type Loc = WorldState['memory']['locations'][number]
type Tr = WorldState['memory']['transitions'][number]
const near = (a: readonly number[], b: readonly number[], r: number) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) <= r

/** The lit Overworld portal this bot built (latest), if any. */
export function builtPortal (s: WorldState): Loc | null {
  const ps = s.memory.locations.filter(l => l.kind === 'portal_ow' && l.dim === 'overworld' && l.source === 'built' && l.detail?.lit === true)
  return ps.sort((a, b) => Number(b.detail?.builtAt ?? 0) - Number(a.detail?.builtAt ?? 0))[0] ?? null
}

/** Overworld → Nether portal transitions that left from the built portal (within B.portalNear blocks). */
export function builtEntries (s: WorldState): Tr[] {
  const p = builtPortal(s)
  if (!p) return []
  return s.memory.transitions.filter(t => t.from === 'overworld' && t.to === 'the_nether' && t.cause === 'portal' && near(t.fromPos, p.pos, B.portalNear))
}

/** In the Nether now, having arrived through the portal the bot built (the latest transition). */
export function inNetherViaBuilt (s: WorldState): boolean {
  if (s.dim !== 'the_nether') return false
  const last = s.memory.transitions[s.memory.transitions.length - 1]
  return !!last && builtEntries(s).includes(last)
}

export function portalNetherKnown (s: WorldState): boolean {
  return s.memory.locations.some(l => l.kind === 'portal_nether' && l.dim === 'the_nether')
}

/** The excursion of the current Nether visit (after the latest transition into the Nether) reached B.excursionMin. */
export function excursionDone (s: WorldState): boolean {
  const entry = [...s.memory.transitions].reverse().find(t => t.to === 'the_nether')
  if (!entry) return false
  return s.memory.excursions.some(e => e.t >= entry.t && e.dist >= B.excursionMin)
}

/**
 * return_ok, verified from the client's own dimension state: back in the Overworld through
 * a portal (not a death respawn), after an entry through the built portal, with an
 * excursion of ≥ B.excursionMin blocks away from the Nether portal in between.
 */
export function returnOk (s: WorldState): boolean {
  if (s.dim !== 'overworld') return false
  const entries = builtEntries(s)
  return s.memory.transitions.some(back => back.from === 'the_nether' && back.to === 'overworld' && back.cause === 'portal' &&
    entries.some(e => e.t < back.t && s.memory.excursions.some(x => x.t > e.t && x.t <= back.t && x.dist >= B.excursionMin)))
}

/** Milestone B: in_nether through a built portal, portal_nether remembered, and a demonstrated return (return_ok). */
export function milestoneB (s: WorldState): boolean {
  return returnOk(s) && portalNetherKnown(s)
}

/** Funnel flags after nether_ready. */
export const B_FLAGS: Record<string, (s: WorldState) => boolean> = {
  portal_built: s => builtPortal(s) !== null,
  in_nether: inNetherViaBuilt,
  portal_nether: portalNetherKnown,
  excursion: excursionDone,
  return_ok: returnOk,
}
