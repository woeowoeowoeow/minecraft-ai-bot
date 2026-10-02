// Fixture scenarios for the two leading M0 navigation failure classes: water and
// underground. Real vanilla server, flat peaceful world, terrain built by console
// commands. Labeled fixtures: development evidence only, never a gate.
// Run: npm run test:scenario
import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NavGoal, NavResult } from '../../src/schema/index.js'
import { Excavator } from '../../src/nav/excavate.js'
import { startFixture, Y, type Fixture } from './harness.js'

let f: Fixture
let deaths = 0

beforeAll(async () => {
  f = await startFixture('nav')
  f.bot.on('death', () => { deaths++ })
}, 300_000)
afterAll(async () => { await f?.close() }, 60_000)

type Case = {
  build (f: Fixture): Promise<void>
  start: [number, number, number]
  goal: NavGoal
  items?: Record<string, number>
  timeoutMs?: number
}

async function run (c: Case): Promise<{ r: NavResult; died: boolean }> {
  await f.reset(26, Y(40))
  await c.build(f)
  await f.cmd('effect give Bot minecraft:instant_health 1 5')
  await f.place(...c.start, c.items)
  const d0 = deaths
  const ac = new AbortController()
  const r = await f.nav.goto(c.goal, { profile: 'overworld', timeoutMs: c.timeoutMs ?? f.nav.budgetMs(c.goal), signal: ac.signal })
  if (!r.ok) report(r)
  return { r, died: deaths > d0 }
}

function waterStats (label: string, r: NavResult): void {
  if (process.env.DEBUG_WATER) appendFileSync(process.env.DEBUG_WATER, `WATER ${label} ok=${r.ok} surfacings=${r.detail.surfacings ?? 0} ${JSON.stringify(r.detail.water)} ms=${r.ms}\n`)
}

function report (r: NavResult): void {
  const d = r.detail
  console.log('NAV FAIL', !r.ok && r.class, d.reason, 'end', d.lastPos, 'water', JSON.stringify(d.water), 'exc', JSON.stringify(d.excavation), 'statuses', JSON.stringify(d.pathStatuses), 'path', JSON.stringify(d.lastPath.slice(0, 8)))
  for (const ev of f.events.slice(-25)) if (ev.type !== 'physics_correction' && ev.type !== 'excavation_step') console.log('  ev', ev.type, JSON.stringify(ev.data).slice(0, 240))
}

/** Raised stone island: ground top at Y(10) (bot stands at Y(11)). */
async function island (f: Fixture): Promise<void> {
  await f.fill(-26, Y(-1), -26, 26, Y(10), 26, 'stone')
  await f.fill(-26, Y(10), -26, 26, Y(10), 26, 'grass_block')
}

describe('water', () => {
  it('exits a deep pool whose banks are a 1-block ledge (physics cannot climb it)', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-5, Y(2), -5, 5, Y(10), 5, 'air'); await f.fill(-5, Y(2), -5, 5, Y(9), 5, 'water') },
      start: [0, Y(9), 0], goal: { kind: 'near', target: [15, Y(11), 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.water?.exits).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('exits a deep pool at a flush bank without help', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-5, Y(2), -5, 5, Y(10), 5, 'water') },
      start: [0, Y(10), 0], goal: { kind: 'near', target: [15, Y(11), 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
  }, 180_000)

  it('surfaces and escapes after starting on the floor of deep water', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-8, Y(0), -8, 8, Y(10), 8, 'air'); await f.fill(-8, Y(0), -8, 8, Y(9), 8, 'water') },
      start: [0, Y(0), 0], goal: { kind: 'near', target: [16, Y(11), 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.surfacings ?? 0).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('surfaces from under an overhang by swimming to open water', async () => {
    const { r, died } = await run({
      async build (f) {
        await island(f)
        await f.fill(-8, Y(0), -8, 8, Y(10), 8, 'air')
        await f.fill(-8, Y(0), -8, 8, Y(9), 8, 'water')
        await f.fill(-8, Y(10), -8, 1, Y(11), 8, 'dirt')
      },
      start: [-5, Y(2), 0], goal: { kind: 'near', target: [16, Y(11), 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
  }, 180_000)

  it('swims across a kelp sea at the surface (kelp is water, not floor) and climbs a ledge', async () => {
    const { r, died } = await run({
      async build (f) {
        await island(f)
        await f.fill(-6, Y(0), -26, 18, Y(10), 26, 'air')
        await f.fill(-6, Y(0), -26, 18, Y(9), 26, 'water')
        await f.fill(-6, Y(0), -26, 18, Y(3), 26, 'kelp_plant')
        await f.fill(-6, Y(0), -26, 18, Y(0), 26, 'sand')
      },
      start: [-12, Y(11), 0], goal: { kind: 'near', target: [22, Y(11), 0], range: 1.5 },
    })
    waterStats('kelp', r)
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
  }, 180_000)

  it('walks around a lake when the dry route is reasonable', async () => {
    const { r, died } = await run({
      async build (f) { await f.fill(-4, Y(-3), -9, 4, Y(-1), 9, 'water') },
      start: [-10, Y(0), 0], goal: { kind: 'near', target: [10, Y(0), 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.water?.msInWater ?? 0).toBeLessThan(1500)
  }, 120_000)

  it('bridges over deep water with scaffold blocks instead of swimming', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-6, Y(0), -26, 18, Y(10), 26, 'air'); await f.fill(-6, Y(0), -26, 18, Y(9), 26, 'water') },
      start: [-12, Y(11), 0], goal: { kind: 'near', target: [22, Y(11), 0], range: 1.5 }, items: { dirt: 64 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.water?.msInWater ?? 0).toBeLessThan(3000)
  }, 180_000)

  it('crosses a seagrass channel at the surface (seagrass is water, not walkable floor)', async () => {
    const { r, died } = await run({
      async build (f) {
        await island(f)
        await f.fill(-6, Y(7), -26, 18, Y(10), 26, 'air')
        await f.fill(-6, Y(7), -26, 18, Y(9), 26, 'water')
        await f.fill(-6, Y(7), -26, 18, Y(7), 26, 'seagrass')
        await f.fill(-6, Y(8), -26, 18, Y(8), 26, 'tall_seagrass[half=lower]')
      },
      start: [-12, Y(11), 0], goal: { kind: 'near', target: [22, Y(11), 0], range: 1.5 },
    })
    waterStats('seagrass', r)
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    // Same profile as the kelp crossing on 1.16.1 (measured: 2 proactive surfacings, one ledge exit).
    expect(r.detail.surfacings ?? 0).toBeLessThanOrEqual(2)
  }, 180_000)
})

describe('physics and server corrections', () => {
  it('climbs a 1-wide open-air staircase without a server correction loop (collision epsilon)', async () => {
    let corrections = 0
    const log: string[] = []
    let navT0 = 0
    const offNav = f.bus.on(ev => { if (ev.type === 'nav_start') navT0 = Date.now() })
    // Count only during navigation: arena setup (reset/teleport) also sends position packets.
    const onForced = () => { if (!navT0) return; corrections++; if (process.env.DEBUG_FORCED) log.push(`${Date.now() - navT0} ${f.bot.entity.position.toString()}`) }
    f.bot.on('forcedMove', onForced)
    try {
      const { r, died } = await run({
        async build (f) {
          for (let i = 0; i <= 12; i++) {
            await f.fill(i, Y(-1), 0, i, Y(i - 1), 0, 'stone')
            await f.fill(i, Y(-1), -1, i, Y(i + 2), -1, 'stone')
            await f.fill(i, Y(-1), 1, i, Y(i + 2), 1, 'stone')
          }
          await f.fill(13, Y(-1), -1, 16, Y(11), 1, 'stone')
        },
        start: [-3, Y(0), 0], goal: { kind: 'near', target: [15, Y(12), 0], range: 1.5 },
      })
      expect(died).toBe(false)
      expect(r.ok).toBe(true)
      expect(r.detail.strategy).toBe('pathfinder')
      expect(r.detail.correctionLoops ?? 0).toBe(0)
      expect(corrections).toBeLessThan(5)
    } finally {
      offNav()
      if (log.length) console.log('forcedMove', log.length, log.slice(0, 15).join(' | '), ' … ', log.slice(-5).join(' | '))
      f.bot.removeListener('forcedMove', onForced)
    }
  }, 180_000)

  it('recovers when the server moves the bot mid-route', async () => {
    let teleports = 0
    const tp = () => { teleports++; f.server.command('execute as Bot at @s run tp @s ~ ~ ~-4') }
    const timers: NodeJS.Timeout[] = []
    const off = f.bus.on(ev => { if (ev.type === 'nav_start' && !timers.length) timers.push(setTimeout(tp, 1500), setTimeout(tp, 3000)) })
    try {
      const { r, died } = await run({ build: async () => {}, start: [0, Y(0), -12], goal: { kind: 'near', target: [0, Y(0), 20], range: 1.5 } })
      expect(teleports).toBeGreaterThanOrEqual(1)
      expect(died).toBe(false)
      expect(r.ok).toBe(true)
    } finally {
      off()
      for (const t of timers) clearTimeout(t)
    }
  }, 120_000)
})

/** Solid stone mass: top at Y(34) (bot stands at Y(35)), 35 blocks deep. */
async function rock (f: Fixture): Promise<void> {
  await f.fill(-26, Y(-1), -26, 26, Y(34), 26, 'stone')
}

describe('underground (controlled excavation)', () => {
  it('fails fast with MISSING_RESOURCE without a pickaxe', async () => {
    const { r } = await run({ build: rock, start: [0, Y(35), 0], goal: { kind: 'y', target: Y(10) } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.class).toBe('MISSING_RESOURCE')
    expect(r.detail.missing?.[0]?.item).toBe('wooden_pickaxe')
    expect(r.ms).toBeLessThan(5000)
  }, 120_000)

  it('descends to a target depth by verified dig-down', async () => {
    const { r, died } = await run({ build: rock, start: [0, Y(35), 0], goal: { kind: 'y', target: Y(10) }, items: { stone_pickaxe: 1 } })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.strategy).toBe('excavate')
    expect(r.detail.dryStart).toBe('already_dry')
    expect(Math.floor(f.bot.entity.position.y)).toBe(Y(10))
  }, 240_000)

  it('reaches an enclosed cave pocket by staircase and tunnel', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(12, Y(8), 7, 14, Y(10), 9, 'air') },
      start: [0, Y(35), 0], goal: { kind: 'near', target: [13, Y(8), 8], range: 1.5 }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.excavation?.byKind.stair_down ?? 0).toBeGreaterThan(0)
  }, 300_000)

  it('routes around lava under its column and never touches it', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(-2, Y(24), -2, 2, Y(26), 2, 'lava') },
      start: [0, Y(35), 0], goal: { kind: 'y', target: Y(15) }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(f.bot.health).toBe(20)
  }, 240_000)

  it('does not open into water pockets and copes with falling gravel', async () => {
    const { r, died } = await run({
      async build (f) {
        await rock(f)
        await f.fill(-3, Y(27), -3, 3, Y(30), 3, 'gravel')
        await f.fill(1, Y(20), -1, 2, Y(22), 1, 'water')
      },
      start: [0, Y(35), 0], goal: { kind: 'y', target: Y(15) }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    const head = f.bot.blockAt(f.bot.entity.position.offset(0, 1.6, 0))
    expect(head?.name).not.toBe('water')
  }, 240_000)

  it('does not drop into a deep cave; descends beside it instead', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(-3, Y(16), -3, 3, Y(28), 3, 'air') },
      start: [0, Y(35), 0], goal: { kind: 'y', target: Y(10) }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(f.bot.health).toBe(20)
  }, 300_000)

  it('walks to a dry start before excavating from a shoreline', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(-4, Y(30), -4, 4, Y(34), 4, 'water') },
      start: [0, Y(34), 0], goal: { kind: 'y', target: Y(15) }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(f.events.some(e => e.type === 'water_event' && e.data.kind === 'excavation_relocate')).toBe(true)
    expect(r.detail.dryStart).toBe('found')
  }, 300_000)

  it('fails fast with NAV_HAZARD when no dry excavation start is in reach (open water)', async () => {
    const { r, died } = await run({
      async build (f) { await f.fill(-26, Y(-1), -26, 26, Y(-1), 26, 'sand'); await f.fill(-26, Y(0), -26, 26, Y(9), 26, 'water') },
      start: [0, Y(9), 0], goal: { kind: 'y', target: Y(2) }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.class).toBe('NAV_HAZARD')
    expect(r.detail.dryStart).toBe('none')
    expect(r.ms).toBeLessThan(5000)
  }, 120_000)

  it('staircases down through a thick sand layer: falling sand never strands a step', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(-26, Y(26), -26, 26, Y(34), 26, 'sand'); await f.fill(12, Y(8), 7, 14, Y(10), 9, 'air') },
      start: [0, Y(35), 0], goal: { kind: 'near', target: [13, Y(8), 8], range: 1.5 }, items: { stone_pickaxe: 1, iron_shovel: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.excavation?.byKind.stair_down ?? 0).toBeGreaterThan(0)
  }, 300_000)

  it('mid-excavation, drops in from a neighbour\'s lip instead of sneaking against the edge forever', async () => {
    // Field case (excavation fixture r01): after a step the hitbox overlapped the neighbouring
    // block by 4 mm, so the bot stood on its edge above an open feet cell, and every step's
    // centring move (sneaking) refused to leave the edge: "excavation steps keep failing".
    // Driven through the Excavator directly: at excavation *start* the dry-start check
    // already moves the bot off such a lip.
    await f.reset(26, Y(40))
    await rock(f)
    await f.fill(0, Y(33), 1, 0, Y(34), 1, 'air') // 2-deep hole under the feet cell (0, Y35, 1)
    await f.place(0, Y(35), 3, { stone_pickaxe: 1 })
    await f.cmd(`tp Bot 0.5 ${Y(35)} 1.704`) // hitbox z 1.404–2.004: held by the lip of (0, Y34, 2)
    await new Promise(res => setTimeout(res, 1500))
    expect(Math.floor(f.bot.entity.position.z)).toBe(1)
    expect(f.bot.entity.onGround).toBe(true)
    const d0 = deaths
    const ac = new AbortController()
    const r = await new Excavator(f.bot, f.bus).run({ y: Y(20) }, feet => feet[1] === Y(20), { signal: ac.signal, deadline: Date.now() + 120_000, isAborted: () => false })
    if (!r.ok) console.log('EXC FAIL', r.cls, r.reason, r.lastBlocked)
    expect(deaths).toBe(d0)
    expect(r.ok).toBe(true)
    expect(r.unperched).toBeGreaterThanOrEqual(1)
  }, 240_000)

  it('leaves a walkable return path: the pathfinder can climb back out', async () => {
    const down = await run({ build: rock, start: [0, Y(35), 0], goal: { kind: 'near', target: [14, Y(20), 0], range: 1.5 }, items: { stone_pickaxe: 1 } })
    expect(down.r.ok).toBe(true)
    const entry = down.r.detail.excavation!.entry
    const ac = new AbortController()
    const up = await f.nav.goto({ kind: 'near', target: entry, range: 1.5 }, { profile: 'overworld', timeoutMs: 90_000, signal: ac.signal })
    if (!up.ok) report(up)
    expect(up.ok).toBe(true)
    expect(up.detail.strategy).toBe('pathfinder')
  }, 300_000)
})
