import { describe, expect, it } from 'vitest'
import { nextSearchHeading } from '../../src/skills/generic/collect.js'
import { mulberry32 } from '../../src/bot/rng.js'

// Unit vector of a heading in the searchStep convention: x = sin h, z = −cos h.
const dir = (h: number) => [Math.sin(h), -Math.cos(h)] as const

describe('collect search heading', () => {
  it('leads away from the spawn point once the bot has left it', () => {
    const rnd = mulberry32(7)
    for (let i = 0; i < 200; i++) {
      const me: [number, number, number] = [60 * Math.cos(i), 64, 60 * Math.sin(i)]
      const [dx, dz] = dir(nextSearchHeading(me, [0, 64, 0], null, false, rnd))
      const out = (dx * me[0] + dz * me[2]) / Math.hypot(me[0], me[2])
      expect(out).toBeGreaterThan(Math.cos(Math.PI / 4) - 1e-9) // within ±45° of straight outward
    }
  })

  it('six steps from spawn end far from it (no circling)', () => {
    const rnd = mulberry32(3)
    let me: [number, number, number] = [0, 64, 0]
    let h: number | null = null
    for (let n = 0; n < 6; n++) {
      h = nextSearchHeading(me, [0, 64, 0], h, false, rnd)
      const [dx, dz] = dir(h)
      me = [me[0] + dx * 48, 64, me[2] + dz * 48]
    }
    expect(Math.hypot(me[0], me[2])).toBeGreaterThan(200)
  })

  it('turns at least 90° after a failed step', () => {
    const rnd = mulberry32(5)
    for (let i = 0; i < 50; i++) {
      const h = nextSearchHeading([100, 64, 0], [0, 64, 0], 1, true, rnd)
      const [ax, az] = dir(1)
      const [bx, bz] = dir(h)
      expect(ax * bx + az * bz).toBeLessThanOrEqual(1e-9)
    }
  })
})
