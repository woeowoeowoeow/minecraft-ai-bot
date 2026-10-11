// Water handling helpers (pathfinder-agnostic): shoreline exits and route checks.
import type { V3 } from '../schema/index.js'
import type { BlockView } from './blocks.js'

export type WaterExit = {
  /** Feet cell to stand in on the shore. */
  stand: V3
  /** Water surface cell to swim to before climbing out. */
  from: V3
  /** 'flush': shore top is level with the water top (a plain jump out).
   *  'ledge': shore is one block higher; the lip must be dug first (physics cannot climb it).
   *  'notch': a wall at least two blocks above the water (an iceberg): the lip and the cell above
   *  it are dug, and the bot stands in the notch on the block level with the water top. */
  kind: 'flush' | 'ledge' | 'notch'
  dist: number
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** A dry cell the bot can stand in: solid floor, two passable cells, nothing liquid or harmful. */
export function standable (view: BlockView, x: number, y: number, z: number): boolean {
  const floor = view.at(x, y - 1, z)
  return floor.kind === 'solid' && view.at(x, y, z).kind === 'air' && view.at(x, y + 1, z).kind === 'air'
}

/** Water cell with open air above: where a swimming bot floats. */
export function surfaceCell (view: BlockView, x: number, y: number, z: number): boolean {
  return view.at(x, y, z).kind === 'water' && view.at(x, y + 1, z).kind === 'air'
}

/** Ice turns into water when broken over a solid or liquid block (1.16.1 IceBlock.afterBreak): never dug for an exit. */
const MELTS = new Set(['ice', 'frosted_ice'])
const diggable = (c: { kind: string; name: string; gravity: boolean; digMs: number }, maxMs: number) => c.kind === 'solid' && !c.gravity && !MELTS.has(c.name) && c.digMs <= maxMs

/**
 * Shore exits within `radius` of `pos`, best first: flush exits, then ledge exits, then notches,
 * each by distance. A ledge exit needs its lip (the shore block level with the bot's head) to be
 * diggable in reasonable time; a notch needs the lip and the block above it (an iceberg or snow
 * wall rising two or more blocks above the water, ckit-r2d r01), no water or lava behind them,
 * and nothing that falls into it.
 */
export function findWaterExits (view: BlockView, pos: V3, radius = 12, maxLipDigMs = 1500): WaterExit[] {
  const out: WaterExit[] = []
  const [px, py, pz] = pos.map(Math.floor) as V3
  const wetAround = (x: number, y: number, z: number, fromX: number, fromZ: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    if (x + dx! === fromX && z + dz! === fromZ) return false
    const k = view.at(x + dx!, y, z + dz!).kind
    return k === 'water' || k === 'lava'
  })
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -3; dy <= 2; dy++) {
        const x = px + dx
        const y = py + dy
        const z = pz + dz
        if (!surfaceCell(view, x, y, z)) continue
        for (const [ex, ez] of DIRS) {
          const sx = x + ex
          const sz = z + ez
          const dist = Math.hypot(dx, dz)
          if (standable(view, sx, y + 1, sz)) {
            out.push({ stand: [sx, y + 1, sz], from: [x, y, z], kind: 'flush', dist })
            continue
          }
          if (view.at(sx, y, sz).kind !== 'solid' || view.at(x, y + 2, z).kind !== 'air') continue
          const lip = view.at(sx, y + 1, sz)
          if (lip.digMs > maxLipDigMs) continue
          if (standable(view, sx, y + 2, sz)) {
            out.push({ stand: [sx, y + 1, sz], from: [x, y, z], kind: 'ledge', dist })
            continue
          }
          const cap = view.at(sx, y + 2, sz)
          if (diggable(lip, maxLipDigMs) && diggable(cap, maxLipDigMs) && !wetAround(sx, y + 1, sz, x, z) && !wetAround(sx, y + 2, sz, x, z) && !view.at(sx, y + 3, sz).gravity && view.at(sx, y + 3, sz).kind !== 'water' && view.at(sx, y + 3, sz).kind !== 'lava') {
            out.push({ stand: [sx, y + 1, sz], from: [x, y, z], kind: 'notch', dist })
          }
        }
      }
    }
  }
  const rank = { flush: 0, ledge: 1, notch: 2 } as const
  out.sort((a, b) => (a.kind === b.kind ? a.dist - b.dist : rank[a.kind] - rank[b.kind]))
  return out
}

/** Longest run of consecutive water nodes on a planned path. */
export function longestWaterRun (path: V3[], isWater: (p: V3) => boolean): number {
  let best = 0
  let run = 0
  for (const p of path) {
    run = isWater(p) ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best
}

const DIRS6: [number, number, number][] = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]

/**
 * Route (cell centres, excluding the start) through connected water from `pos`
 * to the nearest water cell with open air above: the way up when the bot is
 * under an overhang or a ceiling. Breadth-first, bounded; null if none.
 */
export function routeToAir (view: BlockView, pos: V3, maxNodes = 600): V3[] | null {
  const start = pos.map(Math.floor) as V3
  const key = (c: V3) => c.join(',')
  const prev = new Map<string, string | null>([[key(start), null]])
  const queue: V3[] = [start]
  for (let i = 0; i < queue.length && prev.size < maxNodes; i++) {
    const c = queue[i]!
    if (i > 0 && surfaceCell(view, ...c)) {
      const out: V3[] = []
      for (let k: string | null = key(c); k && k !== key(start); k = prev.get(k) ?? null) out.unshift(k.split(',').map(Number) as V3)
      return out
    }
    for (const [dx, dy, dz] of DIRS6) {
      const n: V3 = [c[0] + dx, c[1] + dy, c[2] + dz]
      if (prev.has(key(n)) || view.at(...n).kind !== 'water') continue
      prev.set(key(n), key(c))
      queue.push(n)
    }
  }
  return null
}

/** Where excavation may start: here, at the nearest dry cell, or nowhere within reach. */
export type DryStart =
  | { kind: 'already_dry' }
  | { kind: 'found'; pos: V3 }
  | { kind: 'none'; radius: number }

/**
 * Where to start excavating: standable, nothing liquid in or around the body or
 * under the floor. `already_dry` if `pos` qualifies, else the nearest such cell
 * within `radius` (`found`), else `none` (e.g. open ocean): never start in water.
 */
export function dryStart (view: BlockView, pos: V3, radius = 12, exclude: (c: V3) => boolean = () => false): DryStart {
  const ok = (x: number, y: number, z: number) => {
    if (!standable(view, x, y, z)) return false
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -2, 0]] as const) {
      for (const h of [0, 1]) {
        const k = view.at(x + dx, y + dy + (dy === 0 ? h : 0), z + dz).kind
        if (k === 'water' || k === 'lava') return false
      }
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = view.at(x + dx, y - 1, z + dz).kind
      if (k === 'water' || k === 'lava') return false
    }
    return true
  }
  const [px, py, pz] = pos.map(Math.floor) as V3
  if (ok(px, py, pz)) return { kind: 'already_dry' }
  let best: V3 | null = null
  let bestD = Infinity
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -3; dy <= 4; dy++) {
        const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5
        if (d >= bestD) continue
        if (ok(px + dx, py + dy, pz + dz) && !exclude([px + dx, py + dy, pz + dz])) { best = [px + dx, py + dy, pz + dz]; bestD = d }
      }
    }
  }
  return best ? { kind: 'found', pos: best } : { kind: 'none', radius }
}
