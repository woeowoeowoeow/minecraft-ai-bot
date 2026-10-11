// The only file that imports mineflayer-pathfinder (architecture §10 swap point).
import type { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import * as pfNs from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { EventBus } from '../observer/events.js'
import { ownAir } from '../observer/vitals.js'
import type { NavDiag, NavFailClass, NavGoal, NavProfile, NavResult, V3 } from '../schema/index.js'
import { liveView, WATER_LIKE } from './blocks.js'
import { cardinalToYaw, digReleasesLiquid, isProtected, needsAir, unstickDirections } from './hazards.js'
import { installCollisionEpsilon } from './physics-epsilon.js'
import { excavationDistance, Excavator, type ExcavationTarget } from './excavate.js'
import { installFallGuard } from './fall-guard.js'
import { goalDistance } from './goal-distance.js'
import { equipFor } from './tools.js'
import { excavationBudgetMs, navTimeoutMs, type GotoOptions, type Navigator } from './navigator.js'
import { DEFAULT_STUCK, planWaypoints, StuckDetector, type StuckOptions } from './stuck.js'
import { undergroundTarget } from './underground.js'
import { dryStart, findWaterExits, longestWaterRun, routeToAir } from './water.js'

type PF = typeof import('mineflayer-pathfinder')
const pf: PF = ((pfNs as unknown as { default?: PF }).default ?? pfNs) as PF
const { goals, Movements } = pf
type PfGoal = InstanceType<typeof goals.Goal>
type PfMovements = InstanceType<typeof Movements>
// Pathfinder's search-node class (not exported from the package index).
const Move = createRequire(import.meta.url)('mineflayer-pathfinder/lib/move.js') as new (x: number, y: number, z: number, remainingBlocks: number, cost: number, toBreak?: unknown[], toPlace?: unknown[]) => Node
type Node = { x: number; y: number; z: number; remainingBlocks: number }
type PBlock = { position: Vec3; liquid: boolean; physical: boolean; safe: boolean; type: number; name: string }

const SAMPLE_MS = 250
const IDLE_REPLAN_MS = 1500
const MAX_REPLANS_WITHOUT_PROGRESS = 6
const MAX_EMPTY_NOPATH = 3
const MAX_UNSTICK = 2

/** Air (0–20) at which navigation pauses to surface, even if the head just went under. */
const LOW_AIR = 14
/** Surface proactively when the head has been under water this long. */
const MAX_SUBMERGED_MS = 2500
const SURFACE_MAX_MS = 7000
const AIR_REFLEX = { maxSubmergedMs: MAX_SUBMERGED_MS, lowAir: LOW_AIR }
const MAX_SURFACINGS = 4
/** Water trap escape: exits searched this far along the surface after none within 12. */
const ESCAPE_RADIUS = 40
/** Ice ceilings dug through from below rather than swum under for longer than ICE_ROUTE_MAX cells. */
const ICE_CEILING = new Set(['ice', 'packed_ice', 'frosted_ice', 'snow_block'])
const ICE_ROUTE_MAX = 4
/** How far above the eyes an ice ceiling is looked for, and from how far it is dug. */
const ICE_SCAN_UP = 6
const ICE_DIG_REACH = 3.5
/** In water without progress this long → try a shoreline exit. */
const WATER_STALL_MS = 8000
const MAX_EXIT_ATTEMPTS = 3
/** A planned swim longer than this triggers one replan that strongly prefers dry land. */
const LONG_SWIM_NODES = 40

/** ≥ this many server position corrections within the window = the bot is wedged. */
const CORRECTION_LOOP_N = 8
const CORRECTION_WINDOW_MS = 1500
const MAX_CORRECTION_LOOPS = 4

const LIQUID_COST = 4
const DRY_LIQUID_COST = 14

export function loadPathfinder (bot: Bot): void {
  installCollisionEpsilon()
  bot.loadPlugin(pf.pathfinder)
}

/**
 * Water-correct movement model on top of pathfinder's Movements:
 * - kelp, seagrass and bubble columns are water (not walkable air);
 * - no search node may have its head under water: swimming happens at the surface;
 * - entering water lands on its surface cell (upstream lands one block under it);
 * - from a surface cell the bot can climb onto a flush shore (upstream's jump-up
 *   rejects every exit from deep water); physics cannot climb a 1-block ledge from
 *   water, and pathfinder only digs on ground, so ledges are left to `exitWater`;
 * - from a submerged cell the only move is up;
 * - no straight-down digging (upstream `getMoveDown` digs the block underfoot).
 */
function waterSafe (bot: Bot, m: PfMovements): void {
  const mm = m as unknown as {
    liquids: Set<number>; blocksToAvoid: Set<number>; liquidCost: number
    getBlock (n: unknown, dx: number, dy: number, dz: number): PBlock
    getLandingBlock (n: Node, dir: { x: number; z: number }): PBlock | null
    getNeighbors (n: Node): Node[]
    getMoveDown (n: Node, out: Node[]): void
  }
  const reg = bot.registry
  for (const n of WATER_LIKE) { const b = reg.blocksByName[n]; if (b) mm.liquids.add(b.id) }
  if (reg.blocksByName.bubble_column) mm.blocksToAvoid.add(reg.blocksByName.bubble_column.id)

  const baseLanding = mm.getLandingBlock.bind(mm)
  mm.getLandingBlock = (node, dir) => {
    const d = mm.getBlock(node, dir.x, -1, dir.z)
    if (d.liquid && d.safe) return d
    return baseLanding(node, dir)
  }

  const baseMoveDown = mm.getMoveDown.bind(mm)
  mm.getMoveDown = (node, out) => {
    if (mm.getBlock(node, 0, -1, 0).physical) return
    baseMoveDown(node, out)
  }

  const dirs = [{ x: -1, z: 0 }, { x: 1, z: 0 }, { x: 0, z: -1 }, { x: 0, z: 1 }]
  const baseNeighbors = mm.getNeighbors.bind(mm)
  mm.getNeighbors = (node) => {
    const here = mm.getBlock(node, 0, 0, 0)
    const above = mm.getBlock(node, 0, 1, 0)
    if (here.liquid && above.liquid) {
      // Submerged: surface first.
      return [new Move(node.x, node.y + 1, node.z, node.remainingBlocks, 1 + mm.liquidCost)]
    }
    let out = baseNeighbors(node).filter(n => !mm.getBlock(n, 0, 1, 0).liquid)
    if (here.liquid) {
      // Swimming: pathfinder digs and places only on ground, so a move that needs either never
      // happens, and a diagonal past a solid corner pins the bot against it (ckit-r2d r01: x/z frozen
      // 1 200 s at a packed-ice corner, every attempt "repeatedly out of air").
      out = out.filter(n => {
        const mv = n as unknown as { x: number; z: number; toBreak?: unknown[]; toPlace?: unknown[] }
        if ((mv.toBreak?.length ?? 0) > 0 || (mv.toPlace?.length ?? 0) > 0) return false
        const dx = mv.x - node.x
        const dz = mv.z - node.z
        if (dx === 0 || dz === 0) return true
        return [0, 1].every(dy => !mm.getBlock(node, dx, dy, 0).physical && !mm.getBlock(node, 0, dy, dz).physical)
      })
    }
    if (here.liquid && !above.liquid) {
      for (const dir of dirs) {
        const c = mm.getBlock(node, dir.x, 0, dir.z)
        if (!c.physical || mm.blocksToAvoid.has(c.type)) continue
        // Flush exits only: pathfinder digs only while on ground, so it cannot open a
        // ledge from deep water. Ledge exits are handled by the navigator (exitWater).
        const clear = [mm.getBlock(node, dir.x, 1, dir.z), mm.getBlock(node, 0, 2, 0), mm.getBlock(node, dir.x, 2, dir.z)].every(b => b.safe)
        if (clear) out.push(new Move(node.x + dir.x, node.y + 1, node.z + dir.z, node.remainingBlocks, 2 + mm.liquidCost))
      }
    }
    return out
  }
}

function movementsFor (bot: Bot, profile: NavProfile, dry: boolean, noDig = false, portal = false): PfMovements {
  const m = new Movements(bot)
  const items = bot.registry.itemsByName
  m.scafoldingBlocks = ['dirt', 'cobblestone', 'netherrack', 'stone']
    .map(n => items[n]?.id).filter((x): x is number => x !== undefined)
  // 'walk' goals (combat chases, death recovery) never dig: digging swaps the held tool.
  m.canDig = !noDig
  for (const b of bot.registry.blocksArray) if (isProtected(b.name)) m.blocksCantBreak.add(b.id)
  // Never through a portal on the way somewhere else (ckit-r2d r02: a sheep chase from beside the
  // portal walked into it and the bot hunted sheep in the Nether); only a goal in a portal cell.
  const portalId = bot.registry.blocksByName.nether_portal?.id
  if (!portal && portalId !== undefined) (m as unknown as { blocksToAvoid: Set<number> }).blocksToAvoid.add(portalId)
  m.allowSprinting = true
  m.maxDropDown = 4
  if (noDig) {
    // 'walk' goals are chases and short moves near mobs: no gap jumps and no drop that hurts
    // (dev batches 7 and 9: two chases ended 14–24 blocks down a ravine).
    m.allowParkour = false
    m.maxDropDown = 3
    // Nor do they build: a fish chase bridged the sea surface with scaffolding and capped the
    // bot under its own block (dev batch 12 r03: drowned under it, surfacing failed twice).
    m.scafoldingBlocks = []
  }
  const mm = m as unknown as { liquidCost: number }
  mm.liquidCost = dry ? DRY_LIQUID_COST : LIQUID_COST
  if (profile === 'nether') netherProfile(bot, m)
  else if (profile === 'nether_travel') netherTravelProfile(bot, m)
  else if (profile === 'overworld_cautious') {
    // Overworld work next to lava (portal sites and lava pools, milestone B): no parkour, drops of
    // at most 3, and the Nether's lava step costs. The plain overworld profile (milestone A) is unchanged.
    m.allowParkour = false
    m.maxDropDown = 3
    lavaCosts(bot, m)
  }
  else if (profile !== 'overworld') {
    // Cautious default until the end/stronghold profiles are built (milestones D–E).
    m.allowParkour = false
    m.maxDropDown = 3
    mm.liquidCost = dry ? DRY_LIQUID_COST : LIQUID_COST + 1
  }
  waterSafe(bot, m)
  return m
}

/** An unstick move brakes after this many blocks along its direction (one cell, never past it). */
export const UNSTICK_STEP = 0.6

/** Extra cost (per step) of standing in a cell with lava this close: the path keeps its distance. */
export const NETHER_LAVA_STEP_COST = { adjacent: 40, near2: 8 } as const

/**
 * Nether profile (architecture §10, milestone B): falls and lava kill, so no parkour,
 * drops of at most 2, no digging down (waterSafe), never digging a block that touches
 * lava (upstream `dontCreateFlow` covers liquids above and beside), magma and soul
 * fire avoided, and a heavy step cost next to lava. Soul sand only slows: allowed.
 * Scaffolding with netherrack or cobblestone bridges short gaps.
 */
function netherProfile (bot: Bot, m: PfMovements): void {
  const reg = bot.registry
  m.allowParkour = false
  m.maxDropDown = 2
  m.allowSprinting = false
  const mm = m as unknown as { blocksToAvoid: Set<number>; dontCreateFlow: boolean; exclusionAreasStep: ((b: PBlock) => number)[]; exclusionAreasBreak: ((b: PBlock) => number)[] }
  mm.dontCreateFlow = true
  for (const n of ['magma_block', 'soul_fire', 'fire', 'lava', 'wither_rose', 'campfire', 'soul_campfire']) { const b = reg.blocksByName[n]; if (b) mm.blocksToAvoid.add(b.id) }
  lavaCosts(bot, m)
  // No bridge block over lava or a deep drop: when a placement fails there the bot falls (C dev
  // batch 20261007-110334: B excursions in r01 and r02 and a mine search leg in r04 bridged over
  // 35–50-block drops or the lava sea and fell). Towers and short gap bridges stay allowed.
  const lavaId = reg.blocksByName.lava?.id
  const pm = m as unknown as { exclusionAreasPlace: ((b: PBlock) => number)[] }
  pm.exclusionAreasPlace.push(b => {
    const cell = (dy: number): BridgeCell => {
      const x = bot.blockAt(b.position.offset(0, -dy, 0), false)
      return !x ? 'unknown' : x.type === lavaId ? 'lava' : x.boundingBox === 'block' ? 'solid' : 'air'
    }
    return unsafeBridge(cell) ? NETHER_BRIDGE.forbidden : 0
  })
}

/** Bridge rule (pure): a block placed here needs solid ground within `depth` below it, with only air between. */
export const NETHER_BRIDGE = { depth: 4, forbidden: 1000 } as const
export type BridgeCell = 'solid' | 'lava' | 'air' | 'unknown'
export function unsafeBridge (below: (dy: number) => BridgeCell): boolean {
  for (let dy = 1; dy <= NETHER_BRIDGE.depth; dy++) {
    const c = below(dy)
    if (c === 'solid') return false
    if (c !== 'air') return true // lava, or unloaded
  }
  return true
}

/**
 * Long Nether travel (milestone C: fortress search, piglin search, the way back). The `nether`
 * rules, but no scaffolding (no bridges, no towers) and lava up to 4 blocks below a step counts as
 * near: with the `nether` costs a tower-and-bridge over a lava lake beat walking a causeway beside
 * it and ran out of blocks mid-lake (C fixture), and a bridge over the lava-sea cavern fell 60
 * blocks when a placement failed (ckit1 r01).
 */
export const NETHER_TRAVEL = { placeCost: 20, below: 4 } as const

function netherTravelProfile (bot: Bot, m: PfMovements): void {
  netherProfile(bot, m)
  m.placeCost = NETHER_TRAVEL.placeCost
  // No bridging or towering at all: a failed placement at the edge of the lava-sea cavern drops
  // the bot 60 blocks into lava (ckit1 r01). Gaps are left to the tunnel fallback.
  m.scafoldingBlocks = []
  const mm = m as unknown as { exclusionAreasStep: ((b: PBlock) => number)[] }
  mm.exclusionAreasStep.length = 0
  lavaCosts(bot, m, NETHER_TRAVEL.below, false)
  // blocksToAvoid keeps magma out of the body cells only; a magma floor burns too.
  const magma = bot.registry.blocksByName.magma_block?.id
  if (magma !== undefined) mm.exclusionAreasStep.push(b => bot.blockAt(b.position.offset(0, -1, 0), false)?.type === magma ? 200 : 0)
}

/** Step cost next to lava and no breaking beside it (nether and overworld_cautious profiles). */
function lavaCosts (bot: Bot, m: PfMovements, below = 2, breakRule = true): void {
  const mm = m as unknown as { exclusionAreasStep: ((b: PBlock) => number)[]; exclusionAreasBreak: ((b: PBlock) => number)[] }
  const lavaId = bot.registry.blocksByName.lava!.id
  // Lava distance per cell, cached for a few seconds (path searches visit thousands of nodes).
  let cache = new Map<string, number>()
  let cacheAt = Date.now()
  const lavaDist = (p: Vec3): number => {
    if (Date.now() - cacheAt > 3000 || cache.size > 50_000) { cache = new Map(); cacheAt = Date.now() }
    const k = `${p.x},${p.y},${p.z}`
    const hit = cache.get(k)
    if (hit !== undefined) return hit
    let d = 3
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -below; dy <= 1; dy++) {
      const r = Math.max(Math.abs(dx), Math.abs(dz))
      if (r < d && bot.blockAt(p.offset(dx, dy, dz), false)?.type === lavaId) d = r
    }
    cache.set(k, d)
    return d
  }
  const lavaWithin = (p: Vec3, r: number) => lavaDist(p) <= r
  mm.exclusionAreasStep.push(b => lavaWithin(b.position, 1) ? NETHER_LAVA_STEP_COST.adjacent : lavaWithin(b.position, 2) ? NETHER_LAVA_STEP_COST.near2 : 0)
  // Never break a block with lava anywhere around it (a flow into the tunnel is fatal here).
  if (breakRule) mm.exclusionAreasBreak.push(b => lavaWithin(b.position, 1) ? 1000 : 0)
}

/** A dry excavation start the bot failed to reach is skipped for this long (dev batch 6 r01: 16 tries of one cell). */
const BAD_DRY_START_MS = 5 * 60_000

export class PathfinderNavigator implements Navigator {
  private history: NavResult[] = []
  private badDryStarts = new Map<string, number>()
  private movements = new Map<string, PfMovements>()
  private active: { abort: () => void } | null = null
  /** Timestamps of recent server position corrections (forcedMove). */
  private corrections: number[] = []
  private readonly excavator: Excavator

  constructor (private readonly bot: Bot, private readonly bus: EventBus, private readonly stuckOpts: StuckOptions = DEFAULT_STUCK) {
    this.excavator = new Excavator(bot, bus)
    installFallGuard(bot, bus)
    bot.on('forcedMove', () => {
      this.corrections.push(Date.now())
      if (this.corrections.length > 64) this.corrections.shift()
    })
  }

  /**
   * Server keeps teleporting the bot back: the client's box sits a hair inside a
   * block (e.g. after a jump up a 1-wide stair), every move is rejected and
   * pathfinder never notices. Seen in M0 as ~20 corrections/s for minutes.
   */
  private correctionLoop (now: number): boolean {
    return this.corrections.filter(t => now - t <= CORRECTION_WINDOW_MS).length >= CORRECTION_LOOP_N
  }

  /** Walk to the centre of the current cell (away from whatever the box is clipping). */
  private async recentre (): Promise<void> {
    const bot = this.bot
    this.halt()
    const c = bot.entity.position.floored()
    const end = Date.now() + 1500
    while (Date.now() < end) {
      const p = bot.entity.position
      const dx = c.x + 0.5 - p.x
      const dz = c.z + 0.5 - p.z
      if (Math.hypot(dx, dz) < 0.12) break
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('sneak', true)
      await sleep(50)
    }
    bot.clearControlStates()
    this.corrections = []
    await sleep(250)
  }

  recent (): NavResult[] { return this.history.slice(-10) }

  budgetMs (goal: NavGoal): number {
    const p = this.pos()
    const under = undergroundTarget(liveView(this.bot), goal, p)
    if (under) return excavationBudgetMs(excavationDistance([Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])], under))
    const d = goalDistance(goal, p)
    return navTimeoutMs(Number.isFinite(d) ? Math.min(2000, d) : 64)
  }

  stop (): void {
    this.active?.abort()
    this.halt()
  }

  private halt (): void {
    try { this.bot.pathfinder.setGoal(null) } catch { /* ignore */ }
    this.bot.clearControlStates()
  }

  private pos (): V3 {
    const p = this.bot.entity.position
    return [p.x, p.y, p.z]
  }

  private noDig = false
  /** The goal is a portal cell (usePortal's step in): the only paths allowed through portal blocks. */
  private portalGoal = false

  private setMovements (profile: NavProfile, dry: boolean): void {
    const k = `${profile}:${dry ? 'dry' : 'std'}:${this.noDig ? 'nodig' : 'dig'}:${this.portalGoal ? 'portal' : ''}`
    let m = this.movements.get(k)
    if (!m) { m = movementsFor(this.bot, profile, dry, this.noDig, this.portalGoal); this.movements.set(k, m) }
    this.bot.pathfinder.setMovements(m)
  }

  private toPfGoal (goal: NavGoal): PfGoal {
    const t = goal.target
    const v = Array.isArray(t) ? t : null
    switch (goal.kind) {
      case 'block': return new goals.GoalBlock(v![0], v![1], v![2])
      case 'near': return new goals.GoalNear(v![0], v![1], v![2], goal.range ?? 1)
      case 'xz': return new goals.GoalNearXZ(v![0], v![2], goal.range ?? 2)
      case 'y': return new goals.GoalY(t as number)
      case 'reach': return new goals.GoalLookAtBlock(new Vec3(v![0], v![1], v![2]) as never, this.bot.world, { reach: goal.range ?? 4.5 })
      case 'away': return new goals.GoalInvert(new goals.GoalNear(v![0], v![1], v![2], goal.range ?? 16))
      case 'entity': {
        const e = this.bot.entities[t as number]
        if (!e) throw new Error(`entity ${String(t)} not tracked`)
        return new goals.GoalFollow(e, goal.range ?? 2)
      }
    }
  }

  async goto (goal: NavGoal, o: GotoOptions): Promise<NavResult> {
    // Always yield one macrotask: a goal that is already met resolves at once, and a
    // caller looping on it must never starve the socket (dev batch 1: keepAlive kick).
    await new Promise(r => setImmediate(r))
    if (this.active) this.stop()
    this.noDig = goal.mode === 'walk'
    this.portalGoal = goal.kind === 'block' && Array.isArray(goal.target) && this.bot.blockAt(new Vec3(goal.target[0]!, goal.target[1]!, goal.target[2]!), false)?.name === 'nether_portal'
    const t0 = Date.now()
    const startPos = this.pos()
    const entityPos = (): V3 | undefined => {
      if (goal.kind !== 'entity') return undefined
      const e = this.bot.entities[goal.target as number]
      return e ? [e.position.x, e.position.y, e.position.z] : undefined
    }
    const diag: NavDiag = {
      goal, profile: o.profile, startPos: startPos.map(r1) as V3, lastPos: startPos.map(r1) as V3,
      startDist: r1(goalDistance(goal, startPos, entityPos())), endDist: 0,
      legs: 0, replans: 0, partial: false, pathStatuses: {}, resets: {},
      stuckEvents: 0, unstickAttempts: 0, blocksTravelled: 0, lastPath: [],
      strategy: 'pathfinder',
      water: { msInWater: 0, exitAttempts: 0, exits: 0, dryReplans: 0, longestSwim: 0 },
    }
    this.bus.emit('nav_start', { goal, profile: o.profile, startDist: diag.startDist }, 'debug')

    let result: NavResult | null = null
    try {
      const under = undergroundTarget(liveView(this.bot), goal, startPos)
      if (under) {
        diag.strategy = 'excavate'
        result = await this.runExcavation(goal, under, diag, o, t0)
      } else {
        const legs: NavGoal[] = []
        if (Array.isArray(goal.target) && goal.kind !== 'away') {
          for (const [x, z] of planWaypoints(startPos, goal.target)) legs.push({ kind: 'xz', target: [x, 0, z], range: 6 })
        }
        legs.push(goal)
        for (const leg of legs) {
          diag.legs++
          const deadline = t0 + o.timeoutMs
          const fail = await this.runLeg(leg, goal, diag, deadline, o, entityPos)
          if (fail) {
            result = { ok: false, class: fail, ms: Date.now() - t0, detail: diag }
            break
          }
        }
        if (!result) {
          const d = goalDistance(goal, this.pos(), entityPos())
          result = { ok: true, dist: r1(d), ms: Date.now() - t0, detail: diag }
        }
      }
    } catch (err) {
      diag.reason = `exception: ${(err as Error).message}`
      result = { ok: false, class: 'NAV_UNREACHABLE', ms: Date.now() - t0, detail: diag }
    } finally {
      this.halt()
      this.active = null
    }
    diag.lastPos = this.pos().map(r1) as V3
    diag.endDist = r1(goalDistance(goal, this.pos(), entityPos()))
    diag.blocksTravelled = r1(diag.blocksTravelled)
    if (diag.water) diag.water.msInWater = Math.round(diag.water.msInWater)
    this.history.push(result)
    if (this.history.length > 20) this.history.shift()
    this.bus.emit('nav_end', {
      ok: result.ok, class: result.ok ? null : result.class, ms: result.ms, goal, profile: o.profile,
      startDist: diag.startDist, endDist: diag.endDist, legs: diag.legs, replans: diag.replans,
      stuckEvents: diag.stuckEvents, unstickAttempts: diag.unstickAttempts, blocksTravelled: diag.blocksTravelled,
      partial: diag.partial, pathStatuses: diag.pathStatuses, resets: diag.resets, reason: diag.reason ?? null,
      strategy: diag.strategy, dryStart: diag.dryStart ?? null, water: diag.water, excavation: diag.excavation ?? null, surfacings: diag.surfacings ?? 0,
    }, result.ok ? 'debug' : 'warn')
    return result
  }

  /** Deterministic controlled excavation (staircase / verified dig-down / tunnel) to an underground target. */
  private async runExcavation (goal: NavGoal, t: ExcavationTarget, diag: NavDiag, o: GotoOptions, t0: number): Promise<NavResult> {
    let aborted = false
    this.active = { abort: () => { aborted = true } }
    this.halt()
    // Never start digging from water or its edge: walk to a dry cell first, or fail
    // with a structured hazard when none is within reach (open water).
    const p = this.pos()
    const now = Date.now()
    for (const [k, until] of this.badDryStarts) if (until <= now) this.badDryStarts.delete(k)
    const ds = dryStart(liveView(this.bot), p, 12, c => this.badDryStarts.has(c.join(',')))
    diag.dryStart = ds.kind
    if (ds.kind === 'none') {
      this.bus.emit('water_event', { kind: 'excavation_no_dry_start', pos: p.map(Math.round), radius: ds.radius }, 'warn')
      diag.reason = `no dry excavation start within ${ds.radius} blocks`
      return { ok: false, class: 'NAV_HAZARD', ms: Date.now() - t0, detail: diag }
    }
    if (ds.kind === 'found') {
      const start = ds.pos
      this.bus.emit('water_event', { kind: 'excavation_relocate', from: p.map(Math.round), to: start }, 'info')
      this.setMovements(o.profile, false)
      const g = new goals.GoalBlock(start[0], start[1], start[2])
      this.bot.pathfinder.setGoal(g)
      const end = Math.min(Date.now() + 30_000, t0 + o.timeoutMs)
      while (Date.now() < end && !aborted && !o.signal.aborted && !g.isEnd(this.bot.entity.position.floored() as never)) await sleep(SAMPLE_MS)
      this.halt()
      if (!g.isEnd(this.bot.entity.position.floored() as never)) {
        if (!aborted && !o.signal.aborted) this.badDryStarts.set(start.join(','), Date.now() + BAD_DRY_START_MS)
        diag.reason = 'could not reach a dry excavation start'
        return { ok: false, class: aborted || o.signal.aborted ? 'CANCELLED' : 'NAV_HAZARD', ms: Date.now() - t0, detail: diag }
      }
    }
    const range = Math.max(goal.kind === 'y' ? 0 : 0.9, goal.range ?? 0)
    const done = (feet: V3) => goal.kind === 'y' ? feet[1] === t.y : goalDistance(goal, this.pos()) <= range
    let prev = this.pos()
    const r = await this.excavator.run(t, done, {
      signal: o.signal, deadline: t0 + o.timeoutMs,
      isAborted: () => aborted || o.signal.aborted,
      onProgress: () => {
        const p = this.pos()
        diag.blocksTravelled += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2])
        prev = p
        o.onProgress?.(goalDistance(goal, p))
      },
    })
    diag.legs = 1
    diag.excavation = { steps: r.steps, dug: r.dug, falls: r.falls, byKind: r.byKind, entry: r.entry, lastBlocked: r.lastBlocked, refills: r.refills, unperched: r.unperched }
    diag.lastPath = r.path.slice(-24)
    if (r.ok) return { ok: true, dist: r1(goalDistance(goal, this.pos())), ms: Date.now() - t0, detail: diag }
    diag.reason = r.reason
    if (r.missing) diag.missing = r.missing
    return { ok: false, class: r.cls ?? 'NAV_UNREACHABLE', ms: Date.now() - t0, detail: diag }
  }

  private feetInWater (): boolean {
    return Boolean((this.bot.entity as { isInWater?: boolean }).isInWater)
  }

  /**
   * Out of the water: on the ground with no water in the feet cell. `isInWater` alone reads false
   * while the bot bobs at the surface (prismarine-physics shrinks the hitbox by 0.4 at each end):
   * escapeWater returned "dry" from a 1 × 1 hole it had just dug through an ice sheet.
   */
  private standingDry (): boolean {
    const b = this.bot.blockAt(this.bot.entity.position.offset(0, 0.1, 0), false)
    const wet = !!b && (WATER_LIKE.has(b.name) || (b as unknown as { getProperties (): Record<string, unknown> }).getProperties?.().waterlogged === true)
    return this.bot.entity.onGround && !this.feetInWater() && !wet
  }

  private headInWater (): boolean {
    const b = this.bot.blockAt(this.bot.entity.position.offset(0, 1.62, 0), false)
    return !!b && (WATER_LIKE.has(b.name) || (b as unknown as { getProperties (): Record<string, unknown> }).getProperties?.().waterlogged === true)
  }

  /** Returns null on success, or the failure class. */
  private async runLeg (leg: NavGoal, finalGoal: NavGoal, diag: NavDiag, deadline: number, o: GotoOptions, entityPos: () => V3 | undefined): Promise<NavFailClass | null> {
    const bot = this.bot
    const pfGoal = this.toPfGoal(leg)
    // Entity goals end on the true distance: GoalFollow tests the floored cell, which reads
    // "arrived" while the entity is still out of melee reach, so callers would spin.
    const isEnd = leg.kind === 'entity'
      ? () => { const e = bot.entities[leg.target as number]; return !e || bot.entity.position.distanceTo(e.position) <= (leg.range ?? 2) }
      : () => pfGoal.isEnd(bot.entity.position.floored() as never)
    if (isEnd()) return null
    const water = diag.water!

    let dry = finalGoal.dry === true
    this.setMovements(o.profile, dry)
    const em = bot as unknown as EventEmitter
    let reached = false
    let emptyNoPath = 0
    let lastUpdate = Date.now()
    let aborted = false
    let wantDryReplan = false
    const isWater = (p: V3) => { const b = bot.blockAt(new Vec3(p[0], p[1], p[2]), false); return !!b && WATER_LIKE.has(b.name) }
    const onReached = (g: unknown) => { if (g === pfGoal) reached = true }
    const onUpdate = (r: { status: string; path: { x: number; y: number; z: number }[] }) => {
      lastUpdate = Date.now()
      diag.pathStatuses[r.status] = (diag.pathStatuses[r.status] ?? 0) + 1
      if (r.path.length) {
        const path = r.path.map(p => [p.x, p.y, p.z] as V3)
        diag.lastPath = path.slice(0, 24)
        const swim = longestWaterRun(path, isWater)
        water.longestSwim = Math.max(water.longestSwim, swim)
        if (swim > LONG_SWIM_NODES && !dry) wantDryReplan = true
      }
      if (r.status === 'noPath' || r.status === 'timeout') {
        if (r.path.length === 0) emptyNoPath++
        else diag.partial = true
      } else if (r.status === 'success') {
        emptyNoPath = 0
      }
    }
    const onReset = (reason: string) => { diag.resets[reason] = (diag.resets[reason] ?? 0) + 1 }
    em.on('goal_reached', onReached)
    em.on('path_update', onUpdate)
    em.on('path_reset', onReset)
    this.active = { abort: () => { aborted = true } }

    const stuck = new StuckDetector(this.stuckOpts)
    const legDist = () => goalDistance(leg, this.pos(), leg === finalGoal ? entityPos() : undefined)
    let best = legDist()
    stuck.reset(Date.now(), best)
    let replansSinceProgress = 0
    let idleSince: number | null = null
    let prev = this.pos()
    let lastSample = Date.now()
    let submergedSince: number | null = null
    let waterStallSince: number | null = null
    const setGoal = () => bot.pathfinder.setGoal(pfGoal, leg.kind === 'entity')

    try {
      setGoal()
      for (;;) {
        await sleep(SAMPLE_MS)
        const now = Date.now()
        const pos = this.pos()
        diag.blocksTravelled += Math.hypot(pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2])
        prev = pos
        const inWater = this.feetInWater()
        if (inWater) water.msInWater += now - lastSample
        lastSample = now

        if (reached || isEnd()) return null
        if (aborted || o.signal.aborted) { diag.reason = 'cancelled'; return 'CANCELLED' }
        if (now > deadline) { diag.reason = inWater ? 'nav timeout (in water)' : 'nav timeout'; return 'SKILL_TIMEOUT' }
        const feet = bot.blockAt(bot.entity.position, false)
        if (feet?.name === 'lava') { diag.reason = 'in lava'; return 'NAV_HAZARD' }

        // ── air: surface proactively, long before drowning ───────────────
        const headIn = this.headInWater()
        submergedSince = headIn ? (submergedSince ?? now) : null
        if (needsAir(headIn, headIn ? now - submergedSince! : 0, ownAir(bot), AIR_REFLEX)) {
          diag.surfacings = (diag.surfacings ?? 0) + 1
          if (diag.surfacings > MAX_SURFACINGS) { diag.reason = 'repeatedly out of air'; return 'NAV_HAZARD' }
          const ok = await this.surface()
          if (!ok) { diag.reason = 'cannot surface (no air above)'; return 'NAV_HAZARD' }
          submergedSince = null
          diag.replans++
          stuck.reset(Date.now(), legDist())
          setGoal()
          continue
        }

        const d = legDist()
        if (d < best - 0.5) {
          best = d
          replansSinceProgress = 0
          waterStallSince = null
          o.onProgress?.(goalDistance(finalGoal, pos, entityPos()))
        }

        // ── long swims: replan once with a strong dry-land preference ─────
        if (wantDryReplan && !dry) {
          dry = true
          wantDryReplan = false
          water.dryReplans++
          this.bus.emit('water_event', { kind: 'dry_replan', longestSwim: water.longestSwim, pos: pos.map(Math.round) }, 'info')
          this.setMovements(o.profile, true)
          diag.replans++
          setGoal()
          continue
        }

        // ── stuck in water: find and climb out at a real shoreline exit ───
        waterStallSince = inWater ? (waterStallSince ?? now) : null
        if (waterStallSince !== null && (now - waterStallSince >= WATER_STALL_MS || emptyNoPath > 0)) {
          if (water.exitAttempts >= MAX_EXIT_ATTEMPTS) { diag.reason = 'water exit failed repeatedly'; return 'NAV_HAZARD' }
          water.exitAttempts++
          const exited = await this.exitWater(o, () => aborted, diag)
          if (exited === 'no_air') { diag.reason = 'cannot surface during water exit'; return 'NAV_HAZARD' }
          if (exited === 'ok') water.exits++
          waterStallSince = null
          emptyNoPath = 0
          stuck.reset(Date.now(), legDist())
          best = legDist()
          diag.replans++
          setGoal()
          continue
        }

        if (emptyNoPath >= MAX_EMPTY_NOPATH) { diag.reason = inWater ? 'no path from water' : 'no path (search exhausted)'; return 'NAV_UNREACHABLE' }

        const busy = bot.pathfinder.isMining() || bot.pathfinder.isBuilding()
        const moving = bot.pathfinder.isMoving() || busy
        if (!moving) {
          idleSince ??= now
          if (now - idleSince >= IDLE_REPLAN_MS && now - lastUpdate >= IDLE_REPLAN_MS) {
            // Pathfinder finished a partial path (or never found one) without reaching the goal.
            if (replansSinceProgress >= MAX_REPLANS_WITHOUT_PROGRESS) { diag.reason = 'replans exhausted without progress'; return 'NAV_UNREACHABLE' }
            diag.replans++
            replansSinceProgress++
            idleSince = null
            setGoal()
          }
          continue
        }
        idleSince = null

        if (this.correctionLoop(now)) {
          diag.correctionLoops = (diag.correctionLoops ?? 0) + 1
          this.bus.emit('stuck_detected', { reason: 'correction_loop', pos: pos.map(Math.round), dist: r1(d), attempt: diag.correctionLoops, inWater }, 'warn')
          if (diag.correctionLoops > MAX_CORRECTION_LOOPS) { diag.reason = 'server position-correction loop'; return 'NAV_STUCK' }
          await this.recentre()
          diag.replans++
          stuck.reset(Date.now(), legDist())
          setGoal()
          continue
        }

        const why = stuck.sample(now, pos, d, busy)
        if (why) {
          diag.stuckEvents++
          this.bus.emit('stuck_detected', { reason: why, pos: pos.map(Math.round), dist: r1(d), attempt: diag.unstickAttempts + 1, digging: bot.pathfinder.isMining(), inWater }, 'warn')
          if (diag.unstickAttempts >= MAX_UNSTICK) { diag.reason = `stuck: ${why}${inWater ? ' (in water)' : ''}`; return 'NAV_STUCK' }
          diag.unstickAttempts++
          await this.unstick(diag.unstickAttempts)
          diag.replans++
          stuck.reset(Date.now(), legDist())
          best = legDist()
          setGoal()
        }
      }
    } finally {
      em.removeListener('goal_reached', onReached)
      em.removeListener('path_update', onUpdate)
      em.removeListener('path_reset', onReset)
      this.setMovements(o.profile, false)
    }
  }

  /**
   * Get the head out of the water and refill air. Swims straight up when open air
   * is above; under an overhang or ceiling, follows the shortest route through
   * connected water to open air; as a last resort digs the block overhead.
   * False if the head never clears the water.
   */
  async surface (): Promise<boolean> {
    const bot = this.bot
    const p0 = bot.entity.position
    this.bus.emit('interrupt_start', { reason: 'low_air', air: ownAir(bot), pos: [p0.x, p0.y, p0.z].map(Math.round) }, 'warn')
    this.halt()
    const t0 = Date.now()
    let cleared = false
    const route = routeToAir(liveView(bot), [p0.x, p0.y + 1.62, p0.z])
    // Under an ice sheet (frozen ocean or lake) with air beyond it: a long swim under the ice is the
    // danger. The sheet is the first non-water block up the column from the head (c-staging fixture:
    // the bot had sunk 1.4 blocks, the ice was 4.4 above the eyes and a feet-relative 2..4 window
    // missed it). It is dug once within reach; the bot swims up to it until then.
    let ceil: ReturnType<typeof bot.blockAt> = null
    for (let dy = 1; dy <= ICE_SCAN_UP && !ceil; dy++) {
      const b = bot.blockAt(p0.offset(0, 1.62 + dy, 0), false)
      if (!b) break
      if (b.name !== 'water') ceil = b
    }
    const ceilInReach = () => !!ceil && ceil.position.y + 0.5 - (bot.entity.position.y + 1.62) <= ICE_DIG_REACH
    const overCeil = ceil ? bot.blockAt(ceil.position.offset(0, 1, 0), false) : null
    const iceCeiling = !!ceil && ICE_CEILING.has(ceil.name) && !!overCeil && (overCeil.boundingBox === 'empty' || overCeil.name === 'water')
    const digFirst = iceCeiling && (!route || route.length > ICE_ROUTE_MAX)
    let wp = 0
    let dug = false
    const start = bot.entity.position.clone()
    while (Date.now() - t0 < SURFACE_MAX_MS + (dug && iceCeiling ? 6000 : 0)) {
      // A route that is not being followed (wedged under a block, dev batch 12 r03): dig the ceiling.
      if (!cleared && route && !dug && Date.now() - t0 > 2500 && bot.entity.position.distanceTo(start) < 0.5) {
        dug = true
        const above = bot.blockAt(bot.entity.position.offset(0, 2.2, 0), false)
        if (above && above.boundingBox === 'block' && above.diggable && !isProtected(above.name) && bot.digTime(above) < 2500 && !/sand|gravel/.test(above.name)) {
          await withTimeout(bot.dig(above, true), bot.digTime(above) + 3000).catch(() => {})
        }
      }
      // Re-assert every tick: a pathfinder dig aborted by halt() clears control states asynchronously.
      bot.setControlState('jump', true)
      if (!cleared && route && !digFirst && route.length > 1 && wp < route.length) {
        // Steer the head toward the next water cell on the route to open air.
        const c = route[wp]!
        const p = bot.entity.position
        const dx = c[0] + 0.5 - p.x
        const dz = c[2] + 0.5 - p.z
        if (Math.hypot(dx, dz) < 0.35 && p.y + 1.62 >= c[1]) wp++
        else {
          await bot.look(Math.atan2(-dx, -dz), 0, true)
          bot.setControlState('forward', Math.hypot(dx, dz) >= 0.35)
        }
      } else if (!cleared && !dug && (digFirst || (!route && Date.now() - t0 > 1500)) && (!iceCeiling || ceilInReach()) &&
        (iceCeiling || bot.blockAt(bot.entity.position.offset(0, 2.2, 0), false)?.name !== 'water')) {
        // No water route to air (or, under an ice sheet, only a long one): dig the ceiling if it is
        // quick to break. Ice over water turns into water and opens the column to the air above.
        // Still rising through open water: the one dig waits for a block.
        dug = true
        const above = iceCeiling ? bot.blockAt(ceil!.position, false) : bot.blockAt(bot.entity.position.offset(0, 2.2, 0), false)
        const limit = iceCeiling ? 6000 : 2500
        // Under water and afloat a dig is 25× slower: the right tool matters (a pickaxe for ice).
        if (above && iceCeiling) await equipFor(bot, above).catch(() => null)
        if (above && above.boundingBox === 'block' && above.diggable && !isProtected(above.name) && bot.digTime(above) < limit && !/sand|gravel/.test(above.name)) {
          this.bus.emit('water_event', { kind: 'ceiling_dig', block: above.name, route: route ? route.length : null, air: ownAir(bot) }, 'info')
          await withTimeout(bot.dig(above, true), bot.digTime(above) + 3000).catch(() => {})
        }
      }
      await sleep(150)
      if (!this.headInWater()) { cleared = true; bot.setControlState('forward', false) }
      if (cleared && ownAir(bot) >= 19) break
    }
    bot.clearControlStates()
    this.bus.emit('interrupt_end', { reason: 'low_air', air: ownAir(bot), ms: Date.now() - t0, cleared, route: route ? route.length : null }, 'info')
    return cleared
  }

  /**
   * Water trap escape (after ckit-r2d r01, where every route to the portal ended "repeatedly out of
   * air" for 1 200 s): surface first (an ice ceiling is dug), then the shoreline exits within 12,
   * then within ESCAPE_RADIUS along the surface (notches cut into packed ice or snow included).
   * True once the bot stands out of the water.
   */
  async escapeWater (signal: AbortSignal): Promise<boolean> {
    if (this.standingDry()) return true
    if (this.headInWater() && !(await this.surface())) return false
    const diag = { surfacings: 0 } as unknown as NavDiag
    for (const radius of [12, ESCAPE_RADIUS]) {
      if (signal.aborted) return false
      const r = await this.exitWater({ signal }, () => signal.aborted, diag, radius)
      if (r === 'ok') return true
      if (r === 'no_air') return false
      diag.surfacings = 0
    }
    return this.standingDry()
  }

  /**
   * Climb out at the nearest real shoreline exit: flush exits first, then ledges.
   * Swims to the surface cell beside the exit (pathfinder, surface-only water model),
   * digs a ledge's lip while holding the surface, then jumps out with plain controls.
   * Air reflex: every wait in here checks the head and air supply and surfaces
   * before continuing; if the bot cannot surface the exit is abandoned ('no_air').
   */
  private async exitWater (o: Pick<GotoOptions, 'signal'>, isAborted: () => boolean, diag: NavDiag, radius = 12): Promise<'ok' | 'failed' | 'no_air'> {
    const bot = this.bot
    const p = bot.entity.position
    const exits = findWaterExits(liveView(bot), [p.x, p.y, p.z], radius)
    this.bus.emit('water_event', { kind: 'exit_attempt', pos: [p.x, p.y, p.z].map(Math.round), candidates: exits.length, best: exits[0] ?? null }, 'info')
    const stop = () => isAborted() || o.signal.aborted
    let submergedSince: number | null = null
    let noAir = false
    /** False when the bot needed air and could not surface: abandon the exit. */
    const breathe = async (): Promise<boolean> => {
      const now = Date.now()
      const headIn = this.headInWater()
      submergedSince = headIn ? (submergedSince ?? now) : null
      if (!needsAir(headIn, headIn ? now - submergedSince! : 0, ownAir(bot), AIR_REFLEX)) return true
      diag.surfacings = (diag.surfacings ?? 0) + 1
      this.bus.emit('water_event', { kind: 'exit_air_reflex', air: ownAir(bot), surfacings: diag.surfacings }, 'warn')
      this.halt()
      const ok = diag.surfacings <= MAX_SURFACINGS && await this.surface()
      submergedSince = null
      if (!ok) noAir = true
      return ok
    }
    for (const ex of exits.slice(0, 3)) {
      if (stop() || noAir) break
      const approach = new goals.GoalXZ(ex.from[0], ex.from[2])
      bot.pathfinder.setGoal(approach)
      const end = Date.now() + 12_000 + 600 * ex.dist
      while (Date.now() < end && !stop() && !approach.isEnd(bot.entity.position.floored() as never)) {
        await sleep(SAMPLE_MS)
        if (!(await breathe())) break
        if (!bot.pathfinder.goal) bot.pathfinder.setGoal(approach)
      }
      this.halt()
      if (noAir) break
      if (!approach.isEnd(bot.entity.position.floored() as never)) continue
      const [sx, sy, sz] = ex.stand
      const tx = sx + 0.5
      const tz = sz + 0.5
      const face = () => bot.look(Math.atan2(-(tx - bot.entity.position.x), -(tz - bot.entity.position.z)), 0, true)
      if (ex.kind === 'ledge' || ex.kind === 'notch') {
        // The lip, and for a notch the block above it too (the bot then stands in the notch).
        for (const dy of ex.kind === 'notch' ? [0, 1] : [0]) {
          for (let tries = 0; tries < 3; tries++) {
            if (!(await breathe())) break
            const b = bot.blockAt(new Vec3(sx, sy + dy, sz), false)
            if (!b || b.boundingBox === 'empty') break
            bot.setControlState('jump', true)
            await face()
            await equipFor(bot, b).catch(() => null)
            await withTimeout(bot.dig(b, true), bot.digTime(b) * 2 + 3000).catch(() => { try { bot.stopDigging() } catch { /* ignore */ } })
          }
          if (noAir) break
        }
        if (noAir) break
        const blocked = [0, ...(ex.kind === 'notch' ? [1] : [])].some(dy => (bot.blockAt(new Vec3(sx, sy + dy, sz), false)?.boundingBox ?? 'block') !== 'empty')
        if (blocked) { bot.clearControlStates(); continue }
      }
      const until = Date.now() + 3000
      while (Date.now() < until && !stop()) {
        if (!(await breathe())) break
        await face()
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleep(100)
        const f = bot.entity.position.floored()
        if (bot.entity.onGround && !this.feetInWater() && f.y >= sy) break
      }
      bot.clearControlStates()
      if (noAir) break
      if (bot.entity.onGround && !this.feetInWater()) {
        this.bus.emit('water_event', { kind: 'exit_ok', exit: ex.kind, stand: ex.stand }, 'info')
        return 'ok'
      }
    }
    this.bus.emit('water_event', { kind: noAir ? 'exit_no_air' : 'exit_failed', candidates: exits.length }, 'warn')
    return noAir ? 'no_air' : 'failed'
  }

  /**
   * Built-in unstick sequence (architecture §10): a jump-step, then a step back and a
   * dig at head height. Hazard-aware: a move is only taken in a direction whose
   * entered cells, jump cell and landing are free of lava, fire and deep drops
   * (`unstickDirections`); with no safe direction the bot only jumps in place. The
   * head-height dig never opens a block next to lava or water.
   */
  private async unstick (attempt: number): Promise<void> {
    const bot = this.bot
    this.halt()
    const p = bot.entity.position
    const feet: V3 = [Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z)]
    const view = liveView(bot)
    const dirs = unstickDirections(view, feet, bot.entity.yaw, attempt)
    this.bus.emit('stuck_detected', { reason: 'unstick_move', attempt, pos: feet, safeDirs: dirs.length, dir: dirs[0] ?? null }, 'debug')
    if (dirs.length) {
      await bot.look(cardinalToYaw(dirs[0]!), 0, true)
      bot.setControlState('forward', true)
    }
    bot.setControlState('jump', true)
    // One cell at most: `stepHazard` vouches for the next cell only, and 700 ms of forward + jump
    // carried the bot 3.5 blocks, off a ledge into lava 6.7 below (ckit-r2c r01, bastion approach).
    // Releasing forward is not enough (airborne momentum carries ~1 block): brake with a short back.
    const start = p.clone()
    const until = Date.now() + (attempt <= 1 ? 700 : 900)
    let braked = false
    while (Date.now() < until) {
      await sleep(50)
      const d = dirs[0]
      const q = bot.entity.position
      if (!braked && d && (q.x - start.x) * d[0] + (q.z - start.z) * d[1] >= UNSTICK_STEP) {
        braked = true
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
        bot.setControlState('back', true)
        await sleep(150)
        bot.setControlState('back', false)
      }
    }
    bot.clearControlStates()
    if (attempt > 1 && dirs.length) {
      const d = dirs[0]!
      const q = bot.entity.position
      const head: V3 = [Math.floor(q.x) + d[0], Math.floor(q.y + 1e-3) + 1, Math.floor(q.z) + d[1]]
      const b = bot.blockAt(new Vec3(...head), false)
      if (b && b.boundingBox === 'block' && b.diggable && !/bedrock/.test(b.name) && !isProtected(b.name) && bot.canDigBlock(b) && !digReleasesLiquid(liveView(bot), head)) {
        await withTimeout(bot.dig(b, true), 6000).catch(() => {})
      }
    }
    bot.clearControlStates()
  }
}

function r1 (v: number): number { return Math.round(v * 10) / 10 }
function sleep (ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(v => { clearTimeout(h); resolve(v) }, e => { clearTimeout(h); reject(e) })
  })
}
