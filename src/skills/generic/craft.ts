import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { z } from 'zod'
import type { Requirement } from '../../schema/index.js'
import { waitFor, withTimeout } from '../acts.js'
import { SkillFailure, type Precondition, type SkillDef } from '../types.js'

const Params = z.object({ item: z.string(), count: z.number().int().positive().default(1) })
type P = z.infer<typeof Params>

function nearbyTable (bot: Bot): Block | null {
  const id = bot.registry.blocksByName.crafting_table?.id
  if (id === undefined) return null
  return bot.findBlock({ matching: id, maxDistance: 4 }) ?? null
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

/**
 * Ask the server for the authoritative inventory contents. Mineflayer's 2×2
 * craft never confirms its last click (it only syncs table windows), so the
 * client model can drift; architecture §7.2 requires a resync before trusting it.
 */
export async function resyncInventory (bot: Bot): Promise<boolean> {
  const sync = (bot as Bot & { _syncWindow?: (w: unknown) => Promise<void> })._syncWindow
  if (!sync) return false
  try { await withTimeout(sync(bot.inventory), 3000, 'inventory sync'); return true } catch { return false }
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

/** Goal-shaped craft: ensure inventory has ≥ count of `item`. Uses a crafting table within 4 blocks if needed. */
export const craft: SkillDef<P, { crafted: number }> = {
  id: 'craft',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => (s.inventory[p.item] ?? 0) >= p.count,
  preconditions: (_s, p, env) => check(env.bot, p),
  timeoutMs: () => 30_000,
  stallMs: 20_000,
  async run (ctx, p) {
    const { bot } = ctx
    const item = bot.registry.itemsByName[p.item]!
    const count = () => bot.inventory.count(item.id, null)
    await resyncAndCheck(ctx, 'before_craft')
    const start = count()
    for (let round = 0; count() < p.count; round++) {
      ctx.checkAbort()
      if (round >= 4) throw new SkillFailure('STATE_INCONSISTENT', 'crafting made no progress', { key: `item=${p.item}` })
      const table = nearbyTable(bot)
      const recipe = bot.recipesFor(item.id, null, 1, table)[0]
      if (!recipe) {
        const missing = missingFor(bot, item.id, true)
        throw new SkillFailure('MISSING_RESOURCE', `missing ingredients for ${p.item}`, { key: `item=${p.item}` }, missing)
      }
      const times = Math.ceil((p.count - count()) / recipe.result.count)
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
