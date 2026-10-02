// Death recovery (architecture §7.4 step 3): go back to the death point and pick
// up what is still lying there. Only offered by Recovery when the drops can
// still exist (Overworld, < 4 min old, ≤ 300 blocks, not a lava/void death).
import { z } from 'zod'
import { Vec3S } from '../../schema/index.js'
import { sleep } from '../runner.js'
import { SkillFailure, type SkillDef } from '../types.js'

const Params = z.object({ pos: Vec3S })
type P = z.infer<typeof Params>

export const recoverItems: SkillDef<P, { picked: number }> = {
  id: 'recoverItems',
  level: 'generic',
  params: Params,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 150_000,
  stallMs: 60_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const r = await ctx.nav.goto({ kind: 'near', target: p.pos.map(Math.floor) as [number, number, number], range: 3, mode: 'walk' })
    if (!r.ok) throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, `death point unreachable: ${r.detail.reason ?? r.class}`, { key: 'target=death_point', nav: r.detail })
    let picked = 0
    const end = Date.now() + 25_000
    while (Date.now() < end) {
      ctx.checkAbort()
      const me = bot.entity.position
      const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position && e.position.distanceTo(me) < 10).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
      if (!drops.length) break
      const d = drops[0]!
      const nr = await ctx.nav.goto({ kind: 'near', target: [Math.floor(d.position.x), Math.floor(d.position.y), Math.floor(d.position.z)], range: 0.8 }, { timeoutMs: 8000 })
      await sleep(300, ctx.signal)
      if (!d.isValid) { picked++; ctx.progress('picked', picked) } else if (!nr.ok) break
    }
    return { picked }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
