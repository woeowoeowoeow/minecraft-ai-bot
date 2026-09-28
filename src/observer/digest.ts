import type { EventRecord, StateDigest, V3 } from '../schema/index.js'
import { summarizeRecent } from './events.js'
import type { WorldState } from './types.js'

export const DIGEST_CAPS = { invKinds: 25, entities: 8, locations: 12, recent: 20, blocks: 10 } as const

const TOOL_RE = /_(pickaxe|axe|shovel|hoe|sword)$|^(shield|bow|crossbow|flint_and_steel|shears|fishing_rod|water_bucket|lava_bucket|bucket)$/

/** Deterministic, capped projection of WorldState (architecture §8.2). */
export function buildDigest (s: WorldState, recent: EventRecord[]): StateDigest {
  const invEntries = Object.entries(s.inventory).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const inv: Record<string, number> = {}
  for (const [k, v] of invEntries.slice(0, DIGEST_CAPS.invKinds)) inv[k] = v
  if (invEntries.length > DIGEST_CAPS.invKinds) inv['…other_kinds'] = invEntries.length - DIGEST_CAPS.invKinds

  const tools = invEntries.filter(([k]) => TOOL_RE.test(k)).map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
  const armor = [s.equipment.head, s.equipment.chest, s.equipment.legs, s.equipment.feet].filter(Boolean).join(',') || 'none'

  const ents = [...s.nearby.entities].sort((a, b) => a.dist - b.dist)
  const fmtEnt = (e: { name: string; dist: number }) => `${e.name}@${Math.round(e.dist)}`
  const hostile = ents.filter(e => e.kind === 'hostile').slice(0, DIGEST_CAPS.entities).map(fmtEnt)
  const other = ents.filter(e => e.kind !== 'hostile' && e.kind !== 'item').slice(0, Math.max(0, DIGEST_CAPS.entities - hostile.length)).map(fmtEnt)

  const blocks: Record<string, number> = {}
  const kinds = Object.entries(s.nearby.interestBlocks)
    .filter(([, ps]) => ps.length > 0)
    .map(([k, ps]) => [k, ps.length, Math.min(...ps.map(p => dist(p, s.pos)))] as const)
    .sort((a, b) => a[2] - b[2])
    .slice(0, DIGEST_CAPS.blocks)
  for (const [k, n] of kinds) blocks[k] = n

  const locations = s.memory.locations
    .filter(l => l.dim === s.dim)
    .map(l => ({ kind: l.kind, dist: Math.round(dist(l.pos, s.pos)), dir: compass(s.pos, l.pos), pos: l.pos.map(Math.round) as V3 }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, DIGEST_CAPS.locations)

  const reached = Object.entries(s.milestones).filter(([, v]) => v !== null).map(([k]) => k)
  const obj = s.control.objective
  return {
    t: s.t,
    dim: s.dim,
    pos: s.pos.map(v => Math.round(v * 10) / 10) as V3,
    vitals: { hp: round1(s.vitals.health), food: s.vitals.food, air: s.vitals.air, effects: s.vitals.effects.slice(0, 8), armor },
    inv,
    tools,
    objective: obj ? { id: obj.id, strategy: obj.strategy, milestone: obj.milestone, elapsedS: Math.round(s.t - (s.control.objectiveStartedAt ?? s.t)) } : null,
    milestones: { reached: reached.filter(k => /^(M0|[A-F])$/.test(k)), flags: reached.filter(k => !/^(M0|[A-F])$/.test(k)) },
    locations,
    nearby: {
      hostile,
      other,
      hazards: s.nearby.hazards.slice(0, 5).map(h => `${h.kind}@${Math.round(h.dist)}`),
      blocks,
    },
    activeSkill: s.control.skillStack.length ? s.control.skillStack.map(x => x.skill).join('>') : null,
    recent: summarizeRecent(recent, DIGEST_CAPS.recent),
    failures: { current: s.counters.currentFailure, countThisObjective: s.counters.failuresThisObjective },
    deaths: s.counters.deaths,
  }
}

export function dist (a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function round1 (v: number): number { return Math.round(v * 10) / 10 }

/** 8-point compass direction from a to b (Minecraft: -Z is north, +X is east). */
export function compass (a: V3, b: V3): string {
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return 'here'
  const ang = (Math.atan2(dx, -dz) * 180) / Math.PI // 0 = north, 90 = east
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[((Math.round(ang / 45) % 8) + 8) % 8]!
}
