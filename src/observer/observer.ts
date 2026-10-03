import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { Dim, Objective, V3 } from '../schema/index.js'
import { buildDigest } from './digest.js'
import { EventBus } from './events.js'
import type { BodyCell, BodyState, EntityInfo, Hazard, Location, ToolInfo, WorldMemory, WorldState } from './types.js'
import { ARMOR_POINTS, ENTITY_KIND_GAPS, FISH, FOOD_ANIMALS, METADATA } from '../version.js'
import { ownAir } from './vitals.js'

/**
 * Base interest set (architecture §8.1), 1.16.1 names; objectives can add more via
 * `addInterest`. Positions come from loaded chunk data, as the architecture's
 * interest index specifies.
 */
const BASE_INTEREST = ['lava', 'water', 'crafting_table', 'furnace', 'coal_ore', 'iron_ore', 'gravel', 'obsidian']
const INTEREST_RADIUS = 64
const PER_KIND = 16
/** A lava pool is usable for a later lava cast when it has this many connected source blocks. */
export const LAVA_POOL_MIN_SOURCES = 10
const NOT_COVER = /leaves|log|wood|mushroom_block|vine|bamboo/
/** Food-animal sightings within this distance of a remembered spot refresh it. */
const ANIMAL_CLUSTER = 24
const MAX_ANIMAL_SPOTS = 12

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
    transitions: [],
    excursions: [],
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
  private fallStartY: number | null = null
  private seenAt = new Map<number, number>()
  private lastDist = new Map<number, { d: number; t: number; closing: number }>()
  /** Last position in the dimension being left (captured at the respawn packet, before the teleport). */
  private departure: V3 | null = null
  private diedSinceTransition = false

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
      this.diedSinceTransition = true
      this.counters.deaths++
      const pos = toV3(bot.entity.position)
      const lost = { ...this.lastInv }
      // The death message usually arrives just before Mineflayer's death event (dev batch 7 r01:
      // a null cause hid a lava death, and item recovery walked back into the lava lake).
      const recent = this.lastDeathMessage !== null && bus.now() - this.lastDeathMessageAt < 3 ? this.lastDeathMessage : null
      this.memory.deaths.push({ pos, dim: this.dim(), t: bus.now(), lost, cause: recent })
      bus.emit('death', { pos: pos.map(Math.round), dim: this.dim(), message: this.lastDeathMessage, lost }, 'error')
    })
    bot.on('move', () => {
      const e = bot.entity
      const inLiquid = Boolean((e as Entity & { isInWater?: boolean; isInLava?: boolean }).isInWater || (e as { isInLava?: boolean }).isInLava)
      if (e.onGround || inLiquid || this.fallStartY === null || e.position.y > this.fallStartY) this.fallStartY = e.position.y
    })
    bot.on('entityGone', (e: Entity) => { this.seenAt.delete(e.id); this.lastDist.delete(e.id) })
    // The respawn packet arrives before the new position: the entity still stands where it left.
    bot.on('respawn', () => { if (bot.entity?.position) this.departure = toV3(bot.entity.position) })
    bot.on('spawn', () => {
      const dim = this.dim()
      if (this.lastDim && dim !== this.lastDim) this.onTransition(this.lastDim, dim)
      // A death respawn in the same dimension is no transition: forget the death, or the next
      // portal trip is recorded as a death respawn (dev2 r01: an A-phase death marked the first
      // Nether entry `death`, and return_ok needed a second round trip).
      else this.diedSinceTransition = false
      this.lastDim = dim
      this.lastHealth = bot.health
    })
    bot.on('forcedMove', () => {
      this.physicsCorrections++
      bus.emit('physics_correction', { pos: toV3(bot.entity.position).map(Math.round), n: this.physicsCorrections }, 'debug')
    })
    bot.on('messagestr', (msg: string, position: string) => {
      if (position === 'game_info') return
      if (msg.startsWith(bot.username + ' ')) {
        this.lastDeathMessage = msg
        this.lastDeathMessageAt = bus.now()
        const d = this.memory.deaths[this.memory.deaths.length - 1]
        if (d && d.cause === null && bus.now() - d.t < 3) d.cause = msg
      }
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
    this.timers.push(setInterval(() => { try { this.scanLavaPools() } catch { /* world not ready */ } }, 5000))
    bot.inventory.on('updateSlot', () => this.trackInventory())
  }

  private lastDeathMessage: string | null = null
  private lastDeathMessageAt = -Infinity

  /**
   * A dimension change (milestone B): record it with where the bot left and arrived and
   * whether a death caused it, drop per-dimension caches, and remember the portal the
   * bot arrived in once its blocks are loaded (client-visible state only).
   */
  private onTransition (from: Dim, to: Dim): void {
    const toPos = toV3(this.bot.entity.position).map(v => Math.round(v * 10) / 10) as V3
    const cause = this.diedSinceTransition ? 'death' : 'portal'
    const tr = { from, to, t: this.bus.now(), fromPos: (this.departure ?? toPos).map(v => Math.round(v * 10) / 10) as V3, toPos, cause } as const
    this.memory.transitions.push({ ...tr })
    this.diedSinceTransition = false
    this.departure = null
    this.interestCache = null
    this.seenAt.clear()
    this.lastDist.clear()
    this.fallStartY = null
    this.bus.emit('dimension_change', { ...tr })
    if (cause === 'portal') void this.rememberArrivalPortal(to, toPos)
  }

  /** Arrival portal: the nearest nether_portal block within 3 blocks, polled until its chunk is in. */
  private async rememberArrivalPortal (dim: Dim, at: V3): Promise<void> {
    const id = this.bot.registry.blocksByName.nether_portal?.id
    if (id === undefined) return
    for (let i = 0; i < 20; i++) {
      if (this.dim() !== dim) return
      const p = this.bot.findBlocks({ matching: id, maxDistance: 4, count: 12, point: new Vec3(...at) })
        .sort((a, b) => a.distanceTo(new Vec3(...at)) - b.distanceTo(new Vec3(...at)))[0]
      if (p) {
        const kind = dim === 'the_nether' ? 'portal_nether' : dim === 'overworld' ? 'portal_ow' : null
        if (kind) this.remember(kind, [p.x, p.y, p.z], 'observed', { lit: true, arrival: true })
        return
      }
      await new Promise(r => setTimeout(r, 500))
    }
    this.bus.emit('nether', { kind: 'arrival_portal_not_seen', dim, at }, 'warn')
  }

  stop (): void {
    for (const t of this.timers) clearInterval(t)
    this.flushItemDelta()
  }

  /** After a death (architecture §7.4): drop caches and per-entity tracking; memory (locations, explored, deaths) is kept. */
  afterDeath (): void {
    this.interestCache = null
    this.seenAt.clear()
    this.lastDist.clear()
    this.fallStartY = null
    this.control.skillStack.length = 0
    this.control.interrupt = null
    this.memory.blacklist = this.memory.blacklist.filter(b => !b.key.startsWith('mob:'))
  }

  addInterest (names: string[]): void {
    for (const n of names) this.interest.add(n)
    this.interestCache = null
  }

  dim (): Dim {
    const d = String(this.bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, '')
    return d === 'the_nether' || d === 'the_end' ? d : 'overworld'
  }

  /** Everything the bot has: main inventory, hotbar, worn armor and the off-hand. */
  inventory (): Record<string, number> {
    const inv: Record<string, number> = {}
    for (const it of this.bot.inventory.items()) inv[it.name] = (inv[it.name] ?? 0) + it.count
    for (const i of [5, 6, 7, 8, 45]) {
      const it = this.bot.inventory.slots[i]
      if (it) inv[it.name] = (inv[it.name] ?? 0) + it.count
    }
    return inv
  }

  count (pred: (name: string) => boolean): number {
    let n = 0
    for (const it of this.bot.inventory.items()) if (pred(it.name)) n += it.count
    return n
  }

  remember (kind: Location['kind'], pos: V3, source: Location['source'], detail?: Location['detail']): void {
    const dim = this.dim()
    const existing = this.memory.locations.find(l => l.kind === kind && l.dim === dim && Math.hypot(l.pos[0] - pos[0], l.pos[2] - pos[2]) < 8)
    if (existing) { existing.lastSeen = this.bus.now(); if (detail) existing.detail = { ...existing.detail, ...detail }; return }
    this.memory.locations.push({ kind, dim, pos, confidence: 1, source, lastSeen: this.bus.now(), detail })
    this.bus.emit('location_discovered', { kind, dim, pos: pos.map(Math.round), source, ...(detail ? { detail } : {}) })
  }

  /**
   * Food animals seen (adults): one remembered spot per 24-block cluster, with the last
   * sighting time, so a later hunt can go back instead of searching (architecture §8.1 memory).
   */
  private rememberAnimal (pos: V3, now: number): void {
    const dim = this.dim()
    const near = this.memory.locations.find(l => l.kind === 'animals' && l.dim === dim && Math.hypot(l.pos[0] - pos[0], l.pos[2] - pos[2]) < ANIMAL_CLUSTER)
    if (near) {
      near.lastSeen = now
      near.detail = { ...(near.detail ?? {}), seen: Number(near.detail?.seen ?? 0) + 1 }
      return
    }
    const spots = this.memory.locations.filter(l => l.kind === 'animals')
    if (spots.length >= MAX_ANIMAL_SPOTS) {
      const oldest = spots.sort((a, b) => a.lastSeen - b.lastSeen)[0]!
      this.memory.locations = this.memory.locations.filter(l => l !== oldest)
    }
    this.memory.locations.push({ kind: 'animals', dim, pos: pos.map(Math.floor) as V3, confidence: 1, source: 'observed', lastSeen: now, detail: { seen: 1 } })
  }

  forget (kind: Location['kind'], pos: V3, radius = 2): void {
    this.memory.locations = this.memory.locations.filter(l => !(l.kind === kind && Math.hypot(l.pos[0] - pos[0], l.pos[1] - pos[1], l.pos[2] - pos[2]) <= radius))
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
    // One search per kind, so plentiful kinds (water, stone ores) never crowd out rare ones.
    // Logs share one search (twelve block kinds, one resource).
    const blocks: Record<string, V3[]> = {}
    const groups = new Map<string, number[]>()
    for (const n of this.interest) {
      const b = this.bot.registry.blocksByName[n]
      if (!b) continue
      const g = n.endsWith('_log') ? '_logs' : n
      groups.set(g, [...(groups.get(g) ?? []), b.id])
    }
    for (const [g, ids] of groups) {
      const found = this.bot.findBlocks({ matching: ids, maxDistance: INTEREST_RADIUS, count: g === '_logs' ? 3 * PER_KIND : PER_KIND })
      for (const p of found) {
        const name = g === '_logs' ? this.bot.blockAt(p, false)?.name : g
        if (!name) continue
        const list = (blocks[name] ??= [])
        if (list.length < PER_KIND) list.push([p.x, p.y, p.z])
      }
    }
    this.interestCache = { at: this.bus.now(), pos, blocks }
    return blocks
  }

  /**
   * Remembers lava pools (connected lava with ≥ LAVA_POOL_MIN_SOURCES source blocks
   * and an open surface) found in loaded chunks: the lava half of nether_ready's
   * "water bucket plus a known lava pool". Bounded flood fill per candidate.
   */
  scanLavaPools (): void {
    if (this.dim() !== 'overworld') return
    const lava = this.interestBlocks().lava ?? []
    const known = this.memory.locations.filter(l => l.kind === 'lava_pool' && l.dim === 'overworld')
    for (const start of lava) {
      if (known.some(l => Math.hypot(l.pos[0] - start[0], l.pos[1] - start[1], l.pos[2] - start[2]) < 12)) continue
      const pool = floodLava(this.bot, start, 400)
      if (pool.sources >= LAVA_POOL_MIN_SOURCES && pool.open > 0) {
        this.remember('lava_pool', pool.anchor, 'observed', { sources: pool.sources, open: pool.open, y: pool.anchor[1] })
        return
      }
    }
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
    // Below the dimension's floor (1.16.1: y 0 in every dimension) there is only void.
    if (me.y < ((this.bot.game as { minY?: number } | undefined)?.minY ?? 0)) out.push({ kind: 'void', pos: toV3(me), dist: 0 })
    return out
  }

  private entities (): EntityInfo[] {
    const me = this.bot.entity.position
    const eye = me.offset(0, 1.62, 0)
    const now = this.bus.now()
    const out: EntityInfo[] = []
    for (const e of Object.values(this.bot.entities) as Entity[]) {
      if (e === this.bot.entity || !e.position) continue
      const d = e.position.distanceTo(me)
      if (d > 32) continue
      if (!this.seenAt.has(e.id)) this.seenAt.set(e.id, now)
      const kind = entityKind(e)
      const info: EntityInfo = { id: e.id, name: e.name ?? e.type, kind, pos: toV3(e.position).map(v => Math.round(v * 10) / 10) as V3, dist: Math.round(d * 10) / 10, ageS: Math.round((now - this.seenAt.get(e.id)!) * 10) / 10 }
      if (kind === 'item') {
        const it = safeCall(() => e.getDroppedItem())
        if (it) info.item = { name: it.name, count: it.count }
      } else if (kind === 'hostile' || kind === 'passive') {
        // Land animals only: a fish sighting is a point in open water, often far below the surface
        // (re-gate 20260930: hunts walked back to "animal spots" at y 41–57 and swam down to drowned).
        if (kind === 'passive' && FOOD_ANIMALS[info.name] && !FISH.has(info.name) && ((e as unknown as { metadata?: unknown[] }).metadata ?? [])[METADATA.ageableBaby] !== true) this.rememberAnimal(info.pos, now)
        if (d <= 24) info.los = lineOfSight(this.bot, eye, e.position.offset(0, (e.height ?? 1.6) * 0.85, 0))
        const md = (e as unknown as { metadata?: unknown[] }).metadata ?? []
        if (kind === 'passive' && md[METADATA.ageableBaby] === true) info.baby = true
        if (e.name === 'creeper' && md[METADATA.creeperSwell] === 1) info.swelling = true
        const held = (e as unknown as { heldItem?: { name?: string } | null }).heldItem
        if (held?.name) info.held = held.name
        const prev = this.lastDist.get(e.id)
        const t = Date.now()
        let closing = prev?.closing ?? 0
        if (prev && t - prev.t >= 200) { closing = Math.round(((prev.d - d) / ((t - prev.t) / 1000)) * 10) / 10; this.lastDist.set(e.id, { d, t, closing }) } else if (!prev) this.lastDist.set(e.id, { d, t, closing: 0 })
        info.closing = closing
      }
      out.push(info)
    }
    return out.sort((a, b) => a.dist - b.dist).slice(0, 24)
  }

  private cellAt (x: number, y: number, z: number): BodyCell {
    const b = this.bot.blockAt(new Vec3(x, y, z), false)
    if (!b) return 'unknown'
    if (b.name === 'lava') return 'lava'
    if (b.name === 'fire' || b.name === 'soul_fire') return 'fire'
    if (b.name === 'water' || b.name === 'bubble_column' || /kelp|seagrass/.test(b.name)) return 'water'
    const props = (b as unknown as { getProperties?: () => Record<string, unknown> }).getProperties?.() ?? {}
    if (props.waterlogged === true) return 'water'
    return b.boundingBox === 'block' ? 'solid' : 'air'
  }

  body (): BodyState {
    const e = this.bot.entity
    const p = e.position
    const fx = Math.floor(p.x); const fz = Math.floor(p.z)
    const feet = this.cellAt(fx, Math.floor(p.y + 0.05), fz)
    const head = this.cellAt(fx, Math.floor(p.y + 1.62), fz)
    const fb = this.bot.blockAt(new Vec3(fx, Math.floor(p.y + 0.05), fz), false) as unknown as { light?: number; skyLight?: number } | null
    let covered = false
    let n = 0
    for (let y = Math.floor(p.y) + 2; y <= Math.floor(p.y) + 40; y++) {
      const b = this.bot.blockAt(new Vec3(fx, y, fz), false)
      if (!b) break
      if (b.boundingBox === 'block' && !NOT_COVER.test(b.name) && ++n >= 2) { covered = true; break }
    }
    const solid = (x: number, y: number, z: number) => this.cellAt(x, y, z) === 'solid'
    const fy = Math.floor(p.y + 0.05)
    const enclosed = feet !== 'solid' && head !== 'solid' && solid(fx, fy + 2, fz) &&
      [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => solid(fx + dx!, fy, fz + dz!) && solid(fx + dx!, fy + 1, fz + dz!))
    return {
      feet, head, enclosed,
      velY: Math.round((e.velocity?.y ?? 0) * 100) / 100,
      fallDist: this.fallStartY === null ? 0 : Math.max(0, Math.round((this.fallStartY - p.y) * 10) / 10),
      light: fb && typeof fb.light === 'number' && typeof fb.skyLight === 'number' ? { block: fb.light, sky: fb.skyLight } : null,
      covered,
    }
  }

  tools (): ToolInfo[] {
    const out: ToolInfo[] = []
    for (const it of this.bot.inventory.slots) {
      if (!it) continue
      const max = (it as unknown as { maxDurability?: number }).maxDurability
      if (!max) continue
      const used = (it as unknown as { durabilityUsed?: number }).durabilityUsed ?? 0
      out.push({ name: it.name, slot: it.slot, remaining: Math.max(0, max - used), max })
    }
    return out
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
      body: this.body(),
      tools: this.tools(),
      armor: [5, 6, 7, 8].reduce((a, i) => a + (ARMOR_POINTS[bot.inventory.slots[i]?.name ?? ''] ?? 0), 0),
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

/**
 * Entity kind from minecraft-data's category (Mineflayer's `entity.kind`). In
 * 1.16.1 every mob has type `mob`, so the type does not separate hostile from
 * passive; mobs the data leaves uncategorised come from ENTITY_KIND_GAPS.
 */
export function entityKind (e: { type?: string; name?: string; kind?: string }): EntityInfo['kind'] {
  if (e.type === 'player') return 'player'
  if (e.name === 'item') return 'item'
  if (e.kind === 'Hostile mobs') return 'hostile'
  if (e.kind === 'Passive mobs') return 'passive'
  return (e.name && ENTITY_KIND_GAPS[e.name]) || 'other'
}

function round1 (v: number): number { return Math.round(v * 10) / 10 }

function safeCall<T> (fn: () => T): T | null {
  try { return fn() } catch { return null }
}

/** Sampled ray between two points; blocked by any block with a full collision box (as vanilla mob sight). */
export function lineOfSight (bot: Bot, from: Vec3, to: Vec3): boolean {
  const d = to.minus(from)
  const len = d.norm()
  const steps = Math.ceil(len / 0.3)
  let last = ''
  for (let i = 1; i < steps; i++) {
    const p = from.plus(d.scaled(i / steps)).floored()
    const k = `${p.x},${p.y},${p.z}`
    if (k === last) continue
    last = k
    const b = bot.blockAt(p, false)
    if (!b) return false
    if (b.boundingBox === 'block') return false
  }
  return true
}

/** Connected lava from `start` (6-neighbour flood fill, bounded): source count, open surface cells, and the source nearest the start. */
export function floodLava (bot: Bot, start: V3, max: number): { sources: number; open: number; anchor: V3 } {
  const key = (v: V3) => v.join(',')
  const seen = new Set<string>([key(start)])
  const queue: V3[] = [start]
  let sources = 0
  let open = 0
  let anchor = start
  for (let i = 0; i < queue.length && queue.length < max; i++) {
    const c = queue[i]!
    const b = bot.blockAt(new Vec3(...c), false)
    if (!b || b.name !== 'lava') continue
    if (b.metadata === 0) {
      if (sources === 0) anchor = c
      sources++
      const above = bot.blockAt(new Vec3(c[0], c[1] + 1, c[2]), false)
      if (above && above.name !== 'lava' && above.boundingBox === 'empty') open++
    }
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as const) {
      const n: V3 = [c[0] + dx, c[1] + dy, c[2] + dz]
      if (seen.has(key(n))) continue
      seen.add(key(n))
      const nb = bot.blockAt(new Vec3(...n), false)
      if (nb?.name === 'lava') queue.push(n)
    }
  }
  return { sources, open, anchor }
}

export { Vec3 }
