// Bastion gold for milestone C (architecture §10G): the fast gold source when a bastion is
// known. 1.16.1 bastions hold gold blocks in their walls (9 ingots each; bridge, hoglin stable,
// housing units and treasure templates all carry some) and chests whose loot tables give gold
// ingots, gold blocks and nuggets. The bot walks to the remembered bastion, then takes the
// nearest safely reachable target in small batches:
// - a gold block only with no piglin inside the vanilla anger box (player box inflated by 16;
//   breaking a guarded block angers every piglin there, sight or not) and an iron pickaxe;
// - a chest only with no piglin in that box that can see the bot (opening one angers the
//   piglins that see the player), and with room above to open it;
// never a target whose digging opens lava or water, never one with lava under the stand.
// The objective asks for a small batch (policy goldWant): one gold block already covers it,
// so bartering starts at once and a lucky run stops early.
import { Vec3 } from 'vec3'
import { z } from 'zod'
import progression from '../../../config/progression.json' with { type: 'json' }
import { liveView } from '../../nav/blocks.js'
import { digReleasesLiquid } from '../../nav/hazards.js'
import type { Location, WorldState } from '../../observer/types.js'
import { usableBastion } from '../../planner/policy.js'
import type { V3 } from '../../schema/index.js'
import { dig, equipItem, withTimeout } from '../acts.js'
import { pickup } from '../generic/collect.js'
import { pickaxeFor, piglinsWatching, PIGLIN_GUARD_MARGIN, PIGLIN_GUARD_R } from '../generic/mine.js'
import { sleep } from '../runner.js'
import { wearsGold } from '../survival/threat.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { barterStats } from './barter.js'
import { legToward, blockedHeading } from './fortress-plan.js'
import { netherLeg, rememberFailed } from './nether-move.js'

const C = progression.C

/**
 * Bastion work bounds: within `approachR` of the remembered bastion the bot looks for targets
 * (scan C.bastionScanR around it); `legs` travel legs to get there; a guarded target is waited
 * on `guardWaitMs` (piglins wander), then left `skipS`; `maxTargets` attempts per run.
 */
export const BASTION = { approachR: 40, legs: 8, guardWaitMs: 8000, skipS: 90, failS: 600, maxTargets: 10, reach: 4.2, unreachableS: 600 } as const

const GOLDEN = /^golden_(helmet|chestplate|leggings|boots)$/
/** Chest loot worth taking: gold (barter currency), and a golden armor piece if none is spare. */
export function wantedLoot (name: string, inv: Record<string, number>): boolean {
  if (name === 'gold_ingot' || name === 'gold_block' || name === 'gold_nugget') return true
  if (GOLDEN.test(name)) return Object.keys(inv).filter(k => GOLDEN.test(k)).reduce((a, k) => a + (inv[k] ?? 0), 0) < 2
  return false
}

/** Ingots plus the ingots held as blocks and nuggets. */
export const goldEq = (inv: Record<string, number>) => (inv.gold_ingot ?? 0) + 9 * (inv.gold_block ?? 0) + Math.floor((inv.gold_nugget ?? 0) / 9)

const hd = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)
const key = (v: { x: number; y: number; z: number }) => `bgold:${v.x},${v.y},${v.z}`

type Target = { v: Vec3; kind: 'gold_block' | 'chest'; cost: number }

/**
 * Piglins inside the vanilla anger box around the bot (1.16.1 `PiglinTasks.angerNearbyPiglins`:
 * the player box grown by 16). `seeing` keeps only piglins that may see the bot (a chest opening
 * angers only those); the client's sight estimate counts unknown as seeing.
 */
export function piglinsInBox (s: Pick<WorldState, 'pos' | 'nearby'>, seeing = false): number {
  const me = s.pos
  const h = PIGLIN_GUARD_R + 0.6 + PIGLIN_GUARD_MARGIN
  return s.nearby.entities.filter(e => e.name === 'piglin' && (!seeing || e.los !== false) &&
    Math.abs(e.pos[0] - me[0]) <= h && Math.abs(e.pos[2] - me[2]) <= h && e.pos[1] - me[1] > -(PIGLIN_GUARD_R + 1.95 + PIGLIN_GUARD_MARGIN) && e.pos[1] - me[1] < PIGLIN_GUARD_R + 1.8 + PIGLIN_GUARD_MARGIN).length
}

/** Gold blocks and chests near the bastion worth a try, cheapest first (pure over the block view). */
function targets (ctx: SkillCtx, b: Location, canMineBlocks: boolean): Target[] {
  const bot = ctx.bot
  const reg = bot.registry.blocksByName
  const ids = [reg.chest?.id, ...(canMineBlocks ? [reg.gold_block?.id] : [])].filter((x): x is number => x !== undefined)
  const me = bot.entity.position
  const view = liveView(bot)
  const out: Target[] = []
  // Around the bastion, not the bot: from one end of a large bastion the other end's targets are > 64 blocks off.
  for (const v of bot.findBlocks({ matching: ids, point: new Vec3(b.pos[0], b.pos[1], b.pos[2]), maxDistance: C.bastionScanR + 16, count: 160 })) {
    if (hd([v.x, v.y, v.z], b.pos) > C.bastionScanR || ctx.env.isBlacklisted(key(v))) continue
    const blk = bot.blockAt(v, false)
    if (!blk) continue
    const c: V3 = [v.x, v.y, v.z]
    // At least one open face to work from; nothing that floods the cell with lava or water.
    const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].filter(([dx, dy, dz]) => view.at(c[0] + dx!, c[1] + dy!, c[2] + dz!).kind === 'air')
    if (!faces.length || digReleasesLiquid(view, c)) continue
    if (blk.name === 'chest' && view.at(c[0], c[1] + 1, c[2]).kind === 'solid') continue
    // Lava within 2 below or beside the open faces: a misstep there is a death (bridge and treasure pieces stand over lava).
    let lava = false
    for (const [dx, , dz] of faces) for (let dy = -3; dy <= 0 && !lava; dy++) if (view.at(c[0] + dx!, c[1] + dy, c[2] + dz!).kind === 'lava') lava = true
    if (lava) continue
    const cost = v.distanceTo(me) + 2 * Math.abs(v.y - me.y) + (blk.name === 'chest' ? -3 : 0)
    out.push({ v, kind: blk.name === 'chest' ? 'chest' : 'gold_block', cost })
  }
  return out.sort((a, b) => a.cost - b.cost)
}

/** Gold blocks in inventory → ingots (shapeless 1 → 9, the 2×2 grid). */
async function blocksToIngots (ctx: SkillCtx): Promise<void> {
  const bot = ctx.bot
  const blocks = ctx.state().inventory.gold_block ?? 0
  if (!blocks) return
  const reg = bot.registry
  const r = bot.recipesFor(reg.itemsByName.gold_ingot!.id, null, 1, null).find(x => x.delta.some(d => d.id === reg.itemsByName.gold_block!.id && d.count < 0))
  if (!r) return
  try { await withTimeout(bot.craft(r, blocks, undefined), 8000, 'craft ingots') } catch (e) { ctx.localRecovery(`gold block → ingots: ${(e as Error).message}`) }
}

/** Open a chest and take the gold (and a spare golden armor piece). Ingot equivalents taken. */
async function lootChest (ctx: SkillCtx, v: Vec3): Promise<number> {
  const bot = ctx.bot
  const before = goldEq(ctx.state().inventory)
  const blk = bot.blockAt(v, false)
  if (!blk) return 0
  await bot.lookAt(v.offset(0.5, 0.5, 0.5), true)
  const win = await withTimeout(bot.openContainer(blk), 6000, 'open chest')
  try {
    for (const it of win.containerItems()) {
      if (!wantedLoot(it.name, ctx.state().inventory)) continue
      try { await withTimeout(win.withdraw(it.type, null, it.count), 4000, 'withdraw') } catch (e) { ctx.localRecovery(`withdraw ${it.name}: ${(e as Error).message}`) }
    }
  } finally {
    try { win.close() } catch { /* ignore */ }
  }
  await sleep(300, ctx.signal)
  return Math.max(0, goldEq(ctx.state().inventory) - before)
}

const Params = z.object({
  /** Gold ingots to hold (absolute; blocks are converted). */
  count: z.number().int().positive(),
  maxTargets: z.number().int().positive().default(BASTION.maxTargets),
})
type P = z.infer<typeof Params>

export const bastionGold: SkillDef<P, { ingots: number; blocks: number; chests: number; guarded: number }> = {
  id: 'bastionGold',
  level: 'progression',
  params: Params,
  isSatisfied: (s, p) => (s.inventory.gold_ingot ?? 0) >= p.count,
  preconditions: (s) => {
    if (s.dim !== 'the_nether') return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'bastions are in the Nether' }
    if (!usableBastion(s)) return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'no usable bastion remembered' }
    const gold = Object.keys(s.inventory).some(k => GOLDEN.test(k) && (s.inventory[k] ?? 0) > 0)
    if (!gold) return { ok: false, reason: 'no golden armor (piglins would attack)', missing: [{ item: 'golden_helmet', count: 1 }] }
    return { ok: true }
  },
  timeoutMs: () => 12 * 60_000,
  stallMs: 150_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const led = barterStats(ctx.memory)
    const gold = () => ctx.state().inventory.gold_ingot ?? 0
    const start = gold()
    let legs = 0
    let tried = 0
    let blocks = 0
    let chests = 0
    let guarded = 0
    if (!wearsGold(ctx.state())) {
      const g = Object.keys(ctx.state().inventory).find(k => GOLDEN.test(k))
      if (g) await equipItem(bot, g, g.endsWith('helmet') ? 'head' : g.endsWith('chestplate') ? 'torso' : g.endsWith('leggings') ? 'legs' : 'feet')
    }
    const canMineBlocks = () => {
      const pick = pickaxeFor(bot, 'gold_block')
      const inv = ctx.state().inventory
      return pick === null || ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].some(k => (inv[k] ?? 0) > 0)
    }
    for (;;) {
      ctx.checkAbort()
      await blocksToIngots(ctx)
      if (gold() >= p.count) break
      if (ctx.env.isBlacklisted('provoked:piglin')) throw new SkillFailure('COMBAT_DANGER', 'piglins turned hostile', { key: 'piglins=hostile' })
      const s = ctx.state()
      const b = usableBastion(s)
      if (!b) break
      if (hd(s.pos, b.pos) > BASTION.approachR) {
        if (legs >= BASTION.legs) {
          b.detail = { ...b.detail, unreachableUntil: s.t + BASTION.unreachableS }
          ctx.log('bastion', { kind: 'unreachable', bastion: b.pos.map(Math.round), legs, dist: Math.round(hd(s.pos, b.pos)) })
          throw new SkillFailure('NAV_UNREACHABLE', `bastion not reached after ${legs} legs`, { key: 'target=bastion' })
        }
        const failed = ctx.memory.netherFailed ?? []
        const leg = legToward(s.pos, [b.pos[0], b.pos[2]], 64, h => blockedHeading(failed, s.pos, h, s.t))
        if (!leg) {
          b.detail = { ...b.detail, unreachableUntil: s.t + BASTION.unreachableS }
          throw new SkillFailure('NAV_HAZARD', 'every heading toward the bastion failed recently', { key: 'target=bastion' })
        }
        legs++
        ctx.log('bastion', { kind: 'approach', n: legs, bastion: b.pos.map(Math.round), dist: Math.round(hd(s.pos, b.pos)) })
        const r = await netherLeg(ctx, leg.to, leg.heading, 'bastion')
        if (!r.ok) rememberFailed(ctx, leg.heading)
        continue
      }
      const cands = targets(ctx, b, canMineBlocks())
      if (!cands.length || tried >= p.maxTargets) {
        if (!cands.length) {
          b.detail = { ...b.detail, exhausted: true }
          ctx.log('bastion', { kind: 'exhausted', bastion: b.pos.map(Math.round), blocks, chests, ironPick: canMineBlocks() })
        }
        break
      }
      const t = cands[0]!
      tried++
      const tv: V3 = [t.v.x, t.v.y, t.v.z]
      const r = await ctx.nav.goto({ kind: 'near', target: tv, range: 3, mode: 'path' }, { profile: 'nether_travel', timeoutMs: 45_000 })
      if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
      if (!r.ok || bot.entity.position.offset(0, 1.62, 0).distanceTo(t.v.offset(0.5, 0.5, 0.5)) > BASTION.reach) {
        ctx.env.blacklist(key(t.v), 'bastion_unreachable', BASTION.failS)
        ctx.log('bastion', { kind: 'skip', why: 'unreachable', target: t.kind, at: tv, nav: r.ok ? 'ok' : r.class })
        continue
      }
      // Piglins wander: wait a little for the anger box to clear, then leave the target for a while.
      const isGuarded = () => t.kind === 'gold_block' ? piglinsWatching(ctx.state()) > 0 : piglinsInBox(ctx.state(), true) > 0
      const t0 = Date.now()
      while (isGuarded() && Date.now() - t0 < BASTION.guardWaitMs) { ctx.checkAbort(); await sleep(500, ctx.signal) }
      if (isGuarded()) {
        guarded++
        ctx.env.blacklist(key(t.v), 'piglins_watching', BASTION.skipS)
        ctx.log('bastion', { kind: 'guarded', target: t.kind, at: tv, piglins: piglinsInBox(ctx.state(), t.kind === 'chest') })
        continue
      }
      const before = gold()
      if (t.kind === 'chest') {
        let got = 0
        try { got = await lootChest(ctx, t.v) } catch (e) { ctx.checkAbort(); ctx.localRecovery(`chest: ${(e as Error).message}`) }
        // Looted (or unopenable): never again.
        ctx.env.blacklist(key(t.v), 'chest_looted', 24 * 3600)
        chests++
        led.gold.chest += got
        ctx.log('bastion', { kind: 'chest', at: tv, ingots: got, held: goldEq(ctx.state().inventory) })
      } else {
        const blk = bot.blockAt(t.v, false)
        if (!blk || blk.name !== 'gold_block') { ctx.env.blacklist(key(t.v), 'gone', BASTION.failS); continue }
        const had = ctx.state().inventory.gold_block ?? 0
        try {
          await dig(bot, blk, ctx.signal)
        } catch (e) {
          ctx.checkAbort()
          ctx.env.blacklist(key(t.v), 'dig_failed', BASTION.failS)
          ctx.localRecovery(`gold block dig: ${(e as Error).message}`)
          continue
        }
        await pickup(ctx, t.v, () => (ctx.state().inventory.gold_block ?? 0) > had)
        const got = (ctx.state().inventory.gold_block ?? 0) > had
        ctx.env.blacklist(key(t.v), 'mined', 24 * 3600)
        if (got) { blocks++; led.gold.bastionBlock += 9 }
        ctx.log('bastion', { kind: 'gold_block', at: tv, picked: got, piglinsInBox: piglinsInBox(ctx.state()) })
      }
      await blocksToIngots(ctx)
      if (gold() > before) ctx.progress('gold', gold())
    }
    const ingots = gold() - start
    if (gold() < 1) throw new SkillFailure('NOT_FOUND', `no gold from the bastion (${tried} targets, ${guarded} guarded)`, { key: 'target=bastion_gold', blocks, chests, guarded })
    return { ingots, blocks, chests, guarded }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
