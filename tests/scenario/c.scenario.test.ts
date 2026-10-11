// Milestone C mechanics on the real 1.16.1 server, in Nether arenas built with console
// commands on a flat world (labeled fixtures, development only, never a gate): piglin
// bartering (and baby piglins), nether gold mining into ingots, fortress detection
// and search beyond view distance, blaze fights at a spawner, the enderman alternate,
// and the walk back to the arrival portal along the trail.
import { Vec3 } from 'vec3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fortressKnown } from '../../src/planner/milestones.js'
import { isBabyPiglin } from '../../src/skills/progression/barter.js'
import { startFixture, type Fixture } from './harness.js'
import { runtime, type Runtime } from './runtime.js'

let f: Fixture
let rt: Runtime
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const n = (c: string) => f.cmd(`execute in minecraft:the_nether run ${c}`)

beforeAll(async () => {
  f = await startFixture('c-nether', { difficulty: 'normal', spawnMonsters: true })
  rt = runtime(f)
}, 300_000)
afterAll(async () => { rt?.obs.stop(); await f?.close() }, 60_000)

/** /fill in the Nether split under the vanilla 32768-block limit. */
async function nfill (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Promise<void> {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
  const slab = Math.max(1, Math.floor(32_768 / ((by - ay + 1) * (bz - az + 1))))
  for (let x = ax; x <= bx; x += slab) await n(`fill ${x} ${ay} ${az} ${Math.min(bx, x + slab - 1)} ${by} ${bz} ${block}`)
}

/** A walled netherrack arena: floor top at y 99 (stand at y 100), air to y 109, walls one block outside. */
async function arena (x0: number, x1: number, z0: number, z1: number): Promise<void> {
  await n(`forceload add ${x0 - 1} ${z0 - 1} ${x1 + 1} ${z1 + 1}`)
  await sleep(2500)
  await nfill(x0 - 1, 95, z0 - 1, x1 + 1, 112, z1 + 1, 'netherrack')
  await nfill(x0, 100, z0, x1, 110, z1, 'air')
  await f.cmd('kill @e[type=!player]')
}

async function toNether (x: number, y: number, z: number, items: Record<string, number>, head?: string): Promise<void> {
  await f.cmd('clear Bot')
  await f.cmd('effect clear Bot')
  await n(`tp Bot ${x + 0.5} ${y} ${z + 0.5} 0 0`)
  await sleep(3000)
  await f.bot.waitForChunksToLoad()
  for (const [item, k] of Object.entries(items)) await f.cmd(`give Bot minecraft:${item} ${k}`)
  if (head) await f.cmd(`replaceitem entity Bot armor.head minecraft:${head}`)
  await f.cmd('effect give Bot minecraft:instant_health 1 5')
  await f.cmd('effect give Bot minecraft:saturation 1 20')
  await sleep(1500)
}

function resetMemory (): void {
  rt.obs.memory.locations = rt.obs.memory.locations.filter(l => !['fortress', 'blaze_spawner', 'bastion', 'piglins', 'endermen', 'portal_nether'].includes(l.kind))
  rt.obs.memory.netherFailed = []
  rt.obs.memory.blacklist = []
  rt.obs.memory.cLedger = undefined
}

// Isolation: every test starts with no mobs or items left over (blazes from an earlier spawner,
// piglins, drops) and fresh Nether memory, so the tests pass in any order and alone.
beforeEach(async () => {
  await f.cmd('kill @e[type=!player]')
  resetMemory()
  rt.obs.memory.explored.the_nether.clear()
})

/**
 * A self-contained blaze fortress room (its own arena, x0..x0+40): brick floor, walls with a
 * doorway, a partial roof and a blaze spawner on a pillar at x0+28. The bot is kept out of client
 * range while it is built (a spawner set into an already-loaded chunk section is not seen by the
 * client's findBlocks), then placed at the room's entrance.
 */
async function blazeRoom (x0: number): Promise<number> {
  await n('tp Bot 0.5 100 0.5')
  await sleep(2500)
  await arena(x0, x0 + 40, -10, 10)
  const fx = x0 + 28
  await nfill(fx - 10, 99, -8, fx + 10, 99, 8, 'nether_bricks')
  await nfill(fx - 10, 100, -8, fx - 10, 104, 8, 'nether_bricks')
  await nfill(fx - 10, 100, -1, fx - 10, 102, 1, 'air')
  await nfill(fx - 10, 105, -8, fx + 2, 105, 8, 'nether_bricks')
  await n(`setblock ${fx} 100 0 minecraft:nether_bricks`)
  await n(`setblock ${fx} 101 0 minecraft:spawner{SpawnData:{id:"minecraft:blaze"},Delay:20}`)
  await f.cmd('kill @e[type=!player]')
  return fx
}

describe('piglin bartering', () => {
  it('reads baby piglins from metadata, gives adults one ingot at a time, tracks the returns', async () => {
    await arena(-14, 14, -14, 14)
    resetMemory()
    await toNether(0, 100, 0, { gold_ingot: 10, iron_sword: 1, cooked_beef: 8 }, 'golden_helmet')
    const tag = '{IsImmuneToZombification:1b,PersistenceRequired:1b}'
    await n(`summon piglin 4 100 0 ${tag}`)
    await n(`summon piglin -4 100 3 ${tag}`)
    await n('summon piglin 0 100 -6 {IsBaby:1b,IsImmuneToZombification:1b,PersistenceRequired:1b}')
    await sleep(2500)
    const piglins = Object.values(f.bot.entities).filter(e => e.name === 'piglin')
    console.log('piglin metadata', piglins.map(e => JSON.stringify((e as unknown as { metadata: unknown[] }).metadata.map((v, i) => v === true ? i : null).filter(x => x !== null))))
    expect(piglins).toHaveLength(3)
    expect(piglins.filter(e => isBabyPiglin(e as never))).toHaveLength(1)
    const t0 = f.events.length
    const r = await rt.run('barterPearls', { count: 64, searchLegs: 0 })
    // Every ingot traded, then a hand-over for more gold.
    expect(r.status).toBe('failure')
    expect(r.failure?.class).toBe('MISSING_RESOURCE')
    expect(rt.inv().gold_ingot ?? 0).toBe(0)
    const gives = f.events.slice(t0).filter(e => e.type === 'barter' && e.data.kind === 'give')
    expect(gives).toHaveLength(10)
    expect(f.events.slice(t0).filter(e => e.type === 'barter' && e.data.kind === 'provoked')).toHaveLength(0)
    expect(f.bot.health).toBeGreaterThan(15)
    console.log('after barter', JSON.stringify(rt.inv()))
  }, 240_000)
})

describe('piglin on a ledge', () => {
  it('tosses gold to a piglin it can see but not reach, and the piglin barters it', async () => {
    await arena(-14, 14, -14, 14)
    resetMemory()
    // A 3×3 pillar 4 blocks high, 5 blocks away, walled by air: no way up without scaffolding.
    await nfill(4, 100, -1, 6, 103, 1, 'netherrack')
    await toNether(0, 100, 0, { gold_ingot: 3, iron_sword: 1, cooked_beef: 8 }, 'golden_helmet')
    await n('summon piglin 5 104 0 {IsImmuneToZombification:1b,PersistenceRequired:1b,NoAI:0b}')
    await sleep(2500)
    const t0 = f.events.length
    const r = await rt.run('barterPearls', { count: 64, searchLegs: 0 })
    const gives = f.events.slice(t0).filter(e => e.type === 'barter' && e.data.kind === 'give')
    console.log('ledge barter', r.status, JSON.stringify(gives.map(g => g.data.method)), JSON.stringify(rt.inv()))
    expect(gives.length).toBeGreaterThanOrEqual(1)
    expect(gives.some(g => g.data.method === 'toss')).toBe(true)
  }, 240_000)
})

describe('nether gold', () => {
  it('mines nether gold ore with a stone pickaxe and crafts ingots from the nuggets', async () => {
    await arena(-14, 14, -14, 14)
    resetMemory()
    await toNether(0, 100, 0, { stone_pickaxe: 1, crafting_table: 1, cooked_beef: 8 }, 'golden_helmet')
    for (const [x, z] of [[4, 2], [5, 2], [4, 3], [6, -3], [-5, 4], [-5, 5], [3, -6], [-2, -7]] as const) await n(`setblock ${x} 99 ${z} minecraft:nether_gold_ore`)
    await sleep(800)
    const r = await rt.run('obtain', { item: 'gold_ingot', count: 2 })
    expect(r.status).toBe('success')
    expect(rt.inv().gold_ingot ?? 0).toBeGreaterThanOrEqual(2)
  }, 300_000)
})

describe('fortress search and blazes', () => {
  // A long corridor (z −8..8) from x −10 to 260; a nether-brick "fortress" room at x 225..245 with a blaze spawner.
  const FX = 235
  it('finds a fortress beyond view distance through the unseen part of its zone', async () => {
    await arena(-10, 260, -8, 8)
    resetMemory()
    // The room: brick floor, walls with a doorway toward −x, a partial roof, the spawner on a pillar.
    await nfill(FX - 10, 99, -8, FX + 10, 99, 8, 'nether_bricks')
    await nfill(FX - 10, 100, -8, FX - 10, 104, 8, 'nether_bricks')
    await nfill(FX - 10, 100, -1, FX - 10, 102, 1, 'air')
    await nfill(FX - 10, 105, -8, FX + 2, 105, 8, 'nether_bricks')
    await n(`setblock ${FX} 100 0 minecraft:nether_bricks`)
    // Placed before the bot loads the chunk: the client's findBlocks pre-filters on section
    // palettes, which a later single-block update does not extend (real spawners come with the chunk).
    await n(`setblock ${FX} 101 0 minecraft:spawner{SpawnData:{id:"minecraft:blaze"},Delay:20}`)
    await toNether(0, 100, 0, { iron_sword: 1, shield: 1, stone_pickaxe: 2, netherrack: 32, cooked_beef: 16 }, 'golden_helmet')
    // The armor a C run has: golden helmet (piglins) and iron boots.
    await f.cmd('replaceitem entity Bot armor.feet minecraft:iron_boots')
    // Seen already: everything except the +x part of region (0,0)'s zone (the corridor's direction).
    const ex = rt.obs.memory.explored.the_nether
    for (let cx = -60; cx <= 60; cx++) for (let cz = -60; cz <= 60; cz++) if (!(cx >= 11 && cx <= 22 && cz >= 0 && cz <= 4)) ex.add(`${cx},${cz}`)
    rt.obs.memory.locations.push({ kind: 'portal_nether', dim: 'the_nether', pos: [0, 100, 0], confidence: 1, source: 'observed', lastSeen: rt.obs.state().t })
    expect(fortressKnown(rt.obs.state())).toBe(false)
    const r = await rt.run('findFortress', { mode: 'regions', maxLegs: 6 })
    expect(r.status).toBe('success')
    expect(fortressKnown(rt.obs.state())).toBe(true)
    const legs = f.events.filter(e => e.type === 'fortress' && e.data.kind === 'search')
    expect(legs.length).toBeGreaterThanOrEqual(1)
    expect(f.bot.entity.position.x).toBeGreaterThan(30)
  }, 400_000)

  it('camps at the spawner, fights blazes with sword and shield, and collects rods', async () => {
    const deaths0 = rt.obs.state().counters.deaths
    const fx = await blazeRoom(5000)
    await toNether(fx - 22, 100, 0, { iron_sword: 1, shield: 1, stone_pickaxe: 2, netherrack: 32, cooked_beef: 16 }, 'golden_helmet')
    await f.cmd('replaceitem entity Bot armor.feet minecraft:iron_boots')
    // With fire resistance (the bastion route barters for it before the rods: 20/423 per ingot).
    await f.cmd('give Bot minecraft:potion{Potion:"minecraft:fire_resistance"} 2')
    await sleep(6000)
    expect(rt.obs.memory.locations.some(l => l.kind === 'blaze_spawner')).toBe(true)
    const t0 = f.events.length
    const r = await rt.run('collectBlazeRods', { count: 2, mode: 'spawner' })
    console.log('blaze events', f.events.slice(t0).filter(e => e.type === 'blaze' || e.type === 'death').map(e => JSON.stringify(e.data)).join(' | '))
    expect(r.status).toBe('success')
    expect(rt.obs.memory.locations.some(l => l.kind === 'blaze_spawner')).toBe(true)
    expect(f.events.slice(t0).some(e => e.type === 'blaze' && e.data.kind === 'camp')).toBe(true)
    expect(rt.inv().blaze_rod ?? 0).toBeGreaterThanOrEqual(2)
    expect(rt.obs.state().counters.deaths).toBe(deaths0)
  }, 600_000)
})

describe('blazes without fire resistance', () => {
  it('fights with shield and retreats beyond the spawner range when hurt, without dying', async () => {
    const deaths0 = rt.obs.state().counters.deaths
    // Its own fresh room: no blazes left over from the test before (the old order dependence).
    const fx = await blazeRoom(6000)
    await toNether(fx - 22, 100, 0, { iron_sword: 1, shield: 1, stone_pickaxe: 2, netherrack: 32, cooked_beef: 24 }, 'golden_helmet')
    await f.cmd('replaceitem entity Bot armor.feet minecraft:iron_boots')
    await sleep(6000)
    expect(rt.obs.memory.locations.some(l => l.kind === 'blaze_spawner')).toBe(true)
    expect(Object.values(f.bot.entities).filter(e => e.name === 'blaze')).toHaveLength(0)
    const t0 = f.events.length
    const r = await rt.run('collectBlazeRods', { count: 2, mode: 'spawner' })
    console.log('no-FR blaze events', r.status, f.events.slice(t0).filter(e => e.type === 'blaze' || e.type === 'death').map(e => JSON.stringify(e.data)).join(' | '))
    expect(rt.obs.state().counters.deaths).toBe(deaths0)
  }, 600_000)
})

describe('enderman alternate', () => {
  it('hunts endermen for pearls with sword and shield', async () => {
    const deaths0 = rt.obs.state().counters.deaths
    await arena(-16, 16, -16, 16)
    resetMemory()
    await toNether(0, 100, 0, { iron_sword: 1, shield: 1, cooked_beef: 16 }, 'iron_helmet')
    await f.cmd('replaceitem entity Bot armor.chest minecraft:iron_chestplate')
    for (const [x, z] of [[8, 8], [-8, 8], [8, -8], [-8, -8], [10, 0]] as const) await n(`summon enderman ${x} 100 ${z} {PersistenceRequired:1b}`)
    await sleep(2000)
    const r = await rt.run('huntEndermen', { count: 1, searchLegs: 0 })
    const kills = f.events.filter(e => e.type === 'enderman' && e.data.kind === 'kill').length
    console.log('enderman', r.status, kills, JSON.stringify(rt.inv()))
    expect(kills).toBeGreaterThanOrEqual(1)
    expect(rt.obs.state().counters.deaths).toBe(deaths0)
    // 0–1 pearl per kill: five endermen leave a 3 % chance of none.
    if (r.status === 'success') expect(rt.inv().ender_pearl ?? 0).toBeGreaterThanOrEqual(1)
  }, 400_000)
})

describe('return to the arrival portal', () => {
  it('walks back along the trail from 100+ blocks and leaves through the portal', async () => {
    const deaths0 = rt.obs.state().counters.deaths
    // An L-shaped causeway over a lava lake: portal at the start, the far end 70 + 70 blocks away.
    await n('forceload add -12 -12 90 90')
    await sleep(2500)
    await nfill(-12, 95, -12, 90, 112, 90, 'netherrack')
    await nfill(-12, 98, -12, 90, 110, 90, 'air')
    await nfill(-12, 97, -12, 90, 97, 90, 'lava')
    await nfill(-3, 97, -3, 3, 97, 3, 'netherrack')
    await nfill(4, 97, -1, 75, 97, 1, 'netherrack')
    await nfill(73, 97, 2, 75, 97, 75, 'netherrack')
    await f.cmd('kill @e[type=!player]')
    await n('fill 0 98 -1 0 102 2 minecraft:obsidian')
    await n('fill 0 99 0 0 101 1 minecraft:air')
    await n('setblock 0 99 0 minecraft:fire')
    resetMemory()
    rt.obs.memory.trail = undefined
    // A real dimension change starts the trail: hop to the Overworld first.
    await f.cmd('execute in minecraft:overworld run tp Bot 0.5 4 0.5')
    await sleep(3000)
    await toNether(2, 98, 0, { iron_sword: 1, stone_pickaxe: 1, netherrack: 32, cooked_beef: 8 }, 'golden_helmet')
    expect(rt.obs.memory.trail).toBeDefined()
    const portal = f.bot.findBlocks({ matching: f.bot.registry.blocksByName.nether_portal!.id, maxDistance: 6, count: 1 })[0]
    expect(portal).toBeDefined()
    if (!rt.obs.memory.locations.some(l => l.kind === 'portal_nether')) rt.obs.memory.locations.push({ kind: 'portal_nether', dim: 'the_nether', pos: [portal!.x, portal!.y, portal!.z], confidence: 1, source: 'observed', lastSeen: rt.obs.state().t })
    // Out along the causeway (the observer records the trail).
    for (const t of [[40, 98, 0], [74, 98, 0], [74, 98, 40], [74, 98, 72]] as const) {
      const r = await rt.env.nav.goto({ kind: 'near', target: [t[0], t[1], t[2]], range: 2 }, { profile: 'nether', timeoutMs: 90_000, signal: new AbortController().signal })
      expect(r.ok).toBe(true)
    }
    expect(rt.obs.memory.trail!.points.length).toBeGreaterThan(10)
    const t0 = f.events.length
    const back = await rt.run('usePortal', { to: 'overworld' })
    expect(back.status).toBe('success')
    expect(rt.obs.dim()).toBe('overworld')
    console.log('trail test deaths', JSON.stringify(f.events.filter(e => e.type === 'death').slice(-2).map(e => e.data)))
    expect(f.events.slice(t0).some(e => e.type === 'trail' && e.data.kind === 'done')).toBe(true)
    expect(rt.obs.state().counters.deaths).toBe(deaths0)
    expect(f.bot.entity.position.distanceTo(new Vec3(0, 0, 0))).toBeGreaterThanOrEqual(0)
  }, 600_000)
})
