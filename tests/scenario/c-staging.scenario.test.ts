// C staging after ckit-r2d (labeled fixtures on the real 1.16.1 server, development only, never a
// gate): the B → C-Nether departure from carried resources only, optional items skipped when they
// would need a search, the bed set from a site beside the portal frame (also from a bot that starts
// inside the portal, and at night with a monster near), the minimum re-kit after a death since B,
// and the r01-type water traps (pinned at a packed-ice corner; under an ice sheet).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ProgressionController } from '../../src/controller/progression.js'
import { C_FLAGS } from '../../src/planner/milestones.js'
import { C_MILESTONES, C_REQUIREMENTS, candidateObjectives, rekit } from '../../src/planner/policy.js'
import { liveView } from '../../src/nav/blocks.js'
import { portalKeepOut, stageSites } from '../../src/skills/progression/stage-plan.js'
import progression from '../../config/progression.json' with { type: 'json' }
import { Telemetry } from '../../src/telemetry/telemetry.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  f = await startFixture('c-staging', { difficulty: 'easy', keepInventory: false, spawnMonsters: false, spawnAnimals: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

function resetRunState (): void {
  const m = rt.obs.memory
  m.locations = []
  m.blacklist = []
  m.transitions = []
  m.deaths = []
  m.excursions = []
  m.trail = undefined
  m.stash = undefined
  m.cStage = undefined
  m.cLedger = undefined
  for (const k of Object.keys(rt.obs.milestones)) delete rt.obs.milestones[k]
}
beforeEach(async () => {
  await f.cmd('execute in minecraft:overworld run tp Bot 0.5 4 0.5')
  await sleep(1500)
  await f.cmd('kill @e[type=!player]')
  await f.cmd('time set day')
  resetRunState()
})

const CKIT = { iron_pickaxe: 1, iron_sword: 1, shield: 1, bucket: 1, water_bucket: 1, iron_boots: 1, flint_and_steel: 1, cooked_beef: 20, cobblestone: 64, crafting_table: 1, stick: 8, stone_pickaxe: 2 }
const PZ = 10
/** A lit obsidian portal in the plane z = PZ (frame x −1..2, y +0..+4; opening x 0..1, y +1..+3), remembered as built. */
async function portal (): Promise<[number, number, number][]> {
  await f.fill(-1, Y(0), PZ, 2, Y(4), PZ, 'obsidian')
  await f.fill(0, Y(1), PZ, 1, Y(3), PZ, 'air')
  await f.cmd(`setblock 0 ${Y(1)} ${PZ} minecraft:fire`)
  await sleep(1500)
  rt.obs.memory.locations.push({ kind: 'portal_ow', dim: 'overworld', pos: [0, Y(1), PZ], confidence: 1, source: 'built', lastSeen: rt.obs.state().t, detail: { lit: true, builtAt: rt.obs.state().t } })
  const cells: [number, number, number][] = []
  for (let x = 0; x <= 1; x++) for (let y = Y(1); y <= Y(3); y++) cells.push([x, y, PZ])
  return cells
}
/** B just recorded (the staging window is open); the world spawn remembered far away unless `spawnNear`. */
function afterB (spawnNear = false): void {
  const t = rt.obs.state().t
  rt.obs.milestones.A = Math.max(0, t - 300)
  rt.obs.milestones.B = Math.max(0, t - 5)
  rt.obs.memory.locations.push({ kind: 'spawn', dim: 'overworld', pos: spawnNear ? [3, Y(0), 4] : [0, Y(0), -200], confidence: 1, source: 'observed', lastSeen: 0 })
}
async function wearGold (): Promise<void> {
  await f.cmd('replaceitem entity Bot armor.head minecraft:golden_helmet')
  await sleep(800)
}

function controller (deadlineMs: number): ProgressionController {
  const telemetry = new Telemetry(mkdtempSync(join(tmpdir(), 'cstage-')), f.bus, { state: () => rt.obs.state(), digest: () => rt.obs.digest(), navRecent: () => [], voxels: () => null })
  return new ProgressionController({
    runner: rt.runner, bus: f.bus, telemetry,
    state: () => rt.obs.state(), setObjective: o => rt.obs.setObjective(o),
    requirements: C_REQUIREMENTS, milestones: C_MILESTONES, flags: C_FLAGS, target: 'C', deadline: Date.now() + deadlineMs,
    waitForRespawn: async () => { await sleep(3000) },
    resync: async () => {},
    afterDeath: () => { f.nav.stop(); rt.obs.afterDeath() },
  })
}
async function runUntil (ms: number, until: (evs: typeof f.events) => boolean): Promise<{ evs: typeof f.events; s: number }> {
  const n0 = f.events.length
  const t0 = Date.now()
  const ctl = controller(ms)
  const done = ctl.run()
  const end = Date.now() + ms
  while (Date.now() < end && !until(f.events.slice(n0))) await sleep(300)
  ctl.stop()
  await done
  return { evs: f.events.slice(n0), s: (Date.now() - t0) / 1000 }
}
const entered = (e: typeof f.events) => e.some(x => x.type === 'dimension_change' && x.data.to === 'the_nether')
const objectives = (e: typeof f.events) => e.filter(x => x.type === 'objective' && x.data.id).map(x => String(x.data.id))
const skillsRun = (e: typeof f.events) => e.filter(x => x.type === 'skill_start').map(x => String(x.data.skill))

describe('cheap C staging', () => {
  it('carried wood and a bed: second table, bed beside the frame, kit chest, then the Nether — no gathering', async () => {
    await f.reset(28, Y(16))
    const cells = await portal()
    await f.place(4, Y(0), 4, { ...CKIT, oak_planks: 16, white_bed: 1 })
    await wearGold()
    afterB()
    const { evs, s } = await runUntil(180_000, entered)
    const objs = objectives(evs)
    console.log('staging objectives', JSON.stringify(objs), 'B → Nether s', Math.round(s))
    expect(entered(evs)).toBe(true)
    expect(objs).toEqual(expect.arrayContaining(['c_table2', 'c_bed', 'c_stash', 'c_enter']))
    // Nothing searched or gathered.
    expect(skillsRun(evs).filter(k => ['collect', 'hunt', 'mine', 'explore', 'relocate'].includes(k))).toEqual([])
    const bed = evs.find(e => e.type === 'stash' && e.data.kind === 'bed')!.data
    const kit = evs.find(e => e.type === 'stash' && e.data.kind === 'staged')!.data
    console.log('bed', JSON.stringify(bed), 'kit', JSON.stringify(kit))
    expect(bed.set).toBe(true)
    const keep = portalKeepOut(cells)
    expect(keep.has((bed.pos as number[]).join(','))).toBe(false)
    expect(keep.has((kit.pos as number[]).join(','))).toBe(false)
    // Spares crafted from the carried planks (C.stashPickaxes allows two).
    expect((kit.items as Record<string, number>).stone_pickaxe).toBeGreaterThanOrEqual(1)
    // Never teleported before the re-entry objective.
    const firstCross = evs.findIndex(e => e.type === 'dimension_change')
    const enterObj = evs.findIndex(e => e.type === 'objective' && e.data.id === 'c_enter')
    expect(enterObj).toBeGreaterThanOrEqual(0)
    expect(firstCross).toBeGreaterThan(enterObj)
    expect(s).toBeLessThan(150)
  }, 300_000)

  it('the ckit inventory (no wood, gold or wool) and a tree 40 blocks off: optional items skipped, straight in', async () => {
    await f.reset(48, Y(16))
    await portal()
    // A natural-looking oak 40 blocks away (beyond C.stageWoodR): never walked to for the kit.
    await f.fill(40, Y(0), 0, 40, Y(4), 0, 'oak_log')
    await f.fill(38, Y(3), -2, 42, Y(5), 2, 'oak_leaves[persistent=false]')
    await f.fill(40, Y(0), 0, 40, Y(4), 0, 'oak_log')
    await f.place(4, Y(0), 4, CKIT)
    await wearGold()
    afterB()
    const { evs, s } = await runUntil(120_000, entered)
    const objs = objectives(evs)
    console.log('skip objectives', JSON.stringify(objs), 'B → Nether s', Math.round(s), 'skills', JSON.stringify([...new Set(skillsRun(evs))]))
    expect(entered(evs)).toBe(true)
    expect(skillsRun(evs).filter(k => ['hunt', 'mine', 'explore', 'relocate', 'stashKit', 'setSpawnBed'].includes(k))).toEqual([])
    // The tree was never approached.
    const far = evs.filter(e => e.type === 'nav_start' && Array.isArray((e.data.goal as { target?: number[] })?.target) && Math.abs((e.data.goal as { target: number[] }).target[0]! - 40) <= 4)
    expect(far).toEqual([])
    expect(rt.obs.memory.stash).toBeUndefined()
    expect(s).toBeLessThan(60)
    // The tree stands outside the next tests' reset radius (28): remove it (the re-kit test passed
    // in sequence only by chopping it, and searched a treeless world for 180 s on its own).
    await f.fill(38, Y(0), -2, 42, Y(5), 2, 'air')
  }, 240_000)
})

describe('bed beside the portal', () => {
  it('a bot that starts inside the portal steps out at once, sets the bed beside the frame, and is never teleported', async () => {
    await f.reset(28, Y(16))
    const cells = await portal()
    await f.place(0, Y(1), PZ, { ...CKIT, white_bed: 1 })
    await wearGold()
    afterB()
    const { evs } = await runUntil(90_000, e => e.some(x => x.type === 'stash' && x.data.kind === 'bed'))
    const leave = evs.find(e => e.type === 'interrupt_start' && (e.data as { id?: string }).id === 'leave_portal') ?? evs.find(e => e.type === 'skill_start' && e.data.skill === 'leavePortal')
    const bed = evs.find(e => e.type === 'stash' && e.data.kind === 'bed')?.data
    console.log('leave', JSON.stringify(leave?.data), 'bed', JSON.stringify(bed))
    expect(leave).toBeDefined()
    expect(evs.some(e => e.type === 'dimension_change')).toBe(false)
    expect(bed?.set).toBe(true)
    expect(bed?.answer).toBe('set')
    expect(portalKeepOut(cells).has((bed!.pos as number[]).join(','))).toBe(false)
    // The respawn point is the bed: a death respawns beside it.
    await f.cmd('tp Bot 20 4 -20')
    await sleep(1500)
    await f.cmd('kill Bot')
    await sleep(3500)
    if (f.bot.health <= 0) f.bot.respawn?.()
    await sleep(2500)
    const p = f.bot.entity.position
    const bp = bed!.pos as number[]
    console.log('respawned at', p, 'bed', bp)
    expect(Math.hypot(p.x - bp[0]!, p.z - bp[2]!)).toBeLessThanOrEqual(3)
  }, 200_000)

  it('at night with a monster near: "monsters nearby" still sets the respawn point (1.16.1 order)', async () => {
    await f.reset(28, Y(16))
    const cells = await portal()
    await f.place(4, Y(0), 4, { ...CKIT, white_bed: 1 })
    await wearGold()
    afterB()
    // A zombie in a glass cage 5 blocks behind the bed site the skill will pick (well inside the
    // 1.16.1 monster box of ±8 × ±5 around the bed head; the first run put it 9.5 blocks off on x
    // and the bot slept). The site is taken before the cage exists; the cage only removes sites.
    const site = stageSites(liveView(f.bot), cells, { bed: true, near: progression.C.bedNear })[0]!
    const [zx, zz] = [site.cell[0], site.cell[2] - 5]
    await f.cmd('time set midnight')
    await f.fill(zx - 1, Y(0), zz - 1, zx + 1, Y(3), zz + 1, 'glass')
    await f.fill(zx, Y(1), zz, zx, Y(2), zz, 'air')
    await f.cmd(`summon zombie ${zx + 0.5} ${Y(1)} ${zz + 0.5} {PersistenceRequired:1b,NoAI:1b}`)
    await sleep(1500)
    const zombie = Object.values(f.bot.entities).find(e => e.name === 'zombie')
    expect(zombie).toBeDefined()
    const r = await rt.run('setSpawnBed', {})
    const bed = f.events.filter(e => e.type === 'stash' && e.data.kind === 'bed').at(-1)?.data
    console.log('night bed', r.status, 'site', JSON.stringify(site), 'zombie', zombie!.position, JSON.stringify(bed))
    expect(r.status).toBe('success')
    expect(bed?.pos).toEqual(site.cell)
    // The unsafe-bed refusal itself, not a sleep: the refusal still means the point is this bed.
    expect((bed?.msgs as string[]).join(' ')).toMatch(/monsters nearby/i)
    expect(bed?.answer).toBe('set')
    expect(f.bot.isSleeping).toBe(false)
    await f.cmd('time set day')
    await f.cmd('kill @e[type=zombie]')
    await f.cmd('tp Bot 20 4 -20')
    await sleep(1500)
    await f.cmd('kill Bot')
    await sleep(3500)
    if (f.bot.health <= 0) f.bot.respawn?.()
    await sleep(2500)
    const p = f.bot.entity.position
    const bp = bed!.pos as number[]
    console.log('respawned at', p)
    expect(Math.hypot(p.x - bp[0]!, p.z - bp[2]!)).toBeLessThanOrEqual(3)
  }, 200_000)
})

describe('death → minimum re-kit → Nether re-entry', () => {
  it('no kit staged: after a death since B only the minimum (table, one pickaxe, 4 food, a golden piece), then in', async () => {
    await f.reset(28, Y(16))
    await portal()
    // The bot died after B (its full kit is gone); it carries what it gathered again on the way back:
    // 4 logs = the pickaxes and sword, the table placed to craft them (crafting leaves it in the
    // world) and the one table carried in. The flat fixture has no tree to fetch more from.
    await f.place(4, Y(0), 4, { oak_log: 4, cobblestone: 20, cooked_beef: 4, gold_ingot: 4, iron_ingot: 0 })
    afterB(true)
    rt.obs.memory.deaths.push({ pos: [30, Y(0), 30], dim: 'overworld', t: rt.obs.state().t - 2, cause: 'Bot was slain' })
    expect(rekit(rt.obs.state())).toBe(true)
    const plan = candidateObjectives(C_REQUIREMENTS, rt.obs.state()).map(o => o.id).filter(i => i.startsWith('c_'))
    console.log('re-kit plan', JSON.stringify(plan))
    expect(plan).not.toContain('c_shield')
    expect(plan).not.toContain('c_table2')
    expect(plan).not.toContain('c_stash')
    const { evs, s } = await runUntil(180_000, entered)
    const objs = objectives(evs)
    console.log('re-kit objectives', JSON.stringify(objs), 'death → Nether s', Math.round(s), 'inv', JSON.stringify(rt.inv()))
    const ti = evs.findIndex(e => e.type === 'objective' && e.data.id === 'c_table')
    if (ti >= 0) console.log('c_table detail', JSON.stringify(evs.slice(ti).filter(e => /^skill_|^nav_end|^objective|recovery|local_recovery|craft|interrupt/.test(e.type)).slice(0, 60).map(e => [e.type, e.data.skill ?? e.data.id ?? null, e.data.status ?? null, e.data.depth ?? null, JSON.stringify(e.data.params ?? (e.data.failure as { reason?: string } | null)?.reason ?? e.data.reason ?? e.data.detail ?? '').slice(0, 160)])))
    console.log('re-kit skills', JSON.stringify(evs.filter(e => (e.type === 'skill_end' && e.data.depth === 0) || e.type === 'interrupt_start' || e.type === 'objective').map(e => e.type === 'skill_end' ? [e.data.skill, e.data.status, (e.data.failure as { reason?: string } | null)?.reason ?? null] : [e.type, (e.data as { id?: string }).id ?? null])))
    expect(entered(evs)).toBe(true)
    expect(skillsRun(evs).filter(k => ['hunt', 'mine', 'explore', 'relocate'].includes(k))).toEqual([])
    const worn = [5, 6, 7, 8].map(i => f.bot.inventory.slots[i]?.name)
    expect(worn.some(w => w?.startsWith('golden_'))).toBe(true)
    expect(s).toBeLessThan(150)
  }, 300_000)
})

describe('r01-type water traps', () => {
  // Basin: stone walls around |x|,|z| = 25, water y 4..13 (top at 14.0), a packed-ice berg in the
  // north-west quadrant rising to y 17, and a corner pocket like ckit-r2d r01's.
  async function sea (sheet = false): Promise<void> {
    await f.reset(30, Y(20))
    await f.fill(-26, Y(0), -26, 26, Y(9), 26, 'stone')
    await f.fill(-25, Y(0), -25, 25, Y(9), 25, 'water')
    if (sheet) {
      await f.fill(-25, Y(9), -25, 25, Y(9), 25, 'ice')
      await f.fill(14, Y(9), 0, 14, Y(9), 0, 'water')
      return
    }
    await f.fill(-12, Y(0), -12, -1, Y(13), -1, 'packed_ice')
    await f.fill(-1, Y(0), 0, -1, Y(13), 0, 'packed_ice')
    await f.fill(0, Y(0), -1, 0, Y(13), -1, 'packed_ice')
    // The pocket diagonal to the bot (water under air), as in r01.
    await f.fill(-1, Y(0), -1, -1, Y(9), -1, 'water')
    await f.fill(-1, Y(10), -1, -1, Y(13), -1, 'air')
  }

  it('pinned at a packed-ice corner: the route swims around (no dig or corner squeeze from the water)', async () => {
    await sea()
    await f.place(0, Y(9), 0, { iron_pickaxe: 1, cooked_beef: 4 })
    await sleep(1500)
    const n0 = f.events.length
    // The land beyond the berg (the basin wall top at the north-west).
    const r = await f.nav.goto({ kind: 'near', target: [-20, Y(10), -26], range: 3 }, { profile: 'overworld', timeoutMs: 120_000, signal: new AbortController().signal })
    const evs = f.events.slice(n0)
    const lowAir = evs.filter(e => e.type === 'interrupt_start' && e.data.reason === 'low_air').length
    console.log('corner nav', r.ok, r.ok ? null : r.class, JSON.stringify({ reason: r.detail.reason, ms: r.ms, surfacings: r.detail.surfacings, water: r.detail.water }), 'low_air', lowAir)
    expect(r.ok).toBe(true)
    expect(lowAir).toBeLessThanOrEqual(2)
  }, 200_000)

  it('under an ice sheet with the only hole 14 blocks away: digs the ice above, surfaces, climbs onto the sheet', async () => {
    await sea(true)
    await f.place(0, Y(6), 0, { iron_pickaxe: 1, stone_pickaxe: 1 })
    await sleep(1200)
    const n0 = f.events.length
    const p0 = f.bot.entity.position.clone()
    const ok = await f.nav.surface()
    const evs = f.events.slice(n0)
    const dig = evs.find(e => e.type === 'water_event' && e.data.kind === 'ceiling_dig')
    console.log('under ice: from', p0, 'surfaced', ok, 'dig', JSON.stringify(dig?.data), 'air', f.bot.oxygenLevel, 'end', JSON.stringify(evs.find(e => e.type === 'interrupt_end')?.data))
    expect(ok).toBe(true)
    expect(dig).toBeDefined()
    const n1 = f.events.length
    const out = await f.nav.escapeWater(new AbortController().signal)
    const p = f.bot.entity.position
    console.log('escape', out, 'at', p, 'block below', f.bot.blockAt(p.offset(0, -0.5, 0))?.name, 'water events', JSON.stringify(f.events.slice(n1).filter(e => e.type === 'water_event').map(e => e.data)))
    expect(out).toBe(true)
    expect(f.bot.blockAt(p.offset(0, 0.1, 0))?.name).not.toBe('water')
  }, 200_000)
})
