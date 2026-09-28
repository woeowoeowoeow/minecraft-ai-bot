import { describe, expect, it } from 'vitest'
import { mapView } from '../../src/nav/blocks.js'
import { classifyBlocked, excavationDistance, planStep, type ExcavationTarget } from '../../src/nav/excavate.js'
import { isCovered, undergroundTarget } from '../../src/nav/underground.js'
import type { V3 } from '../../src/schema/index.js'

// Surface at y=64 (bot stands at 65), stone below 60, dirt 60..64.
const ground = (x: number, y: number, z: number) => (y >= 65 ? 'air' : y >= 60 ? 'dirt' : y <= 0 ? 'bedrock' : 'stone')
const P: V3 = [0, 65, 0]

function walk (view: ReturnType<typeof mapView>, from: V3, t: ExcavationTarget, n: number): V3[] {
  const visited = new Set<string>([from.join(',')])
  let p = from
  let prev: [number, number] | null = null
  const out: V3[] = [p]
  for (let i = 0; i < n; i++) {
    const { step } = planStep(view, p, t, visited, prev)
    if (!step) break
    p = step.to
    prev = step.dir ?? prev
    visited.add(p.join(','))
    out.push(p)
    if (excavationDistance(p, t) === 0) break
  }
  return out
}

describe('planStep', () => {
  it('digs straight down (verified) for a depth goal with nothing in the way', () => {
    const { step } = planStep(mapView(ground), P, { y: 40 }, new Set())
    expect(step?.kind).toBe('shaft')
    expect(step?.dig).toEqual([[0, 64, 0]])
    expect(step?.to).toEqual([0, 64, 0])
  })

  it('takes staircase steps toward a target that is both below and away', () => {
    const { step } = planStep(mapView(ground), P, { y: 40, xz: [20, 0] }, new Set())
    expect(step?.kind).toBe('stair_down')
    expect(step?.dir).toEqual([1, 0])
    expect(step?.dig).toEqual([[1, 66, 0], [1, 65, 0], [1, 64, 0]].filter(c => c[1] <= 64))
    expect(step?.to).toEqual([1, 64, 0])
  })

  it('tunnels horizontally once at the target depth', () => {
    const { step } = planStep(mapView(ground), [0, 40, 0], { y: 40, xz: [0, -9] }, new Set())
    expect(step?.kind).toBe('tunnel')
    expect(step?.dir).toEqual([0, -1])
    expect(step?.to).toEqual([0, 40, -1])
  })

  it('never digs down into lava: lava two blocks below forces a sideways stair', () => {
    const view = mapView(ground, { '0,63,0': 'lava' })
    const { step, blocked } = planStep(view, P, { y: 40 }, new Set())
    expect(blocked.some(b => b.kind === 'shaft' && b.reason === 'lava_adjacent')).toBe(true)
    expect(step).not.toBeNull()
    expect(step!.kind).not.toBe('shaft')
    // Nothing the chosen step opens touches the lava.
    for (const c of step!.dig) expect(Math.abs(c[0]) + Math.abs(c[1] - 63) + Math.abs(c[2])).toBeGreaterThan(1)
  })

  it('refuses to open a block next to water', () => {
    const view = mapView(ground, { '1,64,0': 'water' })
    const { blocked } = planStep(view, P, { y: 40 }, new Set())
    expect(blocked.find(b => b.kind === 'shaft')?.reason).toBe('water_adjacent')
  })

  it('does not drop more than 3 blocks into a cave', () => {
    const cells: Record<string, string> = {}
    for (let y = 55; y <= 63; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) cells[`${x},${y},${z}`] = 'air'
    const view = mapView(ground, cells)
    const { blocked } = planStep(view, P, { y: 40 }, new Set())
    expect(blocked.find(b => b.kind === 'shaft')?.reason).toBe('drop_too_deep')
    // Walks off to the side and descends beside the cave, never falling more than 3.
    const path = walk(view, P, { y: 40 }, 200)
    expect(path.at(-1)![1]).toBe(40)
    for (let i = 1; i < path.length; i++) expect(path[i - 1]![1] - path[i]![1]).toBeLessThanOrEqual(3)
  })

  it('allows a short drop into a cave floor within 3 blocks', () => {
    const view = mapView(ground, { '0,63,0': 'air', '0,62,0': 'air' })
    const { step } = planStep(view, P, { y: 40 }, new Set())
    expect(step?.kind).toBe('shaft')
    expect(step?.to).toEqual([0, 62, 0])
    expect(step?.fall).toBe(2)
  })

  it('reports needs_pickaxe when rock is impractical to dig by hand', () => {
    const view = mapView(ground, {}, n => (n === 'stone' ? 7500 : n === 'bedrock' ? Infinity : 750))
    const { step, blocked } = planStep(view, [0, 50, 0], { y: 40 }, new Set())
    expect(step).toBeNull()
    expect(classifyBlocked(blocked)).toMatchObject({ cls: 'MISSING_RESOURCE' })
  })

  it('stops at bedrock with an unreachable classification', () => {
    const { step, blocked } = planStep(mapView(ground), [0, 1, 0], { y: -10 }, new Set())
    expect(step?.kind ?? null).not.toBe('shaft')
    expect(blocked.some(b => b.reason.startsWith('unbreakable:bedrock'))).toBe(true)
  })

  it('refuses stair-up under gravel that would fall on the head', () => {
    const view = mapView(ground, { '0,43,0': 'gravel' })
    const { step, blocked } = planStep(view, [0, 40, 0], { y: 45 }, new Set())
    const ups = blocked.filter(b => b.kind === 'stair_up')
    expect(ups).toHaveLength(4)
    expect(ups.every(b => b.reason === 'gravity_overhead')).toBe(true)
    expect(step?.kind).not.toBe('stair_up')
  })

  it('reaches a covered target through dirt and stone without revisiting cells', () => {
    const t: ExcavationTarget = { y: 30, xz: [12, -7] }
    const path = walk(mapView(ground), P, t, 200)
    expect(path.at(-1)).toEqual([12, 30, -7])
    expect(new Set(path.map(p => p.join(','))).size).toBe(path.length)
    // Every consecutive pair is a legal single step (≤ 1 horizontal, ≤ 3 down, ≤ 1 up).
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [path[i - 1]!, path[i]!]
      expect(Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2])).toBeLessThanOrEqual(1)
      expect(b[1] - a[1]).toBeGreaterThanOrEqual(-3)
      expect(b[1] - a[1]).toBeLessThanOrEqual(1)
    }
  })

  it('is deterministic', () => {
    const t: ExcavationTarget = { y: 35, xz: [-9, 14] }
    expect(walk(mapView(ground), P, t, 200)).toEqual(walk(mapView(ground), P, t, 200))
  })
})

describe('undergroundTarget', () => {
  const view = mapView(ground)
  it('excavates for depth goals well below the feet', () => {
    expect(undergroundTarget(view, { kind: 'y', target: 16 }, [0.5, 65, 0.5])).toEqual({ y: 16 })
    expect(undergroundTarget(view, { kind: 'y', target: 63 }, [0.5, 65, 0.5])).toBeNull()
  })
  it('excavates for covered targets below, but not for surface travel', () => {
    expect(undergroundTarget(view, { kind: 'near', target: [10, 20, 5], range: 1.5 }, [0.5, 65, 0.5])).toEqual({ y: 20, xz: [10, 5] })
    expect(undergroundTarget(view, { kind: 'near', target: [10, 65, 5], range: 1.5 }, [0.5, 65, 0.5])).toBeNull()
    expect(undergroundTarget(view, { kind: 'xz', target: [100, 0, 5], range: 3 }, [0.5, 65, 0.5])).toBeNull()
  })
  it('treats tree canopy as not covering', () => {
    const v = mapView(ground, { '3,70,3': 'oak_leaves', '3,71,3': 'oak_leaves', '3,72,3': 'oak_log' })
    expect(isCovered(v, [3, 65, 3])).toBe(false)
    expect(isCovered(v, [3, 50, 3])).toBe(true)
  })
})
