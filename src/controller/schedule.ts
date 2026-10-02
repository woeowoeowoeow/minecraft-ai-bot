// Day/night objective scheduling (milestone A, after gate 20260929: 21 of 36 deaths
// at night, mostly on surface food and wood trips with a stone sword or less).
// Pure: the policy's offerable objectives go in, one objective (or "shelter") comes
// out. By day the policy's first choice runs. By night, until the bot has iron
// sword, shield and armor, surface work (hunting, logs, filling water) is deferred
// in favour of the first objective that can be done underground or in place
// (mining, smelting, crafting); hunting always waits for day. With nothing else
// to do, the bot digs in and waits.
import type { WorldState } from '../observer/types.js'
import type { Objective } from '../schema/index.js'
import { hintsFrom } from '../skills/generic/obtain.js'
import { planObtain } from '../skills/sources.js'
import { hasShield } from '../skills/survival/threat.js'

/** Surface work window: from sunset (12 000) until shortly after sunrise, when surface mobs burn. */
export const SCHEDULE = { nightFrom: 12_000, nightUntil: 23_300, capableArmor: 4 } as const

export function surfaceNight (s: WorldState): boolean {
  const t = s.vitals.timeOfDay
  return s.dim === 'overworld' && t >= SCHEDULE.nightFrom && t < SCHEDULE.nightUntil
}

/** Equipped well enough for short surface work at night: iron sword, shield and ≥ 4 armor points. */
export function nightCapable (s: WorldState): boolean {
  return (s.inventory.iron_sword ?? 0) > 0 && hasShield(s) && s.armor >= SCHEDULE.capableArmor
}

/**
 * What open-surface work an objective needs: 'hunt' (food animals: a search of
 * unknown length, daytime only), 'short' (logs, filling water), or null (mining,
 * smelting, crafting: underground or in place). From the `obtain` resolved plan.
 */
export function surfaceKind (o: Objective, s: WorldState): 'hunt' | 'short' | null {
  if (o.skill !== 'obtain') return null
  const item = String(o.params.item)
  const count = Number(o.params.count)
  try {
    const { steps } = planObtain(item, count, s.inventory, hintsFrom(s))
    if (steps.some(st => st.kind === 'hunt')) return 'hunt'
    return steps.some(st => st.kind === 'fill' || (st.kind === 'gather' && st.skill === 'collect' && st.blocks.includes('log'))) ? 'short' : null
  } catch {
    return null
  }
}

export function surfaceWork (o: Objective, s: WorldState): boolean {
  return surfaceKind(o, s) !== null
}

/** Deferred at night: hunting always; other surface work unless equipped for the night. */
export function deferAtNight (o: Objective, s: WorldState): boolean {
  const k = surfaceKind(o, s)
  return k === 'hunt' || (k === 'short' && !nightCapable(s))
}

export type Scheduled = { objective: Objective | null; shelter: boolean; deferred: string[] }

export function schedule (candidates: Objective[], s: WorldState): Scheduled {
  if (!candidates.length) return { objective: null, shelter: false, deferred: [] }
  if (!surfaceNight(s)) return { objective: candidates[0]!, shelter: false, deferred: [] }
  const deferred: string[] = []
  for (const o of candidates) {
    if (!deferAtNight(o, s)) return { objective: o, shelter: false, deferred }
    deferred.push(o.id)
  }
  // Hunting waits for day even when equipped: tried after dev batch 6 to save shelter time,
  // reverted after dev batches 7 and 9 (three deaths on night hunts with full gear).
  return { objective: null, shelter: true, deferred }
}
