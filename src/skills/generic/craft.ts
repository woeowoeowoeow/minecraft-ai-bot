import { once } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { z } from 'zod'
import type { Requirement, V3 } from '../../schema/index.js'
import { countOf } from '../sources.js'
import { placeNear, waitFor, withTimeout } from '../acts.js'
import { SkillFailure, type Precondition, type SkillCtx, type SkillDef } from '../types.js'

const Params = z.object({ item: z.string(), count: z.number().int().positive().default(1) })
type P = z.infer<typeof Params>

/** A table close enough to craft at (within 4 blocks). */
function nearbyTable (bot: Bot, maxDistance = 4): Block | null {
  const id = bot.registry.blocksByName.crafting_table?.id
  if (id === undefined) return null
  return bot.findBlock({ matching: id, maxDistance }) ?? null
}

/** The planks kind made from the most plentiful log carried (the `planks` group). */
export function planksKind (bot: Bot): string {
  const logs: Record<string, number> = {}
  for (const it of bot.inventory.items()) if (it.name.endsWith('_log')) logs[it.name] = (logs[it.name] ?? 0) + it.count
  const log = Object.entries(logs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'oak_log'
  return log.replace(/^stripped_/, '').replace(/_log$/, '_planks')
}

/**
 * Get a crafting table within reach: walk to one within 24 blocks, else place
 * one from the inventory (remembered as built). Returns null when neither exists.
 */
async function reachTable (ctx: SkillCtx): Promise<Block | null> {
  const bot = ctx.bot
  const near = nearbyTable(bot)
  if (near) return near
  const far = nearbyTable(bot, 24)
  if (far) {
    const r = await ctx.nav.goto({ kind: 'reach', target: [far.position.x, far.position.y, far.position.z], range: 4 })
    if (r.ok) return nearbyTable(bot)
    ctx.localRecovery(`table unreachable (${r.class})`)
  }
  if (bot.inventory.items().some(i => i.name === 'crafting_table')) {
    const at = await placeNear(bot, 'crafting_table', ctx.signal)
    ctx.log('location_discovered', { kind: 'crafting_table', pos: [at.x, at.y, at.z], source: 'built' })
    ctx.memory.locations.push({ kind: 'crafting_table', dim: ctx.state().dim, pos: [at.x, at.y, at.z] as V3, confidence: 1, source: 'built', lastSeen: ctx.state().t })
    return bot.blockAt(at, false)
  }
  return null
}

type RecipeCtor = new (raw: unknown) => ReturnType<Bot['recipesFor']>[number]
let RecipeClass: RecipeCtor | null = null
function recipeClass (bot: Bot): RecipeCtor {
  // prismarine-recipe as Mineflayer itself loads it (same registry, same Recipe shape).
  RecipeClass ??= (createRequire(createRequire(import.meta.url).resolve('mineflayer'))('prismarine-recipe') as (r: unknown) => { Recipe: RecipeCtor })(bot.registry).Recipe
  return RecipeClass
}

/**
 * One craft of `itemId` with mixed planks. Vanilla recipes take any planks in each
 * slot (the #planks tag); minecraft-data expands them into one same-wood variant each,
 * so 3 oak + 3 spruce planks match no listed shield recipe (dev batch 3). Fill each
 * planks slot of the first variant from whatever planks are carried.
 */
export function mixedPlanksRecipe (bot: Bot, itemId: number): ReturnType<Bot['recipesFor']>[number] | null {
  const raw = bot.registry.recipes[itemId]?.[0] as { inShape?: (number | null)[][]; result: unknown } | undefined
  if (!raw?.inShape) return null
  const isPlanks = (id: number | null) => id !== null && (bot.registry.items[id]?.name ?? '').endsWith('_planks')
  const stock: { id: number; left: number }[] = []
  for (const it of bot.inventory.items()) {
    if (!it.name.endsWith('_planks')) continue
    const e = stock.find(x => x.id === it.type)
    if (e) e.left += it.count; else stock.push({ id: it.type, left: it.count })
  }
  stock.sort((a, b) => b.left - a.left)
  let usesPlanks = false
  const shape = raw.inShape.map(row => row.map(id => {
    if (!isPlanks(id)) return id
    usesPlanks = true
    const src = stock.find(x => x.left > 0)
    if (!src) return -1
    src.left--
    return src.id
  }))
  if (!usesPlanks || shape.some(row => row.includes(-1))) return null
  for (const row of shape) for (const id of row) if (id !== null && !isPlanks(id) && bot.inventory.count(id, null) < 1) return null
  return new (recipeClass(bot))({ inShape: shape, result: raw.result })
}

/** Ingredients missing for the first known recipe (for MISSING_RESOURCE reports). */
function missingFor (bot: Bot, itemId: number, table: boolean): Requirement[] {
  const all = bot.recipesAll(itemId, null, table)
  const r = all[0]
  if (!r) return []
  const out: Requirement[] = []
  for (const d of r.delta) {
    if (d.count >= 0) continue
    const name = bot.registry.items[d.id]?.name ?? String(d.id)
    const need = -d.count
    const have = bot.inventory.count(d.id, null)
    if (have < need) out.push({ item: name, count: need - have })
  }
  if (r.requiresTable && !nearbyTable(bot)) out.push({ item: 'crafting_table', count: 1 })
  return out
}

/**
 * Static preconditions only (item and recipe exist). Ingredient availability is
 * checked in `run`, after resyncing with the server, because the client
 * inventory model may be stale.
 */
function check (bot: Bot, p: P): Precondition {
  const item = bot.registry.itemsByName[p.item]
  if (!item) return { ok: false, cls: 'PRECONDITION_FAILED', reason: `unknown item ${p.item}` }
  if (bot.recipesAll(item.id, null, true).length === 0) return { ok: false, cls: 'PRECONDITION_FAILED', reason: `no crafting recipe for ${p.item}` }
  return { ok: true }
}

/** Click action id for resync probes: negative, so it never collides with Mineflayer's own (positive) ids. */
const RESYNC_ACTION = -7

/**
 * Ask the server for the authoritative inventory contents. Mineflayer's 2×2
 * craft never confirms its last click (it only syncs table windows), so the
 * client model can drift; architecture §7.2 requires a resync before trusting it.
 *
 * 1.16.1 (pre-`stateId` protocol): Mineflayer's `_syncWindow` is a no-op there,
 * so we use the vanilla mechanism instead. A click outside the window with an
 * empty cursor changes nothing on the server; claiming it produced an item makes
 * the server reject it, and a rejected click makes the server resend the whole
 * inventory (`window_items`). Mineflayer answers the rejection with the
 * acknowledgement that re-enables syncing. Returns false (no resync) when the
 * cursor holds an item, because a click outside the window would drop it.
 */
export async function resyncInventory (bot: Bot): Promise<boolean> {
  const b = bot as Bot & { _syncWindow?: (w: unknown) => Promise<void>; _client: { write (name: string, data: unknown): void } }
  if (bot.supportFeature('stateIdUsed')) {
    if (!b._syncWindow) return false
    try { await withTimeout(b._syncWindow(bot.inventory), 3000, 'inventory sync'); return true } catch { return false }
  }
  if (!bot.supportFeature('actionIdUsed') || bot.inventory.selectedItem) return false
  const synced = once(bot, 'setWindowItems:0')
  const claimed = bot.registry.itemsByName.stone!.id
  b._client.write('window_click', { windowId: 0, slot: -999, mouseButton: 0, action: RESYNC_ACTION, mode: 0, item: { present: true, itemId: claimed, itemCount: 1 } })
  try { await withTimeout(synced, 3000, 'inventory sync'); return true } catch { return false }
}

function snapshotCounts (bot: Bot): Record<string, number> {
  const inv: Record<string, number> = {}
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] ?? 0) + it.count
  return inv
}

/** Resync and report any difference between the client model and the server as `inventory_desync`. */
async function resyncAndCheck (ctx: { bot: Bot; log: (t: 'inventory_desync', d: Record<string, unknown>) => void }, when: string): Promise<void> {
  const before = snapshotCounts(ctx.bot)
  if (!(await resyncInventory(ctx.bot))) return
  const after = snapshotCounts(ctx.bot)
  const diff: Record<string, number> = {}
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0)
    if (d !== 0) diff[k] = d
  }
  if (Object.keys(diff).length) ctx.log('inventory_desync', { when, serverMinusClient: diff })
}

/**
 * Goal-shaped craft: ensure inventory has ≥ count of `item` (`planks` = any
 * planks). Uses a crafting table within reach, walks to one within 24 blocks,
 * or places one from the inventory.
 */
export const craft: SkillDef<P, { crafted: number }> = {
  id: 'craft',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => countOf(s.inventory, p.item) >= p.count,
  preconditions: (_s, p, env) => p.item === 'planks' ? { ok: true } : check(env.bot, p),
  timeoutMs: () => 45_000,
  stallMs: 25_000,
  async run (ctx, p) {
    const { bot } = ctx
    const target = () => p.item === 'planks' ? planksKind(bot) : p.item
    const matches = (name: string) => p.item === 'planks' ? name.endsWith('_planks') : name === p.item
    const count = () => bot.inventory.items().filter(i => matches(i.name)).reduce((n, i) => n + i.count, 0)
    await resyncAndCheck(ctx, 'before_craft')
    const start = count()
    let table: Block | null = null
    for (let round = 0; count() < p.count; round++) {
      ctx.checkAbort()
      if (round >= 4) throw new SkillFailure('STATE_INCONSISTENT', 'crafting made no progress', { key: `item=${p.item}` })
      const item = bot.registry.itemsByName[target()]!
      table = nearbyTable(bot)
      let recipe = bot.recipesFor(item.id, null, 1, table)[0]
      if (!recipe && !table && (bot.recipesFor(item.id, null, 1, true)[0] || mixedPlanksRecipe(bot, item.id)?.requiresTable)) {
        table = await reachTable(ctx)
        if (!table) throw new SkillFailure('MISSING_RESOURCE', `no crafting table for ${p.item}`, { key: `item=${p.item}` }, [{ item: 'crafting_table', count: 1 }])
        recipe = bot.recipesFor(item.id, null, 1, table)[0]
      }
      if (!recipe) {
        const mixed = mixedPlanksRecipe(bot, item.id)
        if (mixed && (!mixed.requiresTable || table)) recipe = mixed
      }
      if (!recipe) {
        const missing = missingFor(bot, item.id, true)
        throw new SkillFailure('MISSING_RESOURCE', `missing ingredients for ${p.item}`, { key: `item=${p.item}` }, missing)
      }
      const isMixed = !bot.recipesFor(item.id, null, 1, table).includes(recipe)
      // A mixed-planks recipe names exact planks per slot: craft it once per round.
      const times = isMixed ? 1 : Math.ceil((p.count - count()) / recipe.result.count)
      const before = count()
      try {
        await withTimeout(bot.craft(recipe, times, table ?? undefined), 10_000, 'craft')
      } catch (e) {
        ctx.checkAbort()
        ctx.localRecovery(`craft error: ${(e as Error).message}`)
        closeWindow(bot)
      }
      // Inventory updates can trail the craft promise; then trust only the server's view.
      await waitFor(() => count() > before, 1500, ctx.signal)
      await resyncAndCheck(ctx, 'after_craft')
      if (count() > before) ctx.progress('crafted', count() - start)
    }
    return { crafted: count() - start }
  },
  async onCancel (ctx) { closeWindow(ctx.bot) },
}

function closeWindow (bot: Bot): void {
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
}
