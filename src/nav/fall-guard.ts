// Fall guard (milestone C, ckit-r2d). Two ways the bot left a ledge it was standing on safely:
// - r02 (twice, Nether, 35–50 blocks): upstream pathfinder's `fullStop` (on a dig, a placement or
//   a reached goal) re-centres the bot on the column under its x/z when it is > 0.2 off centre; on
//   a ledge edge, held up only by the neighbouring block, the centre was over open air;
// - r03 (three times, two at the same spot, 30–40 blocks): pathfinder's walk-jump counts a node
//   as reached mid-air, so a jump beside a ledge carried the bot 0.6 blocks sideways off it.
// The guard runs after the pathfinder each physics tick (listeners run in registration order,
// before the controls are simulated). It never moves the bot itself: it only releases the
// movement keys a careful player would not press, and vetoes the client-side re-centring.
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { EventBus } from '../observer/events.js'

type Controls = { forward: boolean; back: boolean; left: boolean; right: boolean; jump: boolean; sprint: boolean; sneak: boolean }
type SimState = { pos: Vec3; onGround: boolean; isInWater: boolean; isInLava: boolean; control: Controls }
const { PlayerState } = createRequire(import.meta.url)('prismarine-physics') as { PlayerState: new (bot: Bot, control: Controls) => SimState }

/**
 * `maxDrop`: a landing farther below than this is a fall (4 blocks: 1 HP; the pathfinder's own
 * drops are ≤ 4). `walkTicks`: the controls are simulated as held this long, then released (a
 * corner turn comes within 0.65 blocks; momentum is kept). `ticks`: look-ahead limit.
 */
export const FALL_GUARD = { maxDrop: 4, walkTicks: 3, ticks: 40 } as const

export type FallSim = { drop: number; landed: boolean; lava: boolean; water: boolean }

/** Pure rule: a simulated move the bot must not make. */
export function unsafeFall (r: FallSim): boolean {
  if (r.lava) return true
  if (r.water) return false
  return !r.landed || r.drop > FALL_GUARD.maxDrop
}

/** Simulate the held controls (then none) with the server's physics until the bot lands. */
export function simulateFall (bot: Bot): FallSim {
  const physics = (bot as unknown as { physics: { simulatePlayer (s: SimState, w: unknown): void } }).physics
  const world = { getBlock: (p: Vec3) => bot.blockAt(p, false) }
  // Read key by key: mineflayer's controlState does not spread (its keys are accessors), and an
  // undefined key makes the simulated x/z NaN, so the simulated bot falls through every floor.
  const c = (bot as unknown as { controlState: Controls }).controlState
  const st = new PlayerState(bot, { forward: !!c.forward, back: !!c.back, left: !!c.left, right: !!c.right, jump: !!c.jump, sprint: !!c.sprint, sneak: !!c.sneak })
  const y0 = st.pos.y
  let left = false
  for (let i = 0; i < FALL_GUARD.ticks; i++) {
    if (i === FALL_GUARD.walkTicks) Object.assign(st.control, { forward: false, back: false, left: false, right: false, jump: false, sprint: false })
    physics.simulatePlayer(st, world)
    const drop = y0 - st.pos.y
    if (st.isInLava) return { drop, landed: true, lava: true, water: false }
    if (st.isInWater) return { drop, landed: true, lava: false, water: true }
    if (drop > FALL_GUARD.maxDrop) return { drop, landed: false, lava: false, water: false }
    if (!st.onGround) left = true
    else if (left || i >= FALL_GUARD.walkTicks) return { drop, landed: true, lava: false, water: false }
  }
  return { drop: y0 - st.pos.y, landed: false, lava: false, water: false }
}

/** Pure rule: re-centring from `from` to `to` leaves the floor (`solid(x, y, z)`: a full block there). */
export function recentreUnsafe (solid: (x: number, y: number, z: number) => boolean, from: Vec3, to: Vec3): boolean {
  const fy = Math.floor(from.y - 0.01)
  const floorUnder = (p: Vec3) => {
    for (const x of new Set([Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)])) {
      for (const z of new Set([Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)])) if (solid(x, fy, z)) return true
    }
    return false
  }
  return floorUnder(from) && !floorUnder(to)
}

const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'] as const

export function installFallGuard (bot: Bot, bus: EventBus): void {
  // mineflayer injects its plugins (physics: clearControlStates, physicsTick; the pathfinder) on
  // `inject_allowed`, after createBot returns. The bot process builds the navigator before that
  // (ckit-r2e: every run died at start on `clearControlStates.bind`); the fixtures build it after
  // spawn. Install on the first spawn then, so the guard still runs after the pathfinder each tick.
  if (typeof (bot as Partial<Bot>).clearControlStates !== 'function') {
    bot.once('spawn', () => installFallGuard(bot, bus))
    return
  }
  let lastLog = 0
  const log = (kind: string, data: Record<string, unknown>) => {
    if (Date.now() - lastLog < 2000) return
    lastLog = Date.now()
    const p = bot.entity.position
    bus.emit('fall_guard', { kind, pos: [p.x, p.y, p.z].map(v => Math.round(v * 10) / 10), ...data }, 'warn')
  }
  const solid = (x: number, y: number, z: number) => bot.blockAt(new Vec3(x, y, z), false)?.boundingBox === 'block'

  // `fullStop` clears the controls first, then re-centres: remember where the bot stood.
  let before: Vec3 | null = null
  const checkRecentre = () => {
    const b = before
    before = null
    const p = bot.entity?.position
    if (!b || !p || (p.x === b.x && p.z === b.z)) return
    if (!recentreUnsafe(solid, b, p)) return
    p.x = b.x
    p.z = b.z
    log('recentre', { to: [b.x, b.z].map(v => Math.round(v * 100) / 100) })
  }
  const clear = bot.clearControlStates.bind(bot)
  bot.clearControlStates = () => {
    clear()
    if (bot.entity?.onGround) {
      before = bot.entity.position.clone()
      queueMicrotask(checkRecentre)
    }
  }

  bot.on('physicsTick', () => {
    checkRecentre()
    const e = bot.entity as unknown as { onGround: boolean; isInWater: boolean; isInLava: boolean } | undefined
    const c = (bot as unknown as { controlState: Controls }).controlState
    if (!e?.onGround || e.isInWater || e.isInLava) return
    if (!c.forward && !c.back && !c.left && !c.right && !c.jump) return
    const r = simulateFall(bot)
    if (!unsafeFall(r)) return
    const keys = MOVE_KEYS.filter(k => c[k]).join('')
    for (const k of MOVE_KEYS) bot.setControlState(k, false)
    log('controls', { keys, drop: Math.round(r.drop * 10) / 10, landed: r.landed, lava: r.lava })
  })
}
