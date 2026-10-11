// Nether travel legs for milestone C (fortress search, piglin and enderman search):
// a pathfinder leg with the `nether` profile (no parkour, drops ≤ 2, lava kept at a
// distance, netherrack/cobblestone bridging), and when that fails a straight 2-high
// tunnel at the current level by controlled excavation, which never opens a block
// beside lava. A failed heading is remembered (memory.netherFailed) so later legs
// from nearby turn away from it.
import type { V3 } from '../../schema/index.js'
import type { SkillCtx } from '../types.js'
import type { FailedHeading } from './fortress-plan.js'

/** Pathfinder leg budget (a 64-block leg in rough terrain). */
const PATH_LEG_MS = 75_000
/** Tunnel fallback length and the feet levels it keeps to (above the lava sea at y 31, below the roof). */
export const TUNNEL = { len: 24, minY: 36, maxY: 110 } as const

export type LegResult = { ok: boolean; via: 'path' | 'tunnel' | null; moved: number; cls: string | null }

const hd = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)

/** Remember a failed heading from here (Nether search legs avoid it for a while). */
export function rememberFailed (ctx: SkillCtx, heading: number): void {
  const s = ctx.state()
  const list = (ctx.memory.netherFailed ??= [])
  list.push({ pos: s.pos.map(Math.round) as V3, heading, t: s.t } satisfies FailedHeading)
  if (list.length > 64) list.splice(0, list.length - 64)
}

/**
 * One leg toward `to` (x, z): the pathfinder first, then a straight tunnel along `heading`
 * at feet level (clamped to TUNNEL.minY..maxY by stepping the target's y). A leg that
 * moved the bot ≥ 24 blocks counts as progress even if its goal was not reached.
 */
export async function netherLeg (ctx: SkillCtx, to: [number, number], heading: number, what: string): Promise<LegResult> {
  const start = ctx.state().pos
  const r = await ctx.nav.goto({ kind: 'xz', target: [to[0], 0, to[1]], range: 6, mode: 'path' }, { profile: 'nether_travel', timeoutMs: PATH_LEG_MS })
  if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
  let moved = hd(ctx.state().pos, start)
  if (r.ok || moved >= 24) {
    ctx.log('fortress', { kind: 'leg', for: what, via: 'path', ok: r.ok, moved: Math.round(moved), to })
    return { ok: true, via: 'path', moved, cls: r.ok ? null : r.class }
  }
  const p = ctx.state().pos
  const y = Math.min(TUNNEL.maxY, Math.max(TUNNEL.minY, Math.floor(p[1] + 0.05)))
  const t: V3 = [Math.round(p[0] + Math.cos(heading) * TUNNEL.len), y, Math.round(p[2] + Math.sin(heading) * TUNNEL.len)]
  const r2 = await ctx.nav.goto({ kind: 'near', target: t, range: 2, mode: 'excavate' }, { profile: 'nether' })
  if (!r2.ok && r2.class === 'CANCELLED') ctx.checkAbort()
  moved = hd(ctx.state().pos, start)
  const ok = r2.ok || moved >= 12
  ctx.log('fortress', { kind: 'leg', for: what, via: 'tunnel', ok, moved: Math.round(moved), to, pathClass: r.ok ? null : r.class, tunnelClass: r2.ok ? null : r2.class })
  return { ok, via: 'tunnel', moved, cls: r2.ok ? null : r2.class }
}
