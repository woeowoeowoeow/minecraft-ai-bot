// Bot process entry point. Receives only BOT_CONFIG (host, port, username,
// RUN_DIR, scenario, reasoner, limit). Never receives the world seed, the
// server log path or the world directory (architecture §2).
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import * as mfNs from 'mineflayer'
import { Controller, type ControllerResult } from '../controller/controller.js'
import { ProgressionController } from '../controller/progression.js'
import { A_FLAGS, B_FLAGS, builtPortal, C_FLAGS } from '../planner/milestones.js'
import { onInventoryRetry, resetWindows } from './inventory-sync.js'
import { respawnWaiter } from './respawn.js'
import { runNavBench } from '../controller/navbench.js'
import { loadPathfinder, PathfinderNavigator } from '../nav/pathfinder.js'
import { EventBus } from '../observer/events.js'
import { Observer } from '../observer/observer.js'
import { A_MILESTONES, A_REQUIREMENTS, B_MILESTONES, B_REQUIREMENTS, C_MILESTONES, C_REQUIREMENTS, M0_REQUIREMENTS, MILESTONES } from '../planner/policy.js'
import { makeReasoner, type Script } from '../planner/reasoner.js'
import { BotConfigS, type BotResult, type NavBenchTrial } from '../schema/index.js'
import { registerASkills, registerBSkills, registerCSkills, registerM0Skills } from '../skills/registry.js'
import { SkillRunner } from '../skills/runner.js'
import type { SkillEnv } from '../skills/types.js'
import { Telemetry } from '../telemetry/telemetry.js'
import { voxelSlice } from '../telemetry/voxels.js'
import { MC_VERSION } from '../version.js'
import { installCursorSync, installDigAck, installRaycastGuard, installRespawnEffectsReset } from './protocol-fixes.js'
import { startStallWatch } from './stall-watch.js'
import { join } from 'node:path'
import { mulberry32 } from './rng.js'

type MF = typeof import('mineflayer')
const mineflayer: MF = ((mfNs as unknown as { default?: MF }).default ?? mfNs) as MF

const EXIT = { ok: 0, crash: 1, infra: 2, unrecoverable: 3 } as const

function log (...a: unknown[]): void {
  console.log(new Date().toISOString(), ...a)
}

async function main (): Promise<void> {
  const cfg = BotConfigS.parse(JSON.parse(process.env.BOT_CONFIG ?? '{}'))
  const started = Date.now()
  const deadline = started + cfg.limitMs - 20_000 // leave time to write artifacts before the evaluator's hard kill
  const random = mulberry32(cfg.rngSeed ?? (started & 0x7fffffff))

  const bot = mineflayer.createBot({ host: cfg.host, port: cfg.port, username: cfg.username, version: MC_VERSION, auth: 'offline', checkTimeoutInterval: 60_000 })
  const bus = new EventBus(Date.now, () => Number(bot.time?.age ?? 0))
  installDigAck(bot, c => bus.emit('dig_ack_correction', c, 'warn'))
  installRespawnEffectsReset(bot, cleared => bus.emit('effects_reset', { cleared }, 'info'))
  installCursorSync(bot)
  const respawn = respawnWaiter(bot)
  onInventoryRetry(bot, r => bus.emit('inventory_retry', r, 'warn'))
  let rayTrips = 0
  installRaycastGuard(why => { if (rayTrips++ < 20) bus.emit('error', { message: `raycast guard: ${why}` }, 'warn') })
  startStallWatch(join(cfg.runDir, 'stalls.jsonl'))
  loadPathfinder(bot)
  const nav = new PathfinderNavigator(bot, bus)
  const obs = new Observer(bot, bus)
  const telemetry = new Telemetry(cfg.runDir, bus, {
    state: () => obs.state(),
    digest: () => obs.digest(),
    navRecent: () => nav.recent(),
    voxels: () => voxelSlice(bot),
  })

  let finished = false
  let controller: Controller | null = null
  let progression: ProgressionController | null = null
  const progressive = cfg.scenario === 'a' || cfg.scenario === 'b' || cfg.scenario === 'c'
  const milestoneDefs = cfg.scenario === 'c' ? C_MILESTONES : cfg.scenario === 'b' ? B_MILESTONES : cfg.scenario === 'a' ? A_MILESTONES : MILESTONES
  const flagDefs = cfg.scenario === 'c' ? { ...A_FLAGS, ...B_FLAGS, ...C_FLAGS } : cfg.scenario === 'b' ? { ...A_FLAGS, ...B_FLAGS } : A_FLAGS
  let navbench: NavBenchTrial[] | undefined
  let stopRequested = false
  const portalSummary = () => portalSummaryOf(obs)

  const finish = async (r: ControllerResult, code: number): Promise<never> => {
    if (finished) return new Promise<never>(() => {})
    finished = true
    try {
      controller?.checkMilestones()
      progression?.checkMilestones()
      const s = obs.state()
      const result: BotResult = {
        outcome: r.outcome, reason: r.reason,
        elapsedS: Math.round((Date.now() - started) / 1000), gameTicks: s.tick,
        milestones: Object.fromEntries(Object.keys(milestoneDefs).map(k => [k, s.milestones[k] ?? null])),
        flags: progression ? Object.fromEntries(Object.keys(flagDefs).map(k => [k, progression!.flags[k] ?? null])) : {},
        deaths: obs.memory.deaths.map(d => ({ t: d.t, dim: d.dim, message: d.cause ?? null })),
        terminalFailure: r.terminalFailure,
        failures: telemetry.failures,
        skills: telemetry.stats.skills,
        nav: telemetry.stats.nav,
        reasoner: { calls: controller?.reasonerCalls ?? 0, byKind: controller?.reasonerByKind ?? {}, fallbacks: controller?.reasonerFallbacks ?? 0, impl: cfg.reasoner },
        physicsCorrections: obs.physicsCorrections,
        interrupts: progression?.interrupts,
        navbench,
        portal: cfg.scenario === 'b' || cfg.scenario === 'c' ? portalSummary() : undefined,
      }
      bus.emit('run_end', { outcome: r.outcome, reason: r.reason }, r.outcome === 'goal_reached' ? 'info' : 'warn')
      telemetry.writeDigest('run_end')
      telemetry.writeResult(result)
    } catch (e) {
      log('failed to write result', e)
    }
    telemetry.stop()
    obs.stop()
    log('finished', r.outcome, r.reason)
    // Stay connected briefly so the evaluator can verify ground truth, unless it already told us to stop.
    if (process.env.BOT_LINGER_MS && !stopRequested) await new Promise(res => setTimeout(res, Number(process.env.BOT_LINGER_MS)))
    try { bot.quit() } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 300)
    return new Promise<never>(() => {})
  }

  process.on('SIGTERM', () => {
    log('SIGTERM from evaluator')
    stopRequested = true
    if (finished) { try { bot.quit() } catch { /* ignore */ } setTimeout(() => process.exit(0), 200); return }
    const bundle = safe(() => telemetry.failureBundle('RUN_TIMEOUT', null, { note: 'evaluator wall-clock limit' }, 300))
    controller?.stop()
    progression?.stop()
    void finish({ outcome: 'timeout', reason: 'evaluator wall-clock limit', terminalFailure: { class: 'SKILL_TIMEOUT', signature: 'SKILL_TIMEOUT|run|-|-|scope=run', bundle } }, EXIT.ok)
  })
  process.on('uncaughtException', (e) => {
    log('uncaughtException', e)
    bus.emit('error', { message: String(e), stack: String((e as Error).stack ?? '').split('\n').slice(0, 6) }, 'error')
    void finish({ outcome: 'infra_error', reason: `uncaught exception: ${String(e)}`, terminalFailure: { class: 'INFRA', signature: 'INFRA|process|-|-|uncaught', bundle: null } }, EXIT.crash)
  })
  process.on('unhandledRejection', (e) => {
    log('unhandledRejection', e)
    bus.emit('error', { message: String(e) }, 'warn')
  })

  bot.on('kicked', (reason) => {
    bus.emit('disconnect', { kind: 'kicked', reason: String(reason).slice(0, 300) }, 'error')
    void finish({ outcome: 'infra_error', reason: `kicked: ${String(reason).slice(0, 200)}`, terminalFailure: { class: 'INFRA', signature: 'INFRA|connection|-|-|kicked', bundle: null } }, EXIT.infra)
  })
  bot.on('end', (reason) => {
    bus.emit('disconnect', { kind: 'end', reason: String(reason) }, finished ? 'info' : 'error')
    void finish({ outcome: 'infra_error', reason: `disconnected: ${String(reason)}`, terminalFailure: { class: 'INFRA', signature: 'INFRA|connection|-|-|end', bundle: null } }, EXIT.infra)
  })
  bot.on('error', (e) => {
    log('bot error', e)
    bus.emit('error', { message: String(e) }, 'error')
  })

  try {
    await withTimeout(once(bot, 'spawn'), 90_000, 'spawn')
  } catch (e) {
    return void finish({ outcome: 'infra_error', reason: `connect failed: ${String(e)}`, terminalFailure: { class: 'INFRA', signature: 'INFRA|connection|-|-|spawn', bundle: null } }, EXIT.infra)
  }
  log('spawned at', bot.entity.position)
  await withTimeout(bot.waitForChunksToLoad(), 60_000, 'chunks').catch(e => bus.emit('error', { message: `chunks: ${String(e)}` }, 'warn'))

  obs.start()
  telemetry.start()
  bus.emit('run_start', { scenario: cfg.scenario, reasoner: cfg.reasoner, limitMs: cfg.limitMs, mcVersion: MC_VERSION, username: cfg.username })
  bus.emit('spawn', { pos: [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z].map(Math.round), dim: obs.dim() })

  const env: SkillEnv = {
    bot, nav, bus,
    state: () => obs.state(),
    memory: obs.memory,
    isBlacklisted: k => obs.isBlacklisted(k),
    blacklist: (k, r, s) => obs.blacklist(k, r, s),
    halt: () => { nav.stop(); bot.clearControlStates(); try { bot.stopDigging() } catch { /* ignore */ } },
    random,
    capture: label => { telemetry.snapshot(label) },
  }
  const runner = cfg.scenario === 'c' ? registerCSkills(new SkillRunner(env)) : cfg.scenario === 'b' ? registerBSkills(new SkillRunner(env)) : cfg.scenario === 'a' ? registerASkills(new SkillRunner(env)) : registerM0Skills(new SkillRunner(env))

  let script: Script = {}
  if (cfg.reasoner === 'scripted') {
    script = JSON.parse(readFileSync(new URL(`../../config/reasoner-scripts/${cfg.scenario}.json`, import.meta.url), 'utf8')) as Script
  }

  if (cfg.scenario === 'navbench') {
    navbench = await runNavBench({
      bot, runner, bus, telemetry, random, deadline, stopped: () => stopRequested,
      deaths: () => obs.counters.deaths,
      waitForRespawn: async () => { await respawn.wait(15_000, 1000) },
    })
    const ok = navbench.filter(t => t.ok).length
    return void finish({ outcome: 'goal_reached', reason: `navbench ${ok}/${navbench.length} trials ok`, terminalFailure: null }, EXIT.ok)
  }

  if (progressive) {
    progression = new ProgressionController({
      runner, bus, telemetry,
      state: () => obs.state(), setObjective: o => obs.setObjective(o),
      requirements: cfg.scenario === 'c' ? C_REQUIREMENTS : cfg.scenario === 'b' ? B_REQUIREMENTS : A_REQUIREMENTS, milestones: milestoneDefs, flags: flagDefs, target: cfg.scenario === 'c' ? 'C' : cfg.scenario === 'b' ? 'B' : 'A', deadline,
      waitForRespawn: async () => { await respawn.wait(15_000, 500) },
      resync: async () => { await resetWindows(bot) },
      afterDeath: () => { nav.stop(); obs.afterDeath() },
    })
    let pr: ControllerResult
    try {
      pr = await progression.run()
    } catch (e) {
      log('controller crashed', e)
      bus.emit('error', { message: String(e), stack: String((e as Error).stack ?? '').split('\n').slice(0, 8) }, 'error')
      const bundle = safe(() => telemetry.failureBundle('INFRA', null, { error: String(e) }))
      pr = { outcome: 'infra_error', reason: `controller crashed: ${String(e)}`, terminalFailure: { class: 'INFRA', signature: 'INFRA|controller|-|-|exception', bundle } }
    }
    return void finish(pr, pr.outcome === 'goal_reached' ? EXIT.ok : pr.outcome === 'infra_error' ? EXIT.infra : EXIT.unrecoverable)
  }

  controller = new Controller({
    runner, reasoner: makeReasoner(cfg.reasoner, script), bus, telemetry,
    state: () => obs.state(), digest: () => obs.digest(), setObjective: o => obs.setObjective(o),
    requirements: M0_REQUIREMENTS, milestones: MILESTONES, target: 'M0', deadline,
    waitForRespawn: async () => { await respawn.wait(15_000, 0) },
  })
  let r: ControllerResult
  try {
    r = await controller.run()
  } catch (e) {
    log('controller crashed', e)
    bus.emit('error', { message: String(e), stack: String((e as Error).stack ?? '').split('\n').slice(0, 8) }, 'error')
    const bundle = safe(() => telemetry.failureBundle('INFRA', null, { error: String(e) }))
    r = { outcome: 'infra_error', reason: `controller crashed: ${String(e)}`, terminalFailure: { class: 'INFRA', signature: 'INFRA|controller|-|-|exception', bundle } }
  }
  await finish(r, r.outcome === 'goal_reached' ? EXIT.ok : r.outcome === 'infra_error' ? EXIT.infra : EXIT.unrecoverable)
}

/** The portal the bot built and the Nether portal it remembered (bot memory, for the evaluator's check). */
function portalSummaryOf (obs: Observer): { ow: [number, number, number] | null; nether: [number, number, number] | null; strategy: string | null } {
  const s = obs.state()
  const ow = builtPortal(s)
  const nether = s.memory.locations.find(l => l.kind === 'portal_nether')
  return { ow: ow ? ow.pos.map(Math.floor) as [number, number, number] : null, nether: nether ? nether.pos.map(Math.floor) as [number, number, number] : null, strategy: ow ? String(ow.detail?.strategy ?? '') || null : null }
}

function safe<T> (fn: () => T): T | null {
  try { return fn() } catch { return null }
}

function withTimeout<T> (p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(h); resolve(v) }, e => { clearTimeout(h); reject(e) })
  })
}

main().catch((e) => {
  log('fatal', e)
  process.exit(EXIT.crash)
})
