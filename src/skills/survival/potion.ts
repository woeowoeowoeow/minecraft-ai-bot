// Fire resistance potions (bartered, milestone C): found by NBT, splashed at the feet or drunk.
// Shared by the blaze fight (before the spawner) and the lava escape reflex.
import type { Bot } from 'mineflayer'
import { withTimeout } from '../acts.js'
import { sleep } from '../runner.js'

/** A fire resistance potion carried (bartering: 20/423 per ingot, drinkable or splash). */
export function fireResPotion (bot: Bot): { slot: number; splash: boolean } | null {
  for (const it of bot.inventory.items()) {
    if (it.name !== 'potion' && it.name !== 'splash_potion') continue
    const nbt = JSON.stringify((it as unknown as { nbt?: unknown }).nbt ?? {})
    if (nbt.includes('fire_resistance')) return { slot: it.slot, splash: it.name === 'splash_potion' }
  }
  return null
}

/**
 * Use a carried fire resistance potion: a splash potion is thrown straight down (instant), a
 * drinkable one is drunk (1.6 s) unless `splashOnly`. Returns the kind used, or null. The caller
 * checks the effect and re-arms.
 */
export async function useFireRes (bot: Bot, signal: AbortSignal, o: { splashOnly?: boolean } = {}): Promise<'splash' | 'drink' | null> {
  const pot = fireResPotion(bot)
  if (!pot || (o.splashOnly && !pot.splash)) return null
  const item = bot.inventory.slots[pot.slot]
  if (!item) return null
  try {
    await bot.equip(item, 'hand')
    if (pot.splash) {
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.activateItem()
      await sleep(300, signal)
      bot.deactivateItem()
    } else {
      await withTimeout(bot.consume(), 5000, 'drink')
    }
  } catch { /* the caller checks the effect */ }
  return pot.splash ? 'splash' : 'drink'
}
