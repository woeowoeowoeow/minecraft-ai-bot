import { describe, expect, it } from 'vitest'
import { mapView } from '../../src/nav/blocks.js'
import { dryStart, findWaterExits, longestWaterRun, routeToAir } from '../../src/nav/water.js'
import { ownAir } from '../../src/observer/vitals.js'

// Ground surface y=64 (stand at 65). Pool x,z ∈ [-5,5]: water surface cell y=63 (a 1-block ledge),
// except its east edge x=5 where the bank at x=6 is lowered (flush exit).
function pool (flushEast: boolean) {
  const cells: Record<string, string> = {}
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) {
    for (let y = 58; y <= 63; y++) cells[`${x},${y},${z}`] = 'water'
    cells[`${x},64,${z}`] = 'air'
  }
  if (flushEast) cells['6,64,0'] = 'air'
  return mapView((x, y) => (y >= 65 ? 'air' : y === 64 ? 'grass_block' : 'dirt'), cells)
}

describe('findWaterExits', () => {
  it('finds only ledge exits around a pool whose banks are one block high', () => {
    const exits = findWaterExits(pool(false), [0.5, 63.2, 0.5], 8)
    expect(exits.length).toBeGreaterThan(0)
    expect(exits.every(e => e.kind === 'ledge')).toBe(true)
    // The lip to dig is the shore block at head level; stand there afterwards.
    const e = exits[0]!
    expect(e.stand[1]).toBe(64)
    expect(e.from[1]).toBe(63)
  })

  it('prefers a flush exit over nearer ledge exits', () => {
    const exits = findWaterExits(pool(true), [-3.5, 63.2, 0.5], 12)
    expect(exits[0]).toMatchObject({ kind: 'flush', stand: [6, 64, 0], from: [5, 63, 0] })
  })

  it('ignores ledges whose lip is too slow to dig', () => {
    const v = mapView((x, y) => (y >= 65 ? 'air' : y === 64 ? 'obsidian' : 'dirt'), { '0,63,0': 'water', '0,64,0': 'air' }, n => (n === 'obsidian' ? 9000 : 500))
    expect(findWaterExits(v, [0.5, 63.2, 0.5], 4)).toEqual([])
  })
})

describe('longestWaterRun', () => {
  it('measures the longest consecutive swim on a path', () => {
    const isWater = (p: [number, number, number]) => p[0] >= 3 && p[0] <= 7
    const path = Array.from({ length: 12 }, (_, i) => [i, 63, 0] as [number, number, number])
    expect(longestWaterRun(path, isWater)).toBe(5)
  })
})

describe('ownAir', () => {
  it("reads the bot entity's own air_supply metadata, not Mineflayer's shared oxygenLevel", () => {
    const bot = { oxygenLevel: -1, entity: { metadata: { 1: 150 } } }
    expect(ownAir(bot as never)).toBe(10)
    expect(ownAir({ entity: { metadata: {} } } as never)).toBe(20)
  })
})

describe('routeToAir', () => {
  // Water y 58..62 under a dirt ceiling at 63 for x < 3; open air above x ≥ 3.
  const cells: Record<string, string> = {}
  for (let x = -5; x <= 6; x++) for (let z = -2; z <= 2; z++) for (let y = 58; y <= 62; y++) cells[`${x},${y},${z}`] = 'water'
  for (let x = 3; x <= 6; x++) for (let z = -2; z <= 2; z++) cells[`${x},63,${z}`] = 'air'
  const view = mapView((x, y) => (y >= 64 ? 'air' : 'dirt'), cells)

  it('finds the way out from under a ceiling through connected water', () => {
    const r = routeToAir(view, [-3.5, 60.6, 0.5])!
    expect(r).not.toBeNull()
    const end = r.at(-1)!
    expect(end[0]).toBeGreaterThanOrEqual(3)
    expect(end[1]).toBe(62)
  })

  it('returns null when the water is sealed', () => {
    const sealed = mapView((x, y) => (y >= 64 ? 'air' : 'dirt'), { '0,60,0': 'water', '0,61,0': 'water' })
    expect(routeToAir(sealed, [0.5, 60.6, 0.5])).toBeNull()
  })
})

describe('dryStart', () => {
  it('moves an excavation start off a shoreline', () => {
    const v = pool(false)
    const s = dryStart(v, [0.5, 63.2, 0.5])
    expect(s.kind).toBe('found')
    const p = (s as { pos: [number, number, number] }).pos
    expect(p[1]).toBe(65)
    expect(Math.max(Math.abs(p[0]), Math.abs(p[2]))).toBeGreaterThanOrEqual(6)
  })
  it('keeps a start that is already dry', () => {
    expect(dryStart(pool(false), [20.5, 65, 20.5])).toEqual({ kind: 'already_dry' })
  })
  it('reports none in open water (distinct from already dry)', () => {
    const ocean = mapView((_x, y) => (y >= 64 ? 'air' : y >= 50 ? 'water' : 'sand'))
    expect(dryStart(ocean, [0.5, 63.2, 0.5])).toEqual({ kind: 'none', radius: 12 })
  })
})

describe('dryStart exclusion (unreachable starts, dev batch 6 r01)', () => {
  it('skips excluded cells and picks the next dry one', async () => {
    const { dryStart } = await import('../../src/nav/water.js')
    const { mapView } = await import('../../src/nav/blocks.js')
    // Water column at the bot, dry ground everywhere else.
    const view = mapView((x, y) => (y >= 64 ? 'air' : 'stone'), { '0,63,0': 'water', '0,64,0': 'water' })
    const a = dryStart(view, [0, 64, 0])
    expect(a.kind).toBe('found')
    const first = (a as { pos: [number, number, number] }).pos
    const b = dryStart(view, [0, 64, 0], 12, c => c.join(',') === first.join(','))
    expect(b.kind).toBe('found')
    expect((b as { pos: [number, number, number] }).pos).not.toEqual(first)
  })
})

