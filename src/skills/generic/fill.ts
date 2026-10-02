// Fill buckets with water (nether_ready option B). A 1.16.1 bucket fills from a
// water *source* block hit by the server's raytrace from the bot's view (5-block
// reach, fluids: source only), so the bot stands next to an open source, looks
// at its surface and uses the bucket.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { z } from 'zod'
import { equipItem, waitFor } from '../acts.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillDef } from '../types.js'
import { Searcher, toSurface } from './explore.js'
import { blockKey } from './collect.js'

const Params = z.object({
  count: z.number().int().positive(),     // absolute water_bucket target
  searchSteps: z.number().int().min(0).default(6),
})
type P = z.infer<typeof Params>

const count = (bot: Bot, name: string) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

/** Open water source blocks (level 0, air above) in loaded range, nearest first. */
export function waterSources (bot: Bot, isBlacklisted: (k: string) => boolean): Vec3[] {
  const id = bot.registry.blocksByName.water!.id
  const me = bot.entity.position
  return bot.findBlocks({ matching: id, maxDistance: 48, count: 64 })
    .filter(v => {
      const b = bot.blockAt(v, false)
      const above = bot.blockAt(v.offset(0, 1, 0), false)
      return b && b.metadata === 0 && above && above.boundingBox === 'empty' && above.name !== 'water' && above.name !== 'lava' && !isBlacklisted(blockKey(v))
    })
    .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
}

export const fillBucket: SkillDef<P, { filled: number }> = {
  id: 'fillBucket',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => (s.inventory.water_bucket ?? 0) >= p.count,
  preconditions: (s) => (s.inventory.bucket ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'no empty bucket', missing: [{ item: 'bucket', count: 1 }] },
  timeoutMs: (_s, p) => 60_000 + 45_000 * p.searchSteps,
  stallMs: 90_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const search = new Searcher('water')
    const start = count(bot, 'water_bucket')
    let fails = 0
    while (count(bot, 'water_bucket') < p.count) {
      ctx.checkAbort()
      if (!count(bot, 'bucket')) throw new SkillFailure('MISSING_RESOURCE', 'no empty bucket', { key: 'item=bucket' }, [{ item: 'bucket', count: 1 }])
      let src = waterSources(bot, k => ctx.env.isBlacklisted(k))[0]
      if (!src && ctx.state().body.covered && search.steps === 0) {
        await toSurface(ctx)
        src = waterSources(bot, k => ctx.env.isBlacklisted(k))[0]
      }
      if (!src) {
        if (search.steps >= p.searchSteps) throw new SkillFailure('SEARCH_EXHAUSTED', 'no open water source found', { key: 'target=water' })
        await search.step(ctx)
        continue
      }
      const r = await ctx.nav.goto({ kind: 'near', target: [src.x, src.y + 1, src.z], range: 2.5 })
      if (!r.ok) {
        ctx.env.blacklist(blockKey(src), r.class)
        if (++fails >= 5) throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, 'water sources unreachable', { key: 'target=water', nav: r.detail })
        continue
      }
      const before = count(bot, 'water_bucket')
      await equipItem(bot, 'bucket', 'hand')
      bot.clearControlStates()
      await bot.lookAt(src.offset(0.5, 0.9, 0.5), true)
      await sleep(150, ctx.signal) // let the look reach the server before the use
      bot.activateItem()
      if (await waitFor(() => count(bot, 'water_bucket') > before, 1500, ctx.signal)) {
        ctx.progress('filled', count(bot, 'water_bucket') - start)
        continue
      }
      ctx.env.blacklist(blockKey(src), 'fill_failed')
      ctx.localRecovery('bucket did not fill')
      if (++fails >= 5) throw new SkillFailure('STATE_INCONSISTENT', 'bucket never filled', { key: 'target=water' })
    }
    return { filled: count(bot, 'water_bucket') - start }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
