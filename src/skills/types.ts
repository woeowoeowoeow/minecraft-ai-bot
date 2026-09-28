import type { Bot } from 'mineflayer'
import type { z } from 'zod'
import type { Navigator } from '../nav/navigator.js'
import type { EventBus } from '../observer/events.js'
import type { WorldMemory, WorldState } from '../observer/types.js'
import type { EventType, FailureClass, NavGoal, NavProfile, NavResult, Requirement, SkillResult } from '../schema/index.js'

/** A skill's own failure (architecture §6.2: `throw SkillFailure(class, reason, detail)`). */
export class SkillFailure extends Error {
  constructor (
    readonly cls: FailureClass,
    readonly reason: string,
    readonly detail: Record<string, unknown> = {},
    readonly missing?: Requirement[],
  ) {
    super(`${cls}: ${reason}`)
    this.name = 'SkillFailure'
  }
}

export type Precondition = { ok: true } | { ok: false; cls?: 'MISSING_RESOURCE' | 'PRECONDITION_FAILED'; reason: string; missing?: Requirement[] }

/** What the bot-side world looks like to the runner. Everything a skill touches goes through here. */
export interface SkillEnv {
  bot: Bot
  nav: Navigator
  bus: EventBus
  state (): WorldState
  memory: WorldMemory
  isBlacklisted (key: string): boolean
  blacklist (key: string, reason: string, seconds?: number): void
  /** Force-clear control states and stop navigation (runner cancellation). */
  halt (): void
  /** Deterministic bot-owned RNG in [0, 1). */
  random (): number
  /** Ask telemetry for a snapshot of current state under `label`. */
  capture (label: string): void
}

export interface SkillCtx {
  bot: Bot
  nav: { goto (goal: NavGoal, o?: { profile?: NavProfile; timeoutMs?: number }): Promise<NavResult> }
  state (): WorldState
  memory: WorldMemory
  env: SkillEnv
  signal: AbortSignal
  log (type: EventType, data: Record<string, unknown>): void
  progress (metric: string, value: number): void
  localRecovery (what: string): void
  run<Q> (child: string, p: Q): Promise<SkillResult>
  capture (label: string): void
  /** Throws the abort reason if the skill has been cancelled. Call between awaits. */
  checkAbort (): void
}

export interface SkillDef<P = unknown, O = unknown> {
  id: string
  level: 'generic' | 'progression' | 'survival'
  params: z.ZodType<P>
  isSatisfied? (s: WorldState, p: P): boolean
  preconditions (s: WorldState, p: P, env: SkillEnv): Precondition
  timeoutMs (s: WorldState, p: P): number
  stallMs: number
  run (ctx: SkillCtx, p: P): Promise<O>
  onCancel? (ctx: SkillCtx): Promise<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySkill = SkillDef<any, any>
