// Client behaviour the 1.16.1 protocol needs and Mineflayer 4.39 lacks. Installed on
// every bot (src/bot/main.ts, scenario harness). Version-specific: see architecture §10.1.
import type { Bot } from 'mineflayer'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'

type DigAck = { location: { x: number; y: number; z: number }; block: number; status: number; successful: boolean }
export type DigAckCorrection = { pos: [number, number, number]; client: string; server: string; status: number; successful: boolean }

/**
 * Apply block-break acknowledgements (`acknowledge_player_digging`, 1.14–1.18 protocol).
 *
 * Mineflayer marks a dug block as air as soon as it sends "finish digging" and ignores
 * the server's acknowledgement. A 1.16 server that counted too few ticks for the dig
 * (server lag, or the bot airborne) acks with the block still in place and breaks it
 * later — or never, when another dig starts first ("abort destroying since another
 * started"). The vanilla client sets the acknowledged state whenever it differs from
 * its own; without that the client keeps a ghost air cell, walks into it, and the
 * server silently teleports the bot back (seen as position-correction storms and
 * `excavation steps keep failing`). 1.19+ replaced this packet with sequenced acks.
 */
export function installDigAck (bot: Bot, onCorrection?: (c: DigAckCorrection) => void): void {
  const client = bot._client as unknown as { on (ev: string, fn: (p: DigAck) => void): void }
  // Looked up per packet: Mineflayer's block plugin attaches `_updateBlockState` after createBot returns.
  const b = bot as Bot & { _updateBlockState?: (p: Vec3, stateId: number) => void }
  client.on('acknowledge_player_digging', (p) => {
    if (!b._updateBlockState) return
    const pos = new Vec3(p.location.x, p.location.y, p.location.z)
    const cur = bot.blockAt(pos, false)
    if (!cur || cur.stateId === p.block) return
    b._updateBlockState(pos, p.block)
    const now = bot.blockAt(pos, false)
    onCorrection?.({ pos: [pos.x, pos.y, pos.z], client: cur.name, server: now?.name ?? String(p.block), status: p.status, successful: p.successful })
  })
}

/**
 * Bound prismarine-world's raycast iterator. With a non-finite direction (a zero-length
 * vector normalised to NaN) every comparison in `RaycastIterator.next` is false, so it
 * never returns null and `world.raycast` spins forever on the event loop: Mineflayer
 * and pathfinder goals (GoalLookAtBlock) call it synchronously. A ray within reach
 * never needs more than a few dozen cells; stop at 2000 and report it.
 */
export function installRaycastGuard (onTrip?: (why: string) => void): void {
  const it = createRequire(import.meta.url)('prismarine-world/src/iterators.js') as { RaycastIterator?: { prototype: { next (): unknown; __guard?: boolean; __steps?: number; dir: { x: number; y: number; z: number } } } }
  const proto = it.RaycastIterator?.prototype
  if (!proto || proto.__guard) return
  const next = proto.next
  proto.next = function (this: typeof proto) {
    const d = this.dir
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)) { onTrip?.('non-finite ray direction'); return null }
    this.__steps = (this.__steps ?? 0) + 1
    if (this.__steps > 2000) { onTrip?.('ray exceeded 2000 cells'); return null }
    return next.call(this)
  }
  proto.__guard = true
}
