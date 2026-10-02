// Death handling (architecture §7.4). Pure decision: is going back for the
// drops worth it? Items despawn after 5 minutes; lava and the void destroy
// them; a second death at the same place means the place itself is the danger.
import type { V3 } from '../schema/index.js'
import { isJunk } from '../skills/inventory.js'

export type DeathRecord = { pos: V3; dim: string; t: number; lost?: Record<string, number>; cause?: string | null }

/** Items dropped below y 1 fall into the void. */
export const DEATH_RECOVERY = { maxAgeS: 240, maxDist: 300, minY: 1 } as const

export function recoverDecision (death: DeathRecord, prior: DeathRecord[], nowS: number, me: V3, dim: string): { recover: boolean; reason: string } {
  if (death.dim !== 'overworld' || dim !== 'overworld') return { recover: false, reason: 'not in the Overworld' }
  if (nowS - death.t > DEATH_RECOVERY.maxAgeS) return { recover: false, reason: 'drops despawning' }
  if (/lava|burn|flames|fire|out of the world/.test(death.cause ?? '')) return { recover: false, reason: `drops destroyed (${death.cause})` }
  if (death.pos[1] < DEATH_RECOVERY.minY) return { recover: false, reason: 'too deep' }
  const d = Math.hypot(death.pos[0] - me[0], death.pos[2] - me[2])
  if (d > DEATH_RECOVERY.maxDist) return { recover: false, reason: `death point ${Math.round(d)} blocks away` }
  if (prior.some(p => p !== death && Math.hypot(p.pos[0] - death.pos[0], p.pos[1] - death.pos[1], p.pos[2] - death.pos[2]) < 16)) return { recover: false, reason: 'died there before' }
  const valuable = Object.entries(death.lost ?? {}).filter(([k, v]) => v > 0 && !isJunk(k) && !/^(dirt|cobblestone|gravel|sand|stone)$/.test(k))
  if (!valuable.length) return { recover: false, reason: 'nothing valuable lost' }
  return { recover: true, reason: `${valuable.length} kinds of useful items ${Math.round(d)} blocks away` }
}
