// Milestone B round 2 (after B gate 20261002, failed on deaths): stale client effects after
// a respawn, bounded digs and stalled wood targets, serialized inventory clicks with a
// bounded retry, and the weak-state threat response (dig in, hold, no resting in the open).
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { describe, expect, it } from 'vitest'
import mcData from 'minecraft-data'
import { installCursorSync, installRespawnEffectsReset } from '../../src/bot/protocol-fixes.js'
import { MC_VERSION } from '../../src/version.js'
import { EQUIP, safeEquip } from '../../src/bot/inventory-sync.js'
import { Cooldowns, selectInterrupt } from '../../src/controller/interrupts.js'
import type { EntityInfo } from '../../src/observer/types.js'
import { dig, DIG_MAX_MS, equipItem } from '../../src/skills/acts.js'
import { collect } from '../../src/skills/generic/collect.js'
import { Searcher } from '../../src/skills/generic/explore.js'
import { respawnWaiter } from '../../src/bot/respawn.js'
import { AbortError } from '../../src/skills/runner.js'
import { SkillFailure, type SkillCtx } from '../../src/skills/types.js'
import { assessThreat } from '../../src/skills/survival/threat.js'
import { mobDeath } from '../../src/recovery/death.js'
import { fakeEnv, fakeState } from './helpers.js'

const FATIGUE_ID = 4
const registry = { effectsByName: { MiningFatigue: { id: FATIGUE_ID } }, effects: { [FATIGUE_ID]: { name: 'MiningFatigue' } } }
const mob = (name: string, dist: number, over: Partial<EntityInfo> = {}): EntityInfo => ({ id: Math.round(dist * 100) + name.length, name, kind: 'hostile', pos: [dist, 64, 0], dist, los: true, ...over })
const near = (...entities: EntityInfo[]) => ({ entities, interestBlocks: {}, hazards: [] })

describe('client effects across a respawn (1.16.1)', () => {
  it('a respawn clears effects the server dropped with the dead player', () => {
    const client = new EventEmitter()
    const bot = { _client: client, registry, entity: { effects: { [FATIGUE_ID]: { id: FATIGUE_ID, amplifier: 2, duration: 6000 } } } }
    const seen: string[][] = []
    installRespawnEffectsReset(bot as never, c => seen.push(c))
    client.emit('respawn', {})
    expect(bot.entity.effects).toEqual({})
    expect(seen).toEqual([['MiningFatigue']])
    client.emit('respawn', {}) // nothing left: no event
    expect(seen).toHaveLength(1)
  })
})

describe('cursor slot (1.16.1 set_slot window −1)', () => {
  it('the server\'s cursor packet updates the client model (Mineflayer drops it)', () => {
    const client = new EventEmitter()
    const reg = mcData(MC_VERSION)
    const bot = { _client: client, registry: reg, inventory: { selectedItem: { name: 'cobblestone' } as unknown }, currentWindow: null }
    const ctl = installCursorSync(bot as never)
    client.emit('set_slot', { windowId: -1, slot: -1, item: { present: false } })
    expect(bot.inventory.selectedItem).toBeNull()
    client.emit('set_slot', { windowId: -1, slot: -1, item: { present: true, itemId: reg.itemsByName.bucket!.id, itemCount: 1 } })
    expect((bot.inventory.selectedItem as { name: string }).name).toBe('bucket')
    client.emit('set_slot', { windowId: 0, slot: 36, item: { present: false } }) // ordinary slots: Mineflayer's own handler
    expect((bot.inventory.selectedItem as { name: string }).name).toBe('bucket')
    ctl.enabled = false
    client.emit('set_slot', { windowId: -1, slot: -1, item: { present: false } })
    expect(bot.inventory.selectedItem).not.toBeNull()
  })
})

/** A bot standing on the ground, empty-handed, whose digs never finish until stopped. */
function digBot (effects: Record<string, unknown>) {
  let stop: ((e: Error) => void) | null = null
  return {
    registry,
    entity: { effects, onGround: true, position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [], slots: [] },
    heldItem: null,
    clearControlStates () {},
    dig: () => new Promise<void>((_resolve, reject) => { stop = reject }),
    stopDigging () { stop?.(new Error('digging stopped')) },
  }
}

describe('bounded digs', () => {
  const log = { name: 'oak_log', digTime: () => 1_100_000 } // Mining Fatigue III, bare hands
  it('a dig predicted beyond DIG_MAX_MS fails at once, naming Mining Fatigue when it is the cause', async () => {
    const signal = new AbortController().signal
    const f = await dig(digBot({ [FATIGUE_ID]: { id: FATIGUE_ID, amplifier: 2 } }) as never, log as never, signal).catch(e => e)
    expect(f).toBeInstanceOf(SkillFailure)
    expect(f).toMatchObject({ cls: 'PRECONDITION_FAILED', detail: { key: 'effect=mining_fatigue' } })
    const g = await dig(digBot({}) as never, log as never, signal).catch(e => e)
    expect(g).toMatchObject({ cls: 'PRECONDITION_FAILED', detail: { key: 'dig=slow,block=oak_log' } })
    expect(DIG_MAX_MS).toBeLessThan(60_000) // below collect's stall watchdog
  })
})

describe('wood collection after a stall', () => {
  it('the log a stalled collect was working on is blacklisted (never retried first)', async () => {
    const target = new Vec3(5, 64, 0)
    const bot = {
      ...digBot({}),
      registry: { ...registry, blocksArray: [{ name: 'oak_log', id: 1 }] },
      findBlocks: () => [target],
      blockAt: (p: Vec3) => p.equals(target) ? { name: 'oak_log', position: target, digTime: () => 3000 } : { name: 'air', position: p },
    }
    const env = fakeEnv()
    const black: [string, string][] = []
    env.bot = bot as never
    env.blacklist = (k: string, r: string) => { black.push([k, r]) }
    const ac = new AbortController()
    const ctx = {
      bot, env, state: env.state, memory: env.memory, signal: ac.signal,
      log: () => {}, progress: () => {}, localRecovery: () => {}, capture: () => {},
      checkAbort: () => { if (ac.signal.aborted) throw ac.signal.reason },
      run: async () => { throw new Error('no children') },
      nav: { goto: async () => ({ ok: true, dist: 0, ms: 1, detail: {} }) },
    } as unknown as SkillCtx
    const p = collect.run(ctx, { block: 'log', count: 3, maxDist: 64, searchSteps: 6, chance: false }).catch(e => e)
    await new Promise(r => setTimeout(r, 100))
    ac.abort(new AbortError('stalled')) // the runner's watchdog
    expect(await p).toBeInstanceOf(AbortError)
    expect(black).toContainEqual(['block:5,64,0', 'collect_stalled'])
  })
})

/** A bot whose equip clicks the server rejects `rejections` times; each rejection is followed by a window resend. */
function equipBot (rejections: number) {
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>
  const slots: (null | { name: string; slot: number })[] = []
  slots[36] = { name: 'water_bucket', slot: 36 }
  slots[20] = { name: 'bucket', slot: 20 }
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  Object.assign(bot, {
    supportFeature: () => false,
    inventory: { slots, selectedItem: null, items: () => slots.filter(Boolean) },
    equip: async (it: { name: string }) => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      if (rejections-- > 0) {
        setTimeout(() => bot.emit('setWindowItems:0'), 5)
        throw new Error(`Server rejected transaction for clicking on slot 38, on window with id 0. (${it.name})`)
      }
    },
  })
  return { bot, stats: () => ({ calls, maxInFlight }) }
}

describe('serialized inventory clicks with a bounded retry (bucket swaps)', () => {
  it('a rejected equip waits for the resend and succeeds on the retry', async () => {
    const { bot, stats } = equipBot(1)
    const retries: unknown[] = []
    await safeEquip(bot as never, 'bucket', 'hand', { onRetry: r => retries.push(r) })
    expect(stats().calls).toBe(2)
    expect(retries).toEqual([expect.objectContaining({ item: 'bucket', attempt: 1, resent: true })])
  })
  it('concurrent swaps never overlap (one click sequence at a time)', async () => {
    const { bot, stats } = equipBot(0)
    await Promise.all([safeEquip(bot as never, 'bucket'), safeEquip(bot as never, 'water_bucket'), safeEquip(bot as never, 'bucket')])
    expect(stats().maxInFlight).toBe(1)
  })
  it('gives up after EQUIP.attempts as STATE_INCONSISTENT (Recovery resyncs), never an uncaught INFRA', async () => {
    const { bot, stats } = equipBot(99)
    const e = await equipItem(bot as never, 'bucket').catch(x => x)
    expect(stats().calls).toBe(EQUIP.attempts)
    expect(e).toBeInstanceOf(SkillFailure)
    expect(e).toMatchObject({ cls: 'STATE_INCONSISTENT', detail: { key: 'inventory=rejected' } })
  })
})

describe('weak-state threat response', () => {
  const s = (entities: EntityInfo[], over: Parameters<typeof fakeState>[0] = {}) => fakeState({ nearby: near(...entities), ...over })
  it('bare-handed with a zombie still 6+ blocks off: dig in; already close: flee', () => {
    expect(assessThreat(s([mob('zombie', 7)]))).toMatchObject({ action: 'cover', reason: expect.stringMatching(/weak: dig in/) })
    expect(assessThreat(s([mob('zombie', 4)])).action).toBe('flee')
  })
  it('armed and healthy still defends; badly hurt with a sword digs in', () => {
    expect(assessThreat(s([mob('zombie', 3)], { inventory: { stone_sword: 1 } })).action).toBe('defend')
    const hurt = fakeState().vitals
    expect(assessThreat(s([mob('zombie', 7)], { inventory: { iron_sword: 1 }, vitals: { ...hurt, health: 5 } })).action).toBe('cover')
  })
  it('creepers, shooters, aquatic mobs and water keep their own responses', () => {
    expect(assessThreat(s([mob('creeper', 5)])).action).toBe('flee')
    expect(assessThreat(s([mob('skeleton', 9)])).action).toBe('cover')
    expect(assessThreat(s([mob('drowned', 6)])).action).toBe('flee')
    expect(assessThreat(s([mob('zombie', 7)], { inLiquid: 'water' })).action).toBe('flee')
    expect(mobDeath('Bot was killed by magic')).toBe(false)
    expect(mobDeath('Bot was slain by Zombie')).toBe(true)
    expect(mobDeath('Bot was killed by Witch using magic')).toBe(true)
  })
  it('no resting in the open with a hostile in sight; a weak bot holds its pocket longer', () => {
    const cd = new Cooldowns(() => 0)
    const none = { skill: null, priority: null }
    const fed = { ...fakeState().vitals, health: 8, food: 20 }
    expect(selectInterrupt(s([mob('zombie', 12)], { vitals: fed }), cd, none)?.id).not.toBe('rest')
    expect(selectInterrupt(s([mob('zombie', 12, { los: false })], { vitals: fed }), cd, none)?.id).toBe('rest')
    const pocket = { ...fakeState().body, enclosed: true, covered: true }
    expect(selectInterrupt(s([mob('zombie', 10, { los: false })], { body: pocket }), cd, none)?.id).toBe('hold') // bare-handed: weak
    expect(selectInterrupt(s([mob('zombie', 10, { los: false })], { body: pocket, inventory: { iron_sword: 1 } }), cd, none)).toBeNull()
  })
})

describe('round 2b: respawn wait and dry searches', () => {
  it('a respawn that already happened is not waited for again (no 15 s blind window)', async () => {
    const bot = new EventEmitter()
    const w = respawnWaiter(bot as never)
    bot.emit('death')
    expect(w.dead()).toBe(true)
    bot.emit('spawn') // Mineflayer's automatic respawn, before the controller asks
    const t0 = Date.now()
    expect(await w.wait(15_000, 0)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(200)
    bot.emit('death')
    setTimeout(() => bot.emit('spawn'), 50)
    expect(await w.wait(15_000, 0)).toBe(true)
  })
  it('food and wood search steps prefer dry ground', async () => {
    const goals: Record<string, unknown>[] = []
    const env = fakeEnv()
    const ctx = { state: env.state, env, log: () => {}, progress: () => {}, checkAbort: () => {}, nav: { goto: async (g: Record<string, unknown>) => { goals.push(g); return { ok: true } } } } as unknown as SkillCtx
    await new Searcher('cow', { surface: true, dry: true }).step(ctx)
    await new Searcher('stone').step(ctx)
    expect(goals[0]).toMatchObject({ kind: 'xz', dry: true })
    expect(goals[1]).not.toHaveProperty('dry')
  })
})
