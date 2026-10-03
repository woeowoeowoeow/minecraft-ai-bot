import type { Dim, Objective, V3 } from '../schema/index.js'

export type EntityInfo = {
  id: number; name: string; kind: 'hostile' | 'passive' | 'player' | 'item' | 'other'; pos: V3; dist: number
  /** Clear line of sight from the bot's eyes (computed for mobs within 24 blocks). */
  los?: boolean
  /** Ageable baby (drops nothing). */
  baby?: boolean
  /** Creeper swelling (about to explode). */
  swelling?: boolean
  /** Item held in the main hand (e.g. a drowned's trident). */
  held?: string | null
  /** Dropped item stack (kind 'item'). */
  item?: { name: string; count: number }
  /** Seconds since the observer first saw this entity. */
  ageS?: number
  /** Horizontal speed toward the bot, blocks/s (positive = approaching). */
  closing?: number
}
export type Hazard = { kind: 'lava' | 'fire' | 'void' | 'water'; pos: V3; dist: number }

export type LocationKind = 'spawn' | 'bed' | 'crafting_table' | 'furnace' | 'chest' | 'lava_pool' | 'village' | 'death' | 'mine_entry' | 'ruined_portal' | 'animals' | 'portal_ow' | 'portal_nether' | 'portal_site'
export type Location = {
  kind: LocationKind; dim: Dim; pos: V3; confidence: number; source: 'observed' | 'built'; lastSeen: number
  /** Kind-specific facts, e.g. a lava pool's source-block count. */
  detail?: Record<string, number | boolean | string>
}

/**
 * A dimension change seen by the client (respawn packet): where the bot left and
 * arrived, and why. `portal` unless a death preceded it (milestone B: return_ok
 * needs a portal transition, verified from the client's own dimension state).
 */
export type Transition = { from: Dim; to: Dim; t: number; fromPos: V3; toPos: V3; cause: 'portal' | 'death' }

export type WorldMemory = {
  locations: Location[]
  explored: Record<Dim, Set<string>>
  blacklist: { key: string; until: number; reason: string }[]
  deaths: { pos: V3; dim: Dim; t: number; lost?: Record<string, number>; cause?: string | null }[]
  transitions: Transition[]
  /** Nether excursions: farthest horizontal distance from the arrival portal during a visit (milestone B). */
  excursions: { t: number; dist: number; portal: V3 }[]
}

/** Architecture §8.1 — M0 subset (no recovery state yet). */
export type WorldState = {
  t: number
  tick: number
  dim: Dim
  pos: V3
  yawPitch: [number, number]
  onGround: boolean
  inLiquid: 'none' | 'water' | 'lava'
  vitals: { health: number; food: number; saturation: number; air: number; effects: string[]; onFire: boolean; timeOfDay: number; isRaining: boolean }
  inventory: Record<string, number>
  hotbar: (string | null)[]
  freeSlots: number
  equipment: { head: string | null; chest: string | null; legs: string | null; feet: string | null; mainHand: string | null; offHand: string | null }
  nearby: { entities: EntityInfo[]; interestBlocks: Record<string, V3[]>; hazards: Hazard[] }
  /** What the bot's body is in, for survival interrupts (architecture §4.2 P0). */
  body: BodyState
  /** Tools and armor with durability, in inventory or worn. */
  tools: ToolInfo[]
  /** Total armor points worn. */
  armor: number
  memory: WorldMemory
  control: { objective?: Objective; objectiveStartedAt?: number; skillStack: { skill: string; startedAt: number }[]; interrupt?: string | null }
  milestones: Record<string, number | null>
  counters: { deaths: number; reasonerCalls: number; failuresBySignature: Record<string, number>; currentFailure: string | null; failuresThisObjective: number }
}

export type BodyCell = 'air' | 'water' | 'lava' | 'solid' | 'fire' | 'unknown'
export type BodyState = {
  feet: BodyCell
  head: BodyCell
  /** Vertical velocity, blocks/tick (negative = falling). */
  velY: number
  /** Blocks fallen since last on the ground (or in liquid). */
  fallDist: number
  /** Block and sky light at the feet (null if the chunk has no light data). */
  light: { block: number; sky: number } | null
  /** ≥ 2 solid non-tree blocks above the head: underground or under cover. */
  covered: boolean
  /** Feet and head cells walled in on all four sides and roofed: no mob can reach or see the bot (a sealed dig-in). */
  enclosed?: boolean
}
export type ToolInfo = { name: string; slot: number; remaining: number; max: number }
