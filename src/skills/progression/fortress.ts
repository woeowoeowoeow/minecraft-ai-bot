// findFortress (milestone C, architecture §6.3): bounded, deterministic Nether search
// until the observer has seen fortress nether bricks in the loaded chunks. Strategy
// `regions` (default) heads for the unresolved structure zone with the most unseen area
// per block of travel (fortress-plan.ts); strategy `axis` (the alternate) sweeps the
// least-seen cardinal direction. Explored chunks, bastions and failed headings are bot
// memory, so a retried or re-issued search continues instead of starting over.
import { z } from 'zod'
import progression from '../../../config/progression.json' with { type: 'json' }
import { fortressKnown } from '../../planner/milestones.js'
import { cRoute } from '../../planner/policy.js'
import type { WorldState } from '../../observer/types.js'
import type { V3 } from '../../schema/index.js'
import { waitFor } from '../acts.js'
import { SkillFailure, type SkillDef } from '../types.js'
import { blockedHeading, chooseAxis, chooseRegion, legToward } from './fortress-plan.js'
import { netherLeg, rememberFailed } from './nether-move.js'
import { exitPortal } from './nether.js'

const C = progression.C

const Params = z.object({
  mode: z.enum(['regions', 'axis']).default('regions'),
  /** Travel legs per run (each ≤ `leg` blocks); the objective is re-issued after a failure. */
  maxLegs: z.number().int().positive().default(14),
  leg: z.number().positive().default(64),
  /** Zones farther than this from the arrival portal are not searched (axis: the sweep's reach). */
  maxRadius: z.number().positive().default(C.fortressRadius),
  /**
   * `any`: stop at the first useful structure, a fortress or a usable bastion (milestone C
   * opportunity order, architecture §10G); `fortress`: only a fortress ends the search.
   */
  target: z.enum(['fortress', 'any']).default('fortress'),
})
type P = z.infer<typeof Params>

/** Fortress blocks the skill checks for itself after each leg (the observer remembers them within 5 s). */
const BRICKS = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs']

/** The search goal: a fortress, or (target `any`) whatever structure sets the C route. */
const found = (s: WorldState, p: P) => p.target === 'any' ? cRoute(s) !== 'search' : fortressKnown(s)

export const findFortress: SkillDef<P, { legs: number; mode: string; explored: number }> = {
  id: 'findFortress',
  level: 'progression',
  params: Params,
  isSatisfied: (s, p) => found(s, p),
  preconditions: s => s.dim === 'the_nether' ? { ok: true } : { ok: false, cls: 'PRECONDITION_FAILED', reason: 'not in the Nether' },
  timeoutMs: (_s, p) => 60_000 + p.maxLegs * 100_000,
  stallMs: 200_000,
  async run (ctx, p) {
    const s0 = ctx.state()
    const origin: V3 = exitPortal(s0)?.pos ?? s0.pos
    const explored = ctx.memory.explored.the_nether
    const isExplored = (cx: number, cz: number) => explored.has(`${cx},${cz}`)
    const ids = BRICKS.map(n => ctx.bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
    let legs = 0
    for (;;) {
      ctx.checkAbort()
      if (found(ctx.state(), p)) return { legs, mode: p.mode, explored: explored.size }
      // Bricks in view that the observer has not recorded yet: wait for its scan.
      if (ctx.bot.findBlocks({ matching: ids, maxDistance: 176, count: 6 }).length >= 6) {
        if (await waitFor(() => found(ctx.state(), p), 6000, ctx.signal)) return { legs, mode: p.mode, explored: explored.size }
      }
      if (legs >= p.maxLegs) throw new SkillFailure('SEARCH_EXHAUSTED', `no fortress after ${legs} legs (${p.mode})`, { key: `fortress=${p.mode}_legs`, explored: explored.size })
      const s = ctx.state()
      const failed = ctx.memory.netherFailed ?? []
      const blocked = (h: number) => blockedHeading(failed, s.pos, h, s.t)
      let target: [number, number]
      let why: Record<string, unknown>
      if (p.mode === 'regions') {
        const bastions = s.memory.locations.filter(l => l.kind === 'bastion' && l.dim === 'the_nether').map(l => l.pos)
        const choice = chooseRegion(s.pos, origin, isExplored, bastions, p.maxRadius)
        if (!choice) throw new SkillFailure('SEARCH_EXHAUSTED', `every structure zone within ${p.maxRadius} of the portal searched`, { key: 'fortress=regions_resolved', explored: explored.size })
        target = choice.target
        why = { region: choice.region, unexplored: choice.unexplored, dist: Math.round(choice.dist), bastions: bastions.length }
      } else {
        const axis = chooseAxis(s.pos, isExplored, 256, blocked)
        if (!axis || Math.hypot(s.pos[0] - origin[0], s.pos[2] - origin[2]) > p.maxRadius + 400) throw new SkillFailure('SEARCH_EXHAUSTED', 'no unseen direction left (axis)', { key: 'fortress=axis_resolved', explored: explored.size })
        target = [s.pos[0] + Math.cos(axis.heading) * p.leg, s.pos[2] + Math.sin(axis.heading) * p.leg]
        why = { heading: Math.round((axis.heading * 180) / Math.PI), unexplored: axis.unexplored }
      }
      const leg = legToward(s.pos, target, p.leg, blocked)
      if (!leg) throw new SkillFailure('NAV_HAZARD', 'every heading from here failed recently', { key: 'fortress=blocked' })
      legs++
      ctx.log('fortress', { kind: 'search', mode: p.mode, target: p.target, n: legs, from: s.pos.map(Math.round), to: leg.to, heading: Math.round((leg.heading * 180) / Math.PI), ...why })
      const before = explored.size
      const r = await netherLeg(ctx, leg.to, leg.heading, 'fortress')
      if (!r.ok) rememberFailed(ctx, leg.heading)
      if (explored.size > before) ctx.progress('explored', explored.size)
    }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
