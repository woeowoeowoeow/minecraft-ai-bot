import { describe, expect, it } from 'vitest'
import { Vec3 } from 'vec3'
import { mapView } from '../../src/nav/blocks.js'
import { recentreUnsafe, unsafeFall } from '../../src/nav/fall-guard.js'
import { cardinalToYaw, digReleasesLiquid, needsAir, stepHazard, unstickDirections, yawToCardinal } from '../../src/nav/hazards.js'

// Flat stone ground: floor top at y 63, the bot stands with feet at y 64.
const ground = (x: number, y: number) => (y <= 63 ? 'stone' : 'air')
const FEET: [number, number, number] = [0, 64, 0]
const EAST = cardinalToYaw([1, 0])

describe('hazard-aware unstick (open item: jump-forward into lava)', () => {
  it('maps yaw to cardinals consistently with look()', () => {
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) expect(yawToCardinal(cardinalToYaw(d))).toEqual(d)
  })

  it('never steps forward into a lava pit; other directions stay available', () => {
    const view = mapView(ground, { '1,63,0': 'lava', '1,62,0': 'lava' })
    expect(stepHazard(view, FEET, [1, 0])).toBe('lava_below')
    const dirs = unstickDirections(view, FEET, EAST, 1)
    expect(dirs).not.toContainEqual([1, 0])
    expect(dirs.length).toBe(3)
  })

  it('rejects lava in the entered cell, lava flowing beside it, and deep drops', () => {
    expect(stepHazard(mapView(ground, { '1,64,0': 'lava' }), FEET, [1, 0])).toBe('lava')
    expect(stepHazard(mapView(ground, { '2,64,0': 'lava' }), FEET, [1, 0])).toBe('lava_adjacent')
    const hole: Record<string, string> = {}
    for (let y = 56; y <= 63; y++) hole[`1,${y},0`] = 'air'
    expect(stepHazard(mapView(ground, hole), FEET, [1, 0])).toBe('drop_too_deep')
    expect(stepHazard(mapView(ground, { '1,64,0': 'magma_block' }), FEET, [1, 0])).toBe('harmful_floor:magma_block')
    expect(stepHazard(mapView(ground, { '1,64,0': 'fire' }), FEET, [1, 0])).toBe('harmful:fire')
  })

  it('accepts a short drop, a step up, and a drop into water', () => {
    expect(stepHazard(mapView(ground, { '1,63,0': 'air', '1,62,0': 'air' }), FEET, [1, 0])).toBeNull()
    expect(stepHazard(mapView(ground, { '1,64,0': 'stone' }), FEET, [1, 0])).toBeNull()
    const well: Record<string, string> = {}
    for (let y = 58; y <= 63; y++) well[`1,${y},0`] = y <= 60 ? 'water' : 'air'
    expect(stepHazard(mapView(ground, well), FEET, [1, 0])).toBeNull()
  })

  it('prefers backward on later attempts and returns nothing when surrounded by lava', () => {
    expect(unstickDirections(mapView(ground), FEET, EAST, 2)[0]).toEqual([-1, 0])
    const moat: Record<string, string> = {}
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) moat[`${x},63,${z}`] = 'lava'
    expect(unstickDirections(mapView(ground, moat), FEET, EAST, 1)).toEqual([])
  })

  it('ckit-r2c r01: a direction whose second cell drops into lava comes after the safe ones', () => {
    // East: one cell of ledge, then a 7-block drop into lava (momentum carried the bot past the first cell).
    const ledge: Record<string, string> = {}
    for (let y = 56; y <= 63; y++) ledge[`2,${y},0`] = y <= 57 ? 'lava' : 'air'
    const dirs = unstickDirections(mapView(ground, ledge), FEET, EAST, 1)
    expect(dirs).toContainEqual([1, 0])
    expect(dirs[0]).not.toEqual([1, 0])
    expect(dirs[dirs.length - 1]).toEqual([1, 0])
  })

  it('never digs a block that would release lava or water', () => {
    expect(digReleasesLiquid(mapView(ground, { '1,66,0': 'lava' }), [1, 65, 0])).toBe(true)
    expect(digReleasesLiquid(mapView(ground, { '1,65,1': 'water' }), [1, 65, 0])).toBe(true)
    expect(digReleasesLiquid(mapView(ground), [1, 65, 0])).toBe(false)
  })
})

describe('air reflex (open item: exitWater had none)', () => {
  const o = { maxSubmergedMs: 2500, lowAir: 14 }
  it('surfaces on low air or a long submersion, never when the head is dry', () => {
    expect(needsAir(true, 100, 13, o)).toBe(true)
    expect(needsAir(true, 3000, 20, o)).toBe(true)
    expect(needsAir(true, 100, 20, o)).toBe(false)
    expect(needsAir(false, 99_999, 0, o)).toBe(false)
  })
})

describe('fall guard (ckit-r2d: re-centring and jumps off Nether ledges)', () => {
  // A ledge: full blocks at y 63 for x ≤ 0, air beyond.
  const solid = (x: number, y: number) => y === 63 && x <= 0
  it('vetoes a re-centre that takes the bot off its only floor column', () => {
    expect(recentreUnsafe(solid, new Vec3(1.1, 64, 0.5), new Vec3(1.5, 64, 0.5))).toBe(true)
    expect(recentreUnsafe(solid, new Vec3(-0.9, 64, 0.5), new Vec3(-0.5, 64, 0.5))).toBe(false)
    // Already off the floor: nothing to protect.
    expect(recentreUnsafe(solid, new Vec3(1.6, 64, 0.5), new Vec3(1.5, 64, 0.5))).toBe(false)
  })
  it('treats long drops, no landing and lava as unsafe, water and short drops as safe', () => {
    expect(unsafeFall({ drop: 30, landed: false, lava: false, water: false })).toBe(true)
    expect(unsafeFall({ drop: 5, landed: true, lava: false, water: false })).toBe(true)
    expect(unsafeFall({ drop: 1, landed: true, lava: true, water: false })).toBe(true)
    expect(unsafeFall({ drop: 4, landed: true, lava: false, water: false })).toBe(false)
    expect(unsafeFall({ drop: 12, landed: true, lava: false, water: true })).toBe(false)
  })
})
