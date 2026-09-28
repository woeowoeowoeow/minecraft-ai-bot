import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { EventBus } from '../observer/events.js'
import type { NavBenchTrial, NavDiag, NavGoal, V3 } from '../schema/index.js'
import type { SkillRunner } from '../skills/runner.js'
import type { Telemetry } from '../telemetry/telemetry.js'

/**
 * Trial plan per run (evaluation.md §6): surface 30/100/300 blocks and caves
 * Y -20..20 within 50 blocks. Each trial starts where the last one ended, so
 * cave trials run last: a failed cave trial leaves the bot underground and
 * would otherwise contaminate the following surface trials.
 */
export const NAVBENCH_PLAN: NavBenchTrial['kind'][] = ['surface30', 'surface30', 'surface100', 'surface100', 'surface300', 'surface300', 'cave', 'cave']

const SURFACE_DIST = { surface30: 30, surface100: 100, surface300: 300 } as const

/**
 * Picks a standable cave position (air, air above, solid below) at Y -20..20
 * within 50 blocks horizontally, from loaded chunk data, using the bot's RNG.
 */
export function pickCaveTarget (bot: Bot, random: () => number): V3 | null {
  const me = bot.entity.position
  const found: V3[] = []
  const isAir = (n?: string) => n === 'air' || n === 'cave_air'
  for (let i = 0; i < 600 && found.length < 40; i++) {
    const r = Math.sqrt(random()) * 50
    const a = random() * Math.PI * 2
    const x = Math.floor(me.x + Math.sin(a) * r)
    const z = Math.floor(me.z + Math.cos(a) * r)
    for (let y = -20; y <= 20; y++) {
      const b = bot.blockAt(new Vec3(x, y, z), false)
      if (!b) break
      if (!isAir(b.name)) continue
      const below = bot.blockAt(new Vec3(x, y - 1, z), false)
      const above = bot.blockAt(new Vec3(x, y + 1, z), false)
      if (below?.boundingBox === 'block' && !/lava|water|magma|bedrock/.test(below.name) && isAir(above?.name)) {
        found.push([x, y, z])
        break
      }
    }
  }
  if (!found.length) return null
  return found[Math.floor(random() * found.length)]!
}

export async function runNavBench (deps: { bot: Bot; runner: SkillRunner; bus: EventBus; telemetry: Telemetry; random: () => number; deadline: number; stopped: () => boolean; deaths: () => number; waitForRespawn: () => Promise<void> }): Promise<NavBenchTrial[]> {
  const { bot, runner, bus, telemetry, random } = deps
  // A death mid-trial respawns the bot elsewhere: cancel the trial and record it as DEATH.
  bus.on(ev => { if (ev.type === 'death') runner.cancel() })
  // Let any evaluator fixture setup (items) arrive before the first trial.
  await new Promise(r => setTimeout(r, 3000))
  bus.emit('capture', { label: 'navbench_start', inventory: Object.fromEntries(bot.inventory.items().map(it => [it.name, it.count])) }, 'debug')
  const trials: NavBenchTrial[] = []
  for (let i = 0; i < NAVBENCH_PLAN.length; i++) {
    if (deps.stopped() || Date.now() > deps.deadline - 30_000) break
    const kind = NAVBENCH_PLAN[i]!
    const me = bot.entity.position
    let goal: NavGoal
    let straightDist: number
    if (kind === 'cave') {
      const t = pickCaveTarget(bot, random)
      if (!t) {
        const trial: NavBenchTrial = { i, kind, profile: 'overworld', ok: false, class: 'NO_TARGET', ms: 0, straightDist: 0, blocksTravelled: 0, stuckEvents: 0, replans: 0, endDist: 0, failureBundle: null }
        trials.push(trial)
        bus.emit('navbench_trial', trial, 'warn')
        continue
      }
      goal = { kind: 'near', target: t, range: 1.5 }
      straightDist = Math.hypot(t[0] - me.x, t[1] - me.y, t[2] - me.z)
    } else {
      const d = SURFACE_DIST[kind]
      const a = random() * Math.PI * 2
      goal = { kind: 'xz', target: [Math.round(me.x + Math.sin(a) * d), 0, Math.round(me.z - Math.cos(a) * d)], range: 3 }
      straightDist = d
    }
    const deathsBefore = deps.deaths()
    const res = await runner.run('navigate', { goal, profile: 'overworld' })
    const died = deps.deaths() > deathsBefore
    const diag: NavDiag | undefined = res.status === 'success'
      ? (res.outputs as { detail?: NavDiag } | undefined)?.detail
      : (res.failure?.detail as { nav?: NavDiag } | undefined)?.nav
    const ok = res.status === 'success' && !died
    const cls = died ? 'DEATH' : (res.failure?.class ?? res.status)
    const bundle = ok ? null : telemetry.failureBundle(`navbench-${kind}-${cls}`, res.failure ?? null, { trial: i, goal, died }, 300)
    if (died) await deps.waitForRespawn()
    const trial: NavBenchTrial = {
      i, kind, profile: 'overworld', ok, class: ok ? null : cls,
      ms: res.metrics.durationMs, straightDist: Math.round(straightDist),
      blocksTravelled: diag?.blocksTravelled ?? 0, stuckEvents: diag?.stuckEvents ?? 0, replans: diag?.replans ?? 0,
      endDist: diag?.endDist ?? -1, failureBundle: bundle,
    }
    trials.push(trial)
    bus.emit('navbench_trial', trial, ok ? 'info' : 'warn')
  }
  return trials
}
