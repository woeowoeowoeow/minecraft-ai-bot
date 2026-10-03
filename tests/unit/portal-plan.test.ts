import { describe, expect, it } from 'vitest'
import { mapView } from '../../src/nav/blocks.js'
import type { V3 } from '../../src/schema/index.js'
import { overlayView, WATER_SOURCE } from '../../src/skills/progression/buckets.js'
import {
  aimPickup, aimPlace, bucketRay, cellAt, evaluateSite, findSites, FRAME_UV, frameStatus, lavaAccess, planFor, poolCells,
  resumeCheck, waterCandidates, type PortalGeom,
} from '../../src/skills/progression/portal-plan.js'

const OBS_MS = (n: string) => (n === 'bedrock' || n === 'obsidian' ? Infinity : 500)
const flat = (x: number, y: number, z: number) => (y < 4 ? 'grass_block' : 'air')
const geom: PortalGeom = { origin: [0, 4, 0], U: [1, 0, 0], F: [0, 0, 1] }
const eyeAt = (st: V3): V3 => [st[0] + 0.5, st[1] + 1.62, st[2] + 0.5]

describe('bucketRay (vanilla Item.raycast replica)', () => {
  const view = mapView(flat, { '0,4,-3': 'stone', '0,4,-1': 'water', '0,4,-2': 'water_flow' })
  it('a full bucket passes through fluids and stops at the first block with an outline', () => {
    const hit = bucketRay(view, [0.5, 4.5, 0.5], [0, 0, -1], 5, 'place')
    expect(hit?.cell).toEqual([0, 4, -3])
    expect(hit?.face).toEqual([0, 0, 1])
  })
  it('an empty bucket stops at the first source and ignores flowing fluid', () => {
    const v2 = mapView(flat, { '0,4,-1': 'water_flow', '0,4,-2': 'water' })
    expect(bucketRay(v2, [0.5, 4.5, 0.5], [0, 0, -1], 5, 'pickup')?.cell).toEqual([0, 4, -2])
  })
  it('respects the 5-block reach', () => {
    const v3 = mapView(flat, { '0,4,-7': 'stone' })
    expect(bucketRay(v3, [0.5, 4.5, 0.5], [0, 0, -1], 5, 'place')).toBeNull()
  })
})

describe('site evaluation', () => {
  it('flat ground: frame and work area clear, back wall to build (20 blocks)', () => {
    const e = evaluateSite(mapView(flat, {}, OBS_MS), geom)
    expect(e.ok).toBe(true)
    if (e.ok) { expect(e.plan.places).toBe(20); expect(e.plan.digs).toBe(0) }
  })
  it('a hillside gives a natural back wall', () => {
    const hill = (x: number, y: number, z: number) => (y < 4 || z < 0 ? 'stone' : 'air')
    const e = evaluateSite(mapView(hill, {}, OBS_MS), geom)
    expect(e.ok && e.plan.places).toBe(0)
  })
  it('rejects liquid beside the cleared cells, gravel above them, and lava too close', () => {
    expect(evaluateSite(mapView(flat, { '4,5,1': 'lava' }, OBS_MS), geom)).toMatchObject({ ok: false, reason: 'lava beside the site' })
    const roof = (x: number, y: number, z: number) => (y < 4 || y > 9 ? 'stone' : 'air')
    expect(evaluateSite(mapView(roof, { '1,9,1': 'gravel' }, OBS_MS), geom)).toMatchObject({ ok: false, reason: 'gravel above the site' })
    expect(evaluateSite(mapView(flat, {}, OBS_MS), geom, { lava: [[6, 4, 2]], clearance: 4 })).toMatchObject({ ok: false, reason: 'too close to lava' })
  })
  it('rejects a site with lava within two blocks of its floor or work area, even far from the listed pool', () => {
    expect(evaluateSite(mapView(flat, { '1,3,4': 'lava' }, OBS_MS), geom)).toMatchObject({ ok: false })
    expect(evaluateSite(mapView(flat, { '1,3,6': 'lava' }, OBS_MS), geom).ok).toBe(true)
  })
  it('prefers a site cut into rock over an open floor (exposure)', () => {
    // Open floor for z ≥ 0, solid rock for z < 0 (a cliff face): the site facing out of the rock is less exposed.
    const cliff = (x: number, y: number, z: number) => (y < 4 || z < -6 ? 'stone' : 'air')
    const v = mapView(cliff, {}, OBS_MS)
    const open = evaluateSite(v, { origin: [0, 4, 4], U: [1, 0, 0], F: [0, 0, 1] })
    const cut = evaluateSite(v, { origin: [0, 4, -6], U: [1, 0, 0], F: [0, 0, 1] })
    expect(open.ok && cut.ok).toBe(true)
    if (open.ok && cut.ok) expect(cut.plan.exposure).toBeLessThan(open.plan.exposure)
  })
  it('counts obsidian already in frame cells and rejects obsidian elsewhere', () => {
    const e = evaluateSite(mapView(flat, { '1,4,0': 'obsidian', '2,4,0': 'obsidian' }, OBS_MS), geom)
    expect(e.ok && e.plan.existing).toBe(2)
    expect(evaluateSite(mapView(flat, { '1,5,1': 'obsidian' }, OBS_MS), geom)).toMatchObject({ ok: false })
  })
  it('findSites is deterministic and skips rejected origins', () => {
    const v = mapView(flat, {}, OBS_MS)
    const a = findSites(v, [0, 4, 0], 2, 0)
    const b = findSites(v, [0, 4, 0], 2, 0)
    expect(a.map(s => s.plan.geom)).toEqual(b.map(s => s.plan.geom))
    const c = findSites(v, [0, 4, 0], 2, 0, { rejected: o => o[0] === a[0]!.plan.geom.origin[0] && o[2] === a[0]!.plan.geom.origin[2] })
    expect(c[0]!.plan.geom.origin).not.toEqual(a[0]!.plan.geom.origin)
  })
})

describe('lava cast aiming (top-down cast against the back wall)', () => {
  // Flat ground with a built back wall, and solid rock where only the site cells are cleared.
  const rock = (x: number, y: number, z: number) => 'stone'
  it.each([['flat', flat], ['rock', rock]] as const)('%s: every frame cell can be cast from a work-area stand: water in, lava in, water out', (_n, terrain) => {
    const cells: Record<string, string> = {}
    for (let u = 0; u < 4; u++) for (let v = 0; v <= 4; v++) cells[cellAt(geom, u, v, -1).join(',')] = 'stone'
    const plan = planFor(geom)
    for (const c of [...plan.interior, ...plan.clear]) if (!plan.frame.some(f => f.join() === c.join()) || terrain === rock) cells[c.join(',')] = 'air'
    for (const [u, v] of FRAME_UV) {
      const view = mapView(terrain, cells, OBS_MS)
      const c = cellAt(geom, u, v)
      const w = waterCandidates(u, v).map(([a, b]) => cellAt(geom, a, b)).find(x => view.at(...x).kind === 'air')
      expect(w, `water cell for ${u},${v}`).toBeDefined()
      const vw = overlayView(view, new Map([[w!.join(','), WATER_SOURCE]]))
      const stand = plan.stands.find(st => aimPlace(vw, eyeAt(st), w!) && aimPlace(vw, eyeAt(st), c) && aimPickup(vw, eyeAt(st), w!))
      expect(stand, `stand for ${u},${v}`).toBeDefined()
      cells[c.join(',')] = 'obsidian'
    }
    expect(frameStatus(mapView(terrain, cells, OBS_MS), geom)).toMatchObject({ obsidian: 10, missing: [], blockers: [] })
  })
  it('a lower obsidian cell in front of the ray is detected (no misplaced lava)', () => {
    // Bottom-up would put the side cell below the target in the ray's way.
    const cells: Record<string, string> = { [cellAt(geom, 0, 2).join(',')]: 'obsidian' }
    for (let u = 0; u < 4; u++) for (let v = 0; v <= 4; v++) cells[cellAt(geom, u, v, -1).join(',')] = 'stone'
    const view = mapView(flat, cells, OBS_MS)
    const target = cellAt(geom, 0, 3)
    for (const st of planFor(geom).stands) {
      const pt = aimPlace(view, eyeAt(st), target)
      if (!pt) continue
      const e = eyeAt(st)
      const d = [pt[0] - e[0], pt[1] - e[1], pt[2] - e[2]]
      const len = Math.hypot(...d)
      const hit = bucketRay(view, e, d.map(x => x / len) as V3, 5, 'place')!
      expect([hit.cell[0] + hit.face[0], hit.cell[1] + hit.face[1], hit.cell[2] + hit.face[2]]).toEqual(target)
    }
  })
})

describe('lava pool access', () => {
  // A 4×4 lava pool at y 3 (surface level), shore of grass around it.
  const pool: Record<string, string> = {}
  for (let x = 10; x < 14; x++) for (let z = 10; z < 14; z++) pool[`${x},3,${z}`] = 'lava'
  it('poolCells finds every source', () => {
    const v = mapView(flat, pool)
    expect(poolCells(v, [10, 3, 10]).sources).toHaveLength(16)
  })
  it('stands keep a block of distance from the lava and reach an open source', () => {
    const v = mapView(flat, pool)
    const acc = lavaAccess(v, poolCells(v, [10, 3, 10]).sources, [0, 4, 0])
    expect(acc.length).toBeGreaterThan(0)
    for (const a of acc) {
      expect(Math.min(...Object.keys(pool).map(k => { const [x, , z] = k.split(',').map(Number); return Math.max(Math.abs(x! - a.stand[0]), Math.abs(z! - a.stand[2])) }))).toBeGreaterThanOrEqual(2)
    }
  })
  it('no access when the pool is ringed by lava flows', () => {
    const ring: Record<string, string> = { ...pool }
    for (let x = 6; x < 18; x++) for (let z = 6; z < 18; z++) if (!pool[`${x},3,${z}`]) ring[`${x},4,${z}`] = 'lava_flow'
    const v = mapView(flat, ring)
    expect(lavaAccess(v, poolCells(v, [10, 3, 10]).sources, [0, 4, 0])).toEqual([])
  })
})

describe('resumeCheck', () => {
  it('a misplaced obsidian block in the interior ends the site', () => {
    expect(resumeCheck(mapView(flat, { [cellAt(geom, 1, 2).join(',')]: 'obsidian' }), geom)).toMatchObject({ ok: false })
    expect(resumeCheck(mapView(flat, {}), geom)).toEqual({ ok: true })
  })
})
