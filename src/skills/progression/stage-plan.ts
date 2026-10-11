// Where the C staging puts its bed and kit chest beside the Overworld portal (after ckit-r2d r02:
// `setSpawnBed` stood inside the portal, placed the bed 3 blocks up — out of the 1.16.1 bed range
// of 2 blocks vertically, so no respawn point — and the bot was teleported). Pure geometry over a
// BlockView: never a portal cell, never the two cells in front of or behind the opening (the
// step-in lanes), the bed's foot and head on solid floor with room above (1.16.1 `isBedObstructed`
// checks the cells above both halves), and a stand cell behind the foot so that looking at the
// foot's floor faces the bed's direction (the server takes the bed's facing from the player's yaw).
import type { V3 } from '../../schema/index.js'
import type { BlockView } from '../../nav/blocks.js'

export type StageSite = {
  /** The cell the block goes into (the bed's foot). */
  cell: V3
  /** Bed direction (foot → head), null for a chest. */
  dir: [number, number] | null
  /** Where the bot stands to place it (and to use it). */
  stand: V3
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const key = (c: readonly number[]) => c.join(',')

/** The portal opening's normal: the axis the bot walks along to step in. */
export function portalNormal (cells: V3[]): [number, number] {
  return cells.every(c => c[0] === cells[0]![0]) && !cells.every(c => c[2] === cells[0]![2]) ? [1, 0] : [0, 1]
}

/** Portal cells and the step-in lanes (1 and 2 cells in front of and behind every portal cell). */
export function portalKeepOut (cells: V3[]): Set<string> {
  const [nx, nz] = portalNormal(cells)
  const out = new Set<string>()
  const bottom = Math.min(...cells.map(c => c[1]))
  for (const c of cells) {
    out.add(key(c))
    for (const k of [-2, -1, 1, 2]) {
      // The lanes at every opening height and one below (the floor the bot walks in on is kept clear of beds and chests).
      for (let y = bottom - 1; y <= bottom + 2; y++) out.add(key([c[0] + nx * k, y, c[2] + nz * k]))
    }
  }
  return out
}

const air = (v: BlockView, c: V3) => v.at(c[0], c[1], c[2]).kind === 'air' && v.at(c[0], c[1], c[2]).name !== 'nether_portal'
const floorOk = (v: BlockView, c: V3) => {
  const f = v.at(c[0], c[1] - 1, c[2])
  return f.kind === 'solid' && !f.gravity && !/_bed$|chest|magma/.test(f.name)
}
const wet = (v: BlockView, c: V3) => [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].some(([dx, dy, dz]) => {
  const k = v.at(c[0] + dx!, c[1] + dy!, c[2] + dz!).kind
  return k === 'lava' || k === 'water'
})
/** A cell a block can go into: air with air above, solid non-gravity floor, nothing liquid around. */
function slot (v: BlockView, c: V3, keep: Set<string>, avoid: Set<string>): boolean {
  return !keep.has(key(c)) && !avoid.has(key(c)) && air(v, c) && air(v, [c[0], c[1] + 1, c[2]]) && floorOk(v, c) && !wet(v, c)
}
/** A cell the bot can stand in: air at feet and head, solid floor, outside the portal and its lanes. */
function standOk (v: BlockView, c: V3, keep: Set<string>, avoid: Set<string>): boolean {
  return !keep.has(key(c)) && !avoid.has(key(c)) && air(v, c) && air(v, [c[0], c[1] + 1, c[2]]) && floorOk(v, c) && !wet(v, c)
}

/**
 * Sites for a bed (`bed`) or a chest beside the portal, best first: within `near` blocks of the
 * portal's centre, at the opening's floor level ±1, beside the frame rather than in front of it.
 * `avoid` holds cells already taken (the bed's two cells when the chest is placed).
 */
export function stageSites (v: BlockView, cells: V3[], o: { bed: boolean; near: number; avoid?: V3[] }): StageSite[] {
  if (!cells.length) return []
  const keep = portalKeepOut(cells)
  const avoid = new Set((o.avoid ?? []).map(key))
  const [nx, nz] = portalNormal(cells)
  const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length
  const cz = cells.reduce((a, c) => a + c[2], 0) / cells.length
  const bottom = Math.min(...cells.map(c => c[1]))
  const out: { s: StageSite; score: number }[] = []
  const R = Math.ceil(o.near)
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let y = bottom - 1; y <= bottom + 1; y++) {
        const c: V3 = [Math.floor(cx) + dx, y, Math.floor(cz) + dz]
        const d = Math.hypot(c[0] + 0.5 - cx, c[2] + 0.5 - cz)
        if (d > o.near || d < 1.5) continue
        if (!slot(v, c, keep, avoid)) continue
        // Distance out along the normal (in front of or behind the opening) costs more than along the frame.
        const front = Math.abs((c[0] + 0.5 - cx) * nx + (c[2] + 0.5 - cz) * nz)
        const score = d + 1.5 * front + Math.abs(y - bottom) * 0.5
        if (o.bed) {
          for (const [ddx, ddz] of DIRS) {
            const head: V3 = [c[0] + ddx, y, c[2] + ddz]
            const stand: V3 = [c[0] - ddx, y, c[2] - ddz]
            if (!slot(v, head, keep, avoid) || !standOk(v, stand, keep, new Set([...avoid, key(head)]))) continue
            out.push({ s: { cell: c, dir: [ddx, ddz], stand }, score })
          }
        } else {
          for (const [ddx, ddz] of DIRS) {
            const stand: V3 = [c[0] - ddx, y, c[2] - ddz]
            if (!standOk(v, stand, keep, avoid)) continue
            out.push({ s: { cell: c, dir: null, stand }, score })
            break
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.score - b.score).map(x => x.s)
}

/** 1.16.1 bed messages (action bar). The respawn point is set before the night and monster checks. */
export type BedAnswer = 'set' | 'too_far' | 'obstructed' | 'occupied' | 'none'
export function bedAnswer (msgs: string[], sleeping: boolean): BedAnswer {
  const all = msgs.join(' | ').toLowerCase()
  // "Respawn point set" is sent only when the point changes; "You can sleep only at night" and
  // "You may not rest now; there are monsters nearby" come after `setSpawnPoint` in
  // ServerPlayerEntity.trySleep (1.16.1), so each of them means the point is this bed.
  if (sleeping || /respawn point set|sleep only at night|monsters nearby/.test(all)) return 'set'
  if (/too far away/.test(all)) return 'too_far'
  if (/obstructed/.test(all)) return 'obstructed'
  if (/occupied/.test(all)) return 'occupied'
  return 'none'
}
