import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { Dim, Objective, V3 } from '../schema/index.js'
import { buildDigest } from './digest.js'
import { EventBus } from './events.js'
import type { EntityInfo, Hazard, Location, WorldMemory, WorldState } from './types.js'
import { ownAir } from './vitals.js'

/** Base interest set (architecture §8.1); objectives can add more via `addInterest`. */
const BASE_INTEREST = ['lava', 'crafting_table', 'coal_ore', 'iron_ore', 'deepslate_iron_ore']
const INTEREST_RADIUS = 64
const PER_KIND = 16

export function toV3 (v: { x: number; y: number; z: number }): V3 {
  return [v.x, v.y, v.z]
}

export function logBlockNames (bot: Bot): string[] {
  return bot.registry.blocksArray.filter(b => b.name.endsWith('_log')).map(b => b.name)
}

/**
 * Builds WorldState from Mineflayer, maintains WorldMemory and the interest
 * index, and translates Mineflayer events into bus events. Never acts.
 */
export class Observer {
  readonly memory: WorldMemory = {
    locations: [],
    explored: { overworld: new Set(), the_nether: new Set(), the_end: new Set() },
    blacklist: [],
    deaths: [],
  }

  readonly control: WorldState['control'] = { skillStack: [] }
  readonly milestones: Record<string, number | null> = {}
  readonly counters: WorldState['counters'] = { deaths: 0, reasonerCalls: 0, failuresBySignature: {}, currentFailure: null, failuresThisObjective: 0 }
  physicsCorrections = 0

  private interest = new Set<string>([...BASE_INTEREST])
  private interestCache: { at: number; pos: V3; blocks: Record<string, V3[]> } | null = null
  private lastInv: Record<string, number> = {}
  private pendingDelta: Record<string, number> = {}
  private lastHealth = 20
  private lastDim: Dim | null = null
  private timers: NodeJS.Timeout[] = []

  constructor (readonly bot: Bot, readonly bus: EventBus) {
    for (const n of logBlockNames(bot)) this.interest.add(n)
  }

  start (): void {
    const { bot, bus } = this
    this.lastHealth = bot.health
    this.lastInv = this.inventory()
    this.lastDim = this.dim()
    this.remember('spawn', toV3(bot.entity.position), 'observed')

    bot.on('health', () => {
      if (bot.health < this.lastHealth - 0.01) {
        bus.emit('damage', { from: round1(this.lastHealth), to: round1(bot.health), food: bot.food }, bot.health <= 8 ? 'warn' : 'info')
      }
      this.lastHealth = bot.health
    })
    bot.on('death', () => {
      this.counters.deaths++
      const pos = toV3(bot.entity.position)
      this.memory.deaths.push({ pos, dim: this.dim(), t: bus.now() })
      bus.emit('death', { pos: pos.map(Math.round), dim: this.dim(), message: this.lastDeathMessage }, 'error')
    })
    bot.on('spawn', () => {
      const dim = this.dim()
      if (this.lastDim && dim !== this.lastDim) bus.emit('dimension_change', { from: this.lastDim, to: dim })
      this.lastDim = dim
      this.lastHealth = bot.health
    })
    bot.on('forcedMove', () => {
      this.physicsCorrections++
      bus.emit('physics_correction', { pos: toV3(bot.entity.position).map(Math.round), n: this.physicsCorrections }, 'debug')
    })
    bot.on('messagestr', (msg: string, position: string) => {
      if (position === 'game_info') return
      if (msg.startsWith(bot.username + ' ')) this.lastDeathMessage = msg
      bus.emit('chat', { msg: msg.slice(0, 200), position }, 'debug')
    })
    bot.on('chunkColumnLoad', (p: { x: number; z: number }) => {
      this.memory.explored[this.dim()].add(`${p.x >> 4},${p.z >> 4}`)
      this.interestCache = null
    })
    bot.on('blockUpdate', (oldB, newB) => {
      if (!this.interestCache || !oldB || !newB) return
      if (this.interest.has(oldB.name) || this.interest.has(newB.name)) this.interestCache = null
    })
    // item_delta coalesced per 5 s (architecture §9)
    this.timers.push(setInterval(() => this.flushItemDelta(), 5000))
    bot.inventory.on('updateSlot', () => this.trackInventory())
  }

  private lastDeathMessage: string | null = null

  stop (): void {
    for (const t of this.timers) clearInterval(t)
    this.flushItemDelta()
  }

  addInterest (names: string[]): void {
    for (const n of names) this.interest.add(n)
    this.interestCache = null
  }

  dim (): Dim {
    const d = String(this.bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, '')
    return d === 'the_nether' || d === 'the_end' ? d : 'overworld'
  }

  inventory (): Record<string, number> {
    const inv: Record<string, number> = {}
    for (const it of this.bot.inventory.items()) inv[it.name] = (inv[it.name] ?? 0) + it.count
    return inv
  }

  count (pred: (name: string) => boolean): number {
    let n = 0
    for (const it of this.bot.inventory.items()) if (pred(it.name)) n += it.count
    return n
  }

  remember (kind: Location['kind'], pos: V3, source: Location['source']): void {
    const dim = this.dim()
    const existing = this.memory.locations.find(l => l.kind === kind && l.dim === dim && Math.hypot(l.pos[0] - pos[0], l.pos[2] - pos[2]) < 8)
    if (existing) { existing.lastSeen = this.bus.now(); return }
    this.memory.locations.push({ kind, dim, pos, confidence: 1, source, lastSeen: this.bus.now() })
    this.bus.emit('location_discovered', { kind, dim, pos: pos.map(Math.round), source })
  }

  isBlacklisted (key: string): boolean {
    const now = this.bus.now()
    this.memory.blacklist = this.memory.blacklist.filter(b => b.until > now)
    return this.memory.blacklist.some(b => b.key === key)
  }

  blacklist (key: string, reason: string, seconds = 600): void {
    this.memory.blacklist.push({ key, until: this.bus.now() + seconds, reason })
  }

  setObjective (o: Objective | undefined): void {
    this.control.objective = o
    this.control.objectiveStartedAt = this.bus.now()
    this.counters.failuresThisObjective = 0
    this.counters.currentFailure = null
  }

  /** Nearest ≤16 positions per interest kind within 64 blocks; cached until chunks/blocks change or 3 s / 8 blocks pass. */
  interestBlocks (force = false): Record<string, V3[]> {
    const pos = toV3(this.bot.entity.position)
    const c = this.interestCache
    if (!force && c && this.bus.now() - c.at < 3 && Math.hypot(c.pos[0] - pos[0], c.pos[1] - pos[1], c.pos[2] - pos[2]) < 8) return c.blocks
    const ids = new Set<number>()
    for (const n of this.interest) { const b = this.bot.registry.blocksByName[n]; if (b) ids.add(b.id) }
    const found = this.bot.findBlocks({ matching: [...ids], maxDistance: INTEREST_RADIUS, count: 512 })
    const blocks: Record<string, V3[]> = {}
    for (const p of found) {
      const b = this.bot.blockAt(p, false)
      if (!b) continue
      const list = (blocks[b.name] ??= [])
      if (list.length < PER_KIND) list.push([p.x, p.y, p.z])
    }
    this.interestCache = { at: this.bus.now(), pos, blocks }
    return blocks
  }

  private hazards (): Hazard[] {
    const out: Hazard[] = []
    const lavaId = this.bot.registry.blocksByName.lava?.id
    const fireId = this.bot.registry.blocksByName.fire?.id
    const ids = [lavaId, fireId].filter((x): x is number => x !== undefined)
    const me = this.bot.entity.position
    for (const p of this.bot.findBlocks({ matching: ids, maxDistance: 5, count: 5 })) {
      const b = this.bot.blockAt(p, false)
      out.push({ kind: b?.name === 'fire' ? 'fire' : 'lava', pos: [p.x, p.y, p.z], dist: p.distanceTo(me) })
    }
    if (me.y < (this.dim() === 'overworld' ? -64 : 0)) out.push({ kind: 'void', pos: toV3(me), dist: 0 })
    return out
  }

  private entities (): EntityInfo[] {
    const me = this.bot.entity.position
    const out: EntityInfo[] = []
    for (const e of Object.values(this.bot.entities) as Entity[]) {
      if (e === this.bot.entity || !e.position) continue
      const d = e.position.distanceTo(me)
      if (d > 32) continue
      out.push({ id: e.id, name: e.name ?? e.type, kind: entityKind(e), pos: toV3(e.position).map(v => Math.round(v * 10) / 10) as V3, dist: Math.round(d * 10) / 10 })
    }
    return out.sort((a, b) => a.dist - b.dist).slice(0, 24)
  }

  state (): WorldState {
    const bot = this.bot
    const e = bot.entity
    const slot = (i: number) => bot.inventory.slots[i]?.name ?? null
    const hotbar: (string | null)[] = []
    for (let i = 36; i < 45; i++) hotbar.push(slot(i))
    const feetBlock = bot.blockAt(e.position, false)
    const inLiquid = feetBlock?.name === 'lava' ? 'lava' : (e as Entity & { isInWater?: boolean }).isInWater || feetBlock?.name === 'water' ? 'water' : 'none'
    return {
      t: this.bus.now(),
      tick: Number(bot.time?.age ?? 0),
      dim: this.dim(),
      pos: toV3(e.position),
      yawPitch: [e.yaw, e.pitch],
      onGround: e.onGround,
      inLiquid,
      vitals: {
        health: bot.health,
        food: bot.food,
        saturation: bot.foodSaturation,
        air: ownAir(bot),
        effects: Object.values(e.effects ?? {}).map(ef => bot.registry.effects?.[(ef as { id: number }).id]?.name ?? String((ef as { id: number }).id)),
        onFire: Boolean((e as Entity & { onFire?: boolean }).onFire),
        timeOfDay: bot.time?.timeOfDay ?? 0,
        isRaining: bot.isRaining,
      },
      inventory: this.inventory(),
      hotbar,
      freeSlots: bot.inventory.emptySlotCount(),
      equipment: { head: slot(5), chest: slot(6), legs: slot(7), feet: slot(8), mainHand: bot.heldItem?.name ?? null, offHand: slot(45) },
      nearby: { entities: this.entities(), interestBlocks: this.interestBlocks(), hazards: this.hazards() },
      memory: this.memory,
      control: this.control,
      milestones: this.milestones,
      counters: this.counters,
    }
  }

  digest () {
    return buildDigest(this.state(), this.bus.tail())
  }

  private trackInventory (): void {
    const now = this.inventory()
    for (const k of new Set([...Object.keys(now), ...Object.keys(this.lastInv)])) {
      const d = (now[k] ?? 0) - (this.lastInv[k] ?? 0)
      if (d !== 0) this.pendingDelta[k] = (this.pendingDelta[k] ?? 0) + d
    }
    this.lastInv = now
  }

  private flushItemDelta (): void {
    const delta = Object.fromEntries(Object.entries(this.pendingDelta).filter(([, v]) => v !== 0))
    this.pendingDelta = {}
    if (Object.keys(delta).length) this.bus.emit('item_delta', { delta })
  }
}

function entityKind (e: Entity): EntityInfo['kind'] {
  const t = String(e.type)
  if (t === 'player') return 'player'
  if (t === 'hostile') return 'hostile'
  if (e.name === 'item') return 'item'
  if (t === 'passive' || t === 'animal' || t === 'water_creature' || t === 'ambient') return 'passive'
  return 'other'
}

function round1 (v: number): number { return Math.round(v * 10) / 10 }

export { Vec3 }
