// Goal-shaped smelting (architecture §6.3 `smelt`): ensure ≥ count of an output
// (or output group, e.g. cooked_food), using a furnace in reach, one within 24
// blocks, or one placed from the inventory. Output already in the furnace counts
// (a preempted smelt resumes where it was). 1.16.1 recipes: version.ts SMELTING.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Furnace } from 'mineflayer'
import { z } from 'zod'
import { Vec3S, type V3 } from '../../schema/index.js'
import { fuelTicks, SMELT_TICKS, SMELTING } from '../../version.js'
import { dig, placeNear, waitFor, withTimeout } from '../acts.js'
import { sleep } from '../runner.js'
import { countOf, GROUPS } from '../sources.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'
import { pickup } from './collect.js'

const Params = z.object({
  item: z.string(),                      // output item or group
  count: z.number().int().positive(),    // absolute target
  input: z.string(),                     // input item or group
  /** A remembered furnace that still holds this smelt's items: go back to it first. */
  at: Vec3S.optional(),
})
type P = z.infer<typeof Params>

const NOT_FUEL = /_(pickaxe|axe|shovel|sword|hoe)$|^crafting_table$/

function inv (bot: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] ?? 0) + it.count
  return out
}

/** Input items carried that smelt into the wanted output (group-aware). */
export function inputsFor (have: Record<string, number>, input: string, output: string): string[] {
  const g = GROUPS[input]
  const outOk = (i: string) => {
    const o = SMELTING[i]
    return !!o && (GROUPS[output] ? GROUPS[output]!(o) : o === output)
  }
  return Object.keys(have).filter(k => (have[k] ?? 0) > 0 && (g ? g(k) : k === input) && outOk(k)).sort((a, b) => (have[b] ?? 0) - (have[a] ?? 0) || a.localeCompare(b))
}

/** Fuel items to load for `items` smelts, best burn time first; never tools or tables. */
export function fuelPlan (have: Record<string, number>, items: number): { name: string; count: number }[] {
  let ticks = items * SMELT_TICKS
  const out: { name: string; count: number }[] = []
  const order = Object.keys(have).filter(k => fuelTicks(k) > 0 && !NOT_FUEL.test(k)).sort((a, b) => fuelTicks(b) - fuelTicks(a) || a.localeCompare(b))
  for (const k of order) {
    if (ticks <= 0) break
    const n = Math.min(have[k] ?? 0, Math.ceil(ticks / fuelTicks(k)))
    if (n > 0) { out.push({ name: k, count: n }); ticks -= n * fuelTicks(k) }
  }
  return ticks > 0 ? [] : out
}

function nearFurnace (bot: Bot, maxDistance: number): Block | null {
  const ids = ['furnace'].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  return bot.findBlock({ matching: ids, maxDistance }) ?? null
}

async function reachFurnace (ctx: SkillCtx): Promise<{ block: Block; placed: boolean } | null> {
  const bot = ctx.bot
  const near = nearFurnace(bot, 4)
  if (near) return { block: near, placed: false }
  const far = nearFurnace(bot, 24)
  if (far) {
    const r = await ctx.nav.goto({ kind: 'reach', target: [far.position.x, far.position.y, far.position.z], range: 4 })
    if (r.ok) { const b = nearFurnace(bot, 5); if (b) return { block: b, placed: false } }
    ctx.localRecovery(`furnace unreachable (${r.ok ? 'moved' : r.class})`)
  }
  if (bot.inventory.items().some(i => i.name === 'furnace')) {
    const at = await placeNear(bot, 'furnace', ctx.signal)
    ctx.memory.locations.push({ kind: 'furnace', dim: ctx.state().dim, pos: [at.x, at.y, at.z] as V3, confidence: 1, source: 'built', lastSeen: ctx.state().t })
    ctx.log('location_discovered', { kind: 'furnace', pos: [at.x, at.y, at.z], source: 'built' })
    return { block: bot.blockAt(at, false)!, placed: true }
  }
  return null
}

/**
 * Remember what a furnace still holds, so a preempted smelt (the bot fled, died or
 * was sent elsewhere) goes back for it instead of gathering the inputs again.
 */
function notePending (ctx: SkillCtx, pos: { x: number; y: number; z: number }, output: string, pending: number): void {
  const s = ctx.state()
  const at: V3 = [pos.x, pos.y, pos.z]
  let loc = ctx.memory.locations.find(l => l.kind === 'furnace' && l.dim === s.dim && l.pos[0] === at[0] && l.pos[1] === at[1] && l.pos[2] === at[2])
  if (!loc) { loc = { kind: 'furnace', dim: s.dim, pos: at, confidence: 1, source: 'observed', lastSeen: s.t }; ctx.memory.locations.push(loc) }
  loc.lastSeen = s.t
  loc.detail = { ...(loc.detail ?? {}), pending, output }
}

export function forgetPending (ctx: SkillCtx, at: V3): void {
  for (const l of ctx.memory.locations) if (l.kind === 'furnace' && l.pos[0] === at[0] && l.pos[1] === at[1] && l.pos[2] === at[2] && l.detail) l.detail.pending = 0
}

function closeWin (bot: Bot, w: Furnace | null): void {
  try { if (w) bot.closeWindow(w as never) } catch { /* ignore */ }
}

export const smelt: SkillDef<P, { smelted: number; placed: boolean }> = {
  id: 'smelt',
  level: 'generic',
  params: Params,
  isSatisfied: (s, p) => countOf(s.inventory, p.item) >= p.count,
  preconditions: () => ({ ok: true }),
  timeoutMs: (s, p) => 45_000 + 11_000 * Math.max(1, p.count - countOf(s.inventory, p.item)),
  stallMs: 40_000,
  async run (ctx, p) {
    const bot = ctx.bot
    const have = () => countOf(inv(bot), p.item)
    const start = have()
    if (p.at) {
      const r = await ctx.nav.goto({ kind: 'reach', target: p.at, range: 4 })
      if (!r.ok) {
        if (r.class === 'CANCELLED') ctx.checkAbort()
        forgetPending(ctx, p.at)
        throw new SkillFailure(r.class === 'CANCELLED' ? 'STATE_INCONSISTENT' : r.class, 'remembered furnace unreachable', { key: `item=${p.item}` })
      }
    }
    const f = await reachFurnace(ctx)
    if (!f) throw new SkillFailure('MISSING_RESOURCE', 'no furnace', { key: `item=${p.item}` }, [{ item: 'furnace', count: 1 }])
    let win: Furnace | null = null
    try {
      win = await withTimeout(bot.openFurnace(f.block), 6000, 'open furnace')
      // The window's copy of the player inventory arrives in a later packet (window_items):
      // transfers before it lands find nothing. Wait until it mirrors what the bot carries.
      // Mineflayer copies the window's inventory section back into bot.inventory only on
      // close, so while the furnace is open every count comes from the window itself.
      const w = win
      const winInv = () => { const o: Record<string, number> = {}; for (const it of w.items()) o[it.name] = (o[it.name] ?? 0) + it.count; return o }
      const haveW = () => countOf(winInv(), p.item)
      const want = inputsFor(inv(bot), p.input, p.item)[0]
      await waitFor(() => !want || w.items().some(i => i.name === want), 4000, ctx.signal)
      const startW = haveW()
      let lastOut = Date.now()
      let coldSince: number | null = null
      for (;;) {
        ctx.checkAbort()
        if (win.outputItem()) {
          await withTimeout(win.takeOutput(), 4000, 'take output').catch(() => {})
          lastOut = Date.now()
          ctx.progress('smelted', haveW() - startW)
        }
        if (haveW() >= p.count) break
        const pendingIn = win.inputItem()?.count ?? 0
        const need = p.count - haveW() - (win.outputItem()?.count ?? 0)
        const carried = winInv()
        if (!win.inputItem() && need > 0) {
          const inputs = inputsFor(carried, p.input, p.item)
          if (!inputs.length) {
            if (pendingIn === 0) throw new SkillFailure('MISSING_RESOURCE', `no ${p.input} to smelt`, { key: `item=${p.item}` }, [{ item: p.input, count: need }])
          } else {
            const it = bot.registry.itemsByName[inputs[0]!]!
            await withTimeout(win.putInput(it.id, null, Math.min(need, carried[inputs[0]!]!, 64)), 4000, 'put input')
          }
        }
        const queued = win.inputItem()?.count ?? 0
        // The block's `lit` state, not Mineflayer's fuel property: that stays 0 when the
        // total-fuel packet arrived before the window listener (e.g. on reopening).
        const lit = (bot.blockAt(f.block.position, false) as unknown as { getProperties?: () => Record<string, unknown> } | null)?.getProperties?.().lit === true
        const burning = lit || (win.fuel ?? 0) > 0
        // The burn-progress property arrives after the window opens: a furnace that is still
        // burning reads as cold at first. Refuel only once it has stayed cold for a while.
        if (queued > 0 && !win.fuelItem() && !burning) {
          coldSince ??= Date.now()
          const plan = fuelPlan(carried, queued)
          const first = plan[0] ?? fuelPlan(carried, 1)[0]
          if (first) await withTimeout(win.putFuel(bot.registry.itemsByName[first.name]!.id, null, first.count), 4000, 'put fuel')
          else if (Date.now() - coldSince > 4000) throw new SkillFailure('MISSING_RESOURCE', 'no fuel', { key: `item=${p.item}` }, [{ item: 'coal', count: Math.ceil(queued / 8) }])
        } else coldSince = null
        notePending(ctx, f.block.position, p.item, (win.inputItem()?.count ?? 0) + (win.outputItem()?.count ?? 0))
        if (Date.now() - lastOut > 25_000 && queued > 0 && !burning && !win.fuelItem()) throw new SkillFailure('STATE_INCONSISTENT', 'furnace not burning', { key: `item=${p.item}` })
        await sleep(1000, ctx.signal)
      }
    } catch (e) {
      if (e instanceof SkillFailure) throw e
      ctx.checkAbort()
      throw new SkillFailure('STATE_INCONSISTENT', `furnace: ${(e as Error).message}`, { key: `item=${p.item}` })
    } finally {
      if (win) notePending(ctx, f.block.position, p.item, (win.inputItem()?.count ?? 0) + (win.outputItem()?.count ?? 0))
      closeWin(bot, win)
    }
    // Carry the furnace on: take it back if it is empty and no other furnace is carried.
    if (f.placed && !bot.inventory.items().some(i => i.name === 'furnace') && bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
      const b = bot.blockAt(f.block.position, false)
      if (b?.name === 'furnace') {
        try {
          await dig(bot, b, ctx.signal)
          await pickup(ctx, b.position, () => bot.inventory.items().some(i => i.name === 'furnace'))
          if (bot.inventory.items().some(i => i.name === 'furnace')) {
            ctx.memory.locations = ctx.memory.locations.filter(l => !(l.kind === 'furnace' && l.pos[0] === b.position.x && l.pos[1] === b.position.y && l.pos[2] === b.position.z))
          }
        } catch { ctx.checkAbort() }
      }
    }
    return { smelted: have() - start, placed: f.placed }
  },
  async onCancel (ctx) { try { if (ctx.bot.currentWindow) ctx.bot.closeWindow(ctx.bot.currentWindow) } catch { /* ignore */ } },
}
