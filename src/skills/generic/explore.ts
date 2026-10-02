// Generic search movement (architecture §6.3 `explore`): bounded steps into new
// ground until a predicate holds. On the surface a step is a 48-block walk; when
// the bot is under cover (mining), a step is a 24-block excavated tunnel at the
// same level, so searching never tries to path through rock.
import { z } from 'zod'
import type { V3 } from '../../schema/index.js'
import { SkillFailure, type SkillCtx, type SkillDef } from '../types.js'

const SURFACE_STEP = 48
const TUNNEL_STEP = 24
/** Within this distance of the search origin the heading is free; beyond it, steps lead outward. */
const SEARCH_NEAR_ORIGIN = 16

/**
 * Heading (radians, 0 = north/−z, clockwise) for the next search step. Steps lead
 * away from `origin` (the remembered spawn), within ±45°, so repeated searches
 * cover new ground instead of circling it; after a failed step the bot turns at
 * least 90° from the blocked heading. Pure; `random` is the bot's RNG.
 */
export function nextSearchHeading (me: V3, origin: V3 | null, prev: number | null, lastFailed: boolean, random: () => number): number {
  if (lastFailed && prev !== null) return prev + (random() < 0.5 ? 1 : -1) * (Math.PI / 2 + random() * Math.PI / 4)
  const dx = origin ? me[0] - origin[0] : 0
  const dz = origin ? me[2] - origin[2] : 0
  if (Math.hypot(dx, dz) < SEARCH_NEAR_ORIGIN) return prev === null ? random() * Math.PI * 2 : prev + (random() - 0.5) * (Math.PI / 2)
  return Math.atan2(dx, -dz) + (random() - 0.5) * (Math.PI / 2)
}

/** Per-skill-run search state: heading memory and step count. */
export class Searcher {
  steps = 0
  private heading: number | null = null
  private lastFailed = false
  /** `surface`: always walk the surface, never tunnel (food animals live on the surface). */
  constructor (private readonly label: string, private readonly opts: { surface?: boolean } = {}) {}

  /** One search step. Returns whether the step reached its target. */
  async step (ctx: SkillCtx): Promise<boolean> {
    const s = ctx.state()
    const origin = s.memory.locations.find(l => l.kind === 'spawn' && l.dim === s.dim)?.pos ?? null
    this.steps++
    this.heading = nextSearchHeading(s.pos, origin, this.heading, this.lastFailed, ctx.env.random)
    const me = s.pos
    // A hunt that tunnels looks for animals inside rock (dev batch 13: 17 tunnel steps, ~800 s of
    // daylight in 3 food-timeout runs). The pathfinder digs its own way out of a covered start.
    const under = s.body.covered && !this.opts.surface
    const d = under ? TUNNEL_STEP : SURFACE_STEP
    const tx = Math.round(me[0] + Math.sin(this.heading) * d)
    const tz = Math.round(me[2] - Math.cos(this.heading) * d)
    ctx.log('search_step', { n: this.steps, for: this.label, heading: Math.round((this.heading * 180) / Math.PI) % 360, from: me.map(Math.round), target: [tx, under ? Math.floor(me[1]) : 0, tz], mode: under ? 'tunnel' : 'surface' })
    const r = under
      ? await ctx.nav.goto({ kind: 'near', target: [tx, Math.floor(me[1]), tz], range: 2 })
      : await ctx.nav.goto({ kind: 'xz', target: [tx, 0, tz], range: 4 })
    if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
    this.lastFailed = !r.ok
    if (r.ok) ctx.progress(`search:${this.label}`, this.steps)
    return r.ok
  }
}

/**
 * Leave the underground for surface work: walk back to the nearest remembered
 * mine entry (up the dug staircase), else head straight up. No-op on the surface.
 */
export async function toSurface (ctx: SkillCtx): Promise<boolean> {
  const s = ctx.state()
  if (!s.body.covered) return true
  const entry = s.memory.locations
    .filter(l => l.kind === 'mine_entry' && l.dim === s.dim)
    .sort((a, b) => Math.hypot(a.pos[0] - s.pos[0], a.pos[2] - s.pos[2]) - Math.hypot(b.pos[0] - s.pos[0], b.pos[2] - s.pos[2]))[0]
  ctx.log('search_step', { n: 0, for: 'surface', from: s.pos.map(Math.round), target: entry?.pos ?? null, mode: 'to_surface' })
  if (entry && Math.hypot(entry.pos[0] - s.pos[0], entry.pos[2] - s.pos[2]) < 96) {
    const r = await ctx.nav.goto({ kind: 'near', target: entry.pos, range: 2 })
    if (r.ok) return true
    if (r.class === 'CANCELLED') ctx.checkAbort()
  }
  const r = await ctx.nav.goto({ kind: 'y', target: Math.max(Math.floor(s.pos[1]) + 1, 64) })
  if (!r.ok && r.class === 'CANCELLED') ctx.checkAbort()
  return !ctx.state().body.covered
}

const Params = z.object({
  blocks: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  maxSteps: z.number().int().positive().default(6),
})
type P = z.infer<typeof Params>

function found (ctx: SkillCtx, p: P): boolean {
  const bot = ctx.bot
  if (p.blocks.length) {
    const ids = p.blocks.map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
    if (ids.length && bot.findBlocks({ matching: ids, maxDistance: 64, count: 1 }).length) return true
  }
  if (p.entities.length) {
    const me = bot.entity.position
    if (Object.values(bot.entities).some(e => e !== bot.entity && e.name && p.entities.includes(e.name) && e.position.distanceTo(me) <= 64)) return true
  }
  return false
}

/** Walk (or tunnel) into new ground until one of the blocks or entities is in loaded range. */
export const explore: SkillDef<P, { steps: number }> = {
  id: 'explore',
  level: 'generic',
  params: Params,
  preconditions: (_s, p) => p.blocks.length || p.entities.length ? { ok: true } : { ok: false, cls: 'PRECONDITION_FAILED', reason: 'nothing to look for' },
  timeoutMs: (_s, p) => 30_000 + 60_000 * p.maxSteps,
  stallMs: 90_000,
  async run (ctx, p) {
    const search = new Searcher(p.blocks[0] ?? p.entities[0] ?? 'explore')
    while (!found(ctx, p)) {
      if (search.steps >= p.maxSteps) throw new SkillFailure('SEARCH_EXHAUSTED', `nothing found after ${search.steps} steps`, { key: `target=${p.blocks[0] ?? p.entities[0]}` })
      await search.step(ctx)
    }
    return { steps: search.steps }
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}

/** L2 relocation (architecture §7.2): one search step (surface walk or tunnel) into new ground. */
export const relocate: SkillDef<Record<string, never>, { moved: boolean }> = {
  id: 'relocate',
  level: 'generic',
  params: z.object({}).passthrough() as unknown as z.ZodType<Record<string, never>>,
  preconditions: () => ({ ok: true }),
  timeoutMs: () => 120_000,
  stallMs: 90_000,
  async run (ctx) {
    const search = new Searcher('relocate')
    for (let i = 0; i < 2; i++) if (await search.step(ctx)) return { moved: true }
    throw new SkillFailure('NAV_UNREACHABLE', 'could not relocate', { key: 'target=relocate' })
  },
  async onCancel (ctx) { ctx.env.nav.stop() },
}
