import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { EventRecord, RunSummary } from '../schema/index.js'
import { findRunDir, writeBatchReport } from './batch.js'
import { ROOT } from './run.js'

function readJsonl<T> (p: string): T[] {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as T] } catch { return [] } })
}

const TIMELINE = new Set(['run_start', 'objective', 'skill_end', 'nav_end', 'stuck_detected', 'search_step', 'failure', 'recovery_step', 'milestone', 'death', 'disconnect', 'run_end', 'error', 'navbench_trial', 'location_discovered'])

function fmtEvent (e: EventRecord): string | null {
  const d = e.data as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const t = String(e.t).padStart(7)
  switch (e.type) {
    case 'skill_end': {
      if (d.depth > 0 && d.status === 'success') return null
      const f = d.failure ? ` ${d.failure.class}: ${d.failure.reason}` : ''
      return `${t}  ${'  '.repeat(d.depth)}skill ${d.skill} → ${d.status} (${(d.durationMs / 1000).toFixed(1)}s, nav ${d.metrics?.navCalls ?? 0}/${d.metrics?.navFailures ?? 0}f)${f}`
    }
    case 'nav_end':
      if (d.ok) return null
      return `${t}    nav ${d.goal.kind} ✗ ${d.class} (${d.reason ?? ''}) dist ${d.startDist}→${d.endDist}, ${(d.ms / 1000).toFixed(1)}s, replans ${d.replans}, stuck ${d.stuckEvents}, statuses ${JSON.stringify(d.pathStatuses)}`
    case 'stuck_detected': return `${t}    stuck: ${d.reason} at ${JSON.stringify(d.pos)} dist ${d.dist} (attempt ${d.attempt}${d.digging ? ', digging' : ''})`
    case 'objective': return `${t}  objective ${d.id} → ${d.skill} ${JSON.stringify(d.params)}`
    case 'search_step': return `${t}    search step ${d.n} heading ${d.heading}° → ${JSON.stringify(d.target)}`
    case 'failure': return `${t}  FAILURE ${d.class} [${d.signature}] bundle ${d.bundle}`
    case 'recovery_step': return `${t}  recovery ${d.level}: ${d.action ?? d.what}`
    case 'navbench_trial': return `${t}  bench #${d.i} ${d.kind}: ${d.ok ? 'ok' : '✗ ' + d.class} ${(d.ms / 1000).toFixed(1)}s, ${d.blocksTravelled} blocks, stuck ${d.stuckEvents}`
    case 'location_discovered': return d.kind === 'spawn' ? null : `${t}  found ${d.kind} at ${JSON.stringify(d.pos)}`
    default: return `${t}  ${e.type} ${JSON.stringify(d).slice(0, 140)}`
  }
}

export function inspectRun (runId: string): string {
  const dir = findRunDir(runId)
  const L: string[] = []
  const summaryP = join(dir, 'summary.json')
  const s: RunSummary | null = existsSync(summaryP) ? JSON.parse(readFileSync(summaryP, 'utf8')) : null
  L.push(`run ${runId}  (${relative(ROOT, dir)})`)
  if (s) {
    L.push(`outcome: ${s.outcome} — ${s.outcomeReason}`)
    L.push(`scenario ${s.config.scenario}, reasoner ${s.config.reasoner}, limit ${s.config.limitMin} min, code ${s.codeRev}${s.dirty ? ' (dirty)' : ''}, seed set ${s.seedSet}`)
    L.push(`timing: server start ${s.timing.serverStartS}s, bot connected at ${s.timing.botConnectS ?? '–'}s, bot run ${s.timing.botRunS ?? '–'}s, teardown ${s.timing.teardownS}s; game ticks ${s.gameTicks}`)
    L.push(`milestones: ${Object.entries(s.milestones).map(([k, v]) => `${k}=${v ?? '–'}`).join(' ')}`)
    L.push(`ground truth: verified=${s.groundTruth.verified} (${s.groundTruth.note}); server inventory ${JSON.stringify(s.groundTruth.inventory)}; deaths ${s.groundTruth.deaths}`)
    L.push(`nav: ${s.nav.ok}/${s.nav.calls} ok, stuck ${s.nav.stuck}, unreachable ${s.nav.unreachable}, timeout ${s.nav.timeout}, stuck events ${s.nav.stuckEvents}, ${s.nav.blocksTravelled} blocks`)
    L.push(`skills: ${Object.entries(s.skills).map(([k, v]) => `${k} ${v.ok}/${v.runs}`).join(', ')}`)
    L.push(`failures: ${s.failures.total} ${JSON.stringify(s.failures.byClass)}; physics corrections ${s.physicsCorrections}; bot exit ${JSON.stringify(s.botExit)}`)
    if (s.terminalFailure) L.push(`terminal failure: ${s.terminalFailure.class} [${s.terminalFailure.signature}] → ${s.terminalFailure.bundle ?? 'no bundle'}`)
    if (!s.artifacts.complete) L.push(`MISSING ARTIFACTS: ${s.artifacts.missing.join(', ')}`)
    if (s.navbench?.length) {
      L.push('navbench:')
      for (const t of s.navbench) L.push(`  #${t.i} ${t.kind.padEnd(10)} ${t.ok ? 'ok ' : '✗  '} ${String(t.class ?? '').padEnd(16)} ${(t.ms / 1000).toFixed(1).padStart(6)}s  straight ${t.straightDist}  travelled ${t.blocksTravelled}  stuck ${t.stuckEvents}  replans ${t.replans}${t.failureBundle ? '  ' + t.failureBundle : ''}`)
    }
  } else {
    L.push('(no summary.json — run incomplete or evaluator crashed)')
  }

  const events = readJsonl<EventRecord>(join(dir, 'events.jsonl'))
  L.push('', `timeline (${events.length} events; successes of nested skills and nav omitted):`)
  for (const e of events) {
    if (!TIMELINE.has(e.type)) continue
    const line = fmtEvent(e)
    if (line) L.push(line)
  }

  const gt = readJsonl<{ t: number; kind: string; data: unknown }>(join(dir, 'ground_truth.jsonl'))
  if (gt.length) {
    L.push('', 'ground truth (server log, evaluator-only):')
    for (const g of gt) L.push(`${String(g.t).padStart(7)}  ${g.kind} ${JSON.stringify(g.data).slice(0, 160)}`)
  }

  const fdir = join(dir, 'failures')
  if (existsSync(fdir)) {
    L.push('', 'failure bundles:')
    for (const b of readdirSync(fdir).sort((a, b) => parseInt(a) - parseInt(b))) L.push(`  ${relative(ROOT, join(fdir, b))}/  (state, digest, events_tail, trace_tail, skill_stack, nav, voxels)`)
  }

  const states = readJsonl<Record<string, unknown>>(join(dir, 'state.jsonl'))
  const last = states[states.length - 1]
  if (last) L.push('', 'last digest:', JSON.stringify(last))
  return L.join('\n')
}

export function inspectBatch (batchId: string): string {
  return writeBatchReport(batchId)
}
