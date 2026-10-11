import type { Dim, Objective, V3 } from '../schema/index.js'

export type EntityInfo = {
  id: number; name: string; kind: 'hostile' | 'passive' | 'player' | 'item' | 'other'; pos: V3; dist: number
  /** Clear line of sight from the bot's eyes (computed for mobs within 24 blocks, and ghasts). */
  los?: boolean
  /** Ghast charging a fireball (it leaves about half a second later). */
  charging?: boolean
  /** Ghast that charged at the bot within GHAST.aggroS (it is shooting at the bot), or a screaming (angry) enderman. */
  aggro?: boolean
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

export type LocationKind = 'spawn' | 'bed' | 'crafting_table' | 'furnace' | 'chest' | 'lava_pool' | 'village' | 'death' | 'mine_entry' | 'ruined_portal' | 'animals' | 'portal_ow' | 'portal_nether' | 'portal_site' | 'trees'
  // Milestone C (Nether, client-visible blocks and entities only): structures seen in loaded chunks,
  // blaze spawners inside nether bricks, and where piglins and endermen were seen.
  | 'fortress' | 'blaze_spawner' | 'bastion' | 'piglins' | 'endermen'
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

/** An area searched for a resource without result (search.ts): the next relocation avoids it until it expires. */
export type SearchedRegion = { kind: string; dim: Dim; pos: V3; r: number; t: number }

export type WorldMemory = {
  locations: Location[]
  explored: Record<Dim, Set<string>>
  blacklist: { key: string; until: number; reason: string }[]
  deaths: { pos: V3; dim: Dim; t: number; lost?: Record<string, number>; cause?: string | null }[]
  transitions: Transition[]
  /** Nether excursions: farthest horizontal distance from the arrival portal during a visit (milestone B). */
  excursions: { t: number; dist: number; portal: V3 }[]
  /** Regions searched per resource without result (B round 3). Optional: older snapshots and fixtures lack it. */
  searched?: SearchedRegion[]
  /**
   * Milestone C: where the bot has stood during the current Nether visit, from the arrival
   * portal on, loop-free (a point that comes back within reach of an earlier one cuts the
   * loop). The way back to the portal is this trail reversed.
   */
  trail?: { since: number; points: V3[] }
  /** Milestone C: Nether directions that failed (search legs), avoided for a while. */
  netherFailed?: { pos: V3; heading: number; t: number }[]
  /**
   * Milestone C replacement kit: a chest the bot filled beside its Overworld portal before the
   * Nether work (`items` = what it holds, as last deposited or withdrawn), for a cheap re-kit after a death.
   */
  stash?: { pos: V3; items: Record<string, number>; t: number }
  /**
   * Milestone C staging attempts per optional component (`bed`, `stash`): the skills count their
   * own runs, and the policy stops offering a component after its bound (C.stageTries).
   */
  cStage?: { tries: Record<string, number> }
  /** Milestone C gold and barter bookkeeping (the policy's adaptive pearl budget reads it). */
  cLedger?: CLedger
}

/**
 * Gold in and out during C: ingots handed to piglins, pearls and fire resistance that came back,
 * gold gained per source (ingot equivalents), and seconds spent mining nether gold ore.
 */
export type CLedger = {
  given: number; pearls: number; refused: number; tossed: number; potions: number
  gold: { ore: number; bastionBlock: number; chest: number }
  oreS: number
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
  /** Block under the feet (milestone C: magma floors burn). */
  floor?: string
  /** Fire in any cell the bot's hitbox overlaps at feet or head level (feet/head read only the centre column). */
  inFire?: boolean
  /** The hitbox overlaps a nether_portal cell at feet or head level. */
  inPortal?: boolean
}
export type ToolInfo = { name: string; slot: number; remaining: number; max: number }
