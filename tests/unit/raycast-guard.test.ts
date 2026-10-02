import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { describe, expect, it } from 'vitest'
import { installRaycastGuard } from '../../src/bot/protocol-fixes.js'

describe('raycast guard (dev batch 3 event-loop stalls)', () => {
  it('stops a ray with a non-finite direction instead of spinning forever', () => {
    const trips: string[] = []
    installRaycastGuard(w => trips.push(w))
    const { RaycastIterator } = createRequire(import.meta.url)('prismarine-world/src/iterators.js')
    const bad = new RaycastIterator(new Vec3(0, 0, 0), new Vec3(NaN, NaN, NaN), 4.5)
    expect(bad.next()).toBeNull()
    const ok = new RaycastIterator(new Vec3(0.5, 0.5, 0.5), new Vec3(1, 0, 0), 4.5)
    const cells = []
    for (let c = ok.next(); c; c = ok.next()) cells.push(c.x)
    expect(cells.length).toBeGreaterThan(2)
    expect(cells.length).toBeLessThan(10)
    expect(trips).toEqual(['non-finite ray direction'])
  })
})
