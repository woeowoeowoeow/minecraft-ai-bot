// Waiting for the respawn after a death. Mineflayer respawns automatically, usually before
// the controller has finished its death bookkeeping, so a plain `once(bot, 'spawn')` started
// then waited out its whole timeout: B round 2 dev batch 20261002-225340 r06 stood ~15 s at
// the respawn point with no interrupts running and was shot from 20 to 4 HP. Here the state
// (dead or alive again) is tracked from the events themselves.
import { once } from 'node:events'
import type { Bot } from 'mineflayer'

export type RespawnWaiter = { dead (): boolean; wait (timeoutMs?: number, settleMs?: number): Promise<boolean> }

/** Track deaths and spawns of `bot`; `wait` resolves once it is alive again (true) or after the timeout (false). */
export function respawnWaiter (bot: Bot): RespawnWaiter {
  let dead = false
  bot.on('death', () => { dead = true })
  bot.on('spawn', () => { dead = false })
  return {
    dead: () => dead,
    async wait (timeoutMs = 15_000, settleMs = 500) {
      if (dead) {
        const ac = new AbortController()
        const t = setTimeout(() => ac.abort(), timeoutMs)
        try { await once(bot, 'spawn', { signal: ac.signal }) } catch { /* timed out */ } finally { clearTimeout(t) }
      }
      // Let the respawn position and inventory packets land before re-planning.
      await new Promise(r => setTimeout(r, settleMs))
      return !dead
    },
  }
}
