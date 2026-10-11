import progression from '../../config/progression.json' with { type: 'json' }
import type { CLedger, Location, WorldState } from '../observer/types.js'
import type { Objective } from '../schema/index.js'
import { GOLDEN_ARMOR, toolTier } from '../version.js'
import { bDone, builtPortal, cEntries, cookedCount, excursionDone, fortressKnown, ironArmorPieces, lavaPoolKnown, milestoneB, milestoneC, netherReady, pearlCount, pearlsDone, returnOk, rodsDone } from './milestones.js'
import { cookableRaw, EMERGENCY, foodItems, hasEmergencyFood } from '../skills/food.js'
import { countOf, planObtain } from '../skills/sources.js'

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
  /** Offered only while this holds (e.g. milestone B work waits for nether_ready); unmet otherwise but never chosen. */
  when? (s: WorldState): boolean
  /** Recovery never relocates for this objective (Nether work: a search walk there is the danger). */
  noRelocate?: boolean
  /**
   * Night work only: never offered by day or ahead of other work. The schedule runs it when
   * every other candidate is deferred at night, instead of sheltering (B round 3: the first
   * night of nearly every re-gate run sheltered ~480 s with only the food hunt left).
   */
  filler?: boolean
  /**
   * Strategy catalog for Recovery's L3 (architecture §5.1): the objective's own ordered
   * strategies, each optionally run by a different skill (milestone C: bartering, then
   * enderman hunting). Without one, Recovery's generic `default`/`wide` catalog applies.
   */
  strategies?: Strategy[]
  /**
   * Items another requirement restocks (item → requirement id). A MISSING_RESOURCE for one of
   * them hands the turn to that requirement instead of climbing the ladder (milestone C: the
   * barter runs out of gold, the gold requirement mines more).
   */
  resupply?: Record<string, string>
  /** Nether objectives of milestone C: a strategy exhaustion with nothing else to do retries in place, never retreats through the portal. */
  noRetreat?: boolean
  met (s: WorldState): boolean
  objective (s: WorldState): Omit<Objective, 'id' | 'milestone'>
}

export type Strategy = { id: string; params?: Record<string, unknown>; skill?: string }

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
export function unmetObjectives (list: RequirementDef[], s: WorldState, opts: { fillers?: boolean } = {}): Objective[] {
  const met = new Set(list.filter(r => r.met(s)).map(r => r.id))
  return list
    .filter(r => Boolean(r.filler) === Boolean(opts.fillers))
    .filter(r => !met.has(r.id) && (r.requires ?? []).every(id => met.has(id)) && (r.when?.(s) ?? true))
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
  // Night filler: cook the raw meat already carried (furnace work, no surface trip).
  { id: 'cook_raw', milestone: 'A', filler: true, bounded: true, persistent: true, desc: `no raw meat left to cook, or ≥ ${A.cookedFoodTarget} cooked food`, met: s => cookableRaw(s.inventory) === 0 || cookedCount(s.inventory) >= A.cookedFoodTarget, objective: s => ({ ...obtainObj('cooked_food', Math.min(A.cookedFoodTarget, cookedCount(s.inventory) + cookableRaw(s.inventory)), 3), strategy: 'cook_carried' }) },
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

/** Night fillers (RequirementDef.filler) that are unmet and offerable, in list order. */
export function fillerObjectives (list: RequirementDef[], s: WorldState, suspended: (id: string) => boolean = () => false): Objective[] {
  return unmetObjectives(list, s, { fillers: true }).filter(o => !suspended(o.id))
}

// ── Milestone B: build a portal, enter the Nether, return (milestones.md) ────
// After nether_ready the A list steps aside except survival basics: B needs the
// portal tools, not a full A kit again (a lava cast turns the empty bucket into a
// lava bucket for a while; a death may cost the armor). Everything is state-based,
// so a death, an interruption or an accidental portal trip simply re-plans.
const B = progression.B

/** Milestone A reached in this run (first-reached time recorded by the controller). */
export const aDone = (s: WorldState) => s.milestones.A != null

/**
 * A requirements still pursued after nether_ready: survival basics a death takes away. The
 * stone sword is one of them (B gate 20261002: r02 ×2 and r13 died bare-handed during B work
 * after an earlier death).
 */
const KEEP_AFTER_A = new Set(['emergency_food', 'wooden_pickaxe', 'stone_pickaxe', 'stone_sword'])

function afterA (r: RequirementDef): RequirementDef {
  return { ...r, met: s => (aDone(s) && !KEEP_AFTER_A.has(r.id)) || (s.dim !== 'overworld') || r.met(s) }
}

// Once B is recorded it stays done (milestone C goes back into the Nether, where milestoneB's
// return_ok no longer holds; B runs end the moment B is recorded, so their behaviour is unchanged).
const tripDone = (s: WorldState) => s.milestones.B != null || milestoneB(s)
const portalReady = (s: WorldState) => builtPortal(s) !== null
/** Portal casting kit needed only until the portal stands. */
const kitNeeded = (s: WorldState) => !tripDone(s) && !portalReady(s) && s.dim === 'overworld' && n(s, 'obsidian') < A.obsidian

/** Golden helmet objective (bounded: no gold nearby means the trip goes ahead without it). */
const goldArmorObj = () => ({ skill: 'obtain', params: { item: 'golden_helmet', count: 1, searchSteps: B.goldSearchSteps }, strategy: 'mine_gold', budgetMs: 10 * 60_000 })
const hasGoldArmor = (s: WorldState) => Object.keys(s.inventory).some(k => GOLDEN_ARMOR.has(k) && n(s, k) > 0)

export const B_REQUIREMENTS: RequirementDef[] = [
  ...A_REQUIREMENTS.map(afterA),
  // Night filler before nether_ready: the golden helmet is mining and furnace work, so a night
  // with only the food hunt left mines it instead of sheltering. B's order is unchanged: every
  // B entry still waits for nether_ready, and b_gold_armor below is then already met.
  { id: 'pre_gold_armor', milestone: 'B', filler: true, bounded: true, when: s => !aDone(s), requires: ['iron_pickaxe', 'iron_sword', 'shield'], desc: 'a golden armor piece (night work before nether_ready)', met: s => aDone(s) || s.dim !== 'overworld' || hasGoldArmor(s), objective: goldArmorObj },
  { id: 'b_flint_and_steel', milestone: 'B', when: aDone, desc: 'flint and steel (lights and relights the portal)', met: s => tripDone(s) || s.dim !== 'overworld' || n(s, 'flint_and_steel') >= 1, objective: () => obtainObj('flint_and_steel', 1, 8) },
  { id: 'b_water_bucket', milestone: 'B', when: aDone, desc: 'a water bucket for the lava cast', met: s => !kitNeeded(s) || n(s, 'water_bucket') >= 1, objective: () => obtainObj('water_bucket', 1, 8) },
  { id: 'b_bucket', milestone: 'B', when: aDone, desc: 'an empty (or lava) bucket for the lava cast', met: s => !kitNeeded(s) || n(s, 'bucket') + n(s, 'lava_bucket') >= 1, objective: () => obtainObj('bucket', 1, 6) },
  { id: 'b_lava_pool', milestone: 'B', when: aDone, desc: 'a usable lava pool remembered', met: s => !kitNeeded(s) || lavaPoolKnown(s), objective: () => ({ skill: 'findLavaPool', params: {}, strategy: 'excavate_to_lava_level', budgetMs: 10 * 60_000 }) },
  { id: 'b_food', milestone: 'B', when: aDone, persistent: true, bounded: true, desc: `≥ ${B.foodItems} food items`, met: s => tripDone(s) || s.dim !== 'overworld' || foodItems(s.inventory) >= B.foodItems, objective: s => ({ skill: 'obtain', params: { item: 'raw_meat', count: countOf(s.inventory, 'raw_meat') + B.foodItems - foodItems(s.inventory), searchSteps: 3 }, strategy: 'hunt_nearby', budgetMs: 4 * 60_000 }) },
  // One golden armor piece before the Nether (architecture §14.4): piglins then stay neutral. Bounded:
  // when no gold is found nearby it is set aside and the trip goes ahead without it.
  { id: 'b_gold_armor', milestone: 'B', when: aDone, bounded: true, desc: 'a golden armor piece (piglin neutrality)', met: s => tripDone(s) || s.dim !== 'overworld' || hasGoldArmor(s), objective: goldArmorObj },
  { id: 'nether_portal', milestone: 'B', when: aDone, noRelocate: true, requires: ['wooden_pickaxe', 'b_flint_and_steel', 'b_water_bucket', 'b_bucket', 'b_lava_pool'], desc: 'a lit portal the bot built', met: s => tripDone(s) || s.dim === 'the_nether' || portalReady(s), objective: () => ({ skill: 'buildNetherPortal', params: { strategy: 'auto' }, strategy: 'lava_cast', budgetMs: 15 * 60_000 }) },
  // A pickaxe first: the way back to a portal is often dug (dev1 r05: pickaxes broke on the approach,
  // the wooden pickaxe was deferred at night and the entry failed 14× for lack of one).
  { id: 'enter_nether', milestone: 'B', when: aDone, requires: ['nether_portal', 'wooden_pickaxe'], desc: 'in the Nether', met: s => tripDone(s) || s.dim === 'the_nether', objective: () => ({ skill: 'usePortal', params: { to: 'the_nether' }, strategy: 'built_portal', budgetMs: 6 * 60_000 }) },
  { id: 'nether_excursion', milestone: 'B', when: aDone, noRelocate: true, requires: ['enter_nether'], desc: `≥ ${B.excursionMin} blocks from the Nether portal this visit`, met: s => tripDone(s) || (s.dim === 'the_nether' && excursionDone(s)), objective: () => ({ skill: 'netherExcursion', params: { minDist: B.excursionMin }, strategy: 'safe_targets', budgetMs: 6 * 60_000 }) },
  { id: 'return_overworld', milestone: 'B', when: aDone, noRelocate: true, requires: ['nether_excursion'], desc: 'back in the Overworld through the portal (return_ok)', met: s => tripDone(s) || returnOk(s), objective: () => ({ skill: 'usePortal', params: { to: 'overworld' }, strategy: 'remembered_portal', budgetMs: 6 * 60_000 }) },
]

export const B_MILESTONES: Record<string, (s: WorldState) => boolean> = {
  M0: hasTable,
  A: netherReady,
  B: milestoneB,
}

// ── Milestone C: fortress, blaze rods, ender pearls, back in the Overworld (milestones.md) ──
// After B the bot prepares a small Overworld kit (food, crafting table, pickaxe durability for
// Nether mining, a shield), stages a replacement kit and a bed at its portal, re-enters, and works
// in the Nether by opportunity (architecture §10G): a fortress already seen → blaze rods first; a
// bastion seen → its gold and pearls first; neither → a structure search, and whichever turns up
// first is used. Gold comes from the bastion where there is one (nether gold ore otherwise), in
// small batches bartered at once, until 14 pearls. Everything is state-based: a death or an
// accidental portal trip re-plans from the inventory.
const C = progression.C
const LATER = progression.later

/** Remaining durability of every pickaxe carried (any tier: nether gold ore and netherrack take a wooden one). */
export function anyPickDurability (s: WorldState): number {
  return s.tools.filter(t => t.name.endsWith('_pickaxe')).reduce((a, t) => a + t.remaining, 0)
}

/** Fire resistance potions held (barter is the bot's only potion source). */
export const fireResHeld = (s: WorldState) => n(s, 'potion') + n(s, 'splash_potion')
/** Bartering still wanted: pearls short, or the rods ahead and no fire resistance yet. */
const needBarter = (s: WorldState) => !pearlsDone(s) || (!rodsDone(s) && fireResHeld(s) === 0)

/** Still short of rods or pearls (the C trip is not done). */
export const cNeed = (s: WorldState) => !rodsDone(s) || !pearlsDone(s)
const inNether = (s: WorldState) => s.dim === 'the_nether'
/** Overworld preparation applies: after B, before the C kit is complete, in the Overworld. */
const owPrep = (s: WorldState) => bDone(s) && s.dim === 'overworld' && cNeed(s) && !milestoneC(s)
const netherWork = (s: WorldState) => bDone(s) && inNether(s)
const hd = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)

/** Piglins seen in the Nether recently (observer spots): gold is worth mining. */
export function piglinsKnown (s: WorldState): boolean {
  return s.memory.locations.some(l => l.kind === 'piglins' && l.dim === 'the_nether' && s.t - l.lastSeen <= C.piglinMemoryS)
}

/** The first Nether entry of the C trip (after B), in bus seconds, or null. */
export function firstCEntry (s: WorldState): number | null {
  return cEntries(s)[0]?.t ?? null
}

/** A death after the C trip began. */
export function cDeath (s: WorldState): boolean {
  const t0 = firstCEntry(s)
  return t0 !== null && s.memory.deaths.some(d => d.t > t0)
}

/**
 * A death after B: the re-kit restores only the minimum safe Nether kit, whether the death came in
 * the Nether or in the Overworld before the first entry (ckit-r2d r01: an Overworld death during
 * the staging rebuilt the full C kit, 2 tables, pickaxes to 600 and a shield from new iron, for 3 200 s).
 */
export function rekit (s: WorldState): boolean {
  const b = s.milestones.B
  return b != null && s.memory.deaths.some(d => d.t > b)
}

/**
 * The bastion worth working: seen in this run, within C.bastionRadius of a remembered Nether
 * portal, not marked exhausted (no gold block or chest left in reach) and not set aside as
 * unreachable for now. Nearest to the bot first.
 */
export function usableBastion (s: WorldState): Location | null {
  const portals = s.memory.locations.filter(l => l.kind === 'portal_nether' && l.dim === 'the_nether')
  return s.memory.locations
    .filter(l => l.kind === 'bastion' && l.dim === 'the_nether' && l.detail?.exhausted !== true && Number(l.detail?.unreachableUntil ?? 0) <= s.t &&
      (!portals.length || portals.some(p => hd(p.pos, l.pos) <= C.bastionRadius)))
    .sort((a, b) => hd(a.pos, s.pos) - hd(b.pos, s.pos))[0] ?? null
}

const NO_LEDGER: CLedger = { given: 0, pearls: 0, refused: 0, tossed: 0, potions: 0, gold: { ore: 0, bastionBlock: 0, chest: 0 }, oreS: 0 }
export const ledger = (s: WorldState): CLedger => s.memory.cLedger ?? NO_LEDGER

/** Gold sources spent: no bastion left to work, and nether gold ore mined for C.oreBudgetS already. */
export const goldExhausted = (s: WorldState) => !usableBastion(s) && ledger(s).oreS >= C.oreBudgetS
/** Bartering clearly unproductive: C.barterCap ingots handed over and the pearls still short. */
export const barterUnproductive = (s: WorldState) => ledger(s).given >= C.barterCap && !pearlsDone(s)
/** Pearls from endermen instead (the existing alternate): gold spent or unproductive, none left in hand. */
export const pearlsByEndermen = (s: WorldState) => !pearlsDone(s) && (goldExhausted(s) || barterUnproductive(s)) && n(s, 'gold_ingot') === 0

/**
 * Opportunity-based C order (architecture §10G), deterministic from what the bot has seen:
 * `rods` while a fortress is known and the pearls are not done (a fortress seen during B is
 * used at once); `pearls` when a usable bastion is known or the rods are done; `search` when
 * neither structure is known (the region search stops at the first fortress or bastion).
 */
export type CRoute = 'rods' | 'pearls' | 'search' | 'return'
export function cRoute (s: WorldState): CRoute {
  if (rodsDone(s) && pearlsDone(s)) return 'return'
  if (rodsFirst(s)) return 'rods'
  if (!pearlsDone(s) && (rodsDone(s) || usableBastion(s))) return 'pearls'
  if (pearlsDone(s)) return 'rods'
  return 'search'
}

/** Fortress-first route: a fortress is known and neither rods nor pearls are done. */
export const rodsFirst = (s: WorldState) => !rodsDone(s) && !pearlsDone(s) && fortressKnown(s)
/**
 * Fortress-first, but a fire resistance potion first when a gold source is known and none is held:
 * without one the blaze fixture died at the spawner every time (0 kills, 2 of 2 isolated runs on
 * 2026-10-08, 4 of 5 during development). Bartering stops at the potion; every ingot also rolls pearls.
 */
export const fireResFirst = (s: WorldState) => rodsFirst(s) && fireResHeld(s) === 0 && (piglinsKnown(s) || !!usableBastion(s)) && !goldExhausted(s) && !barterUnproductive(s)

/**
 * Gold ingots wanted before the next barter round: the expected need for the pearls still
 * missing (1.16.1 table: 20/423 per ingot, 4–8 pearls), capped at one small batch so bartering
 * starts early and a lucky run stops early (c-dev1: ~50 ingots mined before the first trade).
 */
export function goldWant (s: WorldState): number {
  const missing = Math.max(0, LATER.ender_pearls - pearlCount(s))
  // Pearls done, fire resistance still wanted: one fire resistance roll is 20/423 per ingot.
  if (!missing) return needBarter(s) ? C.goldBatch : 0
  return Math.max(1, Math.min(C.goldBatch, Math.ceil((missing / C.pearlsPerIngot) * C.pearlMargin)))
}

/** Stone pickaxes needed on top of those carried to reach the C pickaxe durability. */
function cPickaxes (s: WorldState, target: number): number {
  return n(s, 'stone_pickaxe') + Math.max(1, Math.ceil((target - anyPickDurability(s)) / STONE_PICKAXE_USES))
}

// ── C death recovery (architecture §10G): a replacement kit and a bed at the Overworld portal ──
/** Golden armor pieces carried or worn. */
const goldPieces = (s: WorldState) => Object.keys(s.inventory).reduce((a, k) => a + (GOLDEN_ARMOR.has(k) ? n(s, k) : 0), 0)
/** The replacement kit is staged once, before the first C entry. */
export const stashPending = (s: WorldState) => !s.memory.stash && firstCEntry(s) === null
const stashItems = (s: WorldState) => Object.values(s.memory.stash?.items ?? {}).reduce((a, v) => a + v, 0)
/** Died since the kit was staged, with the kit still in its chest: take it before anything else. */
export function unstashWanted (s: WorldState): boolean {
  const st = s.memory.stash
  return !!st && s.dim === 'overworld' && bDone(s) && cNeed(s) && stashItems(s) > 0 && s.memory.deaths.some(d => d.t > st.t)
}
/** Planks a chest takes. */
export const CHEST_PLANKS = 8
/** A bed the bot set its respawn point at, beside the built portal (1.16.1: verified by fixture). */
export function bedSet (s: WorldState): boolean {
  const portal = builtPortal(s)
  return !!portal && s.memory.locations.some(l => l.kind === 'bed' && l.dim === 'overworld' && l.detail?.set === true && hd(l.pos, portal.pos) <= C.bedNear + 2)
}

// ── C staging (after ckit-r2d): required items, and optional ones only where they are cheap ──
// Measured over ckit-r2 … r2d (B → first C entry 347–1 362 s): the spare golden boots cost 103–706 s
// in every run, the second table and the kit wood were wood trips, and all three Overworld deaths of
// the staging came on those wood trips (each cost the whole iron kit). Required for a safe C entry:
// food, one crafting table, pickaxe durability, a shield, a golden armor piece. Optional (the bed, the
// replacement kit, a second table, a spare golden piece): offered only before the first entry, within
// C.stageWindowS of B, from what is carried (a craft, never a gather or a mine), wood from a natural
// tree within C.stageWoodR at most, and C.stageTries attempts per skill.
/** Every step of obtaining `count` × item is a craft from the carried inventory (no gather, mine, smelt or hunt). */
export function craftOnly (s: WorldState, item: string, count: number): boolean {
  if (countOf(s.inventory, item) >= count) return true
  try { return planObtain(item, count, s.inventory).steps.every(st => st.kind === 'craft') } catch { return false }
}
/** Optional staging is open: before the first C entry, no death since B, within the window after B. */
export function stageOpen (s: WorldState): boolean {
  const b = s.milestones.B
  return b != null && stashPending(s) && !rekit(s) && s.t - b <= C.stageWindowS
}
const stageTries = (s: WorldState, k: string) => s.memory.cStage?.tries[k] ?? 0
/** The bed is worth it only when the world spawn is far from the portal (or far above or below it). */
function bedUseful (s: WorldState): boolean {
  const portal = builtPortal(s)
  const spawn = s.memory.locations.find(l => l.kind === 'spawn' && l.dim === 'overworld')
  if (!portal) return false
  if (!spawn) return true
  return hd(portal.pos, spawn.pos) > C.bedSpawnFar || Math.abs(portal.pos[1] - spawn.pos[1]) > 10
}
/** A bed carried, or one craftable from carried wool and planks. */
const bedAtHand = (s: WorldState) => hasBed(s) || craftOnly(s, 'white_bed', 1)
/** Bed: wanted while staging is open, useful, and within its attempts. */
export const bedOffer = (s: WorldState) => stageOpen(s) && !bedSet(s) && bedUseful(s) && stageTries(s, 'bed') < C.stageTries
/** The replacement kit chest: a chest or its planks carried, within its attempts. */
export const stashOffer = (s: WorldState) => stageOpen(s) && stageTries(s, 'stash') < C.stageTries && (n(s, 'chest') > 0 || planksEq(s) >= CHEST_PLANKS)
/** Kit wood: short of a chest's planks, a known natural tree near (collect `local`: no search, no far scan). */
const stashWoodOffer = (s: WorldState) => stageOpen(s) && stageTries(s, 'stash') < C.stageTries && n(s, 'chest') === 0 && planksEq(s) < CHEST_PLANKS
const hasBed = (s: WorldState) => Object.keys(s.inventory).some(k => k.endsWith('_bed') && n(s, k) > 0)
const armed = (s: WorldState) => Object.keys(s.inventory).some(k => k.endsWith('_sword') && n(s, k) > 0)
const ironHeld = (s: WorldState) => n(s, 'iron_ingot') + n(s, 'iron_ore')

const NETHER_FLAGS = { noRelocate: true, noRetreat: true } as const

// The spawner camp only with fire resistance (a spawner keeps 3–6 blazes in sight; without the potion
// the fixture never got a kill there); without it the fortress floors first, where blazes come singly.
const rodsObjective = (s: WorldState): Omit<Objective, 'id' | 'milestone'> => ({ skill: 'collectBlazeRods', params: { count: LATER.blaze_rods, mode: fireResHeld(s) ? 'spawner' : 'roam' }, strategy: 'auto', budgetMs: 25 * 60_000 })
const rodsDef = (when: (s: WorldState) => boolean): RequirementDef => ({
  id: 'c_rods', milestone: 'C', when, requires: ['c_fortress'], ...NETHER_FLAGS, persistent: true, desc: `≥ ${LATER.blaze_rods} blaze rods`,
  met: s => !inNether(s) || rodsDone(s), objective: rodsObjective, strategies: [{ id: 'auto' }, { id: 'roam', params: { mode: 'roam' } }, { id: 'spawner', params: { mode: 'spawner' } }],
})

/** Gold in small batches, from the bastion where there is one, nether gold ore otherwise; set aside
 * once the sources are spent or bartering has clearly not paid (the enderman alternate takes over). */
const goldDef = (extra: (s: WorldState) => boolean): RequirementDef => ({
  id: 'c_gold', milestone: 'C', when: s => netherWork(s) && extra(s) && (piglinsKnown(s) || !!usableBastion(s)) && !goldExhausted(s) && !barterUnproductive(s), requires: ['c_gold_armor'], ...NETHER_FLAGS, persistent: true,
  desc: 'gold ingots to barter (≥ 1 held)', met: s => !inNether(s) || !needBarter(s) || n(s, 'gold_ingot') >= 1,
  objective: s => usableBastion(s)
    ? { skill: 'bastionGold', params: { count: n(s, 'gold_ingot') + goldWant(s) }, strategy: 'bastion', budgetMs: 15 * 60_000 }
    : { skill: 'obtain', params: { item: 'gold_ingot', count: goldWant(s) }, strategy: 'nether_gold', budgetMs: 15 * 60_000 },
})
/** Blaze fireballs are fire damage: a fire resistance potion makes them harmless (fixture: deaths without one, none with one). */
const fireResDef = (extra: (s: WorldState) => boolean): RequirementDef => ({
  id: 'c_fire_res', milestone: 'C', when: s => netherWork(s) && extra(s) && (piglinsKnown(s) || !!usableBastion(s)) && !rodsDone(s) && !goldExhausted(s), requires: ['c_gold_armor', 'c_fortress'], ...NETHER_FLAGS, bounded: true,
  desc: 'a fire resistance potion before the blazes', met: s => !inNether(s) || rodsDone(s) || fireResHeld(s) >= 1,
  objective: () => ({ skill: 'barterPearls', params: { count: LATER.ender_pearls, fireRes: 1, untilFireRes: true }, strategy: 'barter_fire_res', budgetMs: 10 * 60_000 }),
  resupply: { gold_ingot: 'c_gold' },
})

/** Take the staged kit after a death (before the A basics when it is close or the bot is armed). */
const C_UNSTASH: RequirementDef = {
  id: 'c_unstash', milestone: 'C', bounded: true, noRelocate: true,
  when: s => unstashWanted(s) && (armed(s) || hd(s.memory.stash!.pos, s.pos) <= 32),
  desc: 'the staged replacement kit taken after a death',
  met: s => !unstashWanted(s),
  objective: () => ({ skill: 'takeStash', params: {}, strategy: 'stash', budgetMs: 5 * 60_000 }),
}

export const C_REQUIREMENTS: RequirementDef[] = [
  C_UNSTASH,
  ...B_REQUIREMENTS,
  // Overworld kit for the Nether work (bounded where it is a search). After a death since B only the
  // minimum safe kit is restored (fewer food items, one table, one pickaxe's durability).
  { id: 'c_food', milestone: 'C', when: bDone, bounded: true, persistent: true, desc: `≥ ${C.foodItems} food items before the Nether (${C.minFoodAfterDeath} after a death since B)`, met: s => !owPrep(s) || foodItems(s.inventory) >= (rekit(s) ? C.minFoodAfterDeath : C.foodItems), objective: s => ({ skill: 'obtain', params: { item: 'raw_meat', count: countOf(s.inventory, 'raw_meat') + (rekit(s) ? C.minFoodAfterDeath : C.foodItems) - foodItems(s.inventory), searchSteps: 3 }, strategy: 'hunt_nearby', budgetMs: 4 * 60_000 }) },
  // One table is required (there is no wood in the Nether for another); a second one is optional (c_table2).
  { id: 'c_table', milestone: 'C', when: bDone, desc: 'a crafting table carried', met: s => !owPrep(s) || n(s, 'crafting_table') >= 1, objective: () => obtainObj('crafting_table', 1, 4) },
  // Built up to C.pickDurability, re-opened only below C.pickReopen: the walk to an underground portal
  // wears the pickaxes, and a 600 threshold re-opened the kit after every interrupted trip (ckit14 r02:
  // 40 min looping between the kit and the portal). After a death since B the kit's spares (or one new
  // stone pickaxe) are enough to go back in; when one is built it is built to pickReopen (ckit-r2b r02:
  // one 131-use pickaxe → 4 restock trips in 1 h).
  { id: 'c_pickaxes', milestone: 'C', when: bDone, requires: ['c_table'], desc: `pickaxe durability ≥ ${C.pickReopen} (built to ${C.pickDurability}; after a death since B ${C.minPickAfterDeath}, built to ${C.pickReopen})`, met: s => !owPrep(s) || anyPickDurability(s) >= (rekit(s) ? C.minPickAfterDeath : C.pickReopen), objective: s => obtainObj('stone_pickaxe', cPickaxes(s, rekit(s) ? C.pickReopen : C.pickDurability), 5) },
  // After a death since B the shield is made only from iron already carried (no iron trip for it).
  { id: 'c_shield', milestone: 'C', when: bDone, desc: 'a shield (blazes, ghasts, hoglins); after a death since B only from carried iron', met: s => !owPrep(s) || n(s, 'shield') >= 1 || (rekit(s) && ironHeld(s) === 0), objective: () => obtainObj('shield', 1, 6) },
  // Never into the Nether without golden armor (c-dev1 r06: piglins killed the bot 7 s after a re-entry without it).
  { id: 'c_ow_gold', milestone: 'C', when: bDone, bounded: true, persistent: true, desc: 'a golden armor piece before entering the Nether', met: s => !owPrep(s) || goldPieces(s) >= 1, objective: () => ({ skill: 'obtain', params: { item: 'golden_boots', count: 1, searchSteps: B.goldSearchSteps }, strategy: 'mine_gold', budgetMs: 10 * 60_000 }) },
  // Optional staging (see stageOpen): each one is met as soon as it is not offered, so nothing waits on it.
  // A second table only from carried wood (a craft preempted after placing its table leaves it behind).
  { id: 'c_table2', milestone: 'C', when: s => bDone(s) && stageOpen(s), bounded: true, desc: `a second crafting table, only from carried wood`, met: s => !owPrep(s) || n(s, 'crafting_table') >= C.tables || !stageOpen(s) || !craftOnly(s, 'crafting_table', C.tables), objective: () => obtainObj('crafting_table', C.tables, 2) },
  // A spare golden piece only from carried gold ingots: never a gold search (103–706 s in every ckit run;
  // the search happens only after a death, when there is no kit to lose any more).
  { id: 'c_stash_gold', milestone: 'C', when: s => bDone(s) && stageOpen(s), bounded: true, requires: ['c_ow_gold'], desc: 'a spare golden armor piece, only from carried gold', met: s => !owPrep(s) || !stageOpen(s) || goldPieces(s) >= 2 || !craftOnly(s, 'golden_boots', n(s, 'golden_boots') + 1), objective: s => obtainObj('golden_boots', n(s, 'golden_boots') + 1, 2) },
  // Kit wood: only logs within C.stageWoodR (no search, no far scan, no tree spots); else no kit.
  { id: 'c_stash_wood', milestone: 'C', when: s => bDone(s) && stashWoodOffer(s), bounded: true, requires: ['c_table'], desc: `${CHEST_PLANKS} planks for the kit chest, from trees within ${C.stageWoodR}`, met: s => !owPrep(s) || !stashWoodOffer(s), objective: s => ({ skill: 'collect', params: { block: 'log', count: inv(s, isLog) + Math.ceil((CHEST_PLANKS - planksEq(s)) / 4), maxDist: C.stageWoodR, searchSteps: 0, local: true }, strategy: 'local', budgetMs: 2 * 60_000 }) },
  // Respawn beside the portal (1.16.1, bed-spawn fixture: using a bed by day sets the respawn point).
  // Only a bed at hand (carried, or wool and planks carried); never a sheep hunt.
  { id: 'c_bed', milestone: 'C', when: s => bDone(s) && bedOffer(s) && bedAtHand(s), bounded: true, noRelocate: true, desc: 'respawn point set at a bed beside the portal', met: s => !owPrep(s) || bedSet(s) || !bedOffer(s) || !bedAtHand(s), objective: s => hasBed(s) ? { skill: 'setSpawnBed', params: {}, strategy: 'portal', budgetMs: 2 * 60_000 } : obtainObj('white_bed', 1, 1) },
  { id: 'c_stash', milestone: 'C', when: s => bDone(s) && stashOffer(s), bounded: true, noRelocate: true, desc: 'replacement kit staged beside the portal', met: s => !owPrep(s) || !stashOffer(s), objective: () => ({ skill: 'stashKit', params: {}, strategy: 'portal', budgetMs: 3 * 60_000 }) },
  // The table and pickaxes are hard prerequisites: in the Nether there is no wood for a table (ckit6 r01:
  // a table left behind by a preempted craft made the golden helmet plan ask for logs in the Nether).
  { id: 'c_enter', milestone: 'C', when: bDone, requires: ['wooden_pickaxe', 'c_table', 'c_pickaxes', 'c_ow_gold'], desc: 'in the Nether for the C trip', met: s => !bDone(s) || !cNeed(s) || milestoneC(s) || inNether(s), objective: () => ({ skill: 'usePortal', params: { to: 'the_nether' }, strategy: 'built_portal', budgetMs: 8 * 60_000 }) },
  // Nether work. Out of pickaxe (there is no wood in the Nether for another): back to the Overworld,
  // where the kit above restocks, then in again.
  { id: 'c_restock', milestone: 'C', when: netherWork, noRelocate: true, desc: `pickaxe durability ≥ ${C.restockDurability} in the Nether`, met: s => !inNether(s) || !cNeed(s) || anyPickDurability(s) >= C.restockDurability, objective: () => ({ skill: 'usePortal', params: { to: 'overworld' }, strategy: 'restock', budgetMs: 15 * 60_000 }) },
  { id: 'c_gold_armor', milestone: 'C', when: netherWork, ...NETHER_FLAGS, desc: 'a golden armor piece (piglins stay neutral)', met: s => !inNether(s) || pearlsDone(s) || hasGoldArmor(s), objective: () => ({ skill: 'obtain', params: { item: 'golden_helmet', count: 1 }, strategy: 'nether_gold', budgetMs: 10 * 60_000 }) },
  // Fortress known (seen during B or on the way): blaze rods first, after a fire resistance potion
  // when a gold source is known (gold in small batches, bartered until the potion arrives).
  goldDef(fireResFirst),
  fireResDef(fireResFirst),
  rodsDef(s => netherWork(s) && rodsFirst(s)),
  // Neither structure known: search the 1.16.1 structure regions; the first fortress or bastion seen sets the route.
  {
    // Persistent like c_fortress: a search failing on hazards suspends (gold and piglins go on) instead
    // of ending the run (ckit-r2b r03: terminated after 14 NAV_HAZARD failures with 59 min left).
    id: 'c_structure', milestone: 'C', when: s => netherWork(s) && cRoute(s) === 'search', ...NETHER_FLAGS, persistent: true, desc: 'a fortress or a bastion located',
    met: s => !inNether(s) || cRoute(s) !== 'search',
    objective: () => ({ skill: 'findFortress', params: { mode: 'regions', target: 'any' }, strategy: 'regions', budgetMs: 20 * 60_000 }),
    strategies: [{ id: 'regions', params: { mode: 'regions', target: 'any' } }, { id: 'axis', params: { mode: 'axis', target: 'any' } }],
  },
  // Gold in small batches, from the bastion where there is one, nether gold ore otherwise; set aside
  // once the sources are spent or bartering has clearly not paid (the enderman alternate takes over).
  goldDef(s => !fireResFirst(s)),
  {
    // Once piglins or a bastion have been seen, or once the rods are in: bartering with no piglin in
    // memory would only wander (soul sand valley, warped forest). Gold spent → endermen.
    id: 'c_pearls', milestone: 'C', when: s => netherWork(s) && (piglinsKnown(s) || !!usableBastion(s) || rodsDone(s) || pearlsByEndermen(s)), requires: ['c_gold_armor'], ...NETHER_FLAGS, persistent: true,
    desc: `≥ ${LATER.ender_pearls} ender pearls`, met: s => !inNether(s) || pearlsDone(s),
    objective: s => pearlsByEndermen(s)
      ? { skill: 'huntEndermen', params: { count: LATER.ender_pearls }, strategy: 'endermen', budgetMs: 25 * 60_000 }
      : { skill: 'barterPearls', params: { count: LATER.ender_pearls }, strategy: 'barter', budgetMs: 25 * 60_000 },
    strategies: [{ id: 'barter' }, { id: 'endermen', skill: 'huntEndermen' }],
    resupply: { gold_ingot: 'c_gold' },
  },
  { id: 'c_fortress', milestone: 'C', when: netherWork, ...NETHER_FLAGS, persistent: true, desc: 'a fortress located', met: s => !inNether(s) || rodsDone(s) || fortressKnown(s), objective: () => ({ skill: 'findFortress', params: { mode: 'regions' }, strategy: 'regions', budgetMs: 25 * 60_000 }), strategies: [{ id: 'regions', params: { mode: 'regions' } }, { id: 'axis', params: { mode: 'axis' } }] },
  // Blaze fireballs are fire damage: a fire resistance potion makes them harmless (fixture: deaths
  // without one, none with one). After the pearls (bastion route), barter for one before the rods.
  fireResDef(s => !fireResFirst(s)),
  rodsDef(s => netherWork(s) && !rodsFirst(s)),
  { id: 'c_return', milestone: 'C', when: bDone, requires: ['c_pearls', 'c_rods'], noRelocate: true, desc: 'back in the Overworld through the portal', met: s => s.dim === 'overworld', objective: () => ({ skill: 'usePortal', params: { to: 'overworld' }, strategy: 'remembered_portal', budgetMs: 15 * 60_000 }) },
]

export const C_MILESTONES: Record<string, (s: WorldState) => boolean> = {
  M0: hasTable,
  A: netherReady,
  B: milestoneB,
  C: milestoneC,
}
