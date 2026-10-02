// Tool choice for digging (shared by the excavator and skills). Pure over the
// bot's inventory; nav sits below skills, so it lives here.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import { toolTier } from '../version.js'

function withTimeout<T> (p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(h); resolve(v) }, e => { clearTimeout(h); reject(e) })
  })
}

/** Tools worth saving: nether_ready needs an intact iron pickaxe and sword, so iron and better tools only dig when nothing cheaper works. */
const SPARE_FACTOR = 1.6

function harvests (block: Block, item: Item | null): boolean {
  const ht = (block as unknown as { harvestTools?: Record<string, boolean> }).harvestTools
  if (!ht) return true
  return item !== null && Boolean(ht[item.type])
}

/**
 * Tool for digging this block (null = empty hand). Only tools that make the
 * block drop are considered when some tool can; among those the fastest wins,
 * but iron and better tools count as SPARE_FACTOR× slower so stone tools wear
 * first. Swords never dig (they lose 2 durability per block).
 */
export function bestTool (bot: Bot, block: Block): Item | null {
  const eff = bot.entity.effects as never
  const items = bot.inventory.items().filter(it => !it.name.endsWith('_sword'))
  const canDrop = items.some(it => harvests(block, it))
  let best: Item | null = null
  let score = harvests(block, null) || !canDrop ? block.digTime(null, false, false, false, [], eff) : Infinity
  for (const it of items) {
    if (canDrop && !harvests(block, it)) continue
    const t = block.digTime(it.type, false, false, false, [], eff)
    const tier = toolTier(it.name)
    const sc = tier !== null && tier >= 2 ? t * SPARE_FACTOR : t
    if (sc < score - 1) { score = sc; best = it }
  }
  return best
}

/** Put the right tool (or an empty hand) in the main hand for digging `block`. */
export async function equipFor (bot: Bot, block: Block): Promise<Item | null> {
  const tool = bestTool(bot, block)
  if (tool) {
    if (bot.heldItem?.slot !== tool.slot) await withTimeout(bot.equip(tool, 'hand'), 3000, 'equip')
  } else if (bot.heldItem && (toolTier(bot.heldItem.name) !== null || (bot.heldItem as unknown as { maxDurability?: number }).maxDurability)) {
    // Digging with any damageable item wears it; use the empty hand instead.
    await withTimeout(bot.unequip('hand'), 3000, 'unequip').catch(() => {})
  }
  return tool
}

