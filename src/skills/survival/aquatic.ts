// Shoreline rules for food work (A re-gate 20260930: 6 of 11 deaths were drowned at sea
// level in or right after a food objective: fish chases into open water, flights along the
// beach, melee in the water). Water is not banned: it is unsafe only while aquatic hostiles
// are about, and then food targets at the water's edge are skipped and the bot moves inland.
import type { EntityInfo, WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import type { BlockView } from '../../nav/blocks.js'

/** Hostiles that live in water and follow the bot onto the shore (drowned throw tridents). */
export const AQUATIC_MOBS = new Set(['drowned', 'guardian', 'elder_guardian'])

export const AQUATIC = {
  /** Aquatic hostiles within this distance make nearby water unsafe for food work. */
  zone: 24,
  /** A food target with open water within this horizontal distance is a shoreline target. */
  shore: 4,
  /** How far an inland relocation moves away from the aquatic hostiles and the water. */
  inland: 24,
  /** Inland relocations per hunt before it gives up on this area (bounded). */
  maxRelocations: 2,
} as const

export function isAquatic (name: string): boolean {
  return AQUATIC_MOBS.has(name)
}

/** Aquatic hostiles within `r` of the bot. */
export function aquaticThreats (s: WorldState, r: number = AQUATIC.zone): EntityInfo[] {
  return s.nearby.entities.filter(e => e.kind === 'hostile' && isAquatic(e.name) && e.dist <= r)
}

/** Remembered water cells (the observer's interest scan, nearest first) within `r` horizontally of `p`. */
export function waterCellsNear (s: WorldState, p: V3, r: number): V3[] {
  return (s.nearby.interestBlocks.water ?? []).filter(w => Math.hypot(w[0] - p[0], w[2] - p[2]) <= r && Math.abs(w[1] - p[1]) <= 4)
}

/** The bot is in water or within `r` blocks of it. */
export function atWater (s: WorldState, r: number = AQUATIC.shore): boolean {
  return s.inLiquid === 'water' || s.body.feet === 'water' || waterCellsNear(s, s.pos, r).length > 0
}

/** Water within `r` horizontally of `p` (feet level −2 … +1), from loaded blocks. Unloaded cells count as dry. */
export function waterWithin (view: BlockView, p: V3, r: number = AQUATIC.shore): boolean {
  const [px, py, pz] = p.map(Math.floor) as V3
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      for (let dy = -2; dy <= 1; dy++) if (view.at(px + dx, py + dy, pz + dz).kind === 'water') return true
    }
  }
  return false
}

/**
 * Where to go to get away from aquatic hostiles and the water they come from: a point
 * `dist` blocks from the bot, directly away from the combined centre of those hostiles
 * and nearby water cells. Null when there is nothing to move away from.
 */
export function inlandPoint (s: WorldState, dist: number = AQUATIC.inland): V3 | null {
  const masses: { p: V3; w: number }[] = aquaticThreats(s).map(e => ({ p: e.pos, w: 1 }))
  const water = waterCellsNear(s, s.pos, 10)
  for (const c of water) masses.push({ p: c, w: Math.max(1, masses.length) / water.length })
  const w = masses.reduce((a, m) => a + m.w, 0)
  if (!w) return null
  const cx = masses.reduce((a, m) => a + m.p[0] * m.w, 0) / w
  const cz = masses.reduce((a, m) => a + m.p[2] * m.w, 0) / w
  let dx = s.pos[0] - cx
  let dz = s.pos[2] - cz
  const len = Math.hypot(dx, dz)
  if (len < 0.5) return null
  dx /= len
  dz /= len
  return [Math.floor(s.pos[0] + dx * dist), Math.floor(s.pos[1]), Math.floor(s.pos[2] + dz * dist)]
}
