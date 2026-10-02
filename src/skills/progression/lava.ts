// nether_ready option B, the lava half: make sure a usable lava pool (≥ 10
// connected source blocks with an open surface, observer.scanLavaPools) is in
// memory. In 1.16.1 carvers fill cave air at y ≤ 10 with lava, so excavating to
// just above the lava level and tunnelling finds one; nothing is built here.
import { z } from 'zod'
import progression from '../../../config/progression.json' with { type: 'json' }
import { UNDERGROUND } from '../../version.js'
import { sleep } from '../runner.js'
import { Searcher } from '../generic/explore.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'

const Params = z.object({ maxSteps: z.number().int().positive().default(8) })
type P = z.infer<typeof Params>

function known (ctx: SkillCtx): boolean {
  return ctx.state().memory.locations.some(l => l.kind === 'lava_pool' && l.dim === 'overworld' && Number(l.detail?.sources ?? 0) >= progression.A.lavaPoolMinSources)
}

/** Feet level for the lava search: a few blocks above the 1.16.1 lava level. */
export const LAVA_SEARCH_Y = UNDERGROUND.lavaLevel + 4

export const findLavaPool: SkillDef<P, { steps: number }> = {
  id: 'findLavaPool',
  level: 'progression',
  params: Params,
  isSatisfied: (s) => s.memory.locations.some(l => l.kind === 'lava_pool' && l.dim === 'overworld' && Number(l.detail?.sources ?? 0) >= progression.A.lavaPoolMinSources),
  preconditions: (s) => Object.keys(s.inventory).some(k => k.endsWith('_pickaxe')) ? { ok: true } : { ok: false, reason: 'needs a pickaxe to dig down', missing: [{ item: 'stone_pickaxe', count: 1 }] },
  timeoutMs: (_s, p) => 120_000 + 60_000 * p.maxSteps,
  stallMs: 120_000,
  async run (ctx, p) {
    const search = new Searcher('lava')
    await sleep(5500, ctx.signal) // one observer lava scan
    while (!known(ctx)) {
      ctx.checkAbort()
      const y = ctx.state().pos[1]
      if (y > LAVA_SEARCH_Y + 6) {
        const r = await ctx.nav.goto({ kind: 'y', target: LAVA_SEARCH_Y })
        if (!r.ok && r.class === 'MISSING_RESOURCE') throw new SkillFailure('MISSING_RESOURCE', r.detail.reason ?? 'no pickaxe', { key: 'tool=pickaxe' }, r.detail.missing)
        if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
        if (r.ok) ctx.progress('descended', 1)
      } else {
        if (search.steps >= p.maxSteps) throw new SkillFailure('SEARCH_EXHAUSTED', `no usable lava pool after ${search.steps} steps`, { key: 'target=lava_pool' })
        await search.step(ctx)
      }
      await sleep(5500, ctx.signal)
    }
    return { steps: search.steps }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
