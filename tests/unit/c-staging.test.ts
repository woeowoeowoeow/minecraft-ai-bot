// C staging after ckit-r2d (architecture §10G "C staging"): bed and chest sites beside the portal
// that never touch the portal or its step-in lanes, the 1.16.1 bed answers, the portal-dwell and
// water-trap interrupts, and the frozen-ocean exits (notches cut into an iceberg).
import { describe, expect, it } from 'vitest'
import { Cooldowns, selectInterrupt } from '../../src/controller/interrupts.js'
import { mapView } from '../../src/nav/blocks.js'
import { findWaterExits } from '../../src/nav/water.js'
import { bedAnswer, portalKeepOut, stageSites } from '../../src/skills/progression/stage-plan.js'
import { fakeState } from './helpers.js'

// Flat grass at y 63 (stand at 64); an obsidian frame in the plane z = 0, x −1..2, y 64..68,
// lit opening x 0..1, y 65..67 (the frame's bottom row is y 64: the opening's floor is obsidian).
function portalWorld (extra: Record<string, string> = {}) {
  const cells: Record<string, string> = { ...extra }
  for (let x = -1; x <= 2; x++) for (let y = 64; y <= 68; y++) cells[`${x},${y},0`] = 'obsidian'
  for (let x = 0; x <= 1; x++) for (let y = 65; y <= 67; y++) cells[`${x},${y},0`] = 'nether_portal'
  return mapView((_x, y) => (y >= 64 ? 'air' : 'grass_block'), cells)
}
const PORTAL: [number, number, number][] = [[0, 65, 0], [1, 65, 0], [0, 66, 0], [1, 66, 0], [0, 67, 0], [1, 67, 0]]

describe('staging sites beside the portal', () => {
  it('keeps the portal and the two cells in front of and behind the opening clear', () => {
    const keep = portalKeepOut(PORTAL)
    for (const c of ['0,65,0', '1,65,1', '0,65,-2', '1,66,2', '0,64,-1']) expect(keep.has(c)).toBe(true)
    expect(keep.has('3,65,1')).toBe(false)
  })
  it('a bed: foot and head on floor, beside the frame, stand cell behind the foot, never in a portal lane', () => {
    const v = portalWorld()
    const sites = stageSites(v, PORTAL, { bed: true, near: 6 })
    expect(sites.length).toBeGreaterThan(0)
    const keep = portalKeepOut(PORTAL)
    for (const s of sites.slice(0, 5)) {
      const head = [s.cell[0] + s.dir![0], s.cell[1], s.cell[2] + s.dir![1]]
      expect(keep.has(s.cell.join(','))).toBe(false)
      expect(keep.has(head.join(','))).toBe(false)
      expect(keep.has(s.stand.join(','))).toBe(false)
      // The stand is behind the foot (looking at the foot faces the bed's direction).
      expect([s.cell[0] - s.stand[0], s.cell[2] - s.stand[2]]).toEqual(s.dir)
      // 1.16.1 range: within 3 horizontally and 2 vertically of the bed.
      expect(Math.abs(s.stand[1] - s.cell[1])).toBeLessThanOrEqual(2)
    }
    // Best site: at the opening's floor level (the frame stands on the ground here: y 64), beside the frame.
    expect(sites[0]!.cell[1]).toBe(64)
    expect(Math.abs(sites[0]!.cell[2])).toBeLessThanOrEqual(1)
  })
  it('the chest avoids the bed cells', () => {
    const v = portalWorld()
    const bed = stageSites(v, PORTAL, { bed: true, near: 6 })[0]!
    const bedCells = [bed.cell, [bed.cell[0] + bed.dir![0], bed.cell[1], bed.cell[2] + bed.dir![1]] as [number, number, number]]
    const chest = stageSites(v, PORTAL, { bed: false, near: 6, avoid: bedCells })[0]!
    expect(bedCells.map(c => c.join(','))).not.toContain(chest.cell.join(','))
    expect(chest.dir).toBeNull()
  })
  it('no site over water, lava or a gravity floor', () => {
    const extra: Record<string, string> = {}
    for (let x = -6; x <= 7; x++) for (let z = -6; z <= 6; z++) if (!(x >= -1 && x <= 2 && z === 0)) extra[`${x},63,${z}`] = 'sand'
    expect(stageSites(portalWorld(extra), PORTAL, { bed: true, near: 6 })).toEqual([])
  })
})

describe('1.16.1 bed answers', () => {
  it('the respawn point is set by "Respawn point set", by the night refusal and by the monster refusal', () => {
    expect(bedAnswer(['Respawn point set', 'You can sleep only at night'], false)).toBe('set')
    // Re-using the same bed: no "Respawn point set" (the point did not change), only the refusal.
    expect(bedAnswer(['You can sleep only at night'], false)).toBe('set')
    expect(bedAnswer(['You may not rest now; there are monsters nearby'], false)).toBe('set')
    expect(bedAnswer([], true)).toBe('set')
  })
  it('too far, obstructed, occupied and silence do not set it', () => {
    expect(bedAnswer(['You may not rest now; the bed is too far away'], false)).toBe('too_far')
    expect(bedAnswer(['This bed is obstructed'], false)).toBe('obstructed')
    expect(bedAnswer(['This bed is occupied'], false)).toBe('occupied')
    expect(bedAnswer([], false)).toBe('none')
  })
})

describe('portal dwell and water trap interrupts', () => {
  it('standing in a portal outside the portal skills: step out (P0); usePortal keeps it', () => {
    const s = fakeState({ dim: 'overworld' })
    s.body.inPortal = true
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: 'setSpawnBed', priority: 3 })).toMatchObject({ id: 'leave_portal', priority: 0, skill: 'leavePortal' })
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: 'obtain', priority: 3 })?.id).toBe('leave_portal')
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: 'usePortal', priority: 3 })?.id).not.toBe('leave_portal')
  })
  it('a route failed on the water and the bot still in it: escape the water before the objective', () => {
    const s = fakeState({ dim: 'overworld', t: 100 })
    s.inLiquid = 'water'
    s.memory.blacklist.push({ key: 'water_trap', until: 200, reason: 'repeatedly out of air' })
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: 'setSpawnBed', priority: 3 })).toMatchObject({ id: 'water_escape', priority: 0, skill: 'escapeWater' })
    s.inLiquid = 'none'
    expect(selectInterrupt(s, new Cooldowns(() => 0), { skill: 'setSpawnBed', priority: 3 })?.id).not.toBe('water_escape')
  })
})

describe('frozen-ocean exits (ckit-r2d r01)', () => {
  // Sea: water y 50..62, air above. An iceberg of packed ice x ≥ 3, y 50..66 (rises 4 above the water).
  const berg = (block: string) => mapView((x, y) => (x >= 3 && y <= 66 ? block : y <= 62 ? 'water' : 'air'))
  it('no flush or ledge exit at a tall packed-ice wall: a notch (lip and the block above it)', () => {
    const exits = findWaterExits(berg('packed_ice'), [1.5, 61.5, 0.5], 4)
    expect(exits.length).toBeGreaterThan(0)
    expect(exits[0]).toMatchObject({ kind: 'notch', stand: [3, 63, 0], from: [2, 62, 0] })
  })
  it('never a notch into plain ice (it melts into water when broken)', () => {
    expect(findWaterExits(berg('ice'), [1.5, 61.5, 0.5], 4)).toEqual([])
  })
  it('a flush shore still comes first', () => {
    const v = mapView((x, y) => (x >= 3 && y <= 66 ? 'packed_ice' : x <= -3 && y <= 62 ? 'stone' : y <= 62 ? 'water' : 'air'))
    expect(findWaterExits(v, [0.5, 61.5, 0.5], 6)[0]).toMatchObject({ kind: 'flush' })
  })
})
