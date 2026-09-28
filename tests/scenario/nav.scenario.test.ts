// Fixture scenarios for the two leading M0 navigation failure classes: water and
// underground. Real vanilla server, flat peaceful world, terrain built by console
// commands. Labeled fixtures: development evidence only, never a gate.
// Run: npm run test:scenario
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NavGoal, NavResult } from '../../src/schema/index.js'
import { startFixture, type Fixture } from './harness.js'

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
  await f.reset(26, -20)
  await c.build(f)
  await f.cmd('effect give Bot minecraft:instant_health 1 5')
  await f.place(...c.start, c.items)
  const d0 = deaths
  const ac = new AbortController()
  const r = await f.nav.goto(c.goal, { profile: 'overworld', timeoutMs: c.timeoutMs ?? f.nav.budgetMs(c.goal), signal: ac.signal })
  if (!r.ok) report(r)
  return { r, died: deaths > d0 }
}

function report (r: NavResult): void {
  const d = r.detail
  console.log('NAV FAIL', !r.ok && r.class, d.reason, 'end', d.lastPos, 'water', JSON.stringify(d.water), 'exc', JSON.stringify(d.excavation), 'statuses', JSON.stringify(d.pathStatuses), 'path', JSON.stringify(d.lastPath.slice(0, 8)))
  for (const ev of f.events.slice(-25)) if (ev.type !== 'physics_correction' && ev.type !== 'excavation_step') console.log('  ev', ev.type, JSON.stringify(ev.data).slice(0, 240))
}

/** Raised stone island: ground top at y=-50 (bot stands at -49). */
async function island (f: Fixture): Promise<void> {
  await f.fill(-26, -61, -26, 26, -50, 26, 'stone')
  await f.fill(-26, -50, -26, 26, -50, 26, 'grass_block')
}

describe('water', () => {
  it('exits a deep pool whose banks are a 1-block ledge (physics cannot climb it)', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-5, -58, -5, 5, -50, 5, 'air'); await f.fill(-5, -58, -5, 5, -51, 5, 'water') },
      start: [0, -51, 0], goal: { kind: 'near', target: [15, -49, 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.water?.exits).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('exits a deep pool at a flush bank without help', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-5, -58, -5, 5, -50, 5, 'water') },
      start: [0, -50, 0], goal: { kind: 'near', target: [15, -49, 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
  }, 180_000)

  it('surfaces and escapes after starting on the floor of deep water', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-8, -60, -8, 8, -50, 8, 'air'); await f.fill(-8, -60, -8, 8, -51, 8, 'water') },
      start: [0, -60, 0], goal: { kind: 'near', target: [16, -49, 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.surfacings ?? 0).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('surfaces from under an overhang by swimming to open water', async () => {
    const { r, died } = await run({
      async build (f) {
        await island(f)
        await f.fill(-8, -60, -8, 8, -50, 8, 'air')
        await f.fill(-8, -60, -8, 8, -51, 8, 'water')
        await f.fill(-8, -50, -8, 1, -49, 8, 'dirt')
      },
      start: [-5, -58, 0], goal: { kind: 'near', target: [16, -49, 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
  }, 180_000)

  it('swims across a kelp sea at the surface (kelp is water, not floor) and climbs a ledge', async () => {
    const { r, died } = await run({
      async build (f) {
        await island(f)
        await f.fill(-6, -60, -26, 18, -50, 26, 'air')
        await f.fill(-6, -60, -26, 18, -51, 26, 'water')
        await f.fill(-6, -60, -26, 18, -57, 26, 'kelp_plant')
        await f.fill(-6, -60, -26, 18, -60, 26, 'sand')
      },
      start: [-12, -49, 0], goal: { kind: 'near', target: [22, -49, 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
  }, 180_000)

  it('walks around a lake when the dry route is reasonable', async () => {
    const { r, died } = await run({
      async build (f) { await f.fill(-4, -63, -9, 4, -61, 9, 'water') },
      start: [-10, -60, 0], goal: { kind: 'near', target: [10, -60, 0], range: 1.5 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.water?.msInWater ?? 0).toBeLessThan(1500)
  }, 120_000)

  it('bridges over deep water with scaffold blocks instead of swimming', async () => {
    const { r, died } = await run({
      async build (f) { await island(f); await f.fill(-6, -60, -26, 18, -50, 26, 'air'); await f.fill(-6, -60, -26, 18, -51, 26, 'water') },
      start: [-12, -49, 0], goal: { kind: 'near', target: [22, -49, 0], range: 1.5 }, items: { dirt: 64 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.water?.msInWater ?? 0).toBeLessThan(3000)
  }, 180_000)
})

/** Solid stone mass: top at y=-26 (bot stands at -25), 35 blocks deep. */
async function rock (f: Fixture): Promise<void> {
  await f.fill(-26, -61, -26, 26, -26, 26, 'stone')
}

describe('underground (controlled excavation)', () => {
  it('fails fast with MISSING_RESOURCE without a pickaxe', async () => {
    const { r } = await run({ build: rock, start: [0, -25, 0], goal: { kind: 'y', target: -50 } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.class).toBe('MISSING_RESOURCE')
    expect(r.detail.missing?.[0]?.item).toBe('wooden_pickaxe')
    expect(r.ms).toBeLessThan(5000)
  }, 120_000)

  it('descends to a target depth by verified dig-down', async () => {
    const { r, died } = await run({ build: rock, start: [0, -25, 0], goal: { kind: 'y', target: -50 }, items: { stone_pickaxe: 1 } })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.strategy).toBe('excavate')
    expect(Math.floor(f.bot.entity.position.y)).toBe(-50)
  }, 240_000)

  it('reaches an enclosed cave pocket by staircase and tunnel', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(12, -52, 7, 14, -50, 9, 'air') },
      start: [0, -25, 0], goal: { kind: 'near', target: [13, -52, 8], range: 1.5 }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.detail.excavation?.byKind.stair_down ?? 0).toBeGreaterThan(0)
  }, 300_000)

  it('routes around lava under its column and never touches it', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(-2, -36, -2, 2, -34, 2, 'lava') },
      start: [0, -25, 0], goal: { kind: 'y', target: -45 }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(f.bot.health).toBe(20)
  }, 240_000)

  it('does not open into water pockets and copes with falling gravel', async () => {
    const { r, died } = await run({
      async build (f) {
        await rock(f)
        await f.fill(-3, -33, -3, 3, -30, 3, 'gravel')
        await f.fill(1, -40, -1, 2, -38, 1, 'water')
      },
      start: [0, -25, 0], goal: { kind: 'y', target: -45 }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    const head = f.bot.blockAt(f.bot.entity.position.offset(0, 1.6, 0))
    expect(head?.name).not.toBe('water')
  }, 240_000)

  it('does not drop into a deep cave; descends beside it instead', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(-3, -44, -3, 3, -32, 3, 'air') },
      start: [0, -25, 0], goal: { kind: 'y', target: -50 }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(f.bot.health).toBe(20)
  }, 300_000)

  it('walks to a dry start before excavating from a shoreline', async () => {
    const { r, died } = await run({
      async build (f) { await rock(f); await f.fill(-4, -30, -4, 4, -26, 4, 'water') },
      start: [0, -26, 0], goal: { kind: 'y', target: -45 }, items: { stone_pickaxe: 1 },
    })
    expect(died).toBe(false)
    expect(r.ok).toBe(true)
    expect(f.events.some(e => e.type === 'water_event' && e.data.kind === 'excavation_relocate')).toBe(true)
  }, 300_000)

  it('leaves a walkable return path: the pathfinder can climb back out', async () => {
    const down = await run({ build: rock, start: [0, -25, 0], goal: { kind: 'near', target: [14, -40, 0], range: 1.5 }, items: { stone_pickaxe: 1 } })
    expect(down.r.ok).toBe(true)
    const entry = down.r.detail.excavation!.entry
    const ac = new AbortController()
    const up = await f.nav.goto({ kind: 'near', target: entry, range: 1.5 }, { profile: 'overworld', timeoutMs: 90_000, signal: ac.signal })
    if (!up.ok) report(up)
    expect(up.ok).toBe(true)
    expect(up.detail.strategy).toBe('pathfinder')
  }, 300_000)
})
