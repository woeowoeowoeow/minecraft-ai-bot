// Wood-target hotfix fixtures on the real 1.16.1 server (labeled fixtures; development only).
// Round-3 gate 20261004 r02/r08: the wide log scan and the tree spots took shipwreck timbers
// on the sea floor for trees, and a walk to one cancelled by a flee was chosen again after
// every flee and respawn (8 drowned deaths, both death_limit runs).
import { appendFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cooldowns, P, selectInterrupt, type Interrupt } from '../../src/controller/interrupts.js'
import { botTreeView, treeVerdict } from '../../src/observer/trees.js'
import { woodZones } from '../../src/skills/generic/collect.js'
import { startFixture, Y, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const note = (...a: unknown[]) => { if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n') }
const evs = (type: string, since: number) => f.events.slice(since).filter(e => e.type === type)

beforeAll(async () => {
  f = await startFixture('woodtargets', { difficulty: 'easy', keepInventory: false })
  rt = runtime(f)
  await f.cmd('time set day')
  await f.cmd('gamerule doDaylightCycle false')
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

function forgetAll (): void {
  rt.obs.memory.locations = rt.obs.memory.locations.filter(l => l.kind === 'spawn')
  rt.obs.memory.searched = []
  rt.obs.memory.blacklist = []
  rt.obs.memory.explored.overworld.clear()
}

async function placeSure (x: number, y: number, z: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await f.place(x, y, z, {})
    const there = () => Math.hypot(f.bot.entity.position.x - (x + 0.5), f.bot.entity.position.z - (z + 0.5)) < 2
    // A busy server (large /fill) can roll a teleport back a moment later: it must hold.
    if (there()) { await sleep(2500); if (there()) return }
    await sleep(3000)
  }
  throw new Error(`could not place the bot at ${x} ${y} ${z}`)
}

/** A small oak: a 4-log trunk with a leaf crown (fill-placed leaves are not persistent). */
async function tree (x: number, z: number): Promise<void> {
  await f.fill(x - 2, Y(3), z - 2, x + 2, Y(4), z + 2, 'oak_leaves')
  await f.fill(x, Y(0), z, x, Y(3), z, 'oak_log')
}

const isLogAt = (x: number, y: number, z: number) => f.bot.blockAt(new Vec3(x, y, z), false)?.name.endsWith('_log') ?? false
/** Old candidate filter (before the hotfix): a log counted unless water was right above it. */
const oldAccepts = (v: Vec3) => !/water|kelp|seagrass|bubble_column/.test(f.bot.blockAt(v.offset(0, 1, 0), false)?.name ?? '')

describe('wood targets: natural trees only', () => {
  it('rejects shipwreck timbers on the sea floor and a beached wreck; walks past them to a real tree', async () => {
    forgetAll()
    await f.reset(120, Y(12))
    // Sea east of the start: sand floor at Y(-4), water Y(-3)…Y(-1).
    await f.fill(14, Y(-4), -16, 50, Y(-4), 16, 'sand')
    await f.fill(14, Y(-3), -16, 50, Y(-1), 16, 'water')
    // Wreck: a keel of logs on the sand under a plank deck, a mast standing out of the water.
    await f.fill(24, Y(-3), 0, 34, Y(-3), 0, 'oak_log')
    await f.fill(24, Y(-2), -1, 34, Y(-2), 1, 'spruce_planks')
    await f.fill(29, Y(-1), 0, 29, Y(3), 0, 'spruce_log')
    // Beached wreck west of the start: a log post on a plank hull on dry ground.
    await f.fill(-22, Y(0), -2, -18, Y(0), 2, 'oak_planks')
    await f.fill(-20, Y(1), 0, -20, Y(4), 0, 'spruce_log')
    // The only tree: 90 blocks north (outside the 64-block target range, inside the 160 scan).
    await f.cmd('forceload add -16 -112 16 -80')
    await tree(0, -90)
    await placeSure(0, Y(0), 0)
    for (let i = 0; i < 30 && !isLogAt(0, Y(1), -90); i++) await sleep(1000) // chunks stream in
    await sleep(1500)
    const ids = f.bot.registry.blocksArray.filter(b => b.name.endsWith('_log')).map(b => b.id)
    const near = f.bot.findBlocks({ matching: ids, maxDistance: 64, count: 64 })
    // The fixture reproduces the bug: the old filter accepted wreck logs as wood.
    const oldPicks = near.filter(oldAccepts)
    note('old filter accepted', oldPicks.length, 'of', near.length, oldPicks.slice(0, 6))
    expect(oldPicks.length).toBeGreaterThan(0)
    const at = botTreeView(f.bot)
    for (const v of near) expect(treeVerdict(at, v.x, v.y, v.z).ok).toBe(false)
    expect(treeVerdict(at, 0, Y(1), -90)).toEqual({ ok: true })
    // Tree spots: only the real tree is remembered.
    rt.obs.scanTrees()
    const spots = rt.obs.memory.locations.filter(l => l.kind === 'trees').map(l => l.pos)
    note('tree spots', spots)
    expect(spots.length).toBeGreaterThan(0)
    for (const s of spots) expect(Math.hypot(s[0], s[2] + 90)).toBeLessThan(24)

    const since = f.events.length
    const r = await rt.run('collect', { block: 'log', count: 1, searchSteps: 1 })
    const steps = evs('search_step', since).map(e => e.data)
    note('wreck run', r.status, JSON.stringify(steps))
    expect(r.status).toBe('success')
    for (const st of steps) {
      const t = st.target as number[] | undefined
      if (t) expect(t[0]! > 10 || t[0]! < -10).toBe(false) // never toward the wreck (x 24…34) or the beached post (x −20)
    }
    expect(f.bot.entity.position.z).toBeLessThan(-70)
    expect(isLogAt(28, Y(-3), 0) && isLogAt(29, Y(1), 0) && isLogAt(-20, Y(2), 0)).toBe(true) // wreck untouched
    await f.fill(-3, Y(0), -93, 3, Y(5), -87, 'air')
    await f.cmd('forceload remove all')
  })

  it('accepts naturally grown 1.16.1 trees of every type, and collects from them', async () => {
    forgetAll()
    await f.reset(60, Y(40))
    // Saplings on the superflat grass, grown by fast random ticks into real (natural) trees.
    const single = ['oak', 'birch', 'spruce', 'acacia', 'jungle']
    const spots: [string, number, number][] = single.map((t, i) => [t, -30 + i * 14, -30])
    for (const [t, x, z] of spots) await f.cmd(`setblock ${x} ${Y(0)} ${z} minecraft:${t}_sapling`)
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) await f.cmd(`setblock ${40 + dx!} ${Y(0)} ${-30 + dz!} minecraft:dark_oak_sapling`)
    spots.push(['dark_oak', 40, -30])
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) await f.cmd(`setblock ${-30 + dx!} ${Y(0)} ${-6 + dz!} minecraft:spruce_sapling`)
    spots.push(['giant_spruce', -30, -6])
    await placeSure(0, Y(0), 0)
    await f.cmd('gamerule randomTickSpeed 4000')
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline && !spots.every(([, x, z]) => isLogAt(x, Y(0), z))) await sleep(1000)
    await f.cmd('gamerule randomTickSpeed 0') // no leaf decay or regrowth while the check runs
    await sleep(1500)
    const grown = spots.filter(([, x, z]) => isLogAt(x, Y(0), z)).map(s => s[0])
    note('grown', grown)
    expect(grown.length).toBeGreaterThanOrEqual(5)
    const ids = f.bot.registry.blocksArray.filter(b => b.name.endsWith('_log')).map(b => b.id)
    const logs = f.bot.findBlocks({ matching: ids, maxDistance: 80, count: 2000 })
    const at = botTreeView(f.bot)
    const rejected = logs.map(v => ({ v, verdict: treeVerdict(at, v.x, v.y, v.z), name: f.bot.blockAt(v, false)?.name })).filter(x => !x.verdict.ok)
    note('natural logs', logs.length, 'rejected', rejected.length, JSON.stringify(rejected.slice(0, 12)))
    expect(logs.length).toBeGreaterThan(30)
    expect(rejected.length).toBe(0)

    const before = Object.entries(rt.inv()).filter(([k]) => k.endsWith('_log')).reduce((n, [, v]) => n + v, 0)
    const r = await rt.run('collect', { block: 'log', count: before + 3, searchSteps: 0 })
    expect(r.status).toBe('success')
    await f.cmd('gamerule randomTickSpeed 3')
    await f.fill(-45, Y(0), -45, 55, Y(40), 8, 'air') // the grown trees (taller than the next reset)
  })
})

describe('wood targets: a walk interrupted by danger is not repeated', () => {
  it('a drowned on the way: the tree is left, and the next collect goes to another tree', async () => {
    forgetAll()
    await f.reset(130, Y(12))
    await f.cmd('kill @e[type=!player]')
    // Lake east of the start; the near tree beyond it, a second tree farther west.
    await f.fill(10, Y(-3), -14, 70, Y(-1), 14, 'water')
    await f.cmd('forceload add 80 -16 100 16')
    await f.cmd('forceload add -128 -16 -100 16')
    await tree(90, 0)
    await tree(-115, 0)
    await f.cmd(`summon minecraft:drowned 30 ${Y(-2)} 12 {NoAI:1b,PersistenceRequired:1b}`)
    await f.cmd(`summon minecraft:drowned 55 ${Y(-2)} -12 {NoAI:1b,PersistenceRequired:1b}`)
    await placeSure(0, Y(0), 0)
    for (let i = 0; i < 30 && !(isLogAt(90, Y(1), 0) && isLogAt(-115, Y(1), 0)); i++) await sleep(1000)
    await sleep(1500)

    // The controller loop (ProgressionController.runPreemptible): a higher-priority interrupt cancels the objective with its id.
    const cd = new Cooldowns(() => 0)
    let fired: Interrupt | null = null
    const iv = setInterval(() => {
      if (fired) return
      const i = selectInterrupt(rt.obs.state(), cd, { skill: 'collect', priority: P.objective })
      if (i && i.priority < P.objective) { fired = i; rt.runner.cancel(i.id) }
    }, 250)
    const since = f.events.length
    const r1 = await rt.run('collect', { block: 'log', count: 1, searchSteps: 1 })
    clearInterval(iv)
    const first = evs('search_step', since).map(e => e.data)
    note('interrupted', r1.status, (fired as Interrupt | null)?.id, (fired as Interrupt | null)?.reason, JSON.stringify(first))
    expect(fired).not.toBeNull()
    expect(r1.status).toBe('cancelled')
    expect((first[0]?.target as number[])[0]).toBe(90) // it was walking to the near tree
    expect(first.some(d => d.mode === 'wood_danger')).toBe(true)
    const zones = woodZones(rt.obs.state())
    note('zones', zones)
    expect(zones.some(z => Math.hypot(z[0] - 90, z[2]) < 4)).toBe(true)

    // After the flee (no interrupts now): the zone keeps the bot off the near tree.
    await f.cmd('kill @e[type=minecraft:drowned]')
    await placeSure(0, Y(0), 0)
    const since2 = f.events.length
    const r2 = await rt.run('collect', { block: 'log', count: 1, searchSteps: 1 })
    const second = evs('search_step', since2).map(e => e.data)
    note('second', r2.status, JSON.stringify(second), f.bot.entity.position)
    expect(r2.status).toBe('success')
    for (const d of second) if (d.target) expect((d.target as number[])[0]).toBeLessThan(0)
    expect(f.bot.entity.position.x).toBeLessThan(-90)
    // Nothing dug at the abandoned tree (its chunk is out of the client's range by now).
    expect(f.events.slice(since2).filter(e => e.type === 'nav_start' && Array.isArray((e.data.goal as { target?: number[] })?.target) && (e.data.goal as { target: number[] }).target[0]! > 60)).toEqual([])
    await f.cmd('forceload remove all')
  })
})
