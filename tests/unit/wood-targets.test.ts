import { describe, expect, it } from 'vitest'
import { treeVerdict, type TreeCell, type TreeView } from '../../src/observer/trees.js'
import { inWoodZone, treeSpot, WOOD_DANGER, woodDanger, woodZoneKey, woodZones } from '../../src/skills/generic/collect.js'
import type { EntityInfo } from '../../src/observer/types.js'
import type { V3 } from '../../src/schema/index.js'
import { fakeState } from './helpers.js'

// Round-3 gate 20261004 r02/r08: shipwreck timbers on the sea floor were taken for trees.

/** A small voxel world: unset cells are air above y 62, stone below; `ground` sets a surface layer. */
function world (ground: string, groundY = 62, waterTo = -1): { at: TreeView; set: (x: number, y: number, z: number, name: string, persistent?: boolean) => void } {
  const cells = new Map<string, TreeCell>()
  const at: TreeView = (x, y, z) => {
    const c = cells.get(`${x},${y},${z}`)
    if (c) return c
    if (y === groundY) return { name: ground }
    if (y < groundY) return { name: 'stone' }
    if (y <= waterTo) return { name: 'water' }
    return { name: 'air' }
  }
  return { at, set: (x, y, z, name, persistent) => cells.set(`${x},${y},${z}`, { name, persistent }) }
}

function canopy (set: (x: number, y: number, z: number, n: string, p?: boolean) => void, x: number, top: number, z: number, persistent = false, name = 'oak_leaves'): void {
  for (let dy = -1; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz || dy > 0) set(x + dx, top + dy, z + dz, name, persistent)
}

describe('natural-tree check for wood targets', () => {
  it('accepts a plain oak on grass, from its foot to its top', () => {
    const w = world('grass_block')
    for (let y = 63; y <= 67; y++) w.set(0, y, 0, 'oak_log')
    canopy(w.set, 0, 67, 0)
    for (let y = 63; y <= 67; y++) expect(treeVerdict(w.at, 0, y, 0)).toEqual({ ok: true })
  })

  it('rejects shipwreck timbers on the sea floor (r08: y 50 under the ocean)', () => {
    const w = world('sand', 45, 62)
    for (let x = 0; x < 8; x++) w.set(x, 46, 0, 'oak_log') // keel
    for (let y = 47; y <= 52; y++) w.set(4, y, 0, 'spruce_log') // mast
    for (let x = 0; x < 8; x++) w.set(x, 47, 1, 'oak_planks')
    expect(treeVerdict(w.at, 2, 46, 0).ok).toBe(false)
    expect(treeVerdict(w.at, 4, 50, 0).ok).toBe(false)
    expect(treeVerdict(w.at, 4, 52, 0).ok).toBe(false)
  })

  it('rejects a beached (dry) shipwreck and other log structures without natural leaves', () => {
    const w = world('sand')
    for (let y = 64; y <= 68; y++) w.set(0, y, 0, 'spruce_log')
    w.set(0, 63, 0, 'oak_planks')
    expect(treeVerdict(w.at, 0, 66, 0)).toEqual({ ok: false, why: 'foot' })
    // A house post on grass with placed (persistent) leaves beside it.
    const v = world('grass_block')
    for (let y = 63; y <= 66; y++) v.set(5, y, 5, 'oak_log')
    canopy(v.set, 5, 66, 5, true)
    expect(treeVerdict(v.at, 5, 64, 5)).toEqual({ ok: false, why: 'no_leaves' })
  })

  it('rejects a trunk standing in deep water', () => {
    const w = world('dirt', 55, 62)
    for (let y = 56; y <= 66; y++) w.set(0, y, 0, 'oak_log')
    canopy(w.set, 0, 66, 0)
    expect(treeVerdict(w.at, 0, 64, 0).ok).toBe(false)
  })

  it('accepts a swamp oak whose foot stands in shallow water (the logs above it)', () => {
    const w = world('dirt', 61, 62)
    for (let y = 62; y <= 66; y++) w.set(0, y, 0, 'oak_log')
    canopy(w.set, 0, 66, 0)
    expect(treeVerdict(w.at, 0, 64, 0)).toEqual({ ok: true })
  })

  it('accepts an acacia (diagonal trunk), a 20-block giant spruce and a trunk whose foot was dug', () => {
    const a = world('grass_block')
    a.set(0, 63, 0, 'acacia_log'); a.set(0, 64, 0, 'acacia_log'); a.set(1, 65, 0, 'acacia_log'); a.set(2, 66, 0, 'acacia_log')
    canopy(a.set, 2, 67, 0, false, 'acacia_leaves')
    expect(treeVerdict(a.at, 0, 63, 0)).toEqual({ ok: true })
    const g = world('podzol')
    for (let y = 63; y <= 85; y++) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.set(dx!, y, dz!, 'spruce_log')
    canopy(g.set, 0, 85, 0, false, 'spruce_leaves')
    expect(treeVerdict(g.at, 1, 63, 1)).toEqual({ ok: true })
    const c = world('grass_block')
    for (let y = 64; y <= 67; y++) c.set(0, y, 0, 'birch_log') // y 63 already dug
    canopy(c.set, 0, 67, 0, false, 'birch_leaves')
    expect(treeVerdict(c.at, 0, 64, 0)).toEqual({ ok: true })
  })
})

const drowned = (dist: number): EntityInfo => ({ id: 7, name: 'drowned', kind: 'hostile', pos: [dist, 62, 0], dist } as EntityInfo)

describe('wood targets abandoned under threat', () => {
  it('flee, air and death interrupts, an aquatic hostile about, or the head under water mean danger', () => {
    expect(woodDanger(fakeState(), 'flee')).toBe('flee')
    expect(woodDanger(fakeState(), 'surface')).toBe('surface')
    expect(woodDanger(fakeState(), 'death')).toBe('death')
    expect(woodDanger(fakeState({ nearby: { entities: [drowned(9)], interestBlocks: {}, hazards: [] } }), 'eat')).toBe('aquatic')
    const wet = fakeState()
    wet.body.head = 'water'
    expect(woodDanger(wet, undefined)).toBe('water')
  })

  it('a plain preemption on dry land (eat, rest, nightfall) is not danger', () => {
    for (const by of ['eat', 'rest', 'cook', undefined]) expect(woodDanger(fakeState(), by)).toBeNull()
    expect(woodDanger(fakeState({ nearby: { entities: [drowned(WOOD_DANGER.r + 30)], interestBlocks: {}, hazards: [] } }), 'eat')).toBeNull()
  })

  it('the zone outlives a respawn, excludes logs and tree spots around the target, and expires', () => {
    const s = fakeState({ pos: [-224, 63, -251], t: 100 })
    const target: V3 = [-219, 50, -179]
    s.memory.blacklist.push({ key: woodZoneKey(target), until: 100 + WOOD_DANGER.ttlS, reason: 'wood_flee' })
    s.memory.blacklist.push({ key: 'block:1,2,3', until: 10_000, reason: 'x' })
    const zones = woodZones(s)
    expect(zones).toEqual([target])
    expect(inWoodZone(zones, -219 + 10, -179 - 10)).toBe(true)
    expect(inWoodZone(zones, -219 + 40, -179)).toBe(false)
    const loc = (pos: V3) => ({ kind: 'trees' as const, dim: 'overworld' as const, pos, confidence: 1, source: 'observed' as const, lastSeen: 10 })
    s.memory.locations.push(loc([-219, 50, -179]), loc([-289, 75, -119]))
    expect(treeSpot(s, () => false)).toEqual([-289, 75, -119])
    s.t = 100 + WOOD_DANGER.ttlS + 1
    expect(woodZones(s)).toEqual([])
    expect(treeSpot(s, () => false)).toEqual([-219, 50, -179])
  })
})
