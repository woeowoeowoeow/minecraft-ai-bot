import progression from '../../config/progression.json' with { type: 'json' }
import type { WorldState } from '../observer/types.js'
import type { Objective } from '../schema/index.js'
import { toolTier } from '../version.js'
import { cookedCount, ironArmorPieces, lavaPoolKnown, netherReady } from './milestones.js'
import { EMERGENCY, foodItems, hasEmergencyFood } from '../skills/food.js'
import { countOf } from '../skills/sources.js'

/**
 * A requirement in the ordered progression list (architecture §5.1). The list
 * is data: each entry says when it is met and which goal-shaped skill makes it so.
 */
export type RequirementDef = {
  id: string
  milestone: string
  /** Requirement ids that must be met before this one can be pursued. */
  requires?: string[]
  /** Keep the objective's own search bounds: Recovery's wider strategies do not apply. */
  bounded?: boolean
  /** Failing this objective never terminates the run (it is suspended or relocated): food searches. */
  persistent?: boolean
  /** The predicate `met` checks, in words (logged with OBJECTIVE_NOT_SATISFIED). */
  desc?: string
  met (s: WorldState): boolean
  objective (s: WorldState): Omit<Objective, 'id' | 'milestone'>
}

const inv = (s: WorldState, pred: (n: string) => boolean) =>
  Object.entries(s.inventory).reduce((n, [k, v]) => (pred(k) ? n + v : n), 0)
const isLog = (n: string) => n.endsWith('_log')
const isPlanks = (n: string) => n.endsWith('_planks')
const hasTable = (s: WorldState) => (s.inventory.crafting_table ?? 0) >= 1

/** Planks made from the most plentiful log kind in inventory. */
export function planksFor (s: WorldState): string {
  const logs = Object.entries(s.inventory).filter(([k]) => isLog(k)).sort((a, b) => b[1] - a[1])
  const log = logs[0]?.[0] ?? 'oak_log'
  return log.replace(/^stripped_/, '').replace(/_log$/, '_planks')
}

const M0 = progression.M0

export const M0_REQUIREMENTS: RequirementDef[] = [
  {
    id: 'collect_logs',
    milestone: 'M0',
    met: s => hasTable(s) || inv(s, isPlanks) >= M0.planks || inv(s, isLog) >= M0.logs,
    objective: () => ({ skill: 'collect', params: { block: 'log', count: M0.logs }, strategy: 'nearest_visible', budgetMs: 5 * 60_000 }),
  },
  {
    id: 'craft_planks',
    milestone: 'M0',
    requires: ['collect_logs'],
    met: s => hasTable(s) || inv(s, isPlanks) >= M0.planks,
    objective: s => ({ skill: 'craft', params: { item: planksFor(s), count: M0.planks }, strategy: 'inventory_2x2', budgetMs: 60_000 }),
  },
  {
    id: 'craft_crafting_table',
    milestone: 'M0',
    requires: ['craft_planks'],
    met: hasTable,
    objective: () => ({ skill: 'craft', params: { item: 'crafting_table', count: 1 }, strategy: 'inventory_2x2', budgetMs: 60_000 }),
  },
]

/** Milestone predicates over WorldState (architecture §8.1). M0 only for now. */
export const MILESTONES: Record<string, (s: WorldState) => boolean> = {
  M0: hasTable,
}

/**
 * Deterministic policy: unmet requirements whose prerequisites are met, in list
 * order. The first entry is the default objective; the reasoner may only pick
 * among these.
 */
export function unmetObjectives (list: RequirementDef[], s: WorldState): Objective[] {
  const met = new Set(list.filter(r => r.met(s)).map(r => r.id))
  return list
    .filter(r => !met.has(r.id) && (r.requires ?? []).every(id => met.has(id)))
    .map(r => ({ id: r.id, milestone: r.milestone, ...r.objective(s) }))
}

// ── Milestone A: ProgressionPolicy through nether_ready (architecture §5.1) ──
// The list is data: each entry names the state it produces and asks `obtain`
// for the item; `obtain` works out how (sources.ts). No item recursion here.
const A = progression.A

const n = (s: WorldState, item: string) => s.inventory[item] ?? 0
const hasTier = (s: WorldState, tool: string, tier: number) => Object.keys(s.inventory).some(k => n(s, k) > 0 && k.endsWith(`_${tool}`) && (toolTier(k) ?? -1) >= tier)

/** Iron ingots still needed for every unmet iron item of nether_ready (state-based; shrinks as items are made). */
export function ironNeed (s: WorldState): number {
  let need = 0
  if (!n(s, 'iron_pickaxe')) need += 3
  if (!n(s, 'iron_sword')) need += 2
  if (!n(s, 'shield')) need += 1
  if (!n(s, 'flint_and_steel')) need += 1
  // One empty bucket, plus one for water unless the obsidian route is already complete.
  const buckets = n(s, 'bucket') + n(s, 'water_bucket') + n(s, 'lava_bucket')
  const wanted = 1 + (n(s, 'obsidian') >= A.obsidian ? 0 : 1)
  need += 3 * Math.max(0, wanted - buckets)
  let missing = Math.max(0, A.ironArmorPieces - ironArmorPieces(s))
  for (const piece of A.ironArmor) {
    if (missing <= 0) break
    if (n(s, piece)) continue
    need += ARMOR_IRON[piece] ?? 0
    missing--
  }
  return need
}

const ARMOR_IRON: Record<string, number> = { iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4 }

/** Remaining durability of pickaxes that can mine iron ore (stone and better). */
export function pickDurability (s: WorldState): number {
  return s.tools.filter(t => t.name.endsWith('_pickaxe') && (toolTier(t.name) ?? 0) >= 1).reduce((a, t) => a + t.remaining, 0)
}

const obtainObj = (item: string, count: number, budgetMin: number, strategy = 'default') =>
  ({ skill: 'obtain', params: { item, count }, strategy, budgetMs: budgetMin * 60_000 })

const planksEq = (s: WorldState) => inv(s, isPlanks) + 4 * inv(s, isLog)

/**
 * Wood carried down for the crafting that follows iron (shield 6 planks, a table
 * if none is carried, a margin for sticks and fuel), so no surface trip is needed
 * mid-way. Gate 20260929: 6 deaths on night-time wood trips for the shield.
 */
export function woodNeed (s: WorldState): number {
  if (n(s, 'shield')) return 0 // the shield is the last wood consumer; sticks are kit_sticks
  return (n(s, 'shield') ? 0 : 6) + (hasTable(s) ? 0 : 4) + A.kitWoodMargin
}

/** Stone-tier pickaxes needed on top of those carried to reach the kit durability. */
function kitPickaxes (s: WorldState): number {
  return n(s, 'stone_pickaxe') + Math.max(1, Math.ceil((A.kitPickaxeDurability + KIT_WEAR_MARGIN - pickDurability(s)) / STONE_PICKAXE_USES))
}
const STONE_PICKAXE_USES = 131
/** Mining the cobblestone for a new pickaxe wears the old one (dev batch 7 r01: 248 < 250 after success). */
const KIT_WEAR_MARGIN = 16

const armorPiece = (piece: string): RequirementDef => ({
  id: piece,
  milestone: 'A',
  requires: ['iron_ingots'],
  desc: `${piece} held, or ≥ ${A.ironArmorPieces} iron armor pieces`,
  met: s => n(s, piece) >= 1 || ironArmorPieces(s) >= A.ironArmorPieces,
  objective: () => obtainObj(piece, 1, 3),
})

/**
 * Milestone A order (architecture §5.1, revised after gate 20260929): a small food
 * buffer and stone tools, then the wood kit and the iron trip underground, then
 * sword, shield and armor, and only then the long surface work (the cooked-food
 * stock, water, flint) with defense in hand. Every objective's success satisfies
 * its requirement (the controller checks: OBJECTIVE_NOT_SATISFIED).
 */
export const A_REQUIREMENTS: RequirementDef[] = [
  // Survival first: badly hurt with nothing to eat means no natural regeneration (it needs
  // food ≥ 18), so a little meat comes before anything else (dev batch 4: 7 min at 0.7 HP).
  { id: 'emergency_food', milestone: 'A', bounded: true, persistent: true, desc: `health > ${EMERGENCY.health} or emergency food held`, met: s => s.vitals.health > EMERGENCY.health || hasEmergencyFood(s.inventory), objective: () => ({ skill: 'obtain', params: { item: 'raw_meat', count: 2, searchSteps: 3 }, strategy: 'hunt_nearby', budgetMs: 4 * 60_000 }) },
  { id: 'wooden_pickaxe', milestone: 'A', desc: 'a pickaxe', met: s => hasTier(s, 'pickaxe', 0), objective: () => obtainObj('wooden_pickaxe', 1, 5) },
  { id: 'stone_pickaxe', milestone: 'A', requires: ['wooden_pickaxe'], desc: 'a stone-tier pickaxe', met: s => hasTier(s, 'pickaxe', 1), objective: () => obtainObj('stone_pickaxe', 1, 5) },
  { id: 'stone_sword', milestone: 'A', requires: ['stone_pickaxe'], desc: 'a stone-tier sword', met: s => hasTier(s, 'sword', 1), objective: () => obtainObj('stone_sword', 1, 3) },
  // A few items to eat on the iron trip; only nearby animals (short search), never a long hunt.
  { id: 'food_buffer', milestone: 'A', requires: ['stone_sword'], bounded: true, persistent: true, desc: `≥ ${A.foodBuffer} food items (cooked, raw or other), or defense complete (the full stock takes over)`, met: s => bufferFood(s) >= A.foodBuffer || defenseDone(s), objective: s => ({ skill: 'obtain', params: { item: 'raw_meat', count: countOf(s.inventory, 'raw_meat') + A.foodBuffer - bufferFood(s), searchSteps: A.foodBufferSearchSteps }, strategy: 'hunt_nearby', budgetMs: 3 * 60_000 }) },
  { id: 'kit_wood', milestone: 'A', requires: ['stone_pickaxe'], desc: 'planks + 4 × logs ≥ woodNeed', met: s => planksEq(s) >= woodNeed(s), objective: s => obtainObj('log', inv(s, isLog) + Math.ceil((woodNeed(s) - planksEq(s)) / 4), 4) },
  // Mining kit: enough pickaxe durability for the iron trip, sticks to craft a replacement underground.
  { id: 'kit_pickaxe', milestone: 'A', requires: ['stone_pickaxe'], desc: `stone-tier pickaxe durability ≥ ${A.kitPickaxeDurability} (or iron done)`, met: s => ironNeed(s) === 0 || hasTier(s, 'pickaxe', 2) || pickDurability(s) >= A.kitPickaxeDurability, objective: s => obtainObj('stone_pickaxe', kitPickaxes(s), 4) },
  { id: 'kit_sticks', milestone: 'A', requires: ['stone_pickaxe'], desc: `≥ ${A.kitSticks} sticks (or iron done)`, met: s => ironNeed(s) === 0 || n(s, 'stick') >= A.kitSticks, objective: () => obtainObj('stick', A.kitSticks, 3) },
  { id: 'iron_ingots', milestone: 'A', requires: ['kit_pickaxe', 'kit_sticks'], desc: 'iron ingots ≥ ironNeed', met: s => n(s, 'iron_ingot') >= ironNeed(s), objective: s => obtainObj('iron_ingot', ironNeed(s), 25) },
  { id: 'iron_pickaxe', milestone: 'A', requires: ['iron_ingots'], desc: 'an iron pickaxe', met: s => n(s, 'iron_pickaxe') >= 1, objective: () => obtainObj('iron_pickaxe', 1, 3) },
  { id: 'iron_sword', milestone: 'A', requires: ['iron_ingots'], desc: 'an iron sword', met: s => n(s, 'iron_sword') >= 1, objective: () => obtainObj('iron_sword', 1, 3) },
  { id: 'shield', milestone: 'A', requires: ['iron_ingots'], desc: 'a shield', met: s => n(s, 'shield') >= 1, objective: () => obtainObj('shield', 1, 4) },
  ...A.ironArmor.map(armorPiece),
  { id: 'bucket', milestone: 'A', requires: ['iron_ingots'], desc: 'an empty bucket', met: s => n(s, 'bucket') >= 1, objective: () => obtainObj('bucket', 1, 3) },
  // The cooked-food stock is long surface work: after sword, shield and armor (defense first).
  { id: 'food', milestone: 'A', requires: ['iron_sword', 'shield', ...A.ironArmor], persistent: true, desc: `≥ ${A.cookedFood} cooked food`, met: s => cookedCount(s.inventory) >= A.cookedFood, objective: s => obtainObj('cooked_food', Math.max(A.cookedFoodTarget, cookedCount(s.inventory) + 1), 12) },
  { id: 'water_bucket', milestone: 'A', requires: ['iron_ingots'], desc: `a water bucket (or ≥ ${A.obsidian} obsidian)`, met: s => n(s, 'water_bucket') >= 1 || n(s, 'obsidian') >= A.obsidian, objective: () => obtainObj('water_bucket', 1, 8) },
  { id: 'flint_and_steel', milestone: 'A', requires: ['iron_ingots'], desc: 'flint and steel', met: s => n(s, 'flint_and_steel') >= 1, objective: () => obtainObj('flint_and_steel', 1, 8) },
  { id: 'lava_pool', milestone: 'A', requires: ['stone_pickaxe'], desc: `a known lava pool (≥ ${A.lavaPoolMinSources} sources) or ≥ ${A.obsidian} obsidian`, met: s => lavaPoolKnown(s) || n(s, 'obsidian') >= A.obsidian, objective: () => ({ skill: 'findLavaPool', params: {}, strategy: 'excavate_to_lava_level', budgetMs: 10 * 60_000 }) },
]

/**
 * Sword, shield and armor held: the cooked-food stock is offered from here on, so the early
 * buffer steps aside (dev batch 10 r01: eating the buffer re-opened it ahead of the stock,
 * and the two hunts alternated for a whole day).
 */
function defenseDone (s: WorldState): boolean {
  return n(s, 'iron_sword') >= 1 && n(s, 'shield') >= 1 && A.ironArmor.every(p => n(s, p) >= 1 || ironArmorPieces(s) >= A.ironArmorPieces)
}

/** Food for the early buffer: anything eaten when hungry, plus raw chicken (it is cooked later). */
function bufferFood (s: WorldState): number {
  return foodItems(s.inventory) + n(s, 'chicken')
}

export const A_MILESTONES: Record<string, (s: WorldState) => boolean> = {
  M0: hasTable,
  A: netherReady,
}

/**
 * Next objective (architecture §5.1): the first unmet requirement whose
 * prerequisites are met and which Recovery has not suspended. Deterministic.
 */
export function nextObjective (list: RequirementDef[], s: WorldState, suspended: (id: string) => boolean = () => false): Objective | null {
  return unmetObjectives(list, s).find(o => !suspended(o.id)) ?? null
}

/** Every offerable objective in list order (the controller's day/night schedule picks among them). */
export function candidateObjectives (list: RequirementDef[], s: WorldState, suspended: (id: string) => boolean = () => false): Objective[] {
  return unmetObjectives(list, s).filter(o => !suspended(o.id))
}
