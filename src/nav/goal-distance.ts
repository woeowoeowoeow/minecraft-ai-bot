import type { NavGoal, V3 } from '../schema/index.js'

/** Distance from `pos` to the goal, in the goal's own metric. */
export function goalDistance (goal: NavGoal, pos: V3, entityPos?: V3): number {
  const t = goal.target
  switch (goal.kind) {
    case 'y': return Math.abs(pos[1] - (t as number))
    case 'xz': { const v = t as V3; return Math.max(0, Math.hypot(pos[0] - v[0] - 0.5, pos[2] - v[2] - 0.5) - (goal.range ?? 0)) }
    case 'entity': return entityPos ? Math.hypot(pos[0] - entityPos[0], pos[1] - entityPos[1], pos[2] - entityPos[2]) : Infinity
    case 'away': { const v = t as V3; return Math.max(0, (goal.range ?? 16) - Math.hypot(pos[0] - v[0], pos[1] - v[1], pos[2] - v[2])) }
    default: { const v = t as V3; return Math.hypot(pos[0] - v[0] - 0.5, pos[1] - v[1], pos[2] - v[2] - 0.5) }
  }
}
