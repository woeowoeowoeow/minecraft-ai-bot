import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { V3 } from '../schema/index.js'

export type VoxelSlice = {
  origin: V3            // world coords of layer[0] row[0] col[0] (min x, y, z)
  dims: [number, number, number]  // x, y, z
  bot: V3               // bot feet position relative to origin
  palette: Record<string, string> // char → block name
  /** layers[y][z] is a string over x. '.' = air, '?' = unloaded. Read bottom (y=0) to top. */
  layers: string[][]
}

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=@'

/** 13×7×13 block-name slice around the bot (architecture §9, main nav-diagnosis artifact). */
export function voxelSlice (bot: Bot, rx = 6, ry = 3, rz = 6): VoxelSlice {
  const c = bot.entity.position.floored()
  const origin: V3 = [c.x - rx, c.y - ry, c.z - rz]
  const byName = new Map<string, string>([['air', '.'], ['cave_air', '.'], ['void_air', '.']])
  const palette: Record<string, string> = { '.': 'air', '?': 'unloaded' }
  let next = 0
  const layers: string[][] = []
  for (let y = 0; y <= 2 * ry; y++) {
    const rows: string[] = []
    for (let z = 0; z <= 2 * rz; z++) {
      let row = ''
      for (let x = 0; x <= 2 * rx; x++) {
        const b = bot.blockAt(new Vec3(origin[0] + x, origin[1] + y, origin[2] + z), false)
        if (!b) { row += '?'; continue }
        let ch = byName.get(b.name)
        if (!ch) {
          ch = CHARS[next++] ?? '~'
          byName.set(b.name, ch)
          palette[ch] = b.name
        }
        row += ch
      }
      rows.push(row)
    }
    layers.push(rows)
  }
  const p = bot.entity.position
  return { origin, dims: [2 * rx + 1, 2 * ry + 1, 2 * rz + 1], bot: [r1(p.x - origin[0]), r1(p.y - origin[1]), r1(p.z - origin[2])], palette, layers }
}

function r1 (v: number): number { return Math.round(v * 10) / 10 }
