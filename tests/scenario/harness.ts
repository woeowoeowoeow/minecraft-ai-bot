// Real-server fixture harness (architecture §11 `tests/scenario`). Fixture scenarios
// build terrain with evaluator console commands on a flat, peaceful world. They are
// development tests only and never count toward a gate (evaluation.md §1).
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import * as mfNs from 'mineflayer'
import type { Bot } from 'mineflayer'
import { freePort } from '../../src/evaluation/batch.js'
import { ProcessRegistry } from '../../src/evaluation/procs.js'
import { resolveJava } from '../../src/evaluation/java.js'
import { JAR, ROOT, WORLDS } from '../../src/evaluation/run.js'
import { ServerProcess } from '../../src/evaluation/server.js'
import { MC_VERSION } from '../../src/version.js'
import { installCursorSync, installDigAck, installRaycastGuard, installRespawnEffectsReset } from '../../src/bot/protocol-fixes.js'
import { onInventoryRetry } from '../../src/bot/inventory-sync.js'
import { loadPathfinder, PathfinderNavigator } from '../../src/nav/pathfinder.js'
import { EventBus } from '../../src/observer/events.js'
import type { EventRecord } from '../../src/schema/index.js'

type MF = typeof import('mineflayer')
const mineflayer: MF = ((mfNs as unknown as { default?: MF }).default ?? mfNs) as MF

/** 1.16.1 superflat default: bedrock y=0, dirt 1..2, grass 3; players stand at y=4. */
export const FLAT_Y = 4
/** Absolute y for a height relative to the flat ground's standing level. */
export const Y = (dy: number) => FLAT_Y + dy

export type Fixture = {
  server: ServerProcess
  bot: Bot
  bus: EventBus
  nav: PathfinderNavigator
  events: EventRecord[]
  cmd (line: string): Promise<void>
  /** /fill split into volumes under the vanilla 32768-block limit. */
  fill (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Promise<void>
  /** Clear the arena (|x|,|z| ≤ r, y up to `top`, absolute) back to the superflat ground. */
  reset (r?: number, top?: number): Promise<void>
  /** Teleport, clear inventory, reset vitals, and wait for the client to settle. */
  place (x: number, y: number, z: number, items?: Record<string, number>): Promise<void>
  close (): Promise<void>
  /** The 1.16.1 cursor-slot fix (protocol-fixes.ts); a fixture may switch it off to reproduce the old client. */
  cursorSync: { enabled: boolean }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** `spawnAnimals`: the 1.16.1 server removes summoned animals when spawn-animals=false. */
export type FixtureOptions = { difficulty?: 'peaceful' | 'easy' | 'normal'; keepInventory?: boolean; spawnAnimals?: boolean }

export async function startFixture (name: string, fo: FixtureOptions = {}): Promise<Fixture> {
  const registry = new ProcessRegistry(join(ROOT, '.cache', 'pids'))
  const port = await freePort()
  const worldDir = join(WORLDS, `scenario-${name}-${Date.now()}`)
  const server = new ServerProcess({
    worldDir, port, seed: '1', jarPath: JAR, javaBin: resolveJava(ROOT).bin,
    properties: { 'level-type': 'flat', 'generate-structures': 'false', difficulty: fo.difficulty ?? 'peaceful', 'spawn-monsters': 'false', 'spawn-animals': String(fo.spawnAnimals ?? false) },
  }, registry)
  await server.start()
  const cmd = async (line: string) => { server.command(line); await sleep(60) }
  for (const g of ['doDaylightCycle false', 'doWeatherCycle false', 'doMobSpawning false', 'doTileDrops true', `keepInventory ${fo.keepInventory ?? true}`]) await cmd(`gamerule ${g}`)
  await cmd('time set day')

  const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: 'Bot', version: MC_VERSION, auth: 'offline' })
  await once(bot, 'spawn')
  await bot.waitForChunksToLoad()
  const bus = new EventBus()
  const events: EventRecord[] = []
  bus.on(ev => { events.push(ev) })
  installDigAck(bot, c => bus.emit('dig_ack_correction', c, 'warn'))
  installRaycastGuard(why => bus.emit('error', { message: `raycast guard: ${why}` }, 'warn'))
  installRespawnEffectsReset(bot, cleared => bus.emit('effects_reset', { cleared }, 'info'))
  const cursorSync = installCursorSync(bot)
  onInventoryRetry(bot, r => bus.emit('inventory_retry', r, 'warn'))
  loadPathfinder(bot)
  const nav = new PathfinderNavigator(bot, bus)

  const fill = async (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => {
    const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
    const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
    const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
    const slab = Math.max(1, Math.floor(32_768 / ((by - ay + 1) * (bz - az + 1))))
    for (let x = ax; x <= bx; x += slab) await cmd(`fill ${x} ${ay} ${az} ${Math.min(bx, x + slab - 1)} ${by} ${bz} ${block}`)
  }
  const reset = async (r = 32, top = Y(40)) => {
    await fill(-r, Y(-1), -r, r, top, r, 'air')
    await fill(-r, Y(-3), -r, r, Y(-2), r, 'dirt')
    await fill(-r, Y(-1), -r, r, Y(-1), r, 'grass_block')
    await cmd('kill @e[type=item]')
    await cmd('kill @e[type=!player]')
  }

  const place = async (x: number, y: number, z: number, items: Record<string, number> = {}) => {
    await cmd('clear Bot')
    await cmd('effect clear Bot')
    await cmd(`tp Bot ${x + 0.5} ${y} ${z + 0.5} 0 0`)
    for (const [item, n] of Object.entries(items)) await cmd(`give Bot minecraft:${item} ${n}`)
    await sleep(1500)
    await bot.waitForChunksToLoad()
  }

  const close = async () => {
    try { bot.quit() } catch { /* ignore */ }
    await server.stop().catch(() => {})
    rmSync(worldDir, { recursive: true, force: true })
  }
  return { server, bot, bus, nav, events, cmd, fill, reset, place, close, cursorSync }
}
