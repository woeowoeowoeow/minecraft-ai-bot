// Surface resource search (B round 3, after re-gate 20261003): logs, food animals,
// and L2 relocation. Order: what the client has loaded (the caller scans it),
// remembered spots (the caller), then decisive relocation into new terrain.
//
// The previous search took 48-block steps straight away from the spawn point, so
// an ocean start swam outward for 1600–2100 blocks (r12, r15), and a respawn at the
// same spawn repeated the corridor it had already searched (r15: twice). Here each
// relocation step is 96 blocks, picked from a survey of the loaded surface in 16
// headings: land (and for wood, trees and grass) where the loaded chunks show it,
// unexplored chunks beyond the view distance, and no region already searched for
// the same resource without result. Client-visible state only: loaded chunk
// blocks, the chunks the client has loaded (explored), and the bot's own memory.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { SearchedRegion, WorldMemory } from '../../observer/types.js'
import type { Dim, V3 } from '../../schema/index.js'
import type { SkillCtx } from '../types.js'

/** Surface class of a column: the first collision block (or water) from above. null: chunk not loaded. */
export type SurfaceClass = 'water' | 'tree' | 'green' | 'land' | null
export type SurfaceProbe = (x: number, z: number) => SurfaceClass

export const SEARCH = {
  headings: 16,
  /** Survey distances along each heading (inside the client's loaded radius, ~160 at view distance 10). */
  probeDists: [24, 48, 72, 96, 120, 144],
  /** One relocation step (surface). */
  step: 96,
  /** Distances whose chunks decide novelty: beyond the loaded radius around the current position. */
  noveltyDists: [176, 208, 240],
  /** Look-ahead along a heading for searched regions: a respawn inside one still sees which way leads out of them. */
  exhaustDists: [64, 128, 192, 256],
  /** Radius around a position whose scan found nothing that is marked searched (per resource). */
  regionR: { log: 128, animals: 96, relocate: 48 } as Record<string, number>,
  /** How long a searched region stays exhausted (s). Animals wander; trees stay. */
  regionTtlS: { log: 3600, animals: 1500, relocate: 600 } as Record<string, number>,
  maxRegions: 64,
} as const

/** Value of a surface class for a resource: where the resource is likely, and where walking is possible at all. */
const VALUE: Record<string, Record<Exclude<SurfaceClass, null>, number>> = {
  log: { tree: 1, green: 0.5, land: 0.25, water: 0 },
  animals: { green: 1, tree: 0.6, land: 0.3, water: 0 },
  relocate: { green: 1, tree: 1, land: 1, water: 0 },
}
/** Swimming is slow and exposes the bot to drowned: open water along a heading counts against it on its own. */
const W = { value: 2, water: 0.5, novelty: 1, continuity: 0.3, exhausted: 3 } as const

export type HeadingStat = {
  heading: number
  /** Mean resource value of the loaded columns surveyed along the heading (0–1). */
  value: number
  /** Loaded columns that are water (0–1). */
  water: number
  /** Probes in loaded chunks (of SEARCH.probeDists.length). */
  known: number
  /** Unexplored chunks beyond the loaded radius (0–1). */
  novelty: number
  /** Share of the look-ahead points (SEARCH.exhaustDists) inside regions already searched for this resource (0–1). */
  exhausted: number
}

const dirOf = (h: number): [number, number] => [Math.sin(h), -Math.cos(h)]

export function headingDeg (h: number): number {
  return ((Math.round((h * 180) / Math.PI) % 360) + 360) % 360
}

/** Regions searched for `kind` in `dim` that are still exhausted at `now`. */
export function activeRegions (regions: SearchedRegion[] | undefined, kind: string, dim: Dim, now: number): SearchedRegion[] {
  const ttl = SEARCH.regionTtlS[kind] ?? 1800
  return (regions ?? []).filter(r => r.kind === kind && r.dim === dim && now - r.t <= ttl)
}

export function inRegions (regions: SearchedRegion[], x: number, z: number): boolean {
  return regions.some(r => Math.hypot(r.pos[0] - x, r.pos[2] - z) <= r.r)
}

/**
 * Remember that `kind` was searched around `pos` without result (the caller's scan of
 * the loaded area found nothing usable). Overlapping marks refresh instead of piling up.
 */
export function markSearched (memory: Pick<WorldMemory, 'searched'>, kind: string, dim: Dim, pos: V3, now: number, r = SEARCH.regionR[kind] ?? 64): SearchedRegion {
  const list = (memory.searched ??= [])
  const near = list.find(x => x.kind === kind && x.dim === dim && Math.hypot(x.pos[0] - pos[0], x.pos[2] - pos[2]) < r / 2)
  if (near) { near.t = now; return near }
  const reg: SearchedRegion = { kind, dim, pos: [Math.round(pos[0]), Math.round(pos[1]), Math.round(pos[2])], r, t: now }
  list.push(reg)
  if (list.length > SEARCH.maxRegions) list.splice(0, list.length - SEARCH.maxRegions)
  return reg
}

/**
 * Per-heading survey (pure over `probe` and `isExplored`): the resource value of the
 * loaded surface along each of SEARCH.headings directions, the share of unexplored
 * chunks beyond the loaded radius, and whether the step target lies in a region
 * already searched for this resource ahead.
 */
export function surveyHeadings (probe: SurfaceProbe, pos: V3, kind: string, isExplored: (cx: number, cz: number) => boolean, exhausted: SearchedRegion[]): HeadingStat[] {
  const value = VALUE[kind] ?? VALUE.relocate!
  // Every heading leaves the region the bot stands in: only the others tell headings apart
  // (a respawn inside the spawn region still avoids the corridor searched from it).
  const ahead = exhausted.filter(r => Math.hypot(r.pos[0] - pos[0], r.pos[2] - pos[2]) > r.r)
  const out: HeadingStat[] = []
  for (let i = 0; i < SEARCH.headings; i++) {
    const h = (i * 2 * Math.PI) / SEARCH.headings
    const [dx, dz] = dirOf(h)
    let known = 0; let v = 0; let water = 0
    for (const d of SEARCH.probeDists) {
      const c = probe(Math.floor(pos[0] + dx * d), Math.floor(pos[2] + dz * d))
      if (c === null) continue
      known++
      v += value[c]
      if (c === 'water') water++
    }
    let fresh = 0
    for (const d of SEARCH.noveltyDists) {
      const x = Math.floor(pos[0] + dx * d); const z = Math.floor(pos[2] + dz * d)
      if (!isExplored(x >> 4, z >> 4)) fresh++
    }
    const ex = SEARCH.exhaustDists.filter(d => inRegions(ahead, pos[0] + dx * d, pos[2] + dz * d)).length / SEARCH.exhaustDists.length
    out.push({ heading: h, value: known ? v / known : 0, water: known ? water / known : 0, known, novelty: fresh / SEARCH.noveltyDists.length, exhausted: ex })
  }
  return out
}

export function headingScore (st: HeadingStat, prev: number | null): number {
  const cont = prev === null ? 0 : Math.cos(st.heading - prev)
  return W.value * st.value - W.water * st.water + W.novelty * st.novelty + W.continuity * cont - W.exhausted * st.exhausted
}

/** Best heading (deterministic: ties go to the lowest heading index). */
export function chooseHeading (stats: HeadingStat[], prev: number | null, blocked: number[] = []): { stat: HeadingStat; score: number } {
  let best: { stat: HeadingStat; score: number } | null = null
  for (const st of stats) {
    // A heading whose step failed recently (no path, stuck) is left for a while.
    const penalty = blocked.some(b => Math.cos(st.heading - b) > Math.cos(Math.PI / 6)) ? 2 : 0
    const score = headingScore(st, prev) - penalty
    if (!best || score > best.score + 1e-9) best = { stat: st, score }
  }
  return best!
}

const AIRISH = /^(air|cave_air|void_air)$/
const WATERISH = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass|ice|packed_ice|blue_ice|frosted_ice)$/
const TREEISH = /(_leaves|_log)$/
const GREEN = /^(grass_block|podzol|mycelium|moss_block)$/

/** Surface probe over the client's loaded chunks (top-down to the first collision block or water). */
export function surfaceProbe (bot: Bot): SurfaceProbe {
  const top = Math.min(250, Math.max(110, Math.floor(bot.entity.position.y) + 48))
  return (x, z) => {
    for (let y = top; y >= 0; y--) {
      const b = bot.blockAt(new Vec3(x, y, z), false)
      if (!b) return null
      if (AIRISH.test(b.name)) continue
      if (WATERISH.test(b.name)) return 'water'
      if (TREEISH.test(b.name)) return 'tree'
      if (b.boundingBox !== 'block') continue // plants, snow layers, torches: look below
      if (GREEN.test(b.name)) return 'green'
      return 'land'
    }
    return null
  }
}

/**
 * Decisive surface relocation for one resource (`log`, `animals`, `relocate`). Each
 * step marks the area being left as searched (the caller relocates only when its scan
 * of the loaded area found nothing usable), surveys the loaded surface, and walks 96
 * blocks along the best heading, preferring dry land.
 */
export class Relocator {
  steps = 0
  private prev: number | null = null
  private blocked: number[] = []
  private settled = false

  /**
   * Before the first relocation from a place, let the client finish loading the chunks around
   * it (≤ 5 s) and have the caller scan once more: a scan made while chunks still stream in
   * (just spawned, just arrived) would mark the area searched with resources in it. Returns
   * true when the caller should re-scan instead of stepping.
   */
  async settle (ctx: SkillCtx): Promise<boolean> {
    if (this.settled) return false
    this.settled = true
    await Promise.race([ctx.bot.waitForChunksToLoad().catch(() => {}), new Promise(r => setTimeout(r, SETTLE_MS))])
    ctx.checkAbort()
    return true
  }

  constructor (readonly kind: string, private readonly opts: { step?: number; mark?: boolean } = {}) {}

  async step (ctx: SkillCtx): Promise<boolean> {
    const s = ctx.state()
    const mem = ctx.memory
    if (this.opts.mark !== false) {
      const reg = markSearched(mem, this.kind, s.dim, s.pos, s.t)
      ctx.log('search_region', { kind: this.kind, pos: reg.pos, r: reg.r, regions: activeRegions(mem.searched, this.kind, s.dim, s.t).length })
    }
    const explored = mem.explored[s.dim]
    const regions = activeRegions(mem.searched, this.kind, s.dim, s.t)
    const step = this.opts.step ?? SEARCH.step
    const stats = surveyHeadings(surfaceProbe(ctx.bot), s.pos, this.kind, (cx, cz) => explored.has(`${cx},${cz}`), regions)
    const { stat, score } = chooseHeading(stats, this.prev, this.blocked)
    this.steps++
    const [dx, dz] = dirOf(stat.heading)
    const target: V3 = [Math.round(s.pos[0] + dx * step), 0, Math.round(s.pos[2] + dz * step)]
    const landAhead = stats.filter(x => x.known > 0)
    ctx.log('search_step', { n: this.steps, for: this.kind, heading: headingDeg(stat.heading), from: s.pos.map(Math.round), target, mode: 'relocate_surface' })
    ctx.log('search_relocation', {
      kind: this.kind, n: this.steps, from: s.pos.map(Math.round), target, heading: headingDeg(stat.heading),
      value: round2(stat.value), water: round2(stat.water), novelty: round2(stat.novelty), exhausted: stat.exhausted, score: round2(score),
      surveyed: landAhead.length, waterAll: round2(landAhead.length ? landAhead.reduce((a, x) => a + x.water, 0) / landAhead.length : 0),
    })
    const r = await ctx.nav.goto({ kind: 'xz', target, range: 6, dry: true })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    this.settled = false
    if (r.ok) { this.prev = stat.heading; this.blocked = [] } else {
      // A failed heading is avoided for the next steps; progress made on it still counts.
      this.blocked = [...this.blocked.slice(-2), stat.heading]
      this.prev = null
    }
    ctx.progress(`relocate:${this.kind}`, this.steps)
    return r.ok
  }
}

function round2 (v: number): number { return Math.round(v * 100) / 100 }

/** Longest wait for chunks to load before a relocation. */
const SETTLE_MS = 5000
