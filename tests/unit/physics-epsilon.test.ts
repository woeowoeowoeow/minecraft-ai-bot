import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { installCollisionEpsilon } from '../../src/nav/physics-epsilon.js'

type Box = { computeOffsetX (o: unknown, d: number): number; computeOffsetY (o: unknown, d: number): number }
const AABB = createRequire(import.meta.url)('prismarine-physics/lib/aabb.js') as new (...a: number[]) => Box & { offset (x: number, y: number, z: number): Box }

describe('collision epsilon', () => {
  installCollisionEpsilon()
  // Wall block x∈[1,2], y∈[-27,-26]; player box edge at 2.3 - 0.3 (= 1.9999999999999998).
  const wall = new AABB(1, -27, 0, 2, -26, 1)
  const player = new AABB(-0.3, 0, -0.3, 0.3, 1.8, 0.3).offset(2.3, -26.58, 0.5)

  it('a flush wall still blocks movement into it despite float error', () => {
    expect(wall.computeOffsetX(player, -0.1)).toBeCloseTo(0, 12)
  })

  it('a flush wall beside the player does not block vertical motion', () => {
    expect(wall.computeOffsetY(player, -0.2)).toBe(-0.2)
  })

  it('keeps normal collisions', () => {
    const floor = new AABB(2, -28, 0, 3, -27, 1)
    const above = new AABB(-0.3, 0, -0.3, 0.3, 1.8, 0.3).offset(2.5, -26.9, 0.5)
    expect(floor.computeOffsetY(above, -0.5)).toBeCloseTo(-0.1, 9)
  })
})
