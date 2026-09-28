import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BotResultS, type BotConfig, type BotResult, type GroundTruth, type Outcome, type RunSummary, type Scenario } from '../schema/index.js'
import { parseInventoryData, parseServerLine } from './groundtruth.js'
import { terminate, waitExit, type ProcessRegistry } from './procs.js'
import { MC_VERSION, ServerProcess } from './server.js'

export const ROOT = resolve(new URL('../..', import.meta.url).pathname)
export const JAR = join(ROOT, '.cache', `server-${MC_VERSION}.jar`)
export const WORLDS = join(ROOT, '.cache', 'worlds')

export type RunOptions = {
  batchId: string
  runId: string
  runDir: string
  seed: string              // evaluator-private
  seedSet: string
  scenario: Scenario
  reasoner: 'none' | 'scripted'
  limitMs: number
  port: number
  rngSeed: number
  target: string
  keepWorld?: boolean
  codeRev: { rev: string; dirty: boolean }
  registry: ProcessRegistry
  /** Test hooks: replace the java server and/or the bot process. */
  serverCommand?: { cmd: string; args: string[] }
  botCommand?: { cmd: string; args: string[] }
  serverReadyTimeoutMs?: number
  username?: string
  /** Labeled fixture (evaluation.md §1): evaluator console setup, never scored. */
  fixture?: FixtureName
}

/** Fixture setups: evaluator-only console commands run when the bot joins. */
export type FixtureName = 'kit' | 'kit2'
export const FIXTURES: Record<FixtureName, (user: string) => string[]> = {
  // Milestone-A-like navigation kit: a pickaxe for digging, blocks for scaffolding.
  kit: user => [`give ${user} minecraft:stone_pickaxe 1`, `give ${user} minecraft:dirt 32`],
  // Supplementary: `kit` plus a spare stone pickaxe (131 uses each), to separate excavation
  // reliability from single-tool durability on ~90-block descents.
  kit2: user => [`give ${user} minecraft:stone_pickaxe 2`, `give ${user} minecraft:dirt 32`],
}

export const REQUIRED_ARTIFACTS = ['events.jsonl', 'trace.jsonl', 'state.jsonl', 'bot_result.json', 'bot.log', 'server.log', 'ground_truth.jsonl', join('private', 'seed.txt')]

/**
 * Environment for the bot process: an explicit whitelist. The seed, world dir
 * and server log path are never included (evaluation.md §2.1).
 */
export function botEnv (cfg: BotConfig, lingerMs: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { BOT_CONFIG: JSON.stringify(cfg), BOT_LINGER_MS: String(lingerMs) }
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[k]) env[k] = process.env[k]
  return env
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runOne (o: RunOptions): Promise<RunSummary> {
  const t0 = Date.now()
  const since = () => Math.round((Date.now() - t0) / 100) / 10
  const username = o.username ?? 'Bot'
  mkdirSync(join(o.runDir, 'private'), { recursive: true })
  writeFileSync(join(o.runDir, 'private', 'seed.txt'), o.seed + '\n')
  const gtPath = join(o.runDir, 'ground_truth.jsonl')
  writeFileSync(gtPath, '')
  const gt: GroundTruth[] = []
  const recordGt = (g: GroundTruth) => { gt.push(g); appendFileSync(gtPath, JSON.stringify(g) + '\n') }
  const worldDir = join(WORLDS, o.runId)
  rmSync(worldDir, { recursive: true, force: true })

  let outcome: Outcome | null = null
  let outcomeReason = ''
  let serverStartS = 0
  let teardownS = 0
  let botConnectS: number | null = null
  let botRunS: number | null = null
  let botExit: { code: number | null; signal: string | null } = { code: null, signal: null }
  let gtInventory: Record<string, number> | null = null
  let gtNote = ''
  let bot: ChildProcess | null = null
  let timedOut = false

  const server = new ServerProcess({ worldDir, port: o.port, seed: o.seed, jarPath: JAR, command: o.serverCommand, readyTimeoutMs: o.serverReadyTimeoutMs }, o.registry)
  server.on('line', (line: string) => {
    const g = parseServerLine(line, username, since())
    if (!g) return
    recordGt(g)
    if (g.kind === 'join' && botConnectS === null) {
      botConnectS = since()
      if (o.fixture) {
        for (const c of FIXTURES[o.fixture](username)) server.command(c)
        recordGt({ t: since(), kind: 'fixture', data: { name: o.fixture, commands: FIXTURES[o.fixture](username) } })
      }
    }
  })

  try {
    try {
      await server.start()
      serverStartS = since()
    } catch (e) {
      outcome = 'infra_error'
      outcomeReason = `server start failed: ${(e as Error).message}`
      throw e
    }

    const cfg: BotConfig = { host: '127.0.0.1', port: o.port, username, runDir: o.runDir, scenario: o.scenario, reasoner: o.reasoner, limitMs: o.limitMs, rngSeed: o.rngSeed }
    const { cmd, args } = o.botCommand ?? { cmd: process.execPath, args: ['--import', 'tsx', join(ROOT, 'src', 'bot', 'main.ts')] }
    const botLog = createWriteStream(join(o.runDir, 'bot.log'))
    const botStarted = Date.now()
    bot = spawn(cmd, args, { cwd: ROOT, env: botEnv(cfg, 30_000), stdio: ['ignore', 'pipe', 'pipe'] })
    o.registry.track('bot', bot, o.botCommand ? cmd : 'src/bot/main.ts')
    bot.stdout!.pipe(botLog, { end: false })
    bot.stderr!.pipe(botLog, { end: false })
    bot.once('exit', () => setTimeout(() => botLog.end(), 100))

    const resultPath = join(o.runDir, 'bot_result.json')
    const hardDeadline = botStarted + o.limitMs
    let serverDied = false
    server.once('exit', () => { serverDied = true })
    // Wait for: bot result written, bot exit, server death, or the wall clock.
    for (;;) {
      if (existsSync(resultPath)) break
      if (bot.exitCode !== null || bot.signalCode !== null) break
      if (serverDied) break
      if (Date.now() >= hardDeadline) { timedOut = true; break }
      await sleep(500)
    }

    // Ground truth from the server while the bot is (hopefully) still connected.
    if (server.running) {
      const inv = await server.query(`data get entity ${username} Inventory`, new RegExp(`${username} has the following entity data: (\\[.*\\])$|No entity was found`), 5000)
      if (inv?.[1]) {
        gtInventory = parseInventoryData(inv[1])
        recordGt({ t: since(), kind: 'inventory', data: { items: gtInventory } })
      } else {
        gtNote = inv ? 'player not online at end of run' : 'inventory query timed out'
      }
      const pos = await server.query(`data get entity ${username} Pos`, new RegExp(`${username} has the following entity data: \\[(-?[\\d.]+)d, (-?[\\d.]+)d, (-?[\\d.]+)d\\]`), 3000)
      if (pos) recordGt({ t: since(), kind: 'position', data: { pos: [Number(pos[1]), Number(pos[2]), Number(pos[3])].map(Math.round) } })
    } else {
      gtNote = 'server not running at end of run'
    }

    // Stop the bot: it writes a timeout bundle on SIGTERM if it had not finished.
    const botGrace = timedOut ? 15_000 : 5_000
    const ex = await terminate(bot, botGrace)
    botExit = { code: ex.code, signal: ex.signal }
    botRunS = Math.round((Date.now() - botStarted) / 100) / 10
    if (serverDied && !existsSync(resultPath)) { outcome = 'infra_error'; outcomeReason = 'server exited during run' }
  } catch (e) {
    outcome ??= 'infra_error'
    outcomeReason ||= `evaluator error: ${(e as Error).message}`
  } finally {
    if (bot) await terminate(bot, 3000)
    const tStop = Date.now()
    await server.stop().catch(() => {})
    if (server.child) await waitExit(server.child, 1000)
    try { if (existsSync(server.logPath)) copyFileSync(server.logPath, join(o.runDir, 'server.log')) } catch { /* recorded as missing artifact */ }
    if (!o.keepWorld) rmSync(worldDir, { recursive: true, force: true })
    teardownS = Math.round((Date.now() - tStop) / 100) / 10
  }

  // ── merge into summary.json ────────────────────────────────────────────
  let br: BotResult | null = null
  try {
    const parsed = BotResultS.safeParse(JSON.parse(readFileSync(join(o.runDir, 'bot_result.json'), 'utf8')))
    if (parsed.success) br = parsed.data
    else outcomeReason ||= `bot_result.json invalid: ${parsed.error.issues[0]?.message}`
  } catch { /* missing */ }

  if (!outcome) {
    if (br) {
      outcome = timedOut && br.outcome !== 'goal_reached' ? 'timeout' : br.outcome
      outcomeReason = br.reason
    } else if (timedOut) {
      outcome = 'timeout'; outcomeReason = 'wall clock expired; bot wrote no result'
    } else {
      outcome = 'infra_error'; outcomeReason = `bot exited without result (code ${botExit.code}, signal ${botExit.signal})`
    }
  }

  const deathsGt = gt.filter(g => g.kind === 'death')
  const advancements = gt.filter(g => g.kind === 'advancement').map(g => String(g.data.name))
  let verified: boolean | null = null
  if (o.target === 'M0' && gtInventory) verified = (gtInventory.crafting_table ?? 0) >= 1 === (outcome === 'goal_reached')
  if (o.scenario === 'navbench') verified = gtInventory ? true : null

  const failures = br?.failures ?? []
  const byClass: Record<string, number> = {}
  const bySignature: Record<string, number> = {}
  for (const f of failures) {
    byClass[f.class] = (byClass[f.class] ?? 0) + 1
    bySignature[f.signature] = (bySignature[f.signature] ?? 0) + 1
  }

  const summary: RunSummary = {
    runId: o.runId, batchId: o.batchId, seedSet: o.seedSet, fixture: Boolean(o.fixture),
    codeRev: o.codeRev.rev, dirty: o.codeRev.dirty, mcVersion: MC_VERSION,
    config: { scenario: o.scenario, reasoner: o.reasoner, limitMin: Math.round(o.limitMs / 60_000 * 10) / 10, target: o.target, fixture: o.fixture ?? null },
    startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(),
    outcome, outcomeReason,
    elapsedS: br?.elapsedS ?? botRunS ?? 0,
    timing: { serverStartS, botConnectS, botRunS, teardownS },
    gameTicks: br?.gameTicks ?? 0,
    milestones: br?.milestones ?? { [o.target]: null },
    flags: br?.flags ?? {},
    deaths: (br?.deaths ?? []).map((d, i) => ({ t: d.t, dim: d.dim, cause: (deathsGt[i]?.data.message as string | undefined) ?? d.message })),
    terminalFailure: br?.terminalFailure ?? null,
    failures: { total: failures.length, byClass, bySignature },
    skills: br?.skills ?? {},
    nav: br?.nav ?? { calls: 0, ok: 0, stuck: 0, unreachable: 0, hazard: 0, timeout: 0, cancelled: 0, stuckEvents: 0, blocksTravelled: 0, byProfile: {} },
    reasoner: br?.reasoner ?? { calls: 0, byKind: {}, fallbacks: 0, impl: o.reasoner },
    groundTruth: { verified, inventory: gtInventory, deaths: deathsGt.length, advancements, note: gtNote || (verified === false ? 'bot claim disagrees with server inventory' : 'ok') },
    interventions: 0,
    physicsCorrections: br?.physicsCorrections ?? 0,
    botExit,
    artifacts: { complete: false, missing: [] },
    navbench: br?.navbench,
  }
  const missing = REQUIRED_ARTIFACTS.filter(f => !existsSync(join(o.runDir, f)))
  summary.artifacts = { complete: missing.length === 0, missing }
  writeFileSync(join(o.runDir, 'summary.json'), JSON.stringify(summary, null, 1))
  if (o.registry.count() > 0) console.error(`warning: ${o.registry.count()} child process(es) still tracked after run ${o.runId}`)
  return summary
}

