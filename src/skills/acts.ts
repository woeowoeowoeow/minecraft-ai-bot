// Primitives (architecture §6.1 `ctx.act`): thin Mineflayer wrappers with abort + timeout.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import { sleep } from './runner.js'

export function withTimeout<T> (p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(h); resolve(v) }, e => { clearTimeout(h); reject(e) })
  })
}

/** Fastest tool in inventory for this block (null = hand). */
export function bestTool (bot: Bot, block: Block): Item | null {
  let best: Item | null = null
  let fastest = block.digTime(null, false, false, false, [], bot.entity.effects as never)
  for (const it of bot.inventory.items()) {
    const t = block.digTime(it.type, false, false, false, [], bot.entity.effects as never)
    if (t < fastest) { fastest = t; best = it }
  }
  return best
}

export async function dig (bot: Bot, block: Block, signal: AbortSignal): Promise<void> {
  const tool = bestTool(bot, block)
  if (tool) await withTimeout(bot.equip(tool, 'hand'), 3000, 'equip')
  // Digging while airborne is 5× slower (vanilla rule): settle first, e.g. at the end of a path.
  bot.clearControlStates()
  await waitFor(() => bot.entity.onGround, 1500, signal)
  const inWater = Boolean((bot.entity as { isInWater?: boolean }).isInWater)
  const expected = block.digTime(tool?.type ?? null, false, inWater, !bot.entity.onGround, [], bot.entity.effects as never)
  const onAbort = () => { try { bot.stopDigging() } catch { /* ignore */ } }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await withTimeout(bot.dig(block, true), expected * 1.5 + 4000, 'dig')
  } catch (e) {
    onAbort()
    throw e
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Resolves true when `pred` holds, polling every 100 ms until `ms` passes. */
export async function waitFor (pred: () => boolean, ms: number, signal: AbortSignal): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(100, signal)
  }
  return pred()
}
