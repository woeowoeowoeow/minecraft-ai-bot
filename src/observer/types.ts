import type { Dim, Objective, V3 } from '../schema/index.js'

export type EntityInfo = { id: number; name: string; kind: 'hostile' | 'passive' | 'player' | 'item' | 'other'; pos: V3; dist: number }
export type Hazard = { kind: 'lava' | 'fire' | 'void' | 'water'; pos: V3; dist: number }

export type LocationKind = 'spawn' | 'bed' | 'crafting_table' | 'furnace' | 'chest' | 'lava_pool' | 'village' | 'death'
export type Location = { kind: LocationKind; dim: Dim; pos: V3; confidence: number; source: 'observed' | 'built'; lastSeen: number }

export type WorldMemory = {
  locations: Location[]
  explored: Record<Dim, Set<string>>
  blacklist: { key: string; until: number; reason: string }[]
  deaths: { pos: V3; dim: Dim; t: number }[]
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
  memory: WorldMemory
  control: { objective?: Objective; objectiveStartedAt?: number; skillStack: { skill: string; startedAt: number }[] }
  milestones: Record<string, number | null>
  counters: { deaths: number; reasonerCalls: number; failuresBySignature: Record<string, number>; currentFailure: string | null; failuresThisObjective: number }
}
