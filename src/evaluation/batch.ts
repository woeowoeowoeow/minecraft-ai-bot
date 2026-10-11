import { execFileSync } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { RunSummaryS, type RunSummary, type Scenario } from '../schema/index.js'
import { resolveJava } from './java.js'
import { ProcessRegistry } from './procs.js'
import { aggregate, renderReport, type BatchFailureRow } from './report.js'
import { renderSurvival } from './survival-report.js'
import { renderPortal } from './portal-report.js'
import { renderResources } from './resource-report.js'
import { renderEarlyStop } from './early-stop-report.js'
import { renderC } from './c-report.js'
import { FIXTURES, ROOT, runOne, WORLDS, type FixtureName } from './run.js'
import { MC_VERSION } from '../version.js'
import { SERVER_PROPERTIES } from './server.js'

export const RUNS = join(ROOT, 'runs')

/** Gate time limits from milestones.md (seconds from bot spawn). */
export const GATE_LIMIT_S: Record<string, number> = { M0: 600, A: 2700, B: 4200, C: 7200 }

/** Batch target milestone per scenario. */
export const SCENARIO_TARGET: Record<string, string> = { m0: 'M0', a: 'A', b: 'B', c: 'C', navbench: 'navbench' }

/** Fresh 64-bit world seed from the OS CSPRNG (evaluation.md §2.1). */
export function freshSeed (): string {
  return randomBytes(8).readBigInt64BE().toString()
}

export function freePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

export function codeRev (): { rev: string; dirty: boolean } {
  try {
    const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'config', 'package.json'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0
    return { rev, dirty }
  } catch {
    return { rev: 'uncommitted', dirty: true }
  }
}

export type BatchOptions = {
  scenario: Scenario
  n: number
  parallel: number
  limitMs: number
  reasoner: 'none' | 'scripted'
  /** 'dev': fresh seeds for development batches (never a gate); 'heldout': a gate set. */
  set: 'heldout' | 'replay' | 'dev'
  replay?: string[]           // runIds whose private seeds to reuse (set = replay)
  /** Continue an interrupted batch (host crash): its seeds come from its private manifest; runs never started are run. */
  resume?: string
  keepWorld?: boolean
  label?: string
  fixture?: FixtureName
  /** Predeclared early-fail rules (evaluation.md §1, early-fail rules); default on for milestone B batches. */
  earlyStop?: boolean
}

function stamp (): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Evaluator-private seed manifest: written before the first run so a host crash cannot lose the rest of a held-out set. */
export function seedManifestPath (dir: string): string { return join(dir, 'private', 'seeds.json') }

export async function runBatch (o: BatchOptions): Promise<string> {
  const resumed = o.resume ? JSON.parse(readFileSync(seedManifestPath(join(RUNS, o.resume)), 'utf8')) as { batchId: string; seedSet: string; seeds: string[]; options: Partial<BatchOptions> } : null
  if (resumed) o = { ...o, ...resumed.options, resume: o.resume }
  const batchId = resumed?.batchId ?? `${stamp()}-${o.scenario}${o.label ? '-' + o.label : ''}`
  const seedSet = resumed?.seedSet ?? (o.fixture ? `fixture-${batchId}` : o.set === 'heldout' ? `heldout-${batchId}` : o.set === 'dev' ? `dev-${batchId}` : 'replay')
  const dir = join(RUNS, batchId)
  mkdirSync(dir, { recursive: true })
  const registry = new ProcessRegistry(join(ROOT, '.cache', 'pids'))
  registry.installExitHandlers()
  const swept = registry.sweepOrphans()
  if (swept.killed.length) console.log(`swept ${swept.killed.length} orphaned process(es) from a previous evaluator`)
  // World dirs left by a killed evaluator (no other evaluator running → none are in use).
  if (!registry.otherEvaluatorAlive() && existsSync(WORLDS)) {
    const stale = readdirSync(WORLDS)
    for (const w of stale) rmSync(join(WORLDS, w), { recursive: true, force: true })
    if (stale.length) console.log(`removed ${stale.length} stale world dir(s)`)
  }

  const java = resolveJava(ROOT)
  const rev = codeRev()
  const target = SCENARIO_TARGET[o.scenario] ?? o.scenario
  const earlyStop = o.earlyStop ?? target === 'B'
  const seeds: string[] = resumed
    ? resumed.seeds
    : o.set === 'replay'
      ? (o.replay ?? []).map(id => readFileSync(join(findRunDir(id), 'private', 'seed.txt'), 'utf8').trim())
      : Array.from({ length: o.n }, () => freshSeed())
  if (!resumed) {
    mkdirSync(join(dir, 'private'), { recursive: true })
    const options = { scenario: o.scenario, n: o.n, parallel: o.parallel, limitMs: o.limitMs, reasoner: o.reasoner, set: o.set, label: o.label, fixture: o.fixture, keepWorld: o.keepWorld, earlyStop }
    writeFileSync(seedManifestPath(dir), JSON.stringify({ batchId, seedSet, seeds, options, writtenAt: new Date().toISOString() }, null, 1))
  }
  const meta = {
    batchId, seedSet, n: seeds.length, scenario: o.scenario, reasoner: o.reasoner, limitMin: o.limitMs / 60_000, target,
    codeRev: rev.rev, dirty: rev.dirty, mcVersion: MC_VERSION, java: java.version,
    server: { ...SERVER_PROPERTIES, ...(o.fixture ? FIXTURES[o.fixture].properties : {}) }, parallel: o.parallel,
    startedAt: new Date().toISOString(), node: process.version, fixture: o.fixture ?? null, earlyStop,
  }
  const runIdOf = (i: number) => `${batchId}-r${String(i + 1).padStart(2, '0')}`
  let next = 0
  if (resumed) {
    // Runs that finished keep their summaries; a run the crash interrupted (directory, no
    // summary) is not re-run on the same seed: it is scored infra_error (evaluation.md §1).
    while (next < seeds.length && existsSync(join(dir, runIdOf(next)))) next++
    const cut = Array.from({ length: next }, (_, i) => runIdOf(i)).filter(id => !existsSync(join(dir, id, 'summary.json')))
    console.log(`resuming ${batchId} at run ${next + 1}/${seeds.length}${cut.length ? `; interrupted (score as infra_error): ${cut.join(', ')}` : ''}`)
    const prev = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')) as { meta: Record<string, unknown> }
    Object.assign(meta, { startedAt: prev.meta.startedAt, resumedAt: new Date().toISOString(), interrupted: cut, codeRevAtStart: prev.meta.codeRev, dirtyAtStart: prev.meta.dirty })
  }
  writeFileSync(join(dir, 'batch.json'), JSON.stringify({ meta, status: 'running' }, null, 1))

  const summaries: RunSummary[] = new Array(seeds.length)
  const worker = async () => {
    while (next < seeds.length) {
      const i = next++
      const runId = runIdOf(i)
      const runDir = join(dir, runId)
      const port = await freePort()
      console.log(`[${new Date().toISOString()}] run ${i + 1}/${seeds.length} ${runId} starting (port ${port})`)
      const s = await runOne({
        batchId, runId, runDir, seed: seeds[i]!, seedSet, scenario: o.scenario, reasoner: o.reasoner, limitMs: o.limitMs,
        port, rngSeed: randomInt(0, 2 ** 31 - 1), target, keepWorld: o.keepWorld, codeRev: rev, registry, fixture: o.fixture, java, earlyStop,
      })
      summaries[i] = s
      console.log(`[${new Date().toISOString()}] run ${runId}: ${s.outcome} (${s.outcomeReason}) ${target}=${s.milestones[target] ?? '–'}s deaths=${s.deaths.length} elapsed=${s.elapsedS}s nav=${s.nav.ok}/${s.nav.calls} artifacts=${s.artifacts.complete ? 'complete' : 'missing ' + s.artifacts.missing.join(',')}`)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel, seeds.length)) }, worker))
  writeBatchReport(batchId, { ...meta, endedAt: new Date().toISOString() })
  return batchId
}

export function findRunDir (runId: string): string {
  const direct = join(RUNS, runId)
  if (existsSync(join(direct, 'summary.json')) || existsSync(join(direct, 'bot_result.json'))) return direct
  for (const b of readdirSync(RUNS)) {
    const p = join(RUNS, b, runId)
    if (existsSync(p)) return p
  }
  throw new Error(`run ${runId} not found under runs/`)
}

export function loadBatch (batchId: string): { dir: string; meta: Record<string, unknown>; runs: RunSummary[]; failures: BatchFailureRow[] } {
  const dir = join(RUNS, batchId)
  if (!existsSync(dir)) throw new Error(`batch ${batchId} not found under runs/`)
  const meta = (JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')) as { meta: Record<string, unknown> }).meta
  const runs: RunSummary[] = []
  for (const d of readdirSync(dir).sort()) {
    const p = join(dir, d, 'summary.json')
    if (!existsSync(p)) continue
    const parsed = RunSummaryS.safeParse(JSON.parse(readFileSync(p, 'utf8')))
    if (parsed.success) runs.push(parsed.data)
    else console.error(`skipping ${d}: invalid summary.json (${parsed.error.issues[0]?.message})`)
  }
  const failures: BatchFailureRow[] = []
  for (const r of runs) {
    try {
      const br = JSON.parse(readFileSync(join(dir, r.runId, 'bot_result.json'), 'utf8')) as { failures?: BatchFailureRow[] }
      for (const f of br.failures ?? []) failures.push({ ...f, runId: r.runId })
    } catch { /* no bot result */ }
  }
  return { dir, meta, runs, failures }
}

/** (Re)writes batch.json aggregates, failures.jsonl and report.md. Returns the report text. */
export function writeBatchReport (batchId: string, metaOverride?: Record<string, unknown>): string {
  const { dir, meta: m0, runs, failures } = loadBatch(batchId)
  const meta = { ...m0, ...metaOverride } as Record<string, unknown> & { target: string; limitMin: number }
  const agg = aggregate(runs, failures, meta.target, GATE_LIMIT_S[meta.target] ?? meta.limitMin * 60)
  writeFileSync(join(dir, 'failures.jsonl'), failures.map(f => JSON.stringify({ runId: f.runId, t: f.t, class: f.class, signature: f.signature, milestone: f.milestone, ladderLevel: f.ladderLevel, bundle: f.bundle ? `${f.runId}/${f.bundle}` : null })).join('\n') + (failures.length ? '\n' : ''))
  writeFileSync(join(dir, 'batch.json'), JSON.stringify({ meta, status: 'complete', aggregate: agg }, null, 1))
  const base = renderReport({
    batchId, seedSet: String(meta.seedSet), codeRev: String(meta.codeRev), dirty: Boolean(meta.dirty), scenario: String(meta.scenario),
    reasoner: String(meta.reasoner), limitMin: meta.limitMin, date: String(meta.startedAt ?? ''), server: (meta.server ?? {}) as Record<string, string>,
    fixture: (meta.fixture as string | null) ?? null, mcVersion: meta.mcVersion as string | undefined, java: meta.java as string | undefined,
  }, agg, runs)
  const extra = meta.scenario === 'c'
    ? `${renderC(dir, runs)}\n${renderPortal(dir, runs)}\n${renderResources(dir, runs)}\n${renderSurvival(dir, runs)}`
    : meta.scenario === 'b' ? `${renderEarlyStop(dir, runs, { limitS: meta.limitMin * 60, enabled: meta.earlyStop === true })}\n${renderPortal(dir, runs)}\n${renderResources(dir, runs)}\n${renderSurvival(dir, runs)}` : meta.scenario === 'a' ? `${renderResources(dir, runs)}\n${renderSurvival(dir, runs)}` : ''
  const report = extra ? base.replace('## Skills', `${extra}\n## Skills`) : base
  writeFileSync(join(dir, 'report.md'), report)
  return report
}
