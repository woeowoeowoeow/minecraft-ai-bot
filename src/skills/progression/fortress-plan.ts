// Fortress search planning for milestone C (pure). The 1.16.1 Nether places one
// structure attempt per 27×27-chunk region, at a start chunk within the region's first
// 23×23 chunks (the 4-chunk separation), and that attempt is either a fortress or a
// bastion (shared placement, fixed game rule). The structure census (evaluation.md,
// milestone C) confirmed it on 20 fresh seeds: 828 structures, every start chunk at
// region offset 0–22, never two structures in one region, ~36–41 % fortresses.
//
// This is the game's generation rule, not a seed lookup: the bot never knows where a
// start chunk is, only which areas could hold one. A region is resolved when the bot
// has seen most of its candidate zone (loaded chunks) or has seen a bastion there; the
// search heads for the unresolved zone with the most unseen area per block of travel.
// Fortress detection itself is the observer's: nether bricks in loaded chunks.
import progression from '../../../config/progression.json' with { type: 'json' }
import type { V3 } from '../../schema/index.js'

const C = progression.C
export const REGION = { chunks: C.regionChunks, zone: C.zoneChunks } as const

/** Region index of a chunk coordinate (floor division, negative-safe). */
export function regionOfChunk (c: number): number {
  return Math.floor(c / REGION.chunks)
}

export function regionOfBlock (x: number, z: number): [number, number] {
  return [regionOfChunk(Math.floor(x / 16)), regionOfChunk(Math.floor(z / 16))]
}

/** Candidate start-chunk zone of a region, in chunk coordinates (inclusive). */
export function zoneChunks (rx: number, rz: number): { cx0: number; cz0: number; cx1: number; cz1: number } {
  return { cx0: rx * REGION.chunks, cz0: rz * REGION.chunks, cx1: rx * REGION.chunks + REGION.zone - 1, cz1: rz * REGION.chunks + REGION.zone - 1 }
}

/** Block-space centre of a region's zone. */
export function zoneCentre (rx: number, rz: number): [number, number] {
  const z = zoneChunks(rx, rz)
  return [((z.cx0 + z.cx1 + 1) / 2) * 16, ((z.cz0 + z.cz1 + 1) / 2) * 16]
}

/** Horizontal distance from a block position to a region's zone rectangle (0 inside). */
export function distToZone (x: number, z: number, rx: number, rz: number): number {
  const q = zoneChunks(rx, rz)
  const dx = Math.max(q.cx0 * 16 - x, 0, x - (q.cx1 * 16 + 15))
  const dz = Math.max(q.cz0 * 16 - z, 0, z - (q.cz1 * 16 + 15))
  return Math.hypot(dx, dz)
}

/**
 * The region a bastion seen at `pos` belongs to: the zone it lies in, else the nearest zone
 * within `margin` blocks (bastion pieces extend a few chunks from their start). Null if none.
 */
export function attributeStructure (pos: V3, margin = 48): [number, number] | null {
  const [rx0, rz0] = regionOfBlock(pos[0], pos[2])
  let best: { r: [number, number]; d: number } | null = null
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const d = distToZone(pos[0], pos[2], rx0 + dx, rz0 + dz)
      if (d <= margin && (!best || d < best.d)) best = { r: [rx0 + dx, rz0 + dz], d }
    }
  }
  return best?.r ?? null
}

export type RegionStatus = { rx: number; rz: number; unexplored: number; total: number; bastion: boolean; centroid: [number, number] | null }

/** Unexplored share of each zone and its unexplored centroid (chunk keys "cx,cz" of loaded chunks). */
export function regionStatus (rx: number, rz: number, isExplored: (cx: number, cz: number) => boolean, bastions: V3[]): RegionStatus {
  const q = zoneChunks(rx, rz)
  let unexplored = 0
  let sx = 0
  let sz = 0
  for (let cx = q.cx0; cx <= q.cx1; cx++) {
    for (let cz = q.cz0; cz <= q.cz1; cz++) {
      if (isExplored(cx, cz)) continue
      unexplored++
      sx += cx * 16 + 8
      sz += cz * 16 + 8
    }
  }
  const bastion = bastions.some(b => { const r = attributeStructure(b); return !!r && r[0] === rx && r[1] === rz })
  return { rx, rz, unexplored, total: REGION.zone * REGION.zone, bastion, centroid: unexplored ? [sx / unexplored, sz / unexplored] : null }
}

/** A zone counts as searched once this share of it has been loaded. */
export const RESOLVED_SHARE = 0.9

export type SearchChoice = { target: [number, number]; region: [number, number]; value: number; dist: number; unexplored: number }

/** A heading (radians, atan2(dz, dx)) failed from near `pos` recently: avoid it from there. */
export type FailedHeading = { pos: V3; heading: number; t: number }

export const SEARCH_FAIL = { r: 48, arc: Math.PI / 5, ttlS: 600 } as const

export function blockedHeading (failed: FailedHeading[], pos: V3, heading: number, now: number): boolean {
  return failed.some(f => now - f.t <= SEARCH_FAIL.ttlS && Math.hypot(f.pos[0] - pos[0], f.pos[2] - pos[2]) <= SEARCH_FAIL.r &&
    Math.abs(angleDiff(f.heading, heading)) <= SEARCH_FAIL.arc)
}

export function angleDiff (a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return d
}

/**
 * The next region to search: among zones within `maxR` of `origin` (the arrival portal) that
 * are not resolved (bastion seen, or ≥ RESOLVED_SHARE loaded), the one whose unseen area per
 * block of travel is largest. The target is its unseen centroid; deterministic tie-breaks.
 */
export function chooseRegion (pos: V3, origin: V3, isExplored: (cx: number, cz: number) => boolean, bastions: V3[], maxR: number): SearchChoice | null {
  const [ox, oz] = regionOfBlock(origin[0], origin[2])
  const span = Math.ceil(maxR / (REGION.chunks * 16)) + 1
  let best: SearchChoice | null = null
  for (let rx = ox - span; rx <= ox + span; rx++) {
    for (let rz = oz - span; rz <= oz + span; rz++) {
      if (distToZone(origin[0], origin[2], rx, rz) > maxR) continue
      const st = regionStatus(rx, rz, isExplored, bastions)
      if (st.bastion || !st.centroid || st.unexplored < (1 - RESOLVED_SHARE) * st.total) continue
      const dist = Math.hypot(st.centroid[0] - pos[0], st.centroid[1] - pos[2])
      const value = st.unexplored / (dist + 96)
      if (!best || value > best.value + 1e-9 || (Math.abs(value - best.value) <= 1e-9 && (rx < best.region[0] || (rx === best.region[0] && rz < best.region[1])))) {
        best = { target: st.centroid, region: [rx, rz], value, dist, unexplored: st.unexplored }
      }
    }
  }
  return best
}

/**
 * Axis sweep (the alternate strategy): the cardinal direction from `pos` with the most unseen
 * chunks in a 96-block-wide band out to `reach`, avoiding failed headings; null if all are seen.
 */
export function chooseAxis (pos: V3, isExplored: (cx: number, cz: number) => boolean, reach: number, blocked: (h: number) => boolean): { heading: number; unexplored: number } | null {
  let best: { heading: number; unexplored: number } | null = null
  for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    if (blocked(heading)) continue
    const [dx, dz] = [Math.cos(heading), Math.sin(heading)]
    let unexplored = 0
    for (let d = 32; d <= reach; d += 16) {
      for (let w = -48; w <= 48; w += 16) {
        const x = pos[0] + dx * d - dz * w
        const z = pos[2] + dz * d + dx * w
        if (!isExplored(Math.floor(x / 16), Math.floor(z / 16))) unexplored++
      }
    }
    if (unexplored && (!best || unexplored > best.unexplored)) best = { heading, unexplored }
  }
  return best
}

/**
 * Leg target: at most `leg` blocks from `pos` toward `target`, turned by the smallest of
 * ±30°, ±60°, ±90° when the straight heading failed recently from here. Null when every
 * heading is blocked.
 */
export function legToward (pos: V3, target: [number, number], leg: number, blocked: (h: number) => boolean): { to: [number, number]; heading: number } | null {
  const base = Math.atan2(target[1] - pos[2], target[0] - pos[0])
  const d = Math.min(leg, Math.hypot(target[0] - pos[0], target[1] - pos[2]))
  for (const turn of [0, 1, -1, 2, -2, 3, -3]) {
    const h = base + (turn * Math.PI) / 6
    if (blocked(h)) continue
    return { to: [Math.round(pos[0] + Math.cos(h) * Math.max(d, 16)), Math.round(pos[2] + Math.sin(h) * Math.max(d, 16))], heading: h }
  }
  return null
}
