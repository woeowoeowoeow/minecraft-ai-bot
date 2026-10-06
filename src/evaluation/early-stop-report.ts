// Early-fail section of the milestone B batch report (evaluation.md §1, early-fail rules) and the replay
// tool (`npm run inspect -- early-stop <batchId|runId>`). The gate criteria are scored as
// before: every early-stopped run is a failure in the denominator and keeps its deaths.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RunSummaryS, type RunSummary } from '../schema/index.js'
import { EARLY_STOP, replayEarlyStop, terminalTrigger, type EarlyStop, type Ev } from './early-stop.js'
import { findRunDir, RUNS } from './batch.js'
import { isSuccess } from './report.js'

const MAX_EVENTS_BYTES = 256 * 1024 * 1024
/** Milestone B gate criteria (milestones.md), unchanged by the early-fail rules. */
export const B_GATE = { successRate: 0.6, limitS: 70 * 60, deathsPerRun: 1.0, interventions: 0 } as const

function readEvents (runDir: string): Ev[] {
  const p = join(runDir, 'events.jsonl')
  if (!existsSync(p) || statSync(p).size > MAX_EVENTS_BYTES) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Ev] } catch { return [] } })
}

/** Replays a run's events through the monitor: the decision (if any) and the stage where the stream ends. */
export function replayRun (runDir: string, limitS: number): { decision: EarlyStop | null; endStage: string } {
  return replayEarlyStop(readEvents(runDir), limitS)
}

function margin (s: EarlyStop): string {
  const ev = s.evidence as Record<string, unknown>
  if (s.rule === 'controller_stall') {
    const cycles = Array.isArray(ev.cycles) ? ev.cycles.length : 0
    return `no progress ${ev.noProgressS}s (≥ ${EARLY_STOP.stallS}), ${cycles} cycles (≥ ${EARLY_STOP.stallCycles})`
  }
  if (s.rule === 'objective_exhausted') return `${(ev.exhaustions as number[]).length} exhaustions of ${String(ev.objective)} (≥ ${EARLY_STOP.exhaustions})`
  return `remaining ${ev.remainingS}s < bound ${ev.lowerBoundS}s`
}

/** A trigger looks aggressive when it fired at its minimum: exactly the cycle count and < 1 min past the stall window. */
function minimalMargin (s: EarlyStop): boolean {
  const ev = s.evidence as Record<string, unknown>
  if (s.rule !== 'controller_stall') return false
  const cycles = Array.isArray(ev.cycles) ? ev.cycles.length : 0
  return cycles <= EARLY_STOP.stallCycles && Number(ev.noProgressS) < EARLY_STOP.stallS + 60
}

export function renderEarlyStop (dir: string, runs: RunSummary[], o: { limitS: number; enabled: boolean }): string {
  const L: string[] = ['## Early-fail rules (evaluation.md §1, early-fail rules)', '']
  L.push(o.enabled
    ? `Applied live (rules: objective_exhausted ×${EARLY_STOP.exhaustions}, controller_stall ${EARLY_STOP.stallS / 60} min + ${EARLY_STOP.stallCycles} cycles + no discovery${EARLY_STOP.remainderRule ? ', impossible_remainder' : '; impossible_remainder off: no defensible bound'}). Early-stopped runs are failures, stay in the denominator and keep their deaths.`
    : 'Not applied in this batch (runs went to their natural end). Replay estimate below.', '')

  // Gate criteria, unchanged (comparable with earlier B gates).
  const scored = runs.filter(r => r.outcome !== 'intervened')
  const k = scored.filter(isSuccess).length
  const deaths = runs.reduce((a, r) => a + r.deaths.length, 0)
  const interventions = runs.reduce((a, r) => a + r.interventions, 0)
  const slow = runs.filter(r => isSuccess(r) && (r.milestones.B ?? 0) > B_GATE.limitS).length
  const rate = scored.length ? k / scored.length : 0
  const dpr = runs.length ? deaths / runs.length : 0
  const pf = (ok: boolean) => ok ? 'PASS' : 'FAIL'
  L.push('| B gate criterion (unchanged) | value | verdict |', '|---|---|---|')
  L.push(`| reach B ≥ 60 % | ${k}/${scored.length} = ${Math.round(rate * 1000) / 10} % | ${pf(rate >= B_GATE.successRate)} |`)
  L.push(`| ≤ 70 min per run | ${slow} successes over 70 min | ${pf(slow === 0)} |`)
  L.push(`| ≤ 1.0 deaths/run | ${deaths}/${runs.length} = ${Math.round(dpr * 100) / 100} | ${pf(dpr <= B_GATE.deathsPerRun)} |`)
  L.push(`| 0 interventions | ${interventions} | ${pf(interventions === 0)} |`, '')

  const stopped = runs.filter(r => r.outcome === 'early_fail' && r.earlyStop)
  const saved = stopped.reduce((a, r) => a + (r.earlyStop?.savedS ?? 0), 0)
  L.push(`**Early-stopped (rules 2–4): ${stopped.length}/${runs.length} runs, ${Math.round(saved / 60)} min wall time saved** (vs. running each to the ${Math.round(o.limitS / 60)}-min limit).`, '')
  if (stopped.length) {
    L.push('| run | rule | at s | saved s | deaths | stage at termination | margin | review |', '|---|---|---|---|---|---|---|---|')
    for (const r of stopped) {
      const s = r.earlyStop!
      L.push(`| ${r.runId} | ${s.rule} | ${s.atS} | ${s.savedS} | ${r.deaths.length} | ${s.stage} | ${margin(s as EarlyStop)} | ${minimalMargin(s as EarlyStop) ? 'minimal margin' : 'ok'} |`)
    }
    L.push('')
    for (const r of stopped) L.push(`- \`${r.runId}\` evidence: \`${JSON.stringify(r.earlyStop!.evidence).replace(/`/g, "'").slice(0, 600)}\``)
    L.push('')
  }

  // Rule 1: the existing terminal conditions (bot/evaluator), labelled.
  const terminal = runs.filter(r => terminalTrigger(r.outcome))
  if (terminal.length) {
    L.push('Rule 1 (existing terminal conditions):', '', '| run | trigger | ended s | before limit s | deaths | stage at end |', '|---|---|---|---|---|---|')
    for (const r of terminal) {
      const { endStage } = replayRun(join(dir, r.runId), o.limitS)
      L.push(`| ${r.runId} | ${terminalTrigger(r.outcome)} | ${r.elapsedS} | ${Math.max(0, Math.round(o.limitS - r.elapsedS))} | ${r.deaths.length} | ${endStage} |`)
    }
    L.push('')
  }

  if (!o.enabled) {
    const would = runs.map(r => ({ r, d: replayRun(join(dir, r.runId), o.limitS).decision })).filter(x => x.d)
    L.push(`Replay: rules 2–4 would have stopped ${would.length} run(s): ${would.map(x => `${x.r.runId.slice(-3)} ${x.d!.rule}@${x.d!.atS}s${isSuccess(x.r) ? ' **(a success!)**' : ''}`).join(', ') || 'none'}.`, '')
  }
  return L.join('\n')
}

function loadRun (dir: string): RunSummary | null {
  const p = join(dir, 'summary.json')
  if (!existsSync(p)) return null
  const parsed = RunSummaryS.safeParse(JSON.parse(readFileSync(p, 'utf8')))
  return parsed.success ? parsed.data : null
}

/** Replay the early-fail rules over a finished batch or run (validation, evaluation.md §1, early-fail rules). */
export function inspectEarlyStop (id: string): string {
  const batchDir = join(RUNS, id)
  const dirs = existsSync(join(batchDir, 'batch.json'))
    ? readdirSync(batchDir).filter(d => existsSync(join(batchDir, d, 'summary.json'))).sort().map(d => join(batchDir, d))
    : [findRunDir(id)]
  const L: string[] = []
  let stoppedFailures = 0
  let savedS = 0
  const stoppedSuccesses: string[] = []
  for (const d of dirs) {
    const s = loadRun(d)
    if (!s) continue
    const limitS = s.config.limitMin * 60
    const { decision, endStage } = replayRun(d, limitS)
    const end = isSuccess(s) ? `B at ${s.milestones.B}s` : `${s.outcome} at ${s.elapsedS}s`
    if (!decision) { L.push(`${s.runId}  ${end}  → no early stop (${endStage})`); continue }
    if (isSuccess(s)) stoppedSuccesses.push(s.runId)
    else { stoppedFailures++; savedS += Math.max(0, s.elapsedS - decision.atS) }
    L.push(`${s.runId}  ${end}  → ${isSuccess(s) ? 'WOULD STOP A SUCCESS: ' : ''}${decision.rule} at ${decision.atS}s (saves ${Math.round(s.elapsedS - decision.atS)}s) · ${decision.stage}`)
    L.push(`    ${margin(decision)} · evidence ${JSON.stringify(decision.evidence).slice(0, 400)}`)
  }
  L.push('', `failed runs stopped earlier: ${stoppedFailures}, wall time saved ${Math.round(savedS / 60)} min; successes stopped: ${stoppedSuccesses.length ? stoppedSuccesses.join(', ') : 'none'}`)
  return L.join('\n')
}
