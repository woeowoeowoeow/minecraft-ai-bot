// Pure hazard checks for short reflex moves (unstick, flee steps, lava escape).
// Callers supply a BlockView; nothing here touches the bot.
import type { V3 } from '../schema/index.js'
import { HARMFUL_FLOOR, type BlockView } from './blocks.js'

export const CARDINALS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]

/** Deepest drop a reflex step may take (fall damage starts above 3). */
export const REFLEX_MAX_DROP = 3

/**
 * Why a one-block move from `feet` in direction `dir` (with a jump) is unsafe,
 * or null if it is safe. Checks the entered body cells and the jump cell for
 * lava, fire and other harmful blocks, lava beside the entered cells (flowing
 * lava), and the landing column: first solid floor within REFLEX_MAX_DROP, no
 * lava or magma underneath. Walking into a solid wall is safe (no movement).
 */
export function stepHazard (view: BlockView, feet: V3, dir: [number, number]): string | null {
  const [x, y, z] = feet.map(Math.floor) as V3
  const nx = x + dir[0]
  const nz = z + dir[1]
  for (const dy of [0, 1, 2]) {
    const c = view.at(nx, y + dy, nz)
    if (c.kind === 'lava') return 'lava'
    if (c.kind === 'harmful') return `harmful:${c.name}`
    if (c.kind === 'unknown') return 'unloaded'
  }
  // Flowing lava next to the cells the body would pass through.
  for (const dy of [0, 1]) {
    for (const [ax, az] of CARDINALS) {
      if (view.at(nx + ax, y + dy, nz + az).kind === 'lava') return 'lava_adjacent'
    }
  }
  const feetCell = view.at(nx, y, nz)
  // Stepping up onto a solid block: the jump lands on it; check what it is.
  if (feetCell.kind === 'solid') {
    if (HARMFUL_FLOOR.has(feetCell.name)) return `harmful_floor:${feetCell.name}`
    return null
  }
  for (let fy = y - 1, fell = 0; fell <= REFLEX_MAX_DROP; fy--, fell++) {
    const c = view.at(nx, fy, nz)
    if (c.kind === 'solid') {
      if (HARMFUL_FLOOR.has(c.name)) return `harmful_floor:${c.name}`
      return null
    }
    if (c.kind === 'lava') return 'lava_below'
    if (c.kind === 'water') return null // water breaks the fall
    if (c.kind === 'harmful') return `harmful:${c.name}`
    if (c.kind === 'unknown') return 'unloaded'
  }
  return 'drop_too_deep'
}

/** Cardinal direction nearest to a Mineflayer yaw (yaw 0 faces −z, increasing counter-clockwise). */
export function yawToCardinal (yaw: number): [number, number] {
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  return Math.abs(fx) >= Math.abs(fz) ? [Math.sign(fx) || 1, 0] : [0, Math.sign(fz) || 1]
}

/** Yaw that faces a cardinal direction. */
export function cardinalToYaw (dir: [number, number]): number {
  return Math.atan2(-dir[0], -dir[1])
}

/**
 * Directions for an unstick move, safest-first: the preferred direction (forward
 * on the first attempt, backward on later ones) if it is safe, then the other
 * safe cardinals. Empty when every direction is hazardous; the caller then only
 * jumps in place.
 */
export function unstickDirections (view: BlockView, feet: V3, yaw: number, attempt: number): [number, number][] {
  const fwd = yawToCardinal(yaw)
  const back: [number, number] = [0 - fwd[0], 0 - fwd[1]]
  const pref = attempt <= 1 ? fwd : back
  const order: [number, number][] = [pref, ...CARDINALS.filter(d => d[0] !== pref[0] || d[1] !== pref[1])]
  const safe = order.filter(d => stepHazard(view, feet, d) === null)
  // Momentum can carry past the first cell: directions whose second cell is safe too come first
  // (stable sort keeps the preference among them).
  const next = (d: [number, number]): V3 => {
    const [x, y, z] = feet.map(Math.floor) as V3
    const solid = view.at(x + d[0], y, z + d[1]).kind === 'solid'
    return [x + d[0], solid ? y + 1 : y, z + d[1]]
  }
  const ok2 = (d: [number, number]) => stepHazard(view, next(d), d) === null
  return [...safe.filter(ok2), ...safe.filter(d => !ok2(d))]
}

/**
 * Blocks the bot placed to come back to and never digs: the respawn bed, the kit chest (C round 2;
 * ckit-r2 r01 dug up its own bed on a restock trip, and the next death respawned at world spawn) and
 * obsidian (portal frames: a travel dig through one puts the portal out).
 */
export function isProtected (name: string | undefined): boolean {
  return name === 'chest' || name === 'obsidian' || (name?.endsWith('_bed') ?? false)
}

/** True if digging this cell would open it to lava or water (never dig those in a reflex). */
export function digReleasesLiquid (view: BlockView, c: V3): boolean {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const k = view.at(c[0] + dx, c[1] + dy, c[2] + dz).kind
    if (k === 'lava' || k === 'water') return true
  }
  return false
}

/**
 * Air reflex decision, shared by every water behaviour in the navigator: surface
 * when the head has been under water too long or air is low. `air` is 0–20.
 */
export function needsAir (headInWater: boolean, submergedMs: number, air: number, o: { maxSubmergedMs: number; lowAir: number }): boolean {
  return headInWater && (submergedMs >= o.maxSubmergedMs || air < o.lowAir)
}

/**
 * Standable cells to escape lava or fire to, best first: solid non-harmful floor,
 * body cells free of lava and fire, no lava beside the body. Within `r` blocks
 * horizontally and −1..+2 vertically of the feet; nearer first, higher preferred
 * (lava flows down, and climbing out of a pool is the usual way out).
 */
export function safeCells (view: BlockView, feet: V3, r = 4): V3[] {
  const [x0, y0, z0] = feet.map(Math.floor) as V3
  const out: { c: V3; score: number }[] = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const x = x0 + dx; const y = y0 + dy; const z = z0 + dz
        const floor = view.at(x, y - 1, z)
        if (floor.kind !== 'solid' || HARMFUL_FLOOR.has(floor.name)) continue
        const f = view.at(x, y, z); const h = view.at(x, y + 1, z)
        if ((f.kind !== 'air' && f.kind !== 'water') || (h.kind !== 'air' && h.kind !== 'water')) continue
        let lavaNear = false
        // Fire beside the cell burns a body that is not centred (C smoke r01: fire after a ghast fireball).
        for (const hy of [0, 1]) for (const [ax, az] of CARDINALS) { const k = view.at(x + ax, y + hy, z + az); if (k.kind === 'lava' || k.name === 'fire' || k.name === 'soul_fire') lavaNear = true }
        if (lavaNear) continue
        out.push({ c: [x, y, z], score: Math.hypot(dx, dz) - 0.3 * dy })
      }
    }
  }
  out.sort((a, b) => a.score - b.score || a.c[0] - b.c[0] || a.c[2] - b.c[2] || a.c[1] - b.c[1])
  return out.map(o => o.c)
}
