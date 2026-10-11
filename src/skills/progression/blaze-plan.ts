// Blaze fight planning for milestone C (pure over a BlockView). Fortress floors are
// nether bricks; a camp is a standable floor cell close to the blaze spawner (blazes
// spawn within 4 blocks of it), away from lava and drops, preferably under a roof and
// with walls around (fewer open sides to be shot from). Attacks respect vanilla reach:
// 3 blocks from the eye to the target's hitbox.
import type { BlockView } from '../../nav/blocks.js'
import type { V3 } from '../../schema/index.js'
import { lavaNear, safeStand } from './nether-plan.js'

export const FORTRESS_FLOOR = new Set(['nether_bricks', 'nether_brick_stairs', 'nether_brick_slab'])
/** Survival reach to an entity (eye to the nearest point of its hitbox). */
export const REACH = 3.0

/** Standable cells on fortress floor within `r` (horizontal) of `centre`, ±`dy`, nearest to `from` first. */
export function fortressFloors (view: BlockView, centre: V3, r: number, dy: number, from: V3, limit = 8): V3[] {
  const out: { c: V3; d: number }[] = []
  const [x0, y0, z0] = centre.map(Math.floor) as V3
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.hypot(dx, dz) > r) continue
      for (let y = y0 - dy; y <= y0 + dy; y++) {
        const c: V3 = [x0 + dx, y, z0 + dz]
        if (!FORTRESS_FLOOR.has(view.at(c[0], c[1] - 1, c[2]).name)) continue
        if (!safeStand(view, c, 1)) continue
        out.push({ c, d: Math.hypot(c[0] - from[0], c[1] - from[1], c[2] - from[2]) })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d || a.c[0] - b.c[0] || a.c[2] - b.c[2] || a.c[1] - b.c[1]).slice(0, limit).map(o => o.c)
}

/** Open sides (of 4) at feet and head level, and whether a solid block covers the head within 3. */
export function exposure (view: BlockView, c: V3): { open: number; roofed: boolean } {
  let open = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (view.at(c[0] + dx, c[1], c[2] + dz).kind !== 'solid' || view.at(c[0] + dx, c[1] + 1, c[2] + dz).kind !== 'solid') open++
  }
  let roofed = false
  for (let d = 2; d <= 4; d++) if (view.at(c[0], c[1] + d, c[2]).kind === 'solid') roofed = true
  return { open, roofed }
}

/**
 * Camp cells for a spawner: fortress-floor cells 2–5 blocks (horizontal) from it, feet within
 * 3 below to 1 above the spawner, no lava within 3, best first: roofed, fewer open sides,
 * closer to 3 blocks from the spawner.
 */
export function campCells (view: BlockView, spawner: V3, limit = 6): V3[] {
  const out: { c: V3; score: number }[] = []
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      const h = Math.hypot(dx, dz)
      if (h < 2 || h > 5) continue
      for (let dy = -3; dy <= 1; dy++) {
        const c: V3 = [spawner[0] + dx, spawner[1] + dy, spawner[2] + dz]
        if (!FORTRESS_FLOOR.has(view.at(c[0], c[1] - 1, c[2]).name) || !safeStand(view, c, 1) || lavaNear(view, c, 3) > 0) continue
        const e = exposure(view, c)
        out.push({ c, score: (e.roofed ? 0 : 3) + e.open + Math.abs(h - 3) + Math.abs(dy + 1) * 0.5 })
      }
    }
  }
  return out.sort((a, b) => a.score - b.score || a.c[0] - b.c[0] || a.c[2] - b.c[2] || a.c[1] - b.c[1]).slice(0, limit).map(o => o.c)
}

/** Distance from an eye point to an axis-aligned entity box (feet `pos`, width `w`, height `h`). */
export function eyeToBox (eye: V3, pos: V3, w: number, h: number): number {
  const half = w / 2
  const cx = Math.max(pos[0] - half, Math.min(eye[0], pos[0] + half))
  const cy = Math.max(pos[1], Math.min(eye[1], pos[1] + h))
  const cz = Math.max(pos[2] - half, Math.min(eye[2], pos[2] + half))
  return Math.hypot(eye[0] - cx, eye[1] - cy, eye[2] - cz)
}

/** Blaze hitbox (1.16.1 entity data). */
export const BLAZE_BOX = { w: 0.6, h: 1.8 } as const

/**
 * Where to stand to strike a hovering blaze: a standable cell whose eye (feet + 1.62) is within
 * reach of the blaze's box, nearest to the bot, within `maxFromBot` blocks of it. Null when none.
 */
export function strikeCell (view: BlockView, me: V3, blaze: V3, maxFromBot = 6): V3 | null {
  let best: { c: V3; d: number } | null = null
  const [bx, by, bz] = blaze
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -5; dy <= 1; dy++) {
        const c: V3 = [Math.floor(bx) + dx, Math.floor(by) + dy, Math.floor(bz) + dz]
        if (eyeToBox([c[0] + 0.5, c[1] + 1.62, c[2] + 0.5], [bx, by, bz], BLAZE_BOX.w, BLAZE_BOX.h) > REACH - 0.4) continue
        if (!safeStand(view, c, 1)) continue
        const d = Math.hypot(c[0] + 0.5 - me[0], c[1] - me[1], c[2] + 0.5 - me[2])
        if (d > maxFromBot) continue
        if (!best || d < best.d) best = { c, d }
      }
    }
  }
  return best?.c ?? null
}
