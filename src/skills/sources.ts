// Acquisition table and resolver for `obtain` (architecture §6.1): maps an item
// to how it is acquired (craft, smelt, mine a block, hunt, fill a bucket) and
// resolves a request into an ordered list of goal-shaped steps. Pure: the
// inventory and a few world hints go in, steps come out. Item recursion lives
// here, never in the planner. Recursion is bounded (MAX_DEPTH) and cycle-checked.
import mcData from 'minecraft-data'
import { COOKED_FOODS, FOOD_ANIMALS, fuelTicks, MC_VERSION, SMELT_TICKS, SMELTING, toolTier } from '../version.js'

const data = mcData(MC_VERSION)

export type Inv = Record<string, number>

// ── item groups (virtual items that stand for several real ones) ───────────
const RAW_MEATS = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'])
export const GROUPS: Record<string, (n: string) => boolean> = {
  log: n => n.endsWith('_log') && !/^(crimson|warped)_/.test(n),
  planks: n => n.endsWith('_planks'),
  raw_meat: n => RAW_MEATS.has(n),
  cooked_food: n => COOKED_FOODS.has(n),
  coal_any: n => n === 'coal' || n === 'charcoal',
}

export function isGroup (item: string): boolean { return item in GROUPS }

export function countOf (inv: Inv, item: string): number {
  const g = GROUPS[item]
  if (!g) return inv[item] ?? 0
  let n = 0
  for (const [k, v] of Object.entries(inv)) if (g(k)) n += v
  return n
}

function members (inv: Inv, item: string): string[] {
  const g = GROUPS[item]
  if (!g) return [item]
  return Object.keys(inv).filter(k => g(k) && (inv[k] ?? 0) > 0).sort((a, b) => (inv[b] ?? 0) - (inv[a] ?? 0) || a.localeCompare(b))
}

function add (inv: Inv, item: string, n: number): void {
  // Adding to a group adds to a representative member (planks: the kind made from the most plentiful log).
  const real = GROUPS[item] ? representative(inv, item) : item
  inv[real] = (inv[real] ?? 0) + n
}

function take (inv: Inv, item: string, n: number): void {
  let left = n
  for (const k of members(inv, item)) {
    const t = Math.min(left, inv[k] ?? 0)
    inv[k] = (inv[k] ?? 0) - t
    if (inv[k] === 0) delete inv[k]
    left -= t
    if (left <= 0) return
  }
}

function representative (inv: Inv, group: string): string {
  if (group === 'planks') {
    const log = members(inv, 'log')[0] ?? 'oak_log'
    return log.replace(/^stripped_/, '').replace(/_log$/, '_planks')
  }
  return members(inv, group)[0] ?? ({ log: 'oak_log', raw_meat: 'beef', cooked_food: 'cooked_beef', coal_any: 'coal' } as Record<string, string>)[group] ?? group
}

// ── sources ────────────────────────────────────────────────────────────────
export type ToolNeed = { tool: 'pickaxe' | 'axe' | 'shovel'; minTier: number }
export type GatherSource = {
  kind: 'gather'
  /** Block names (or 'log') whose drop is the item. */
  blocks: string[]
  /** 'collect' for blocks reachable on the surface, 'mine' for ores and stone (controlled excavation). */
  skill: 'collect' | 'mine'
  tool?: ToolNeed
  /** The drop is a chance (flint from gravel): re-place and re-dig the block item. */
  chance?: boolean
  /** A chance drop is knapped from this carried block: one is obtained first (its own source). */
  knapFrom?: string
}
export type Source =
  | GatherSource
  | { kind: 'craft' }
  | { kind: 'smelt'; input: string }
  | { kind: 'hunt'; mobs: string[] }
  | { kind: 'fill'; fluid: 'water' }

/** Explicit sources; anything else is smelted (SMELTING) or crafted (minecraft-data recipes). */
export const SOURCES: Record<string, Source> = {
  log: { kind: 'gather', blocks: ['log'], skill: 'collect' },
  cobblestone: { kind: 'gather', blocks: ['stone', 'cobblestone'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 0 } },
  coal: { kind: 'gather', blocks: ['coal_ore'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 0 } },
  iron_ore: { kind: 'gather', blocks: ['iron_ore'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 1 } },
  // 1.16.1: gold ore needs an iron pickaxe and drops itself (architecture §14.1).
  gold_ore: { kind: 'gather', blocks: ['gold_ore'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 2 } },
  diamond: { kind: 'gather', blocks: ['diamond_ore'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 2 } },
  obsidian: { kind: 'gather', blocks: ['obsidian'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 3 } },
  // Flint is knapped from one carried gravel block (place, dig, repeat: 10 % per dig), and that
  // block comes from controlled mining, which never targets gravel whose digging releases water
  // and reaches buried gravel by excavation. Re-gate 20261003: lake-bed gravel cost 518 s/run,
  // 18 stalls and 21 unreachable targets, and one run (r05) terminated.
  flint: { kind: 'gather', blocks: ['gravel'], skill: 'collect', chance: true, knapFrom: 'gravel' },
  gravel: { kind: 'gather', blocks: ['gravel'], skill: 'mine' },
  sand: { kind: 'gather', blocks: ['sand'], skill: 'collect' },
  dirt: { kind: 'gather', blocks: ['dirt', 'grass_block'], skill: 'collect' },
  raw_meat: { kind: 'hunt', mobs: Object.keys(FOOD_ANIMALS) },
  // A bed for the C respawn point: white wool from white, unsheared sheep (hunt filters by colour).
  white_wool: { kind: 'hunt', mobs: ['sheep'] },
  water_bucket: { kind: 'fill', fluid: 'water' },
  cooked_food: { kind: 'smelt', input: 'raw_meat' },
  coal_any: { kind: 'gather', blocks: ['coal_ore'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 0 } },
}

/**
 * Nether sources (milestone C): gold comes as nuggets from nether gold ore (any pickaxe,
 * 2–6 per block, 1.16.1 loot table), and ingots are crafted from 9 nuggets. In the Overworld
 * gold ingots stay smelted from gold ore (the B golden helmet).
 */
export const NETHER_SOURCES: Record<string, Source> = {
  gold_nugget: { kind: 'gather', blocks: ['nether_gold_ore'], skill: 'mine', tool: { tool: 'pickaxe', minTier: 0 } },
  gold_ingot: { kind: 'craft' },
}

const SMELT_INPUT: Record<string, string> = Object.fromEntries(Object.entries(SMELTING).map(([i, o]) => [o, i]))

/** No source in the Nether: Overworld wood (the bot would only wander; ckit9/10: falls and lava). */
const NETHER_NONE = new Set(['log'])

export function sourceFor (item: string, nether = false): Source | null {
  if (nether && NETHER_NONE.has(item)) return null
  if (nether && NETHER_SOURCES[item]) return NETHER_SOURCES[item]!
  if (SOURCES[item]) return SOURCES[item]!
  if (item === 'planks' || GROUPS.planks!(item)) return { kind: 'craft' }
  if (SMELT_INPUT[item]) return { kind: 'smelt', input: SMELT_INPUT[item]! }
  const it = data.itemsByName[item]
  if (it && data.recipes[it.id]?.length) return { kind: 'craft' }
  return null
}

// ── recipes (minecraft-data, variants normalised to groups) ────────────────
export type Recipe = { result: number; ingredients: Record<string, number>; table: boolean }

function normalise (name: string): string {
  if (GROUPS.planks!(name)) return 'planks'
  if (GROUPS.log!(name) || /^stripped_.*_log$/.test(name)) return 'log'
  if (name === 'blackstone') return 'cobblestone'
  if (name === 'charcoal') return 'coal_any'
  if (name === 'coal') return 'coal_any'
  return name
}

/**
 * Recipes chosen explicitly where minecraft-data lists several: a gold ingot from nine nuggets
 * (its first recipe is the gold block's, which the bot never has).
 */
const RECIPE_OVERRIDES: Record<string, Recipe> = {
  gold_ingot: { result: 1, ingredients: { gold_nugget: 9 }, table: true },
}

export function recipeFor (item: string): Recipe | null {
  if (item === 'planks' || GROUPS.planks!(item)) return { result: 4, ingredients: { log: 1 }, table: false }
  if (RECIPE_OVERRIDES[item]) return RECIPE_OVERRIDES[item]!
  const it = data.itemsByName[item]
  if (!it) return null
  const rs = data.recipes[it.id] ?? []
  const r = rs[0] as { inShape?: (number | null)[][]; ingredients?: number[]; result: { count: number } } | undefined
  if (!r) return null
  const ingredients: Record<string, number> = {}
  const cells = r.inShape ? r.inShape.flat() : (r.ingredients ?? [])
  for (const id of cells) {
    if (id === null || id === undefined) continue
    const n = normalise(data.items[id]?.name ?? String(id))
    ingredients[n] = (ingredients[n] ?? 0) + 1
  }
  const table = r.inShape ? r.inShape.length > 2 || r.inShape.some(row => row.length > 2) : cells.length > 4
  return { result: r.result.count, ingredients, table }
}

// ── steps ──────────────────────────────────────────────────────────────────
export type Step =
  | { kind: 'gather'; item: string; count: number; blocks: string[]; skill: 'collect' | 'mine'; chance?: boolean }
  | { kind: 'craft'; item: string; count: number }
  | { kind: 'smelt'; item: string; count: number; input: string }
  | { kind: 'hunt'; item: string; count: number; mobs: string[] }
  | { kind: 'fill'; item: string; count: number }

/** What the resolver may assume about the world near the bot (never coordinates). */
export type Hints = {
  /** A crafting table or furnace block is already within reach of use. */
  tableNear?: boolean
  furnaceNear?: boolean
  /** Coal ore is in the interest index (so coal is the cheap fuel). */
  coalOreKnown?: boolean
  /** In the Nether: Nether sources first (gold from nether gold ore). */
  nether?: boolean
}

export class ResolveError extends Error {
  constructor (readonly item: string, reason: string) { super(`cannot resolve ${item}: ${reason}`); this.name = 'ResolveError' }
}

export const MAX_DEPTH = 10

/** Cheapest pickaxe that satisfies a tier. */
const PICK_FOR_TIER = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']

export function hasTool (inv: Inv, need: ToolNeed): boolean {
  return Object.keys(inv).some(k => (inv[k] ?? 0) > 0 && k.endsWith(`_${need.tool}`) && (toolTier(k) ?? -1) >= need.minTier)
}

const NOT_FUEL = /_(pickaxe|axe|shovel|sword|hoe)$|^crafting_table$/

/** Furnace items a fuel stock can smelt (tools and crafting tables are never burned). */
export function smeltCapacity (inv: Inv): number {
  let ticks = 0
  for (const [k, v] of Object.entries(inv)) if (!NOT_FUEL.test(k)) ticks += fuelTicks(k) * v
  return Math.floor(ticks / SMELT_TICKS)
}

/**
 * Resolve "have ≥ count of item" into ordered steps, simulating the inventory.
 * Ingredients are reserved while siblings resolve, so shared inputs (planks for
 * sticks and for the tool head) are never double-counted. Every step carries an
 * absolute target (goal-shaped), so re-running a finished step is a no-op.
 */
export function planObtain (item: string, count: number, inv0: Inv, hints: Hints = {}): { steps: Step[]; inv: Inv } {
  const inv: Inv = { ...inv0 }
  const reserved: Inv = {}
  const steps: Step[] = []
  const needs = new Map<Step, number>()
  const avail = (it: string) => countOf(inv, it) - (reserved[it] ?? 0)
  const reserve = (it: string, n: number) => { reserved[it] = (reserved[it] ?? 0) + n }
  const release = (it: string, n: number) => { reserved[it] = (reserved[it] ?? 0) - n; if (reserved[it]! <= 0) delete reserved[it] }

  const ensureTool = (need: ToolNeed, depth: number, stack: string[]) => {
    if (hasTool(inv, need)) return
    if (need.tool !== 'pickaxe') return // only pickaxes are required to harvest (axes/shovels are optional speed)
    ensure(PICK_FOR_TIER[Math.min(need.minTier, PICK_FOR_TIER.length - 1)]!, 1, depth + 1, stack)
  }

  /** Fuel left after everything reserved for pending steps (ingredients and earlier smelts). */
  const fuelAvail = () => {
    const free: Inv = { ...inv }
    for (const [k, n] of Object.entries(reserved)) if (k !== '__fuel') take(free, k, n)
    return smeltCapacity(free) - (reserved.__fuel ?? 0)
  }
  const ensureFuel = (items: number, depth: number, stack: string[]) => {
    if (fuelAvail() >= items) { reserve('__fuel', items); return }
    const coalNeed = Math.ceil(items / 8)
    // Wood fuel as planks: a log burns 1.5 items, its four planks burn 6.
    if (hints.coalOreKnown) ensure('coal_any', coalNeed, depth + 1, stack)
    else ensure('planks', Math.ceil(items / 1.5), depth + 1, stack)
    reserve('__fuel', items)
  }

  function ensure (it: string, n: number, depth: number, stack: string[]): void {
    if (avail(it) >= n) return
    if (depth > MAX_DEPTH) throw new ResolveError(it, `depth > ${MAX_DEPTH}`)
    if (stack.includes(it)) throw new ResolveError(it, `cycle ${[...stack, it].join('>')}`)
    const need = n - avail(it)
    const src = sourceFor(it, hints.nether === true)
    if (!src) throw new ResolveError(it, 'no known source')
    const st = [...stack, it]
    switch (src.kind) {
      case 'gather': {
        if (src.tool) ensureTool(src.tool, depth, st)
        if (src.knapFrom) ensure(src.knapFrom, 1, depth + 1, st)
        const g: Step = { kind: 'gather', item: it, count: countOf(inv, it) + need, blocks: src.blocks, skill: src.skill, chance: src.chance }
        steps.push(g)
        needs.set(g, need)
        add(inv, it, need)
        return
      }
      case 'hunt': {
        const h: Step = { kind: 'hunt', item: it, count: countOf(inv, it) + need, mobs: src.mobs }
        steps.push(h)
        needs.set(h, need)
        add(inv, it, need)
        return
      }
      case 'fill': {
        ensure('bucket', 1, depth + 1, st)
        steps.push({ kind: 'fill', item: it, count: countOf(inv, it) + need })
        take(inv, 'bucket', need)
        add(inv, it, need)
        return
      }
      case 'smelt': {
        ensure(src.input, need, depth + 1, st)
        reserve(src.input, need)
        ensureFuel(need, depth, st)
        if (!hints.furnaceNear) { ensure('furnace', 1, depth + 1, st); reserve('furnace', 1) }
        steps.push({ kind: 'smelt', item: it, count: countOf(inv, it) + need, input: src.input })
        release(src.input, need)
        take(inv, src.input, need)
        consumeFuel(inv, need)
        release('__fuel', need)
        if (!hints.furnaceNear) release('furnace', 1)
        add(inv, it, need)
        return
      }
      case 'craft': {
        const r = recipeFor(it)
        if (!r) throw new ResolveError(it, 'no recipe')
        const times = Math.ceil(need / r.result)
        for (const [ing, k] of Object.entries(r.ingredients)) {
          ensure(ing, k * times, depth + 1, st)
          reserve(ing, k * times)
        }
        if (r.table && !hints.tableNear) { ensure('crafting_table', 1, depth + 1, st); reserve('crafting_table', 1) }
        steps.push({ kind: 'craft', item: it, count: countOf(inv, it) + times * r.result })
        for (const [ing, k] of Object.entries(r.ingredients)) { release(ing, k * times); take(inv, ing, k * times) }
        if (r.table && !hints.tableNear) release('crafting_table', 1)
        add(inv, it, times * r.result)
      }
    }
  }

  ensure(item, count, 0, [])
  return { steps: hoistGathers(steps, needs), inv }
}

/**
 * One trip per raw material: every later gather or hunt of the same item is
 * folded into its first occurrence (its target grows by their needs). Gathering
 * earlier only holds items longer, so every later absolute target still holds.
 */
function hoistGathers (steps: Step[], needs: Map<Step, number>): Step[] {
  const first = new Map<string, Step>()
  const out: Step[] = []
  for (const st of steps) {
    if (st.kind !== 'gather' && st.kind !== 'hunt') { out.push(st); continue }
    const f = first.get(st.item)
    if (!f) { first.set(st.item, st); out.push(st); continue }
    f.count += needs.get(st) ?? 0
  }
  return out
}

/** Burns the cheapest adequate fuel in the simulation: coal first, then planks, logs, sticks. */
function consumeFuel (inv: Inv, items: number): void {
  let ticks = items * SMELT_TICKS
  const order = Object.keys(inv).filter(k => fuelTicks(k) > 0 && !NOT_FUEL.test(k))
    .sort((a, b) => fuelTicks(b) - fuelTicks(a) || a.localeCompare(b))
  for (const k of order) {
    while (ticks > 0 && (inv[k] ?? 0) > 0) {
      inv[k]!--
      ticks -= fuelTicks(k)
    }
    if (inv[k] === 0) delete inv[k]
    if (ticks <= 0) return
  }
}
