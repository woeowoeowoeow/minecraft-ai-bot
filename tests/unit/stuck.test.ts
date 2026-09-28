import { describe, expect, it } from 'vitest'
import { planWaypoints, StuckDetector } from '../../src/nav/stuck.js'
import { goalDistance } from '../../src/nav/goal-distance.js'
import { navTimeoutMs } from '../../src/nav/navigator.js'

describe('StuckDetector', () => {
  it('flags no displacement after the 5 s window', () => {
    const d = new StuckDetector()
    d.reset(0, 50)
    let r = null
    for (let t = 0; t <= 5000; t += 250) r = d.sample(t, [0, 64, 0.1 * (t / 5000)], 50)
    expect(r).toBe('no_displacement')
  })

  it('does not flag a moving bot', () => {
    const d = new StuckDetector()
    d.reset(0, 50)
    for (let t = 0; t <= 15000; t += 250) {
      expect(d.sample(t, [t / 250 * 0.2, 64, 0], 50 - t / 1000)).toBeNull()
    }
  })

  it('exempt samples (digging) never trigger the displacement rule', () => {
    const d = new StuckDetector()
    d.reset(0, 50)
    for (let t = 0; t <= 10000; t += 250) expect(d.sample(t, [0, 64, 0], 50 - t / 1000, true)).toBeNull()
  })

  it('flags no progress when moving in circles for 20 s', () => {
    const d = new StuckDetector()
    d.reset(0, 50)
    let r = null
    for (let t = 0; t <= 30000 && !r; t += 250) {
      const a = t / 1000
      r = d.sample(t, [3 * Math.cos(a), 64, 3 * Math.sin(a)], 50 + Math.sin(a))
    }
    expect(r).toBe('no_progress')
  })

  it('no-progress still applies while digging', () => {
    const d = new StuckDetector()
    d.reset(0, 50)
    let r = null
    for (let t = 0; t <= 20000 && !r; t += 250) r = d.sample(t, [0, 64, 0], 50, true)
    expect(r).toBe('no_progress')
  })

  it('reset clears history', () => {
    const d = new StuckDetector()
    d.reset(0, 50)
    for (let t = 0; t <= 4750; t += 250) d.sample(t, [0, 64, 0], 50)
    d.reset(4800, 50)
    expect(d.sample(5000, [0, 64, 0], 50)).toBeNull()
  })
})

describe('planWaypoints', () => {
  it('no waypoints for short goals', () => {
    expect(planWaypoints([0, 64, 0], [90, 64, 0])).toEqual([])
  })
  it('splits long goals into legs of at most 64 blocks', () => {
    const w = planWaypoints([0, 64, 0], [300, 64, 0])
    expect(w.length).toBe(4)
    const pts = [[0, 0], ...w, [300, 0]]
    for (let i = 1; i < pts.length; i++) expect(Math.hypot(pts[i]![0]! - pts[i - 1]![0]!, pts[i]![1]! - pts[i - 1]![1]!)).toBeLessThanOrEqual(64)
  })
})

describe('goal distance & nav timeout', () => {
  it('xz goals ignore height and subtract range', () => {
    expect(goalDistance({ kind: 'xz', target: [10, 0, 0], range: 3 }, [0.5, 100, 0.5])).toBeCloseTo(7)
  })
  it('contract timeout is 20 s + 1.5 s/block', () => {
    expect(navTimeoutMs(100)).toBe(170_000)
  })
})
