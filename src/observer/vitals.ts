import type { Bot } from 'mineflayer'

/** Entity metadata index of `air_supply` (base Entity field, 0–300 ticks). */
const AIR_SUPPLY_KEY = 1
const MAX_AIR = 300

/**
 * The bot's own air, 0–20 (Mineflayer's `oxygenLevel` scale).
 *
 * Do not use `bot.oxygenLevel`: Mineflayer 4.39 sets it from *any* entity's
 * `air_supply` metadata (no `entity === bot.entity` check), so squid, fish and
 * drowned air values leak into it. We read the bot entity's own metadata
 * instead, which Mineflayer stores per entity.
 */
export function ownAir (bot: Bot): number {
  const md = (bot.entity as unknown as { metadata?: unknown[] } | undefined)?.metadata
  const v = md?.[AIR_SUPPLY_KEY]
  return typeof v === 'number' ? Math.round(Math.max(-20, Math.min(MAX_AIR, v)) / 15) : 20
}
