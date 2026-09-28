import type { NavGoal, V3 } from '../schema/index.js'
import type { BlockView } from './blocks.js'
import type { ExcavationTarget } from './excavate.js'

/** Targets at least this far below the feet use controlled excavation. */
export const UNDERGROUND_DY = 5

const NOT_COVER = /leaves|log|wood|mushroom_block|vine|bamboo/

/**
 * True when the cell is covered: at least `min` solid, non-tree blocks above
 * it within `scan` blocks. Unloaded cells end the scan.
 */
export function isCovered (view: BlockView, p: V3, min = 2, scan = 64): boolean {
  let n = 0
  for (let y = Math.floor(p[1]) + 2; y <= Math.floor(p[1]) + scan; y++) {
    const c = view.at(Math.floor(p[0]), y, Math.floor(p[2]))
    if (c.kind === 'unknown') break
    if (c.kind === 'solid' && !NOT_COVER.test(c.name) && ++n >= min) return true
  }
  return false
}

/**
 * Chooses controlled excavation over pathfinder search:
 * - `y` goals well below the feet (reach a mining depth);
 * - `near`/`block` goals whose target is covered and either well below the
 *   feet, or reached from a covered position (cave to cave).
 * Returns null for everything else (surface travel stays with the pathfinder).
 */
export function undergroundTarget (view: BlockView, goal: NavGoal, pos: V3): ExcavationTarget | null {
  const feetY = Math.floor(pos[1] + 1e-3)
  if (goal.kind === 'y') {
    const t = goal.target as number
    return t <= feetY - UNDERGROUND_DY ? { y: Math.floor(t) } : null
  }
  if (goal.kind !== 'near' && goal.kind !== 'block') return null
  const v = goal.target as V3
  const t: ExcavationTarget = { y: Math.floor(v[1]), xz: [Math.floor(v[0]), Math.floor(v[2])] }
  if (Math.hypot(pos[0] - v[0] - 0.5, pos[1] - v[1], pos[2] - v[2] - 0.5) <= Math.max(3, goal.range ?? 0)) return null
  if (!isCovered(view, v)) return null
  if (t.y <= feetY - UNDERGROUND_DY) return t
  return isCovered(view, pos) ? t : null
}
