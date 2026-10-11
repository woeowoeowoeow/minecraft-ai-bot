// Cheap C-phase death recovery (architecture §10G). A C death used to cost 800–2 600 s
// (c-dev1: the walk back from the world spawn through dug caves, then wood, table, pickaxes,
// food and a golden helmet from scratch). Before the first C entry the bot:
// - sets its respawn point at a bed beside the Overworld portal (1.16.1, bed-spawn fixture:
//   using a bed by day sets it; a death then respawns beside the bed, or at the world spawn
//   when the bed is gone), where wool is at hand;
// - stages a small replacement kit in a chest beside the portal: spares crafted from what it
//   carries (stone pickaxe, stone sword, crafting table), surplus food and cobblestone, and
//   whatever spare it carries of golden armor, shield and flint and steel. Never the trip kit.
// Both are optional and cheap only (policy `stageOpen`, after ckit-r2d): from the carried
// inventory, at explicit sites beside the frame (stage-plan.ts), a bounded number of attempts.
// After a death the policy takes the kit first (`takeStash`) and restores only the minimum.
import { Vec3 } from 'vec3'
import { z } from 'zod'
import progression from '../../../config/progression.json' with { type: 'json' }
import type { V3 } from '../../schema/index.js'
import { foodItems, isEdible } from '../food.js'
import { liveView } from '../../nav/blocks.js'
import { equipItem, waitFor, withTimeout } from '../acts.js'
import { sleep } from '../runner.js'
import { planObtain } from '../sources.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { rememberLoc } from './buckets.js'
import { builtLit } from './portal.js'
import { bedAnswer, stageSites, type StageSite } from './stage-plan.js'

const C = progression.C

const hd = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)
const GOLDEN = /^golden_(helmet|chestplate|leggings|boots)$/

/** Count one attempt of an optional staging component (the policy bounds them by C.stageTries). */
function stageTry (ctx: SkillCtx, k: string): void {
  const st = (ctx.memory.cStage ??= { tries: {} })
  st.tries[k] = (st.tries[k] ?? 0) + 1
}

/** The built portal's lit cells (nether_portal blocks within 4 of the remembered cell). */
function portalCells (ctx: SkillCtx): V3[] {
  const loc = builtLit(ctx.state())
  if (!loc) throw new SkillFailure('PRECONDITION_FAILED', 'no built portal remembered', { key: 'target=portal_ow' })
  const id = ctx.bot.registry.blocksByName.nether_portal!.id
  const cells = ctx.bot.findBlocks({ matching: id, maxDistance: 4, count: 12, point: new Vec3(...loc.pos) }).map(p => [p.x, p.y, p.z] as V3)
  return cells.length ? cells : [loc.pos]
}

/** Walk to the site's stand cell (never through the portal: the pathfinder treats its cells as blocked). */
async function toStand (ctx: SkillCtx, site: StageSite): Promise<void> {
  const me = ctx.bot.entity.position
  if (Math.floor(me.x) === site.stand[0] && Math.floor(me.z) === site.stand[2] && Math.abs(me.y - site.stand[1]) < 0.6) return
  let r = await ctx.nav.goto({ kind: 'block', target: site.stand })
  if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
  if (!r.ok) r = await ctx.nav.goto({ kind: 'block', target: site.stand, mode: 'path' })
  if (!r.ok) {
    if (r.class === 'CANCELLED') ctx.checkAbort()
    throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, 'cannot reach the staging site', { key: 'step=reach_site' })
  }
}

/** Place `item` into the site's cell from its stand cell: looking at the floor's top face faces the bed's direction. */
async function placeAtSite (ctx: SkillCtx, item: string, site: StageSite): Promise<Vec3> {
  const bot = ctx.bot
  await toStand(ctx, site)
  const cell = new Vec3(...site.cell)
  const floor = bot.blockAt(cell.offset(0, -1, 0), false)
  if (!floor) throw new SkillFailure('STATE_INCONSISTENT', 'site floor not loaded', { key: 'step=site' })
  await equipItem(bot, item, 'hand')
  bot.clearControlStates()
  await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true)
  try { await withTimeout(bot.placeBlock(floor, new Vec3(0, 1, 0)), 6000, 'place') } catch { /* checked below */ }
  await sleep(250, ctx.signal)
  const b = bot.blockAt(cell, false)
  const block = item === 'chest' ? 'chest' : item
  if (!b || b.name !== block) throw new SkillFailure('STATE_INCONSISTENT', `${item} not placed at the site`, { key: `step=place_${item}`, cell: site.cell, found: b?.name ?? null })
  return cell
}

/** Spares crafted for the kit (counts made by stashKit): these go into the chest whatever the trip carries. */
export type Spares = Partial<Record<'stone_pickaxe' | 'stone_sword' | 'crafting_table', number>>

/**
 * What goes into the chest, from the carried inventory: never the trip kit itself (the best
 * sword, the trip's tables, C.foodItems food, 32 cobblestone stay), the spares made for the kit,
 * and spare golden armor, shield and flint and steel when two are carried. `pickSpare` bounds the
 * stone pickaxes taken (the trip keeps its durability); default: any stone pickaxe beyond none.
 */
export function stashPlan (inv: Record<string, number>, worn: (string | null)[], spares?: Spares, pickSpare?: number): Record<string, number> {
  const n = (k: string) => inv[k] ?? 0
  const out: Record<string, number> = {}
  const swords = n('stone_sword') - (n('iron_sword') + n('diamond_sword') > 0 || (spares?.stone_sword ?? 0) > 0 ? 0 : 1)
  if (swords > 0) out.stone_sword = 1
  const picks = Math.min(C.stashPickaxes, n('stone_pickaxe'), Math.max(spares?.stone_pickaxe ?? 0, pickSpare ?? n('stone_pickaxe')))
  if (picks > 0) out.stone_pickaxe = picks
  if (n('crafting_table') > C.tables || ((spares?.crafting_table ?? 0) > 0 && n('crafting_table') >= 2)) out.crafting_table = 1
  let food = Math.max(0, Math.min(C.stashFood, foodItems(inv) - C.foodItems))
  for (const [k, v] of Object.entries(inv).filter(([k]) => isEdible(k)).sort((a, b) => b[1] - a[1])) {
    if (food <= 0) break
    const t = Math.min(food, v)
    out[k] = t
    food -= t
  }
  const cobble = Math.min(C.stashCobble, n('cobblestone') - 32)
  if (cobble > 0) out.cobblestone = cobble
  if (n('shield') >= 2) out.shield = 1
  if (n('flint_and_steel') >= 2) out.flint_and_steel = 1
  const golden = Object.keys(inv).filter(k => GOLDEN.test(k) && n(k) > 0)
  const spare = golden.reduce((a, k) => a + n(k), 0) >= 2 ? golden.find(k => !worn.includes(k)) ?? golden.find(k => n(k) >= 2) : undefined
  if (spare) out[spare] = 1
  return out
}

/** Every step of obtaining `count` × item is a craft from `inv` (no gather, mine, smelt or hunt). */
function craftable (inv: Record<string, number>, item: string, count: number): boolean {
  try { return planObtain(item, count, inv).steps.every(st => st.kind === 'craft') } catch { return false }
}

/** Spares wanted, in order, while the carried wood, sticks and cobblestone allow (after the chest itself). */
const SPARE_ORDER: (keyof Spares)[] = ['stone_pickaxe', 'stone_sword', 'crafting_table', 'stone_pickaxe']

const NoParams = z.object({})
type NP = z.infer<typeof NoParams>

export const stashKit: SkillDef<NP, { pos: V3; items: Record<string, number> }> = {
  id: 'stashKit',
  level: 'progression',
  params: NoParams,
  isSatisfied: s => !!s.memory.stash,
  preconditions: s => {
    if (s.dim !== 'overworld') return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'the kit is staged at the Overworld portal' }
    if (!builtLit(s)) return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'no built portal remembered' }
    return { ok: true }
  },
  timeoutMs: () => 3 * 60_000,
  stallMs: 90_000,
  async run (ctx) {
    const bot = ctx.bot
    stageTry(ctx, 'stash')
    const n = (k: string) => ctx.state().inventory[k] ?? 0
    // The chest first (crafted from carried planks or logs only), then spares from what is left.
    if (n('chest') < 1) {
      if (!craftable(ctx.state().inventory, 'chest', 1)) throw new SkillFailure('NOT_FOUND', 'no chest and no carried wood for one', { key: 'item=chest' })
      const r = await ctx.run('obtain', { item: 'chest', count: 1 })
      if (r.status === 'cancelled') ctx.checkAbort()
      if (r.status !== 'success') throw new SkillFailure('MISSING_RESOURCE', 'no chest for the kit', { key: 'item=chest' }, [{ item: 'chest', count: 1 }])
    }
    const made: Spares = {}
    for (const item of SPARE_ORDER) {
      const want = n(item) + 1
      if (!craftable(ctx.state().inventory, item, want)) continue
      const r = await ctx.run('obtain', { item, count: want })
      if (r.status === 'cancelled') ctx.checkAbort()
      if (r.status === 'success') made[item] = (made[item] ?? 0) + 1
      else ctx.localRecovery(`spare ${item}: ${r.failure?.reason ?? r.status}`)
    }
    const cells = portalCells(ctx)
    const site = stageSites(liveView(bot), cells, { bed: false, near: C.bedNear, avoid: bedCells(ctx) })[0]
    if (!site) throw new SkillFailure('NOT_FOUND', 'no chest site beside the portal', { key: 'step=chest_site' })
    const at = await placeAtSite(ctx, 'chest', site)
    const st = ctx.state()
    // Stone pickaxes beyond the trip's durability (C.pickReopen) may go in.
    const dur = st.tools.filter(t => t.name.endsWith('_pickaxe')).reduce((a, t) => a + t.remaining, 0)
    const pickSpare = Math.max(0, Math.floor((dur - C.pickReopen) / 131))
    const want = stashPlan(st.inventory, [st.equipment.head, st.equipment.chest, st.equipment.legs, st.equipment.feet], made, pickSpare)
    const win = await withTimeout(bot.openContainer(bot.blockAt(at, false)!), 6000, 'open chest')
    const items: Record<string, number> = {}
    try {
      for (const [name, count] of Object.entries(want)) {
        const id = bot.registry.itemsByName[name]?.id
        if (id === undefined) continue
        try {
          await withTimeout(win.deposit(id, null, count), 4000, 'deposit')
          items[name] = count
        } catch (e) { ctx.localRecovery(`deposit ${name}: ${(e as Error).message}`) }
      }
    } finally {
      try { win.close() } catch { /* ignore */ }
    }
    const pos: V3 = [at.x, at.y, at.z]
    const portal = cells[0]!
    ctx.memory.stash = { pos, items, t: ctx.state().t }
    rememberLoc(ctx, 'chest', pos, 'built', { stash: true }, 1)
    ctx.log('stash', { kind: 'staged', pos, items, made, portal, dist: Math.round(hd(pos, portal)) })
    return { pos, items }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

/** The bed's two cells, when one was placed beside the portal (the chest goes elsewhere). */
function bedCells (ctx: SkillCtx): V3[] {
  const bed = ctx.state().memory.locations.find(l => l.kind === 'bed' && l.dim === 'overworld')
  if (!bed) return []
  const dx = Number(bed.detail?.dx ?? 0)
  const dz = Number(bed.detail?.dz ?? 0)
  return dx || dz ? [bed.pos, [bed.pos[0] + dx, bed.pos[1], bed.pos[2] + dz]] : [bed.pos]
}

export const takeStash: SkillDef<NP, { taken: Record<string, number> }> = {
  id: 'takeStash',
  level: 'progression',
  params: NoParams,
  preconditions: s => s.dim === 'overworld' && s.memory.stash ? { ok: true } : { ok: false, cls: 'PRECONDITION_FAILED', reason: 'no staged kit in this dimension' },
  timeoutMs: s => 3 * 60_000 + (s.memory.stash ? 1500 * hd(s.memory.stash.pos, s.pos) : 0),
  stallMs: 90_000,
  async run (ctx) {
    const bot = ctx.bot
    const st = ctx.memory.stash!
    const t0 = ctx.state().t
    let r = await ctx.nav.goto({ kind: 'near', target: st.pos, range: 2.5 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    if (!r.ok) r = await ctx.nav.goto({ kind: 'near', target: st.pos, range: 2.5, mode: 'path' })
    if (!r.ok) {
      if (r.class === 'CANCELLED') ctx.checkAbort()
      throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, 'cannot reach the staged kit', { key: 'target=stash' })
    }
    const blk = bot.blockAt(new Vec3(...st.pos), false)
    if (!blk || blk.name !== 'chest') {
      ctx.log('stash', { kind: 'gone', pos: st.pos, block: blk?.name ?? null })
      st.items = {}
      return { taken: {} }
    }
    // Counted from the client inventory itself: the observer's snapshot lags the withdrawals (every
    // kit taken in ckit-r2 … r2d was logged as `taken: {}`; the item deltas show it was taken).
    const live = () => {
      const m: Record<string, number> = {}
      for (const it of bot.inventory.items()) m[it.name] = (m[it.name] ?? 0) + it.count
      return m
    }
    const before = live()
    const win = await withTimeout(bot.openContainer(blk), 6000, 'open chest')
    try {
      for (const it of win.containerItems()) {
        try { await withTimeout(win.withdraw(it.type, null, it.count), 4000, 'withdraw') } catch (e) { ctx.localRecovery(`withdraw ${it.name}: ${(e as Error).message}`) }
      }
    } finally {
      try { win.close() } catch { /* ignore */ }
    }
    await sleep(300, ctx.signal)
    const after = live()
    const taken: Record<string, number> = {}
    for (const [k, v] of Object.entries(after)) if (v > (before[k] ?? 0)) taken[k] = v - (before[k] ?? 0)
    st.items = {}
    ctx.log('stash', { kind: 'taken', pos: st.pos, taken, s: Math.round(ctx.state().t - t0) })
    return { taken }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

export const setSpawnBed: SkillDef<NP, { pos: V3 }> = {
  id: 'setSpawnBed',
  level: 'progression',
  params: NoParams,
  preconditions: s => {
    if (s.dim !== 'overworld') return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'beds explode outside the Overworld' }
    if (!builtLit(s)) return { ok: false, cls: 'PRECONDITION_FAILED', reason: 'no built portal remembered' }
    if (!Object.keys(s.inventory).some(k => k.endsWith('_bed'))) return { ok: false, reason: 'no bed', missing: [{ item: 'white_bed', count: 1 }] }
    return { ok: true }
  },
  timeoutMs: () => 2 * 60_000,
  stallMs: 60_000,
  async run (ctx) {
    const bot = ctx.bot
    stageTry(ctx, 'bed')
    const cells = portalCells(ctx)
    const portal = cells[0]!
    const bedItem = Object.keys(ctx.state().inventory).find(k => k.endsWith('_bed'))!
    // Explicit sites beside the frame, best first (stage-plan.ts); a site whose placement or use fails is skipped.
    const sites = stageSites(liveView(bot), cells, { bed: true, near: C.bedNear }).slice(0, 3)
    if (!sites.length) throw new SkillFailure('NOT_FOUND', 'no bed site beside the portal', { key: 'step=bed_site' })
    let last = 'none'
    for (const site of sites) {
      ctx.checkAbort()
      if (!Object.keys(ctx.state().inventory).some(k => k.endsWith('_bed'))) break
      let at: Vec3
      try { at = await placeAtSite(ctx, bedItem, site) } catch (e) {
        ctx.checkAbort()
        ctx.localRecovery(`bed site ${site.cell.join(',')}: ${(e as Error).message}`)
        continue
      }
      // Use it from the stand cell (within 3 horizontally and 2 vertically of the bed: 1.16.1 range).
      const msgs: string[] = []
      const onMsg = (m: string) => { if (msgs.length < 6) msgs.push(m.slice(0, 80)) }
      bot.on('messagestr', onMsg)
      let answer = bedAnswer(msgs, false)
      try {
        for (let use = 0; use < 2 && answer === 'none'; use++) {
          await bot.lookAt(at.offset(0.5, 0.3, 0.5), true)
          try { await bot.activateBlock(bot.blockAt(at, false)!) } catch (e) { ctx.localRecovery(`use bed: ${(e as Error).message}`) }
          await waitFor(() => bedAnswer(msgs, bot.isSleeping) !== 'none', 2500, ctx.signal)
          answer = bedAnswer(msgs, bot.isSleeping)
        }
      } finally {
        bot.off('messagestr', onMsg)
      }
      // At night the bot would lie down: get up again (the controller keeps working).
      if (bot.isSleeping) { try { await bot.wake() } catch { /* ignore */ } }
      const pos: V3 = [at.x, at.y, at.z]
      const set = answer === 'set'
      rememberLoc(ctx, 'bed', pos, 'built', { set, ...(site.dir ? { dx: site.dir[0], dz: site.dir[1] } : {}) }, 2)
      const me = ctx.state().pos
      ctx.log('stash', { kind: 'bed', pos, set, answer, portal, dist: Math.round(hd(pos, portal)), me: me.map(v => Math.round(v * 10) / 10), stand: site.stand, msgs })
      if (set) return { pos }
      last = answer
      // A bed that cannot set the point here is taken back for the next site.
      const b = bot.blockAt(at, false)
      if (b && b.name.endsWith('_bed')) { try { await withTimeout(bot.dig(b, true), 3000, 'dig bed') } catch { /* ignore */ } await sleep(600, ctx.signal) }
    }
    throw new SkillFailure('STATE_INCONSISTENT', `bed did not set the respawn point (${last})`, { key: `step=bed_spawn|${last}` })
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
