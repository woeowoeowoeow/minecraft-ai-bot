// Milestone B mechanics on the real 1.16.1 server: lava-cast and obsidian portals,
// a pool the builder must reject, portal activation and relighting, Nether entry
// with portal memory and a verified return, and a hazardous Nether arrival.
// Labeled fixtures (console setup on a flat, peaceful world): development only.
import { appendFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { builtPortal, milestoneB, returnOk } from '../../src/planner/milestones.js'
import { cellAt, frameStatus, geomFrom } from '../../src/skills/progression/portal-plan.js'
import { liveView } from '../../src/nav/blocks.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const KIT = { iron_pickaxe: 1, flint_and_steel: 1, water_bucket: 1, bucket: 1, cobblestone: 64, cooked_beef: 8 }

beforeAll(async () => {
  f = await startFixture('portal')
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

/** A 4×4 lava pool at ground level (sources replace the grass), open to the sky. */
async function surfacePool (x0: number, z0: number): Promise<void> {
  await f.fill(x0, Y(-1), z0, x0 + 3, Y(-1), z0 + 3, 'lava')
}

function forgetPortals (): void {
  rt.obs.memory.locations = rt.obs.memory.locations.filter(l => !['portal_ow', 'portal_nether', 'portal_site', 'lava_pool'].includes(l.kind))
  rt.obs.memory.transitions.length = 0
  rt.obs.memory.excursions.length = 0
}

describe('buildNetherPortal: lava cast', () => {
  it('casts a 10-obsidian frame from a surface pool and lights it', async () => {
    await f.reset(30, Y(20))
    forgetPortals()
    await surfacePool(10, 10)
    await f.place(0, Y(0), 0, KIT)
    await sleep(6000) // observer lava-pool scan
    expect(rt.obs.memory.locations.some(l => l.kind === 'lava_pool')).toBe(true)
    const t0 = f.events.length
    const r = await rt.run('buildNetherPortal', { strategy: 'auto' })
    // PORTAL_TRACE=<file>: the build's event timeline, for diagnosing slow or failed casts.
    if (process.env.PORTAL_TRACE) appendFileSync(process.env.PORTAL_TRACE, f.events.slice(t0).filter(e => e.type === 'portal' || e.type === 'nav_end' || (e.type === 'skill_end' && e.data.depth !== 0)).map(e => `${e.t} ${e.type} ${JSON.stringify(e.data).slice(0, 220)}`).join('\n') + '\n')
    expect(r.status).toBe('success')
    expect((r.outputs as { strategy: string }).strategy).toBe('lava_cast')
    const p = builtPortal(rt.obs.state())
    expect(p).not.toBeNull()
    const g = geomFrom(p!.detail)!
    expect(frameStatus(liveView(f.bot), g)).toMatchObject({ obsidian: 10, portal: 6 })
    // Both buckets come back: the water bucket and an empty one.
    expect(rt.inv().water_bucket).toBe(1)
    expect(rt.inv().bucket).toBe(1)
  }, 900_000)
})

describe('Nether entry, portal memory and return', () => {
  it('enters through the built portal, remembers the Nether portal, walks away and returns', async () => {
    // Uses the portal from the previous test.
    expect(builtPortal(rt.obs.state())).not.toBeNull()
    const enter = await rt.run('usePortal', { to: 'the_nether' })
    expect(enter.status).toBe('success')
    expect(rt.obs.dim()).toBe('the_nether')
    await sleep(2000)
    expect(rt.obs.memory.locations.some(l => l.kind === 'portal_nether')).toBe(true)
    const exc = await rt.run('netherExcursion', { minDist: 12 })
    expect(exc.status).toBe('success')
    const back = await rt.run('usePortal', { to: 'overworld' })
    expect(back.status).toBe('success')
    expect(rt.obs.dim()).toBe('overworld')
    const s = rt.obs.state()
    expect(returnOk(s)).toBe(true)
    expect(milestoneB(s)).toBe(true)
  }, 600_000)

  it('relights an extinguished portal before entering', async () => {
    const p = builtPortal(rt.obs.state())!
    const g = geomFrom(p.detail)!
    for (let u = 1; u <= 2; u++) for (let v = 1; v <= 3; v++) { const c = cellAt(g, u, v); await f.cmd(`setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`) }
    await sleep(500)
    expect(frameStatus(liveView(f.bot), g).portal).toBe(0)
    const r = await rt.run('usePortal', { to: 'the_nether' })
    expect(r.status).toBe('success')
    expect(rt.obs.dim()).toBe('the_nether')
    const back = await rt.run('usePortal', { to: 'overworld' })
    expect(back.status).toBe('success')
  }, 600_000)
})

describe('buildNetherPortal: obsidian', () => {
  it('places carried obsidian into a frame when no pool is known', async () => {
    await f.reset(30, Y(20))
    forgetPortals()
    await f.place(0, Y(0), 0, { iron_pickaxe: 1, flint_and_steel: 1, obsidian: 10, cobblestone: 64 })
    const r = await rt.run('buildNetherPortal', { strategy: 'auto' })
    expect(r.status).toBe('success')
    expect((r.outputs as { strategy: string }).strategy).toBe('obsidian')
    const g = geomFrom(builtPortal(rt.obs.state())!.detail)!
    expect(frameStatus(liveView(f.bot), g)).toMatchObject({ obsidian: 10, portal: 6 })
  }, 600_000)
})

describe('awkward lava geometry', () => {
  it('rejects a pool no safe stand can reach and reports NOT_FOUND', async () => {
    await f.reset(30, Y(20))
    forgetPortals()
    // A stone mesa with a 4×4 pit, 6 deep, lava at its bottom: out of reach from the rim.
    await f.fill(-14, Y(0), -14, 14, Y(6), 14, 'stone')
    await f.fill(6, Y(0), 6, 9, Y(6), 9, 'air')
    await f.fill(6, Y(0), 6, 9, Y(0), 9, 'lava')
    await f.place(0, Y(7), 0, KIT)
    await sleep(6000)
    const pool = rt.obs.memory.locations.find(l => l.kind === 'lava_pool')
    expect(pool).toBeDefined()
    const r = await rt.run('buildNetherPortal', { strategy: 'auto' })
    expect(r.status).toBe('failure')
    expect(r.failure?.class).toBe('NOT_FOUND')
    expect(pool!.detail?.unusable).toBe(true)
  }, 300_000)
})

describe('hazardous Nether arrival', () => {
  it('leaves a lava-lake platform by the land side and returns through its portal', async () => {
    await f.reset(30, Y(20))
    forgetPortals()
    await f.place(0, Y(0), 0, { iron_pickaxe: 1, flint_and_steel: 1, cobblestone: 32, netherrack: 32 })
    // Nether arena at y 100: lava lake with a 5×5 platform holding a lit portal; netherrack land to +x.
    const n = (c: string) => f.cmd(`execute in minecraft:the_nether run ${c}`)
    // Console edits need loaded chunks: force-load the arena first.
    await n('forceload add -32 -32 32 32')
    await sleep(3000)
    await n('fill -20 90 -20 30 110 20 air')
    await n('fill -20 95 -20 30 98 20 netherrack')
    await n('fill -20 99 -20 6 99 20 lava')
    await n('fill -2 99 -2 2 99 2 netherrack')
    await n('fill 7 99 -20 30 99 20 netherrack')
    await n('fill 3 99 -1 6 99 1 netherrack') // a 3-wide causeway from the platform to the land
    await n('fill 0 100 -1 0 104 2 obsidian')
    await n('fill 0 101 0 0 103 1 air')
    await n('setblock 0 101 0 minecraft:fire')
    await sleep(1000)
    await f.cmd('execute in minecraft:the_nether run tp Bot 1.5 100 0.5')
    await sleep(3000)
    await f.bot.waitForChunksToLoad()
    expect(rt.obs.dim()).toBe('the_nether')
    const portal = f.bot.findBlocks({ matching: f.bot.registry.blocksByName.nether_portal!.id, maxDistance: 6, count: 1 })[0]
    expect(portal).toBeDefined()
    rt.obs.memory.locations.push({ kind: 'portal_nether', dim: 'the_nether', pos: [portal!.x, portal!.y, portal!.z], confidence: 1, source: 'observed', lastSeen: rt.obs.state().t })
    const exc = await rt.run('netherExcursion', { minDist: 12 })
    expect(exc.status).toBe('success')
    expect(f.bot.entity.position.x).toBeGreaterThan(6)
    expect(rt.obs.state().counters.deaths).toBe(0)
    const back = await rt.run('usePortal', { to: 'overworld' })
    expect(back.status).toBe('success')
    expect(rt.obs.dim()).toBe('overworld')
    expect(f.bot.entity.position.distanceTo(new Vec3(0, Y(0), 0))).toBeGreaterThanOrEqual(0)
  }, 600_000)
})
