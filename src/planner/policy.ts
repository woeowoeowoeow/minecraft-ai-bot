import progression from '../../config/progression.json' with { type: 'json' }
import type { WorldState } from '../observer/types.js'
import type { Objective } from '../schema/index.js'

/**
 * A requirement in the ordered progression list (architecture §5.1). The list
 * is data: each entry says when it is met and which goal-shaped skill makes it so.
 */
export type RequirementDef = {
  id: string
  milestone: string
  /** Requirement ids that must be met before this one can be pursued. */
  requires?: string[]
  met (s: WorldState): boolean
  objective (s: WorldState): Omit<Objective, 'id' | 'milestone'>
}

const inv = (s: WorldState, pred: (n: string) => boolean) =>
  Object.entries(s.inventory).reduce((n, [k, v]) => (pred(k) ? n + v : n), 0)
const isLog = (n: string) => n.endsWith('_log')
const isPlanks = (n: string) => n.endsWith('_planks')
const hasTable = (s: WorldState) => (s.inventory.crafting_table ?? 0) >= 1

/** Planks made from the most plentiful log kind in inventory. */
export function planksFor (s: WorldState): string {
  const logs = Object.entries(s.inventory).filter(([k]) => isLog(k)).sort((a, b) => b[1] - a[1])
  const log = logs[0]?.[0] ?? 'oak_log'
  return log.replace(/^stripped_/, '').replace(/_log$/, '_planks')
}

const M0 = progression.M0

export const M0_REQUIREMENTS: RequirementDef[] = [
  {
    id: 'collect_logs',
    milestone: 'M0',
    met: s => hasTable(s) || inv(s, isPlanks) >= M0.planks || inv(s, isLog) >= M0.logs,
    objective: () => ({ skill: 'collect', params: { block: 'log', count: M0.logs }, strategy: 'nearest_visible', budgetMs: 5 * 60_000 }),
  },
  {
    id: 'craft_planks',
    milestone: 'M0',
    requires: ['collect_logs'],
    met: s => hasTable(s) || inv(s, isPlanks) >= M0.planks,
    objective: s => ({ skill: 'craft', params: { item: planksFor(s), count: M0.planks }, strategy: 'inventory_2x2', budgetMs: 60_000 }),
  },
  {
    id: 'craft_crafting_table',
    milestone: 'M0',
    requires: ['craft_planks'],
    met: hasTable,
    objective: () => ({ skill: 'craft', params: { item: 'crafting_table', count: 1 }, strategy: 'inventory_2x2', budgetMs: 60_000 }),
  },
]

/** Milestone predicates over WorldState (architecture §8.1). M0 only for now. */
export const MILESTONES: Record<string, (s: WorldState) => boolean> = {
  M0: hasTable,
}

/**
 * Deterministic policy: unmet requirements whose prerequisites are met, in list
 * order. The first entry is the default objective; the reasoner may only pick
 * among these.
 */
export function unmetObjectives (list: RequirementDef[], s: WorldState): Objective[] {
  const met = new Set(list.filter(r => r.met(s)).map(r => r.id))
  return list
    .filter(r => !met.has(r.id) && (r.requires ?? []).every(id => met.has(id)))
    .map(r => ({ id: r.id, milestone: r.milestone, ...r.objective(s) }))
}
