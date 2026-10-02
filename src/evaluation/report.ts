import type { FailureEntry, NavBenchTrial, RunSummary } from '../schema/index.js'

export function wilson (k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}

export function quantile (xs: number[], q: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return Math.round((s[lo]! + (s[hi]! - s[lo]!) * (i - lo)) * 10) / 10
}

export type BatchFailureRow = FailureEntry & { runId: string }

export type SignatureRow = { signature: string; class: string; milestone: string | null; terminated: number; occurrences: number; runs: number; examples: string[] }

export type NavBenchAgg = Record<string, {
  trials: number; ok: number; rate: number; ci: [number, number]
  secPerBlock: number | null; stuckPerKm: number | null; km: number
  classes: Record<string, number>; p50s: number | null; p90s: number | null
}>

export type BatchAggregate = {
  n: number
  scored: number
  outcomes: Record<string, number>
  success: { k: number; n: number; rate: number; ci: [number, number] }
  infraRate: number
  artifactsComplete: number
  groundTruthMismatches: string[]
  milestone: { id: string; reached: number; p50: number | null; p90: number | null; withinLimit: number; limitS: number }
  elapsed: { p50: number | null; p90: number | null; max: number | null }
  signatures: SignatureRow[]
  deaths: { total: number; perRun: number; causes: Record<string, number> }
  skills: Record<string, { runs: number; ok: number; rate: number; p50s: number | null; topFail: string | null }>
  nav: { calls: number; ok: number; rate: number; cancelled: number; stuck: number; unreachable: number; hazard: number; timeout: number; stuckEvents: number; blocksTravelled: number; stuckEventsPerKm: number | null; byProfile: Record<string, { calls: number; ok: number }> }
  reasoner: { calls: number; perRun: number; fallbacks: number; byKind: Record<string, number> }
  navbench: NavBenchAgg | null
  /** Funnel over first-reached flags (in the order the bot reports them), then the target milestone. */
  funnel: { id: string; reached: number; p50: number | null; p90: number | null }[]
  interventions: number
}

/** Is this run a success for the batch target? A ground-truth disagreement is never a success. */
export function isSuccess (s: RunSummary): boolean {
  return s.outcome === 'goal_reached' && s.groundTruth.verified !== false
}

export function aggregate (runs: RunSummary[], failures: BatchFailureRow[], target: string, limitS: number): BatchAggregate {
  const outcomes: Record<string, number> = {}
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
  const scoredRuns = runs.filter(r => r.outcome !== 'intervened')
  const k = scoredRuns.filter(isSuccess).length
  const n = scoredRuns.length

  const times = runs.map(r => r.milestones[target]).filter((t): t is number => typeof t === 'number')
  const elapsed = runs.map(r => r.elapsedS)

  // Failure signatures: ranked by runs terminated, then occurrences (evaluation.md §5.4).
  const sig = new Map<string, SignatureRow & { runSet: Set<string> }>()
  for (const f of failures) {
    const row = sig.get(f.signature) ?? { signature: f.signature, class: f.class, milestone: f.milestone, terminated: 0, occurrences: 0, runs: 0, examples: [], runSet: new Set<string>() }
    row.occurrences++
    row.runSet.add(f.runId)
    if (f.bundle && row.examples.length < 2 && !row.examples.some(e => e.startsWith(f.runId + '/'))) row.examples.push(`${f.runId}/${f.bundle}`)
    sig.set(f.signature, row)
  }
  for (const r of runs) {
    const tf = r.terminalFailure
    if (!tf || isSuccess(r)) continue
    const row = sig.get(tf.signature) ?? { signature: tf.signature, class: tf.class, milestone: null, terminated: 0, occurrences: 0, runs: 0, examples: [], runSet: new Set<string>() }
    row.terminated++
    row.runSet.add(r.runId)
    if (tf.bundle && row.examples.length < 2 && !row.examples.some(e => e.startsWith(r.runId + '/'))) row.examples.push(`${r.runId}/${tf.bundle}`)
    sig.set(tf.signature, row)
  }
  // Runs that failed without any recorded failure get a synthetic signature so nothing disappears.
  for (const r of runs) {
    if (isSuccess(r) || r.terminalFailure) continue
    const key = `${r.outcome.toUpperCase()}|run|-|-|${r.outcomeReason.slice(0, 60)}`
    const row = sig.get(key) ?? { signature: key, class: r.outcome, milestone: null, terminated: 0, occurrences: 0, runs: 0, examples: [], runSet: new Set<string>() }
    row.terminated++
    row.occurrences++
    row.runSet.add(r.runId)
    sig.set(key, row)
  }
  const signatures = [...sig.values()]
    .map(({ runSet, ...row }) => ({ ...row, runs: runSet.size }))
    .sort((a, b) => b.terminated - a.terminated || b.occurrences - a.occurrences)

  const causes: Record<string, number> = {}
  let deathTotal = 0
  for (const r of runs) for (const d of r.deaths) { deathTotal++; const c = d.cause ?? 'unknown'; causes[c] = (causes[c] ?? 0) + 1 }

  const skills: BatchAggregate['skills'] = {}
  const skillDur: Record<string, number[]> = {}
  const skillFail: Record<string, Record<string, number>> = {}
  for (const r of runs) {
    for (const [id, s] of Object.entries(r.skills)) {
      const a = (skills[id] ??= { runs: 0, ok: 0, rate: 0, p50s: null, topFail: null })
      a.runs += s.runs
      a.ok += s.ok
      // No spread: one run can hold millions of durations (a runaway loop), which overflows the stack.
      const dur = (skillDur[id] ??= [])
      for (const d of s.durationsS) dur.push(d)
      const fc = (skillFail[id] ??= {})
      for (const [c, v] of Object.entries(s.failClasses)) fc[c] = (fc[c] ?? 0) + v
    }
  }
  for (const [id, a] of Object.entries(skills)) {
    a.rate = a.runs ? a.ok / a.runs : 0
    a.p50s = quantile(skillDur[id] ?? [], 0.5)
    a.topFail = Object.entries(skillFail[id] ?? {}).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
  }

  const nav = { calls: 0, ok: 0, rate: 0, cancelled: 0, stuck: 0, unreachable: 0, hazard: 0, timeout: 0, stuckEvents: 0, blocksTravelled: 0, stuckEventsPerKm: null as number | null, byProfile: {} as Record<string, { calls: number; ok: number }> }
  for (const r of runs) {
    nav.calls += r.nav.calls; nav.ok += r.nav.ok; nav.cancelled += r.nav.cancelled ?? 0; nav.stuck += r.nav.stuck; nav.unreachable += r.nav.unreachable
    nav.hazard += r.nav.hazard; nav.timeout += r.nav.timeout; nav.stuckEvents += r.nav.stuckEvents; nav.blocksTravelled += r.nav.blocksTravelled
    for (const [p, v] of Object.entries(r.nav.byProfile)) {
      const b = (nav.byProfile[p] ??= { calls: 0, ok: 0 })
      b.calls += v.calls; b.ok += v.ok
    }
  }
  // Calls cancelled by a preemption (an interrupt took over) are neither successes nor failures.
  const decided = nav.calls - nav.cancelled
  nav.rate = decided ? nav.ok / decided : 0
  nav.stuckEventsPerKm = nav.blocksTravelled > 0 ? Math.round((nav.stuckEvents / (nav.blocksTravelled / 1000)) * 10) / 10 : null

  const reasoner = { calls: 0, perRun: 0, fallbacks: 0, byKind: {} as Record<string, number> }
  for (const r of runs) {
    reasoner.calls += r.reasoner.calls; reasoner.fallbacks += r.reasoner.fallbacks
    for (const [kk, v] of Object.entries(r.reasoner.byKind)) reasoner.byKind[kk] = (reasoner.byKind[kk] ?? 0) + v
  }
  reasoner.perRun = runs.length ? Math.round((reasoner.calls / runs.length) * 10) / 10 : 0

  const trials = runs.flatMap(r => r.navbench ?? [])
  const flagIds: string[] = []
  for (const r of runs) for (const k of Object.keys(r.flags)) if (!flagIds.includes(k)) flagIds.push(k)
  const funnel = flagIds.map(id => {
    const ts = runs.map(r => r.flags[id]).filter((t): t is number => typeof t === 'number')
    return { id, reached: ts.length, p50: quantile(ts, 0.5), p90: quantile(ts, 0.9) }
  })
  return {
    n: runs.length,
    scored: n,
    outcomes,
    success: { k, n, rate: n ? k / n : 0, ci: wilson(k, n) },
    infraRate: runs.length ? (outcomes.infra_error ?? 0) / runs.length : 0,
    artifactsComplete: runs.filter(r => r.artifacts.complete).length,
    groundTruthMismatches: runs.filter(r => r.groundTruth.verified === false).map(r => r.runId),
    milestone: { id: target, reached: times.length, p50: quantile(times, 0.5), p90: quantile(times, 0.9), withinLimit: times.filter(t => t <= limitS).length, limitS },
    elapsed: { p50: quantile(elapsed, 0.5), p90: quantile(elapsed, 0.9), max: elapsed.length ? Math.max(...elapsed) : null },
    signatures,
    deaths: { total: deathTotal, perRun: runs.length ? deathTotal / runs.length : 0, causes },
    skills,
    nav,
    reasoner,
    navbench: trials.length ? aggregateNavBench(trials) : null,
    funnel,
    interventions: runs.reduce((a, r) => a + r.interventions, 0),
  }
}

export function aggregateNavBench (trials: NavBenchTrial[]): NavBenchAgg {
  const out: NavBenchAgg = {}
  const groups = new Map<string, NavBenchTrial[]>()
  for (const t of trials) {
    groups.set(t.kind, [...(groups.get(t.kind) ?? []), t])
    groups.set('all', [...(groups.get('all') ?? []), t])
  }
  for (const [kind, ts] of groups) {
    // Trials without a target or without a valid setup measure nothing about navigation.
    const scored = ts.filter(t => t.class !== 'NO_TARGET' && t.class !== 'SETUP_FAILED')
    const ok = scored.filter(t => t.ok)
    const blocks = scored.reduce((a, t) => a + t.blocksTravelled, 0)
    const okStraight = ok.reduce((a, t) => a + t.straightDist, 0)
    const okMs = ok.reduce((a, t) => a + t.ms, 0)
    const classes: Record<string, number> = {}
    for (const t of ts) if (!t.ok) classes[t.class ?? '?'] = (classes[t.class ?? '?'] ?? 0) + 1
    out[kind] = {
      trials: ts.length,
      ok: ok.length,
      rate: scored.length ? ok.length / scored.length : 0,
      ci: wilson(ok.length, scored.length),
      secPerBlock: okStraight > 0 ? Math.round((okMs / 1000 / okStraight) * 100) / 100 : null,
      stuckPerKm: blocks > 0 ? Math.round((scored.reduce((a, t) => a + t.stuckEvents, 0) / (blocks / 1000)) * 10) / 10 : null,
      km: Math.round(blocks) / 1000,
      classes,
      p50s: quantile(ok.map(t => t.ms / 1000), 0.5),
      p90s: quantile(ok.map(t => t.ms / 1000), 0.9),
    }
  }
  return out
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`

export function renderReport (meta: { batchId: string; seedSet: string; codeRev: string; dirty: boolean; scenario: string; reasoner: string; limitMin: number; date: string; server: Record<string, string>; fixture?: string | null; mcVersion?: string; java?: string }, agg: BatchAggregate, runs: RunSummary[]): string {
  const L: string[] = []
  L.push(`# Batch report — ${meta.batchId}`, '')
  if (meta.fixture) L.push(`> **Fixture batch (\`${meta.fixture}\`)**: the evaluator set up state with console commands. Development evidence only; never counts toward a gate.`, '')
  L.push(`- Seed set: \`${meta.seedSet}\` (fresh random seeds, evaluator-private) · n = ${agg.n} · scenario \`${meta.scenario}\` · reasoner \`${meta.reasoner}\``)
  L.push(`- Code: \`${meta.codeRev}\`${meta.dirty ? ' (dirty)' : ''} · limit ${meta.limitMin} min · ${meta.date}`)
  L.push(`- Server: vanilla ${meta.mcVersion ?? '?'}${meta.java ? ` (Java ${meta.java})` : ''}, difficulty=${meta.server.difficulty}, view-distance=${meta.server['view-distance']}, online-mode=${meta.server['online-mode']}, no ops`)
  L.push('', '**Anti-overfitting checklist:** no seed values, coordinates, structure offsets or per-seed branches in `src/`/`config/`; seeds never passed to the bot (env whitelist); bot has no ops and uses no commands; server log used only as evaluator ground truth; fixes target failure signatures, not runs.', '')

  L.push('## Outcomes', '')
  L.push('| outcome | count |', '|---|---|')
  for (const [o, c] of Object.entries(agg.outcomes).sort((a, b) => b[1] - a[1])) L.push(`| ${o} | ${c} |`)
  L.push('', `**Success: ${agg.success.k}/${agg.success.n} = ${pct(agg.success.rate)}** (Wilson 95% CI ${pct(agg.success.ci[0])}–${pct(agg.success.ci[1])}) · infra rate ${pct(agg.infraRate)} · complete artifacts ${agg.artifactsComplete}/${agg.n}` +
    (agg.groundTruthMismatches.length ? ` · **ground-truth mismatches: ${agg.groundTruthMismatches.join(', ')}**` : ' · ground truth agrees with bot on every run'), '')

  L.push('## Milestone funnel', '')
  const m = agg.milestone
  L.push(`| milestone | reached | within ${Math.round(m.limitS / 60)} min | p50 s | p90 s |`, '|---|---|---|---|---|')
  L.push(`| ${m.id} | ${m.reached}/${agg.n} | ${m.withinLimit}/${agg.n} | ${m.p50 ?? '–'} | ${m.p90 ?? '–'} |`, '')
  L.push(`Run wall time (bot): p50 ${agg.elapsed.p50 ?? '–'} s, p90 ${agg.elapsed.p90 ?? '–'} s, max ${agg.elapsed.max ?? '–'} s. Interventions: ${agg.interventions}.`, '')
  if (agg.funnel.length) {
    L.push('| flag (first reached) | reached | p50 s | p90 s | drop-off |', '|---|---|---|---|---|')
    let prev = agg.n
    for (const f of agg.funnel) {
      L.push(`| ${f.id} | ${f.reached}/${agg.n} | ${f.p50 ?? '–'} | ${f.p90 ?? '–'} | ${prev - f.reached > 0 ? '−' + (prev - f.reached) : '0'} |`)
      prev = f.reached
    }
    L.push('')
  }

  L.push('## Top failure signatures', '')
  if (!agg.signatures.length) L.push('_None._')
  else {
    L.push('| # | signature | class | terminated runs | occurrences | runs | example bundles |', '|---|---|---|---|---|---|---|')
    agg.signatures.slice(0, 12).forEach((s, i) => L.push(`| ${i + 1} | \`${s.signature}\` | ${s.class} | ${s.terminated} | ${s.occurrences} | ${s.runs} | ${s.examples.map(e => `\`${e}\``).join('<br>') || '–'} |`))
  }
  L.push('')

  L.push('## Deaths', '')
  L.push(`${agg.deaths.total} total, ${Math.round(agg.deaths.perRun * 100) / 100}/run.` + (Object.keys(agg.deaths.causes).length ? ' Causes: ' + Object.entries(agg.deaths.causes).map(([c, v]) => `${c} ×${v}`).join('; ') : ''), '')

  L.push('## Skills', '')
  L.push('| skill | runs | ok | rate | p50 s | top failure |', '|---|---|---|---|---|---|')
  for (const [id, s] of Object.entries(agg.skills)) L.push(`| ${id} | ${s.runs} | ${s.ok} | ${pct(s.rate)} | ${s.p50s ?? '–'} | ${s.topFail ?? '–'} |`)
  L.push('')

  L.push('## Navigation', '')
  const n = agg.nav
  L.push(`${n.calls} calls (${n.cancelled} cancelled by preemption), ${pct(n.rate)} of the rest ok (navigation failure rate ${pct(n.calls - n.cancelled ? 1 - n.rate : 0)}) · stuck ${n.stuck} · unreachable ${n.unreachable} · hazard ${n.hazard} · timeout ${n.timeout} · stuck events ${n.stuckEvents} (${n.stuckEventsPerKm ?? '–'}/km) · ${Math.round(n.blocksTravelled)} blocks travelled`)
  for (const [p, v] of Object.entries(n.byProfile)) L.push(`- profile \`${p}\`: ${v.ok}/${v.calls} ok`)
  L.push('')

  if (agg.navbench) {
    L.push('## Navigation benchmark', '')
    L.push('| target | trials | ok | rate (95% CI) | s/block | stuck/km | p50 s | p90 s | failures |', '|---|---|---|---|---|---|---|---|---|')
    for (const kind of ['surface30', 'surface100', 'surface300', 'cave', 'depth', 'all']) {
      const b = agg.navbench[kind]
      if (!b) continue
      L.push(`| ${kind} | ${b.trials} | ${b.ok} | ${pct(b.rate)} (${pct(b.ci[0])}–${pct(b.ci[1])}) | ${b.secPerBlock ?? '–'} | ${b.stuckPerKm ?? '–'} | ${b.p50s ?? '–'} | ${b.p90s ?? '–'} | ${Object.entries(b.classes).map(([c, v]) => `${c}×${v}`).join(', ') || '–'} |`)
    }
    L.push('')
  }

  L.push('## Reasoner', '')
  L.push(`${agg.reasoner.calls} calls (${agg.reasoner.perRun}/run, local ${meta.reasoner} reasoner, no model calls) · fallbacks ${agg.reasoner.fallbacks} · by kind: ${Object.entries(agg.reasoner.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || '–'}`, '')

  L.push('## Runs', '')
  L.push('| run | outcome | reason | M0 s | elapsed s | server start s | nav ok/calls | stuck ev | failures | GT |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const r of runs) {
    L.push(`| ${r.runId} | ${r.outcome} | ${r.outcomeReason.replace(/\|/g, '/').slice(0, 70)} | ${r.milestones[agg.milestone.id] ?? '–'} | ${r.elapsedS} | ${r.timing.serverStartS} | ${r.nav.ok}/${r.nav.calls} | ${r.nav.stuckEvents} | ${r.failures.total} | ${r.groundTruth.verified === null ? '?' : r.groundTruth.verified ? '✓' : '✗'} |`)
  }
  L.push('')
  return L.join('\n')
}
