// `obtain(item, count)` (architecture §6.1): the recursive resolver's executor.
// Resolves the request against the current inventory (sources.ts, pure and
// bounded), then runs each step as a child skill. Every step is goal-shaped, so
// after a failure the plan is re-resolved from the real inventory (bounded
// replans): a broken pickaxe or a lost crafting table simply reappears as a step.
import { z } from 'zod'
import type { WorldState } from '../../observer/types.js'
import type { SkillResult } from '../../schema/index.js'
import { countOf, GROUPS, planObtain, ResolveError, type Hints, type Step } from '../sources.js'
import { Vec3 } from 'vec3'
import { dig } from '../acts.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { pickup } from './collect.js'

const Params = z.object({
  item: z.string(),
  count: z.number().int().positive(),
  /** Passed to search-heavy children (more search steps on later ladder levels). */
  searchSteps: z.number().int().min(0).optional(),
})
type P = z.infer<typeof Params>

/** Replans after a recoverable step failure (missing input, tool broke, desync). */
export const MAX_REPLANS = 4
const REPLAN_ON = new Set(['MISSING_RESOURCE', 'STATE_INCONSISTENT'])

export function hintsFrom (s: WorldState): Hints {
  const near = (kind: string, r: number) => (s.nearby.interestBlocks[kind] ?? []).some(v => Math.hypot(v[0] - s.pos[0], v[1] - s.pos[1], v[2] - s.pos[2]) <= r)
  return {
    tableNear: near('crafting_table', 20),
    furnaceNear: near('furnace', 20),
    coalOreKnown: (s.nearby.interestBlocks.coal_ore ?? []).length > 0 || (s.inventory.coal ?? 0) > 0,
    ...(s.dim === 'the_nether' ? { nether: true } : {}),
  }
}

/** A remembered furnace (same dimension, ≤ 160 blocks) still holding items that smelt into `output`. */
export function pendingFurnace (s: WorldState, output: string): WorldState['memory']['locations'][number] | null {
  const matches = (o: unknown) => typeof o === 'string' && (o === output || (GROUPS[output]?.(o) ?? false) || (GROUPS[o]?.(output) ?? false))
  return s.memory.locations.find(l => l.kind === 'furnace' && l.dim === s.dim && Number(l.detail?.pending ?? 0) > 0 && matches(l.detail?.output) &&
    Math.hypot(l.pos[0] - s.pos[0], l.pos[2] - s.pos[2]) <= 160) ?? null
}

/** Child skill and params for a resolved step. */
export function stepCall (st: Step, searchSteps?: number): { skill: string; params: Record<string, unknown> } {
  const extra = searchSteps !== undefined ? { searchSteps } : {}
  switch (st.kind) {
    case 'gather':
      return st.skill === 'mine'
        ? { skill: 'mine', params: { blocks: st.blocks, item: st.item, count: st.count, ...extra } }
        : { skill: 'collect', params: { block: st.blocks[0], item: st.item === st.blocks[0] ? undefined : st.item, count: st.count, chance: Boolean(st.chance), ...extra } }
    case 'craft': return { skill: 'craft', params: { item: st.item, count: st.count } }
    case 'smelt': return { skill: 'smelt', params: { item: st.item, count: st.count, input: st.input } }
    case 'hunt': return { skill: 'hunt', params: { item: st.item, count: st.count, mobs: st.mobs, ...extra } }
    case 'fill': return { skill: 'fillBucket', params: { count: st.count, ...extra } }
  }
}

/** Rough duration of a step, for the obtain budget (generous; the runner enforces each child's own timeout). */
function stepMs (st: Step, s: WorldState): number {
  const n = Math.max(1, st.count - countOf(s.inventory, st.item))
  switch (st.kind) {
    case 'gather': return st.skill === 'mine' ? 90_000 + 40_000 * n : 60_000 + (st.chance ? 40_000 : 15_000) * n
    case 'craft': return 45_000
    case 'smelt': return 45_000 + 11_000 * n
    case 'hunt': return 120_000 + 30_000 * n
    case 'fill': return 180_000
  }
}

/**
 * Carry the crafting table on: after a successful obtain, dig up a table this
 * obtain placed (remembered as built) if none is carried and it is close by.
 */
async function retrieveTable (ctx: SkillCtx, since: number): Promise<void> {
  const bot = ctx.bot
  const s = ctx.state()
  if ((s.inventory.crafting_table ?? 0) > 0) return
  const loc = s.memory.locations.find(l => l.kind === 'crafting_table' && l.source === 'built' && l.lastSeen >= since && l.dim === s.dim &&
    Math.hypot(l.pos[0] - s.pos[0], l.pos[1] - s.pos[1], l.pos[2] - s.pos[2]) <= 6)
  if (!loc) return
  const b = bot.blockAt(new Vec3(...loc.pos), false)
  const forget = () => { ctx.memory.locations = ctx.memory.locations.filter(l => l !== loc) }
  if (b?.name !== 'crafting_table') { forget(); return }
  try {
    await dig(bot, b, ctx.signal)
    await pickup(ctx, b.position, () => bot.inventory.items().some(i => i.name === 'crafting_table'))
    if (bot.inventory.items().some(i => i.name === 'crafting_table')) forget()
  } catch { ctx.checkAbort() }
}

export const obtain: SkillDef<P, { steps: number; replans: number }> = {
  id: 'obtain',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => countOf(s.inventory, p.item) >= p.count,
  preconditions: () => ({ ok: true }),
  timeoutMs: (s, p) => {
    try {
      const { steps } = planObtain(p.item, p.count, s.inventory, hintsFrom(s))
      return Math.min(30 * 60_000, 60_000 + steps.reduce((a, st) => a + stepMs(st, s), 0) * 1.5)
    } catch { return 60_000 }
  },
  stallMs: 180_000,
  async run (ctx, p) {
    let ran = 0
    // A child that could not reach a remembered table or furnace overrides the hint: the
    // plan must then carry its own (dev batch 3: 20 identical craft failures per second).
    const unreachable = new Set<string>()
    let lastStep = ''
    let repeats = 0
    const since = ctx.state().t
    for (let replan = 0; ; replan++) {
      ctx.checkAbort()
      const s = ctx.state()
      if (countOf(s.inventory, p.item) >= p.count) {
        await retrieveTable(ctx, since)
        return { steps: ran, replans: replan }
      }
      let steps: Step[]
      try {
        const h = hintsFrom(s)
        if (unreachable.has('crafting_table')) h.tableNear = false
        if (unreachable.has('furnace')) h.furnaceNear = false
        steps = planObtain(p.item, p.count, s.inventory, h).steps
      } catch (e) {
        if (e instanceof ResolveError) throw new SkillFailure('MISSING_RESOURCE', e.message, { key: `item=${e.item}` }, [{ item: e.item, count: 1 }])
        throw e
      }
      ctx.log('objective', { note: 'obtain_plan', item: p.item, count: p.count, replan, steps: steps.map(st => `${st.kind}:${st.item}→${st.count}`) })
      // Items left cooking in a remembered furnace (the smelt was preempted): collect them
      // before gathering the inputs again.
      const sm = steps.find(x => x.kind === 'smelt') as Extract<Step, { kind: 'smelt' }> | undefined
      const held = sm ? pendingFurnace(s, sm.item) : null
      if (sm && held) {
        const r = await ctx.run('smelt', { item: sm.item, count: sm.count, input: sm.input, at: held.pos })
        ran++
        if (r.status === 'cancelled') ctx.checkAbort()
        if (r.status !== 'success' && held.detail) held.detail.pending = 0
        replan--
        continue
      }
      // Run the first step only, then re-resolve: hints change on the way (coal ore seen
      // while mining means coal fuel instead of a surface trip for wood).
      const st = steps[0]
      if (!st) throw new SkillFailure('STATE_INCONSISTENT', 'empty plan for an unmet goal', { key: `item=${p.item}` })
      const call = stepCall(st, p.searchSteps)
      const r = await ctx.run(call.skill, call.params)
      ran++
      let failed: SkillResult | null = null
      if (r.status === 'success') {
        const k = `${st.kind}:${st.item}:${st.count}`
        repeats = k === lastStep ? repeats + 1 : 0
        lastStep = k
        if (repeats < 3) { ctx.progress('steps', ran); replan--; continue }
        failed = { ...r, status: 'failure', failure: { class: 'STATE_INCONSISTENT', reason: `step ${k} succeeds without changing the plan`, detail: {}, signature: `STATE_INCONSISTENT|${call.skill}|-|-|loop` } }
      } else {
        if (r.status === 'cancelled') ctx.checkAbort()
        failed = r
      }
      const f = failed.failure
      for (const m of f?.missing ?? []) if (m.item === 'crafting_table' || m.item === 'furnace') unreachable.add(m.item)
      if (f && REPLAN_ON.has(f.class) && replan < MAX_REPLANS) {
        ctx.localRecovery(`replan after ${f.class} in ${failed.skill}: ${f.reason}`)
        continue
      }
      const cls = f?.class ?? (failed.status === 'timeout' ? 'SKILL_TIMEOUT' : 'STALLED')
      const sub = f?.signature.split('|')[4] ?? ''
      throw new SkillFailure(cls, `${failed.skill}: ${f?.reason ?? failed.status}`, { key: `step=${failed.skill}${sub ? ',' + sub : ''}`, child: f?.detail ?? {} }, f?.missing)
    }
  },
}
