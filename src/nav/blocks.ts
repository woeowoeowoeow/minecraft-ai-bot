// Pathfinder-agnostic block classification for the navigator's own logic
// (water handling, controlled excavation). Pure: callers supply a BlockView.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'

/**
 * Blocks that are always water for movement purposes. Their bounding box is
 * empty, so a naive planner treats them as air (kelp forests and seagrass
 * meadows look like walkable sea floor).
 */
export const WATER_LIKE = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])
/** Passable but harmful to stand in. */
export const HARMFUL_PASSABLE = new Set(['fire', 'soul_fire', 'cobweb', 'sweet_berry_bush', 'powder_snow', 'wither_rose'])
/** Solid, but harmful to stand on. */
export const HARMFUL_FLOOR = new Set(['magma_block', 'campfire', 'soul_campfire', 'pointed_dripstone'])

export type CellKind = 'air' | 'solid' | 'water' | 'lava' | 'harmful' | 'unknown'

export type Cell = {
  name: string
  kind: CellKind
  /** Falls when unsupported (sand, gravel, …). */
  gravity: boolean
  /** Dig time in ms with the best tool the bot holds; Infinity if it cannot be broken. */
  digMs: number
  /** A pickaxe would make this block practical to dig (the block has harvest tools). */
  wantsPickaxe: boolean
}

export interface BlockView {
  at (x: number, y: number, z: number): Cell
}

const UNKNOWN: Cell = { name: 'unloaded', kind: 'unknown', gravity: false, digMs: Infinity, wantsPickaxe: false }
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel'])
const GRAVITY_RE = /concrete_powder$|anvil$/

export function classify (b: Pick<Block, 'name' | 'boundingBox'> & { waterlogged?: boolean }, digMs: number, wantsPickaxe: boolean): Cell {
  const name = b.name
  let kind: CellKind
  if (name === 'lava') kind = 'lava'
  else if (WATER_LIKE.has(name) || b.waterlogged) kind = 'water'
  else if (HARMFUL_PASSABLE.has(name)) kind = 'harmful'
  else if (b.boundingBox === 'empty') kind = 'air'
  else kind = 'solid'
  return { name, kind, gravity: GRAVITY.has(name) || GRAVITY_RE.test(name), digMs, wantsPickaxe }
}

/** Live view over the bot's loaded world, with dig times for the bot's current inventory. */
export function liveView (bot: Bot): BlockView {
  const cache = new Map<string, Cell>()
  const tools = bot.inventory.items()
  return {
    at (x, y, z) {
      const k = `${x},${y},${z}`
      const hit = cache.get(k)
      if (hit) return hit
      const b = bot.blockAt(new Vec3(x, y, z), false)
      let c: Cell
      if (!b) {
        c = UNKNOWN
      } else {
        let digMs = Infinity
        if (b.diggable && b.hardness !== null && b.hardness >= 0) {
          digMs = b.digTime(null, false, false, false, [], bot.entity.effects as never)
          for (const it of tools) digMs = Math.min(digMs, b.digTime(it.type, false, false, false, [], bot.entity.effects as never))
        }
        const props = (b as unknown as { getProperties?: () => Record<string, unknown> }).getProperties?.() ?? {}
        c = classify({ name: b.name, boundingBox: b.boundingBox, waterlogged: props.waterlogged === true }, digMs, Boolean(b.harvestTools))
      }
      cache.set(k, c)
      return c
    },
  }
}

/** Map-backed view for tests: `solid(x,y,z)` default fill plus explicit overrides. */
export function mapView (fill: (x: number, y: number, z: number) => string, cells: Record<string, string> = {}, digMsFor: (name: string) => number = n => (n === 'bedrock' ? Infinity : 500)): BlockView {
  return {
    at (x, y, z) {
      const name = cells[`${x},${y},${z}`] ?? fill(x, y, z)
      if (name === 'unloaded') return UNKNOWN
      const empty = name === 'air' || name === 'cave_air' || WATER_LIKE.has(name) || name === 'lava' || HARMFUL_PASSABLE.has(name) || name === 'short_grass' || name === 'torch'
      return classify({ name, boundingBox: empty ? 'empty' : 'block' }, empty ? 0 : digMsFor(name), /stone|deepslate|ore|granite|diorite|andesite|tuff/.test(name))
    },
  }
}
