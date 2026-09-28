import { z } from 'zod'
import { goalDistance } from '../../nav/goal-distance.js'
import { navBudgetUpperMs } from '../../nav/navigator.js'
import { NavGoalS, NavProfileS, type NavResult } from '../../schema/index.js'
import { SkillFailure, type SkillDef } from '../types.js'

const Params = z.object({ goal: NavGoalS, profile: NavProfileS.default('overworld') })
type P = z.infer<typeof Params>

function contractMs (pos: [number, number, number], p: P): number {
  const d = goalDistance(p.goal, pos)
  return navBudgetUpperMs(p.goal, pos, Number.isFinite(d) ? Math.min(2000, d) : 64)
}

export const navigate: SkillDef<P, NavResult> = {
  id: 'navigate',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => ['near', 'xz', 'y', 'block'].includes(p.goal.kind) && goalDistance(p.goal, s.pos) <= Math.max(0.5, p.goal.range ?? 0),
  preconditions: () => ({ ok: true }),
  // Hard budget: the largest budget the navigator could choose, plus a margin, so the
  // navigator always returns first with its structured diagnostics.
  timeoutMs: (s, p) => contractMs(s.pos, p) + 10_000,
  // The navigator has its own stuck detector (≤ 3 × 20 s); the runner's stall watchdog is the backstop.
  stallMs: 75_000,
  async run (ctx, p) {
    // The navigator picks its own strategy-aware budget (pathfinder contract or excavation).
    const r = await ctx.nav.goto(p.goal, { profile: p.profile })
    if (r.ok) return r
    if (r.class === 'CANCELLED') ctx.checkAbort()
    const cls = r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class
    throw new SkillFailure(cls, r.detail.reason ?? cls, { key: `goal=${p.goal.kind}`, nav: r.detail }, r.detail.missing)
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
