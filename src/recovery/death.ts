// Death handling (architecture §7.4). Pure decision: is going back for the
// drops worth it? Items despawn after 5 minutes; lava and the void destroy
// them; a second death at the same place means the place itself is the danger.
import type { V3 } from '../schema/index.js'
import { isJunk } from '../skills/inventory.js'
import { MOB_THREATS } from '../version.js'

export type DeathRecord = { pos: V3; dim: string; t: number; lost?: Record<string, number>; cause?: string | null }

/** Items dropped below y 1 fall into the void. */
export const DEATH_RECOVERY = { maxAgeS: 240, maxDist: 300, minY: 1 } as const

/** Killed by a mob (melee, arrow, explosion, trident, magic), not by the terrain. */
export function mobDeath (cause: string | null | undefined): boolean {
  return /(slain|shot|blown up|impaled|fireballed) by|stung to death|killed by (?!magic)/.test(cause ?? '')
}

/**
 * Items worth walking back into danger for: iron and better gear and the portal kit (an
 * hour's progress). Stone and wood tools, logs and ores are rebuilt faster than fetched.
 */
export const HIGH_VALUE = /^(iron_(ingot|pickaxe|sword|axe|shovel|helmet|chestplate|leggings|boots)|diamond(_.*)?|golden_(helmet|chestplate|leggings|boots)|shield|bucket|water_bucket|lava_bucket|flint_and_steel|obsidian)$/

/** The death site as last seen alive: under cover (a cave), and the hostiles about. */
export type DeathSite = { covered: boolean; hostiles: { name: string; dist: number }[] }

/**
 * Is going back for the drops worth it? Beyond the drops still existing, a mob death
 * means the place itself is dangerous, and the respawned bot is bare-handed: it goes
 * back only for high-value items, by day, to a surface site that had at most one melee
 * hostile. B gate 20261002: 8 of 9 recovery walks were cancelled by threats, and 4 of
 * the 5 repeat deaths within 5 minutes followed one (r04, r06, r07, r11).
 */
export function recoverDecision (death: DeathRecord, prior: DeathRecord[], nowS: number, me: V3, dim: string, site?: DeathSite, nightNow = false): { recover: boolean; reason: string } {
  if (death.dim !== 'overworld' || dim !== 'overworld') return { recover: false, reason: 'not in the Overworld' }
  if (nowS - death.t > DEATH_RECOVERY.maxAgeS) return { recover: false, reason: 'drops despawning' }
  if (/lava|burn|flames|fire|out of the world/.test(death.cause ?? '')) return { recover: false, reason: `drops destroyed (${death.cause})` }
  if (death.pos[1] < DEATH_RECOVERY.minY) return { recover: false, reason: 'too deep' }
  const d = Math.hypot(death.pos[0] - me[0], death.pos[2] - me[2])
  if (d > DEATH_RECOVERY.maxDist) return { recover: false, reason: `death point ${Math.round(d)} blocks away` }
  if (prior.some(p => p !== death && Math.hypot(p.pos[0] - death.pos[0], p.pos[1] - death.pos[1], p.pos[2] - death.pos[2]) < 16)) return { recover: false, reason: 'died there before' }
  const valuable = Object.entries(death.lost ?? {}).filter(([k, v]) => v > 0 && !isJunk(k) && !/^(dirt|cobblestone|gravel|sand|stone)$/.test(k))
  if (!valuable.length) return { recover: false, reason: 'nothing valuable lost' }
  if (mobDeath(death.cause)) {
    if (!valuable.some(([k]) => HIGH_VALUE.test(k))) return { recover: false, reason: 'mob death, only low-value items lost' }
    if (nightNow) return { recover: false, reason: 'mob death, night' }
    if (site?.covered) return { recover: false, reason: 'mob death under cover' }
    const shooters = (site?.hostiles ?? []).filter(h => MOB_THREATS[h.name]?.ranged)
    if (shooters.length || (site?.hostiles.length ?? 0) >= 2) return { recover: false, reason: `mob death among ${site!.hostiles.length} hostiles${shooters.length ? ' (shooter)' : ''}` }
  }
  return { recover: true, reason: `${valuable.length} kinds of useful items ${Math.round(d)} blocks away` }
}
