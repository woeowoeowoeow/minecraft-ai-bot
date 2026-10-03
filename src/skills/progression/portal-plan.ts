// Nether portal geometry for buildNetherPortal (milestone B). Pure: callers pass a
// BlockView, so site selection, cast order and bucket aiming are unit-testable.
//
// Frame layout in the portal plane (u along the frame, v up, d toward the work area):
//
//   v=4   c  T  T  c        T top, S side, B bottom: the 10 obsidian cells
//   v=3   S  .  .  S        .  interior (2×3, becomes nether_portal)
//   v=2   S  .  .  S        c  corners (never required)
//   v=1   S  .  .  S
//   v=0   c  B  B  c
//        u=0 1  2  3
//
// d = -1 is a solid back wall behind the whole 4×5 rectangle: every bucket is aimed at a
// back-wall face, through the target cell (a bucket's raytrace ignores fluids, so the ray
// passes through the water of the cast). d = 1 (5 high) and d = 2 (4 high) are the cleared
// work area with a solid floor; the bot stands at d = 1..2, v = 0.
import type { BlockView, Cell } from '../../nav/blocks.js'
import type { V3 } from '../../schema/index.js'

export type PortalGeom = { origin: V3; U: V3; F: V3 }

/** The four orientations: frame along x or z, work area on either side. */
export const ORIENTATIONS: { U: V3; F: V3 }[] = [
  { U: [1, 0, 0], F: [0, 0, 1] }, { U: [1, 0, 0], F: [0, 0, -1] },
  { U: [0, 0, 1], F: [1, 0, 0] }, { U: [0, 0, 1], F: [-1, 0, 0] },
]

export function cellAt (g: PortalGeom, u: number, v: number, d = 0): V3 {
  return [g.origin[0] + u * g.U[0] + d * g.F[0], g.origin[1] + v, g.origin[2] + u * g.U[2] + d * g.F[2]]
}

/**
 * Frame cells in cast order: top row first, then the sides downward, the bottom row last.
 * Casting top-down keeps every ray to a back-wall face clear: the cells a ray crosses
 * below its target are not obsidian yet (they are interior or still-empty frame cells).
 */
export const FRAME_UV: readonly (readonly [number, number])[] = [[1, 4], [2, 4], [0, 3], [3, 3], [0, 2], [3, 2], [0, 1], [3, 1], [1, 0], [2, 0]]
export const INTERIOR_UV: readonly (readonly [number, number])[] = [[1, 1], [2, 1], [1, 2], [2, 2], [1, 3], [2, 3]]
export const CORNER_UV: readonly (readonly [number, number])[] = [[0, 0], [3, 0], [0, 4], [3, 4]]

/**
 * Where the water goes while frame cell (u, v) is cast: a cell beside or above it (lava
 * next to water turns to obsidian, except water below), inside the back-walled rectangle.
 * In preference order; the caller skips any that is already solid.
 */
export function waterCandidates (u: number, v: number): [number, number][] {
  if (v === 4) return u === 1 ? [[2, 4], [0, 4]] : [[3, 4], [1, 4]]
  if (v === 0) return [[u, 1]]
  return u === 0 ? [[1, v], [0, v + 1]] : [[2, v], [3, v + 1]]
}

export type SitePlan = {
  geom: PortalGeom
  frame: V3[]
  interior: V3[]
  /** Must be air before casting (frame cells that are already obsidian are not listed). */
  clear: V3[]
  /** Must be solid: the back wall and the floor. */
  solid: V3[]
  /** Feet cells the bot works from. */
  stands: V3[]
  digs: number
  places: number
  existing: number
  /** Open cells bordering the site (approach routes and sight lines for mobs). */
  exposure: number
  cost: number
}

/** Cost of one open cell bordering the site, in dug blocks (a dig is ~0.5 s with an iron pickaxe). */
export const EXPOSURE_WEIGHT = 1

export type SiteOpts = {
  /** Known lava cells (pool sources) the site keeps its distance from. */
  lava?: V3[]
  /** Minimum horizontal (Chebyshev) distance from the frame and work area to any listed lava cell. */
  clearance?: number
  /** Cells the bot should not consider (blacklisted sites). */
  rejected?: (origin: V3) => boolean
  /** Dig time above which a block is impractical (ms). */
  maxDigMs?: number
}

const key = (c: readonly number[]) => c.join(',')
const N6: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

function liquid (c: Cell): boolean { return c.kind === 'water' || c.kind === 'lava' }

/** Every cell set of a site, independent of terrain. */
export function siteCells (g: PortalGeom): { frame: V3[]; interior: V3[]; front: V3[]; wall: V3[]; floor: V3[]; stands: V3[] } {
  const frame = FRAME_UV.map(([u, v]) => cellAt(g, u, v))
  // The top corners hold the cast water for the top row (waterCandidates): they are cleared
  // with the interior (bkit1 r02: in rock the corner stayed stone and the cast had no water cell).
  const interior = [...INTERIOR_UV, [0, 4], [3, 4]].map(([u, v]) => cellAt(g, u!, v!))
  const front: V3[] = []
  const wall: V3[] = []
  const floor: V3[] = []
  const stands: V3[] = []
  for (let u = 0; u < 4; u++) {
    for (let v = 0; v <= 4; v++) front.push(cellAt(g, u, v, 1))
    for (let v = 0; v <= 3; v++) front.push(cellAt(g, u, v, 2))
    for (let v = 0; v <= 4; v++) wall.push(cellAt(g, u, v, -1))
    for (let d = 0; d <= 2; d++) floor.push(cellAt(g, u, -1, d))
    stands.push(cellAt(g, u, 0, 2), cellAt(g, u, 0, 1))
  }
  return { frame, interior, front, wall, floor, stands }
}

/** Is this terrain usable for a portal at `g`, and what does it cost? Rejections carry a reason. */
export function evaluateSite (view: BlockView, g: PortalGeom, o: SiteOpts = {}): { ok: true; plan: SitePlan } | { ok: false; reason: string } {
  const maxDig = o.maxDigMs ?? 3000
  const c = siteCells(g)
  // Cheap rejections first: the floor the bot works on.
  for (const p of c.floor) {
    const f = view.at(...p)
    if (f.kind === 'unknown') return { ok: false, reason: 'unloaded' }
    if (liquid(f)) return { ok: false, reason: 'liquid under the site' }
    if (f.name === 'magma_block') return { ok: false, reason: 'harmful floor' }
  }
  const clearSet = new Set<string>()
  const clear: V3[] = []
  let digs = 0
  let existing = 0
  const frameKeys = new Set(c.frame.map(key))
  for (const p of [...c.frame, ...c.interior, ...c.front]) {
    const b = view.at(...p)
    if (b.kind === 'unknown') return { ok: false, reason: 'unloaded' }
    if (frameKeys.has(key(p)) && b.name === 'obsidian') { existing++; continue }
    if (liquid(b)) return { ok: false, reason: `${b.kind} in the site` }
    if (b.kind === 'harmful') return { ok: false, reason: `${b.name} in the site` }
    clearSet.add(key(p))
    clear.push(p)
    if (b.kind === 'solid') {
      if (!(b.digMs <= maxDig)) return { ok: false, reason: `${b.name} too hard to dig` }
      digs++
    }
  }
  // Nothing may flow or fall into the cleared cells. Open neighbours are exposure: a site cut
  // into rock has few, an open cave floor many (bkit2 r01: 4 deaths to cave mobs at a pool).
  const siteKeys = new Set([...clearSet, ...[...c.frame, ...c.interior, ...c.front].map(key)])
  const exposed = new Set<string>()
  for (const p of clear) {
    for (const [dx, dy, dz] of N6) {
      const q: V3 = [p[0] + dx, p[1] + dy, p[2] + dz]
      if (clearSet.has(key(q))) continue
      const b = view.at(...q)
      if (liquid(b)) return { ok: false, reason: `${b.kind} beside the site` }
      if (dy === 1 && b.gravity) return { ok: false, reason: `${b.name} above the site` }
      // Horizontal openings only: the sky above an open-air site is not an approach route.
      if (dy === 0 && b.kind === 'air' && !siteKeys.has(key(q))) exposed.add(key(q))
    }
  }
  let places = 0
  for (const p of [...c.wall, ...c.floor]) {
    const b = view.at(...p)
    if (b.kind === 'unknown') return { ok: false, reason: 'unloaded' }
    if (liquid(b)) return { ok: false, reason: `${b.kind} in the wall` }
    if (b.kind !== 'solid') places++
  }
  // Lava within 2 blocks of the floor, work area or frame (dev2 r03: a site at the lava level of
  // a large sheet; the walk back from the pool stepped into it, twice). Checked last: it is the
  // most expensive test and few candidates get this far.
  for (const p of [...c.floor, ...c.front, ...c.frame]) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (view.at(p[0] + dx, p[1] + dy, p[2] + dz).kind === 'lava') return { ok: false, reason: 'lava near the site' }
    }
  }
  const clearance = o.clearance ?? 0
  if (clearance > 0 && o.lava?.length) {
    for (const p of [...c.frame, ...c.interior, ...c.front]) {
      for (const l of o.lava) {
        if (Math.abs(l[1] - p[1]) <= 4 && Math.max(Math.abs(l[0] - p[0]), Math.abs(l[2] - p[2])) < clearance) return { ok: false, reason: 'too close to lava' }
      }
    }
  }
  const exposure = exposed.size
  const cost = digs + 2 * places - 0.5 * existing + EXPOSURE_WEIGHT * exposure
  return { ok: true, plan: { geom: g, frame: c.frame, interior: c.interior, clear, solid: [...c.wall, ...c.floor], stands: c.stands, digs, places, existing, exposure, cost } }
}

/**
 * Candidate sites around `center` (within `radius` horizontally, floor y within `dy`),
 * best first: build cost plus a quarter of the distance from the centre. Deterministic.
 */
export function findSites (view: BlockView, center: V3, radius: number, dy: number, o: SiteOpts = {}, limit = 5): { plan: SitePlan; score: number }[] {
  const out: { plan: SitePlan; score: number }[] = []
  const reasons: Record<string, number> = {}
  const [cx, cy, cz] = center.map(Math.floor) as V3
  for (let r = 0; r <= radius; r++) {
    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) !== r) continue
        for (let y = cy - dy; y <= cy + dy; y++) {
          for (const or of ORIENTATIONS) {
            const g: PortalGeom = { origin: [x, y, z], U: or.U, F: or.F }
            if (o.rejected?.(g.origin)) continue
            const e = evaluateSite(view, g, o)
            if (!e.ok) { reasons[e.reason] = (reasons[e.reason] ?? 0) + 1; continue }
            const mid = cellAt(g, 1.5, 0, 1)
            out.push({ plan: e.plan, score: e.plan.cost + 0.25 * Math.hypot(mid[0] - cx, mid[2] - cz) + Math.abs(y - cy) })
          }
        }
      }
    }
  }
  out.sort((a, b) => a.score - b.score || a.plan.geom.origin[0] - b.plan.geom.origin[0] || a.plan.geom.origin[2] - b.plan.geom.origin[2] || a.plan.geom.origin[1] - b.plan.geom.origin[1])
  lastRejections = reasons
  return out.slice(0, limit)
}

/** Rejection reasons of the last findSites call (diagnostics). */
export let lastRejections: Record<string, number> = {}

export type FrameStatus = { obsidian: number; missing: V3[]; blockers: V3[]; portal: number }

/** Frame cells still missing, interior cells that are not empty, and lit portal cells. */
export function frameStatus (view: BlockView, g: PortalGeom): FrameStatus {
  const missing: V3[] = []
  let obsidian = 0
  for (const [u, v] of FRAME_UV) {
    const p = cellAt(g, u, v)
    if (view.at(...p).name === 'obsidian') obsidian++
    else missing.push(p)
  }
  const blockers: V3[] = []
  let portal = 0
  for (const [u, v] of INTERIOR_UV) {
    const p = cellAt(g, u, v)
    const b = view.at(...p)
    if (b.name === 'nether_portal') portal++
    else if (b.kind !== 'air') blockers.push(p)
  }
  return { obsidian, missing, blockers, portal }
}

// ── Bucket raytrace (vanilla `Item.raycast`, 5 blocks, OUTLINE shapes) ────────

export type RayHit = { cell: V3; face: V3; dist: number }

/**
 * Voxel raytrace from `eye` along unit `dir` up to `max` blocks, as the server does for
 * a bucket: a full bucket ignores fluids and stops at the first block with an outline;
 * an empty bucket also stops at the first fluid *source*. Returns the hit cell and the
 * face entered (pointing back toward the eye), or null.
 */
export function bucketRay (view: BlockView, eye: V3, dir: V3, max: number, mode: 'place' | 'pickup'): RayHit | null {
  let x = Math.floor(eye[0]); let y = Math.floor(eye[1]); let z = Math.floor(eye[2])
  const step = dir.map(d => (d > 0 ? 1 : d < 0 ? -1 : 0)) as V3
  const tDelta = dir.map(d => (d !== 0 ? Math.abs(1 / d) : Infinity)) as V3
  const next = (p: number, c: number, s: number) => (s > 0 ? c + 1 - p : p - c)
  const tMax: V3 = [
    step[0] !== 0 ? next(eye[0], x, step[0]) * tDelta[0] : Infinity,
    step[1] !== 0 ? next(eye[1], y, step[1]) * tDelta[1] : Infinity,
    step[2] !== 0 ? next(eye[2], z, step[2]) * tDelta[2] : Infinity,
  ]
  for (let i = 0; i < 64; i++) {
    let axis: 0 | 1 | 2 = 0
    if (tMax[1] < tMax[axis]) axis = 1
    if (tMax[2] < tMax[axis]) axis = 2
    const t = tMax[axis]
    if (t > max) return null
    if (axis === 0) x += step[0]; else if (axis === 1) y += step[1]; else z += step[2]
    tMax[axis] += tDelta[axis]
    const c = view.at(x, y, z)
    if (c.kind === 'unknown') return null
    const face: V3 = [0, 0, 0]
    face[axis] = -step[axis]
    if (c.outline) return { cell: [x, y, z], face, dist: t }
    if (mode === 'pickup' && (c.kind === 'water' || c.kind === 'lava') && c.source) return { cell: [x, y, z], face, dist: t }
  }
  return null
}

export function add (a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
export function same (a: readonly number[], b: readonly number[]): boolean { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }

function unit (from: V3, to: V3): { dir: V3; len: number } {
  const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const len = Math.hypot(...d)
  return { dir: d.map(v => v / len) as V3, len }
}

/** Points on face `face` of `cell` (inset grid), centre first. */
function facePoints (cell: V3, face: V3): V3[] {
  const offs = [0.5, 0.25, 0.75, 0.15, 0.85]
  const pts: V3[] = []
  const axis = face[0] !== 0 ? 0 : face[1] !== 0 ? 1 : 2
  const [a1, a2] = ([0, 1, 2] as const).filter(i => i !== axis)
  for (const s of offs) {
    for (const t of offs) {
      const p: V3 = [cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5]
      p[axis] = cell[axis] + (face[axis] > 0 ? 1 : 0)
      p[a1!] = cell[a1!] + s
      p[a2!] = cell[a2!] + t
      pts.push(p)
    }
  }
  return pts
}

/** Look point for placing a fluid into `target` from `eye`: a solid neighbour's face whose ray lands the fluid there. */
export function aimPlace (view: BlockView, eye: V3, target: V3, max = 4.8): V3 | null {
  for (const n of N6) {
    const ref = add(target, n)
    if (!view.at(...ref).outline) continue
    const face: V3 = [-n[0], -n[1], -n[2]]
    for (const pt of facePoints(ref, face)) {
      const { dir, len } = unit(eye, pt)
      if (len > max) continue
      const hit = bucketRay(view, eye, dir, max, 'place')
      if (hit && same(hit.cell, ref) && same(add(hit.cell, hit.face), target)) return pt
    }
  }
  return null
}

/** Look point for picking up the fluid source at `target` from `eye`. */
export function aimPickup (view: BlockView, eye: V3, target: V3, max = 4.8): V3 | null {
  const pts: V3[] = []
  for (const fy of [0.85, 0.5, 0.2]) for (const [fx, fz] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]] as const) pts.push([target[0] + fx, target[1] + fy, target[2] + fz])
  for (const pt of pts) {
    const { dir, len } = unit(eye, pt)
    if (len > max) continue
    const hit = bucketRay(view, eye, dir, max, 'pickup')
    if (hit && same(hit.cell, target)) return pt
  }
  return null
}

// ── Lava pool access (lava cast) ────────────────────────────────────────────

/** Diagnostics of the last lavaAccess call. */
export let lastAccess = { sources: 0, open: 0 }

/** Connected lava from `start` (6-neighbour, bounded): every lava cell and the source cells among them. */
export function poolCells (view: BlockView, start: V3, max = 4000): { lava: V3[]; sources: V3[] } {
  const seen = new Set<string>([key(start)])
  const queue: V3[] = [start]
  const lava: V3[] = []
  const sources: V3[] = []
  for (let i = 0; i < queue.length && lava.length < max; i++) {
    const c = queue[i]!
    const b = view.at(...c)
    if (b.kind !== 'lava') continue
    lava.push(c)
    if (b.source) sources.push(c)
    for (const [dx, dy, dz] of N6) {
      const n: V3 = [c[0] + dx, c[1] + dy, c[2] + dz]
      if (seen.has(key(n))) continue
      seen.add(key(n))
      queue.push(n)
    }
  }
  return { lava, sources }
}

const HARMFUL_FLOOR = new Set(['magma_block', 'campfire', 'soul_campfire'])

/**
 * Where to stand to fill a bucket from the pool: standable cells (solid, harmless floor;
 * empty feet and head) with no lava within one block (any of 2 below to 2 above), from
 * which the empty-bucket ray reaches an open source (air above it). Nearest to `from`
 * first. Each entry pairs a stand with the source it reaches.
 */
export function lavaAccess (view: BlockView, sources: V3[], from: V3, eyeHeight = 1.62, limit = 8): { stand: V3; source: V3 }[] {
  const out: { stand: V3; source: V3; d: number }[] = []
  const seen = new Set<string>()
  const dist = (c: V3) => Math.hypot(c[0] - from[0], c[1] - from[1], c[2] - from[2])
  const open = sources.filter(s => view.at(s[0], s[1] + 1, s[2]).kind === 'air').sort((a, b) => dist(a) - dist(b)).slice(0, 40)
  lastAccess = { sources: sources.length, open: open.length }
  for (const s of open) {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dy = 0; dy <= 3; dy++) {
          const p: V3 = [s[0] + dx, s[1] + dy, s[2] + dz]
          if (seen.has(key(p))) continue
          const floor = view.at(p[0], p[1] - 1, p[2])
          if (floor.kind !== 'solid' || HARMFUL_FLOOR.has(floor.name)) continue
          if (view.at(...p).kind !== 'air' || view.at(p[0], p[1] + 1, p[2]).kind !== 'air') continue
          // Tier 0: no lava within a block (any of 2 below to 2 above). Tier 1 (shore): lava may lie
          // diagonally or below, but never beside the feet or head and never under the floor
          // (bkit1 r02: the strict rule ran out of reachable sources after a few fetches).
          let near = false
          for (let ax = -1; ax <= 1 && !near; ax++) for (let az = -1; az <= 1 && !near; az++) for (let ay = -2; ay <= 2 && !near; ay++) if (view.at(p[0] + ax, p[1] + ay, p[2] + az).kind === 'lava') near = true
          if (near) {
            if (view.at(p[0], p[1] - 1, p[2]).kind === 'lava') continue
            let beside = false
            for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]] as const) for (const ay of [0, 1, 2]) if (view.at(p[0] + ax, p[1] + ay, p[2] + az).kind === 'lava') beside = true
            if (beside) continue
          }
          const eye: V3 = [p[0] + 0.5, p[1] + eyeHeight, p[2] + 0.5]
          if (!aimPickup(view, eye, s, 4.8)) continue
          seen.add(key(p))
          out.push({ stand: p, source: s, d: Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]) + (near ? 16 : 0) })
        }
      }
    }
  }
  return out.sort((a, b) => a.d - b.d || a.stand[0] - b.stand[0] || a.stand[2] - b.stand[2]).slice(0, limit).map(({ stand, source }) => ({ stand, source }))
}

/**
 * Can a remembered, partly built site still be finished? Obsidian or lava where no frame
 * cell is (a misplaced cast) cannot be dug with an iron pickaxe or safely cleared.
 */
export function resumeCheck (view: BlockView, g: PortalGeom): { ok: true } | { ok: false; reason: string } {
  const c = siteCells(g)
  for (const p of [...c.interior, ...c.front]) {
    const b = view.at(...p)
    if (b.kind === 'unknown') return { ok: false, reason: 'unloaded' }
    if (b.name === 'obsidian') return { ok: false, reason: 'obsidian outside the frame' }
    if (b.kind === 'lava') return { ok: false, reason: 'lava in the site' }
  }
  for (const p of c.frame) if (view.at(...p).kind === 'lava') return { ok: false, reason: 'lava in a frame cell' }
  return { ok: true }
}

/** Geometry ↔ memory detail (portal sites and built portals are remembered by the bot). */
export function geomDetail (g: PortalGeom): Record<string, number> {
  return { ox: g.origin[0], oy: g.origin[1], oz: g.origin[2], ux: g.U[0], uz: g.U[2], fx: g.F[0], fz: g.F[2] }
}
export function geomFrom (d: Record<string, unknown> | undefined): PortalGeom | null {
  if (!d || typeof d.ox !== 'number') return null
  return { origin: [Number(d.ox), Number(d.oy), Number(d.oz)], U: [Number(d.ux), 0, Number(d.uz)], F: [Number(d.fx), 0, Number(d.fz)] }
}
export function planFor (g: PortalGeom): SitePlan {
  const c = siteCells(g)
  return { geom: g, frame: c.frame, interior: c.interior, clear: [...c.frame, ...c.interior, ...c.front], solid: [...c.wall, ...c.floor], stands: c.stands, digs: 0, places: 0, existing: 0, exposure: 0, cost: 0 }
}
