// Nether movement planning for milestone B (pure over a BlockView): where a
// controlled excursion away from the arrival portal may go, and how hazardous the
// arrival is. Nether terrain kills through lava, fire and drops, so targets are
// standable cells with no lava near them; the navigator's `nether` profile keeps
// the path itself away from lava.
import type { BlockView } from '../../nav/blocks.js'
import type { V3 } from '../../schema/index.js'

const HARMFUL_FLOOR = new Set(['magma_block', 'campfire', 'soul_campfire'])

/** Lava cells within `r` (horizontal Chebyshev) of the column at `p`, from 2 below to 2 above the feet. */
export function lavaNear (view: BlockView, p: V3, r: number): number {
  let n = 0
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -2; dy <= 2; dy++) if (view.at(p[0] + dx, p[1] + dy, p[2] + dz).kind === 'lava') n++
    }
  }
  return n
}

/** Feet cell `p` can be stood in: solid harmless floor, feet and head empty and not liquid or fire. */
export function standable (view: BlockView, p: V3): boolean {
  const floor = view.at(p[0], p[1] - 1, p[2])
  const feet = view.at(p[0], p[1], p[2])
  const head = view.at(p[0], p[1] + 1, p[2])
  return floor.kind === 'solid' && !HARMFUL_FLOOR.has(floor.name) && feet.kind === 'air' && head.kind === 'air'
}

/** Standable with no lava within `r` blocks and no drop of more than 3 beside it. */
export function safeStand (view: BlockView, p: V3, r = 2): boolean {
  if (!standable(view, p) || lavaNear(view, p, r) > 0) return false
  // A drop beside the cell (a cliff edge) is a fall risk if it is deeper than 3 blocks.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    let depth = 0
    while (depth <= 4 && view.at(p[0] + dx, p[1] - 1 - depth, p[2] + dz).kind === 'air') depth++
    if (depth > 3) return false
  }
  return true
}

/**
 * Excursion targets at `minDist`..`minDist + 8` blocks (horizontal) from the portal,
 * within 4 blocks of its height: safe standable cells, one per 45° sector, best first
 * (fewest lava cells within 4, smallest height change). Deterministic.
 */
export function excursionTargets (view: BlockView, portal: V3, minDist: number, limit = 6): V3[] {
  const best = new Map<number, { p: V3; score: number }>()
  const R = minDist + 8
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      const d = Math.hypot(dx, dz)
      if (d < minDist || d > R) continue
      for (let dy = -4; dy <= 4; dy++) {
        const p: V3 = [portal[0] + dx, portal[1] + dy, portal[2] + dz]
        if (!safeStand(view, p)) continue
        const score = lavaNear(view, p, 4) * 2 + Math.abs(dy) + (d - minDist) * 0.2
        const sector = (Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8
        const cur = best.get(sector)
        if (!cur || score < cur.score) best.set(sector, { p, score })
      }
    }
  }
  return [...best.values()].sort((a, b) => a.score - b.score || a.p[0] - b.p[0] || a.p[2] - b.p[2]).slice(0, limit).map(b => b.p)
}

/** A tunnel never digs a block slower than this with the carried tools (obsidian, bedrock). */
export const TUNNEL_MAX_DIG_MS = 3000

/**
 * Tunnel fallback: targets `minDist` + 2 blocks away at the portal's feet level, one per
 * cardinal direction whose straight line is lava-free, loaded, and diggable (no block slower
 * than TUNNEL_MAX_DIG_MS: the arrival portal's own obsidian frame and its portal blocks lie
 * on one of these lines; b3-dev1 r05 chose it 14 times). Most solid rock first (netherrack
 * digs fast and a 2-high tunnel never crosses an open drop). Empty if every line is blocked.
 */
export function tunnelTargets (view: BlockView, portal: V3, minDist: number): V3[] {
  const out: { p: V3; solid: number }[] = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    let solid = 0
    let ok = true
    for (let i = 1; i <= minDist + 2 && ok; i++) {
      const x = portal[0] + dx * i
      const z = portal[2] + dz * i
      for (let dy = -1; dy <= 2; dy++) {
        const c = view.at(x, portal[1] + dy, z)
        if (c.kind === 'lava' || c.kind === 'unknown' || c.name === 'nether_portal') ok = false
        // The floor row (dy −1) is stood on, not dug.
        if (dy >= 0 && c.kind === 'solid' && !(c.digMs <= TUNNEL_MAX_DIG_MS)) ok = false
        if (c.kind === 'solid') solid++
      }
      if (lavaNear(view, [x, portal[1], z], 1) > 0) ok = false
    }
    if (ok) out.push({ p: [portal[0] + dx * (minDist + 2), portal[1], portal[2] + dz * (minDist + 2)], solid })
  }
  return out.sort((a, b) => b.solid - a.solid).map(x => x.p)
}

/** The best tunnel target (tunnelTargets), or null. */
export function tunnelTarget (view: BlockView, portal: V3, minDist: number): V3 | null {
  return tunnelTargets(view, portal, minDist)[0] ?? null
}

/** Arrival assessment: lava within 3 blocks, safe standable cells within 4, and whether any exist. */
export function arrivalHazards (view: BlockView, at: V3): { lava: number; safeCells: number; safe: boolean } {
  const p = at.map(Math.floor) as V3
  const lava = lavaNear(view, p, 3)
  let safeCells = 0
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -2; dy <= 2; dy++) if (safeStand(view, [p[0] + dx, p[1] + dy, p[2] + dz])) safeCells++
  return { lava, safeCells, safe: safeCells > 0 }
}
