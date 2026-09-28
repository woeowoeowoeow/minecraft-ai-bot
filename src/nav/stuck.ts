import type { V3 } from '../schema/index.js'

export type StuckReason = 'no_displacement' | 'no_progress'

export type StuckOptions = {
  /** Window for the displacement rule (architecture §7.1: < 0.5 blocks in 5 s). */
  windowMs: number
  minDisplacement: number
  /** No improvement in distance-to-goal for this long. */
  noProgressMs: number
  /** Improvement smaller than this does not count as progress. */
  minImprovement: number
}

export const DEFAULT_STUCK: StuckOptions = { windowMs: 5000, minDisplacement: 0.5, noProgressMs: 20000, minImprovement: 0.5 }

/**
 * Pure NAV_STUCK detector. Feed it samples while the navigator expects the bot
 * to be moving; `exempt` samples (digging/placing) never trigger the
 * displacement rule but still count toward the no-progress rule.
 */
export class StuckDetector {
  private samples: { t: number; pos: V3 }[] = []
  private bestDist = Infinity
  private bestAt = 0

  constructor (private readonly o: StuckOptions = DEFAULT_STUCK) {}

  reset (t: number, dist = Infinity): void {
    this.samples = []
    this.bestDist = dist
    this.bestAt = t
  }

  sample (t: number, pos: V3, dist: number, exempt = false): StuckReason | null {
    if (this.bestAt === 0 && this.bestDist === Infinity) this.bestAt = t
    if (dist < this.bestDist - this.o.minImprovement) {
      this.bestDist = dist
      this.bestAt = t
    }
    if (exempt) {
      this.samples = []
    } else {
      this.samples.push({ t, pos })
      while (this.samples.length > 1 && t - this.samples[1]!.t >= this.o.windowMs) this.samples.shift()
      const first = this.samples[0]!
      if (t - first.t >= this.o.windowMs) {
        let maxDisp = 0
        for (const s of this.samples) {
          maxDisp = Math.max(maxDisp, Math.hypot(s.pos[0] - first.pos[0], s.pos[1] - first.pos[1], s.pos[2] - first.pos[2]))
        }
        if (maxDisp < this.o.minDisplacement) return 'no_displacement'
      }
    }
    if (t - this.bestAt >= this.o.noProgressMs) return 'no_progress'
    return null
  }
}

/**
 * Long-range waypointing (architecture §10): goals more than `threshold`
 * blocks away horizontally are split into legs of ≤ `legLen` toward the target.
 * Returns intermediate XZ waypoints only (the final goal is appended by the caller).
 */
export function planWaypoints (from: V3, to: V3, threshold = 96, legLen = 64): [number, number][] {
  const dx = to[0] - from[0]
  const dz = to[2] - from[2]
  const d = Math.hypot(dx, dz)
  if (d <= threshold) return []
  const n = Math.ceil(d / legLen)
  const out: [number, number][] = []
  for (let i = 1; i < n; i++) out.push([Math.round(from[0] + (dx * i) / n), Math.round(from[2] + (dz * i) / n)])
  return out
}
