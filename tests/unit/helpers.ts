import { EventBus } from '../../src/observer/events.js'
import type { WorldState } from '../../src/observer/types.js'
import type { NavResult } from '../../src/schema/index.js'
import type { SkillEnv } from '../../src/skills/types.js'

export function fakeState (over: Partial<WorldState> = {}): WorldState {
  return {
    t: 0, tick: 0, dim: 'overworld', pos: [0, 64, 0], yawPitch: [0, 0], onGround: true, inLiquid: 'none',
    vitals: { health: 20, food: 20, saturation: 5, air: 300, effects: [], onFire: false, timeOfDay: 1000, isRaining: false },
    inventory: {}, hotbar: [], freeSlots: 36,
    equipment: { head: null, chest: null, legs: null, feet: null, mainHand: null, offHand: null },
    nearby: { entities: [], interestBlocks: {}, hazards: [] },
    memory: { locations: [], explored: { overworld: new Set(), the_nether: new Set(), the_end: new Set() }, blacklist: [], deaths: [] },
    control: { skillStack: [] },
    milestones: {},
    counters: { deaths: 0, reasonerCalls: 0, failuresBySignature: {}, currentFailure: null, failuresThisObjective: 0 },
    ...over,
  }
}

export function fakeEnv (state = fakeState()): SkillEnv & { halted: number; bus: EventBus; navCalls: unknown[] } {
  const bus = new EventBus()
  const env = {
    bot: {} as never,
    bus,
    halted: 0,
    navCalls: [] as unknown[],
    nav: {
      goto: async (goal: unknown): Promise<NavResult> => {
        env.navCalls.push(goal)
        return { ok: true, dist: 0, ms: 1, detail: {} as never }
      },
      stop: () => {},
      budgetMs: () => 60_000,
      recent: () => [],
    },
    state: () => state,
    memory: state.memory,
    isBlacklisted: () => false,
    blacklist: () => {},
    halt: () => { env.halted++ },
    random: () => 0.5,
    capture: () => {},
  }
  return env
}
