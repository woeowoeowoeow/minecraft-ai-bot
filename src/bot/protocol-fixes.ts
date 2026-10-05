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
 * Apply the server's cursor slot (`set_slot` with window −1, slot −1).
 *
 * After a rejected click the 1.16.1 server resends the window contents and the item on the
 * cursor. Mineflayer drops the cursor packet (no window −1), so a stack picked up by the
 * accepted first click of a move whose second click was rejected stays "on the cursor"
 * with no client-side record of whether the server still has it there. B gate 20261002:
 * buckets and cobblestone went missing from the client model after portal-site rejections.
 */
export function installCursorSync (bot: Bot, onCursor?: (item: string | null) => void): { enabled: boolean } {
  const client = bot._client as unknown as { on (ev: string, fn: (p: { windowId: number; slot: number; item: unknown }) => void): void }
  let Item: { fromNotch (n: unknown): { name: string } | null } | null = null
  // `enabled` lets a fixture reproduce the uncorrected client (tests/scenario/b-round2).
  const ctl = { enabled: true }
  client.on('set_slot', (p) => {
    if (!ctl.enabled || p.windowId !== -1 || p.slot !== -1) return
    Item ??= createRequire(import.meta.url)('prismarine-item')(bot.registry) as typeof Item
    const it = Item!.fromNotch(p.item)
    const inv = bot.inventory as unknown as { selectedItem: unknown }
    inv.selectedItem = it
    const w = bot.currentWindow as unknown as { selectedItem: unknown } | null
    if (w) w.selectedItem = it
    onCursor?.(it?.name ?? null)
  })
  return ctl
}

/**
 * Drop the client's status effects on every `respawn` packet.
 *
 * The vanilla client builds a new player entity on respawn, so its effects start empty;
 * the server then re-sends the ones still active (after a dimension change) and none
 * after a death. Mineflayer keeps `bot.entity.effects` across respawns, so an effect the
 * server already removed with the dead player stays on the client forever. B gate
 * 20261002 r09 and part2-r01: Mining Fatigue from an elder guardian survived 2–3 deaths
 * (725 state samples), every client dig waited ~1000 s for the predicted break time, and
 * wood collection stalled 13 times on one log.
 */
export function installRespawnEffectsReset (bot: Bot, onReset?: (cleared: string[]) => void): void {
  const client = bot._client as unknown as { on (ev: string, fn: () => void): void }
  client.on('respawn', () => {
    const e = bot.entity as unknown as { effects?: Record<string, unknown> } | undefined
    if (!e?.effects) return
    const ids = Object.keys(e.effects)
    if (!ids.length) return
    e.effects = {}
    const names = ids.map(id => bot.registry.effects?.[Number(id)]?.name ?? id)
    onReset?.(names)
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
