// Natural-tree check for wood targets (round-3 gate 20261004 r02/r08: the wide log scan and
// the tree spots accepted shipwreck timbers on the sea floor at y 36–50, and the bot swam
// among drowned to reach them: 8 deaths). A log counts as wood only when its trunk stands
// like a grown tree: grounded on soil (or on nothing, once its foot was chopped), not under
// or ringed by water, with natural leaves around its top. Generic over the 1.16.1 trees
// (oak, birch, spruce, jungle, acacia, dark oak, the 2×2 giants): no per-species rules.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

/** A block as the check sees it: name, and for leaves whether a player or a structure placed them. null: not loaded. */
export type TreeCell = { name: string; persistent?: boolean } | null
export type TreeView = (x: number, y: number, z: number) => TreeCell

export const TREE_CHECK = {
  /** Longest trunk followed upward (giant jungle trees). */
  maxTrunk: 32,
  /** Leaves counted within this horizontal radius of the trunk top, from 2 below to 3 above it. */
  canopyR: 3,
  minLeaves: 3,
  /** Water among the 8 cells around the trunk one block above its foot: more than this is a submerged trunk. */
  ringWaterMax: 4,
  /** Water among the 6 neighbours of the log itself: at least this many is a log under water. */
  logWaterMin: 2,
} as const

const isLog = (c: TreeCell) => !!c && c.name.endsWith('_log')
const isWater = (c: TreeCell) => !!c && /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(c.name)
/** What a grown trunk stands on: soil; air once its lowest log was dug; leaves under a branch. */
const FOOT_OK = /^(dirt|grass_block|podzol|coarse_dirt|mycelium|farmland|grass_path|air|cave_air)$|_leaves$/

export type TreeVerdict = { ok: true } | { ok: false; why: 'unloaded' | 'foot' | 'submerged' | 'no_leaves' }

/**
 * Whether the log at (x, y, z) belongs to a natural surface tree (pure over `at`). `memo`
 * caches the trunk verdict by trunk top, so the logs of one tree are checked once.
 */
export function treeVerdict (at: TreeView, x: number, y: number, z: number, memo?: Map<string, TreeVerdict>): TreeVerdict {
  const self = at(x, y, z)
  if (!isLog(self)) return { ok: false, why: 'unloaded' }
  const around = [at(x + 1, y, z), at(x - 1, y, z), at(x, y, z + 1), at(x, y, z - 1), at(x, y + 1, z), at(x, y - 1, z)]
  if (around.filter(isWater).length >= TREE_CHECK.logWaterMin) return { ok: false, why: 'submerged' }

  // Up the trunk: straight, or one diagonal step per level (acacia).
  let tx = x; let ty = y; let tz = z
  for (let i = 0; i < TREE_CHECK.maxTrunk; i++) {
    if (isLog(at(tx, ty + 1, tz))) { ty++; continue }
    const d = DIAG.find(([dx, dz]) => isLog(at(tx + dx, ty + 1, tz + dz)))
    if (!d) break
    tx += d[0]; ty++; tz += d[1]
  }
  const key = `${tx},${ty},${tz}`
  const known = memo?.get(key)
  if (known) return known
  const verdict = trunkVerdict(at, x, y, z, tx, ty, tz)
  memo?.set(key, verdict)
  return verdict
}

const DIAG: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

function trunkVerdict (at: TreeView, x: number, y: number, z: number, tx: number, ty: number, tz: number): TreeVerdict {
  // Down the column to the foot.
  let fy = y
  for (let i = 0; i < TREE_CHECK.maxTrunk && isLog(at(x, fy - 1, z)); i++) fy--
  const below = at(x, fy - 1, z)
  if (!below) return { ok: false, why: 'unloaded' }
  if (!FOOT_OK.test(below.name)) return { ok: false, why: 'foot' }
  let ring = 0
  for (const [dx, dz] of DIAG) if (isWater(at(x + dx, fy + 1, z + dz))) ring++
  if (ring > TREE_CHECK.ringWaterMax) return { ok: false, why: 'submerged' }
  if (isWater(at(tx, ty + 1, tz))) return { ok: false, why: 'submerged' }
  // Natural leaves around the top (player- and structure-placed leaves are persistent).
  let leaves = 0
  const R = TREE_CHECK.canopyR
  for (let dy = 3; dy >= -2; dy--) {
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const c = at(tx + dx, ty + dy, tz + dz)
        if (c && c.name.endsWith('_leaves') && c.persistent !== true && ++leaves >= TREE_CHECK.minLeaves) return { ok: true }
      }
    }
  }
  return { ok: false, why: 'no_leaves' }
}

/** TreeView over the client's loaded chunks. */
export function botTreeView (bot: Bot): TreeView {
  return (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z), false)
    if (!b) return null
    if (!b.name.endsWith('_leaves')) return { name: b.name }
    const p = (b as unknown as { getProperties?: () => Record<string, unknown> }).getProperties?.() ?? {}
    return { name: b.name, persistent: p.persistent === true || p.persistent === 'true' }
  }
}

/** Filter for loaded log positions: only logs of natural surface trees. */
export function naturalTreeFilter (bot: Bot): (v: { x: number; y: number; z: number }) => boolean {
  const at = botTreeView(bot)
  const memo = new Map<string, TreeVerdict>()
  return v => treeVerdict(at, v.x, v.y, v.z, memo).ok
}
