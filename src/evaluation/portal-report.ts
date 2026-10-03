// Milestone B section of the batch report (evaluation.md §5): the time from
// nether_ready to portal, Nether entry, excursion and return; portal strategy
// usage and success; cast and lava-fetch steps; lava-pool search; Nether arrivals,
// excursions, deaths and retreats; ground-truth checks. Built from summary flags
// and each run's events.jsonl (portal, nether, lava_search, recovery_step events).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunSummary } from '../schema/index.js'
import { quantile } from './report.js'

type Ev = { t: number; type: string; data: Record<string, unknown> }
const WANTED = /"type":"(portal|nether|lava_search|recovery_step|dimension_change)"/
const MAX_EVENTS_BYTES = 256 * 1024 * 1024

function readEvents (runDir: string): Ev[] {
  const p = join(runDir, 'events.jsonl')
  if (!existsSync(p) || statSync(p).size > MAX_EVENTS_BYTES) return []
  const out: Ev[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!WANTED.test(line)) continue
    try { out.push(JSON.parse(line) as Ev) } catch { /* partial line */ }
  }
  return out
}

const inc = (m: Record<string, number>, k: string, by = 1) => { m[k] = (m[k] ?? 0) + by }
const fmt = (xs: number[]) => { const a = quantile(xs, 0.5); const b = quantile(xs, 0.9); return a === null ? '–' : `${a} / ${b}` }
const top = (m: Record<string, number>, n = 6) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ×${v}`).join('; ') || '–'

export function renderPortal (dir: string, runs: RunSummary[]): string {
  const L: string[] = ['## Milestone B: portal and Nether trip', '']
  const legs: Record<string, number[]> = { 'nether_ready → portal_built': [], 'portal_built → in_nether': [], 'in_nether → excursion': [], 'excursion → return_ok': [], 'nether_ready → return_ok': [] }
  const pairs: [string, string, string][] = [['nether_ready', 'portal_built', 'nether_ready → portal_built'], ['portal_built', 'in_nether', 'portal_built → in_nether'], ['in_nether', 'excursion', 'in_nether → excursion'], ['excursion', 'return_ok', 'excursion → return_ok'], ['nether_ready', 'return_ok', 'nether_ready → return_ok']]
  const strategyUsed: Record<string, number> = {}
  const strategyBuilt: Record<string, number> = {}
  const siteFail: Record<string, number> = {}
  const poolRejected: Record<string, number> = {}
  const casts = { ok: 0, fail: 0 }
  const fetches = { ok: 0, fail: 0 }
  const arrivals: { lava: number; safeCells: number }[] = []
  const excursion: Record<string, number> = {}
  const nether: Record<string, number> = {}
  let retreats = 0
  let reachedA = 0
  let netherDeaths = 0
  const netherDeathCauses: Record<string, number> = {}
  const gt = { checked: 0, ok: 0, mismatch: [] as string[] }
  const rows: string[] = []
  for (const r of runs) {
    const f = r.flags
    if (f.nether_ready != null) reachedA++
    for (const [a, b, k] of pairs) if (typeof f[a] === 'number' && typeof f[b] === 'number') legs[k]!.push(Math.round((f[b]! - f[a]!) * 10) / 10)
    for (const d of r.deaths) if (d.dim === 'the_nether') { netherDeaths++; inc(netherDeathCauses, (d.cause ?? 'unknown').replace(/^Bot /, '')) }
    if (r.outcome === 'goal_reached') { gt.checked++; if (r.groundTruth.verified !== false) gt.ok++; else gt.mismatch.push(r.runId) }
    const ev = readEvents(join(dir, r.runId))
    let strat = '-'
    for (const e of ev) {
      const d = e.data
      if (e.type === 'portal') {
        if (d.kind === 'strategy') { inc(strategyUsed, String(d.strategy)); strat = String(d.strategy) }
        else if (d.kind === 'built') inc(strategyBuilt, String(d.strategy))
        else if (d.kind === 'site_failure') inc(siteFail, String(d.reason).slice(0, 60))
        else if (d.kind === 'cast') d.ok ? casts.ok++ : casts.fail++
        else if (d.kind === 'lava_fetch') d.ok ? fetches.ok++ : fetches.fail++
        else if (d.kind === 'unlit' || d.kind === 'relight') inc(nether, `portal_${String(d.kind)}${d.kind === 'relight' ? (d.ok ? '_ok' : '_failed') : ''}`)
      } else if (e.type === 'lava_search' && d.kind === 'pool_rejected') inc(poolRejected, String(d.why))
      else if (e.type === 'nether') {
        if (d.kind === 'arrival' && d.dim === 'the_nether') arrivals.push({ lava: Number(d.lava ?? 0), safeCells: Number(d.safeCells ?? 0) })
        else if (d.kind === 'excursion') inc(excursion, String(d.via))
        else if (d.kind === 'excursion_leg' && !d.ok) inc(nether, `excursion_leg_${String(d.class)}`)
        else if (typeof d.kind === 'string') inc(nether, d.kind)
      } else if (e.type === 'recovery_step' && d.action === 'retreat') retreats++
    }
    const t = (k: string) => (typeof f[k] === 'number' ? String(Math.round(f[k]!)) : '–')
    rows.push(`| ${r.runId.slice(-3)} | ${r.outcome} | ${t('nether_ready')} | ${t('portal_built')} | ${t('in_nether')} | ${t('excursion')} | ${t('return_ok')} | ${strat} | ${r.deaths.length} | ${r.groundTruth.verified === null ? '–' : r.groundTruth.verified ? 'ok' : 'MISMATCH'} |`)
  }
  L.push(`Reached nether_ready: ${reachedA}/${runs.length}. Ground truth on B claims: ${gt.ok}/${gt.checked} verified${gt.mismatch.length ? ` (mismatch: ${gt.mismatch.join(', ')})` : ''}.`, '')
  L.push('| leg | n | p50 / p90 s |', '|---|---|---|')
  for (const [k, xs] of Object.entries(legs)) L.push(`| ${k} | ${xs.length} | ${fmt(xs)} |`)
  L.push('')
  L.push(`- **Portal strategy** chosen: ${top(strategyUsed)}; built: ${top(strategyBuilt)}.`)
  L.push(`- **Cast steps:** ${casts.ok} cells cast, ${casts.fail} failed attempts. **Lava fetches:** ${fetches.ok} ok, ${fetches.fail} failed.`)
  L.push(`- **Site failures:** ${top(siteFail)}.`)
  L.push(`- **Lava pools rejected:** ${top(poolRejected)}.`)
  const al = arrivals.map(a => a.lava)
  L.push(`- **Nether arrivals:** ${arrivals.length}; lava within 3 blocks p50/p90 ${fmt(al)}; arrivals with no safe cell nearby: ${arrivals.filter(a => a.safeCells === 0).length}.`)
  L.push(`- **Excursions:** ${top(excursion)}. Nether events: ${top(nether, 8)}. Retreats through the portal: ${retreats}.`)
  L.push(`- **Nether deaths:** ${netherDeaths}${netherDeaths ? ` (${top(netherDeathCauses)})` : ''}.`, '')
  L.push('| run | outcome | nether_ready | portal_built | in_nether | excursion | return_ok | strategy | deaths | GT |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, '')
  return L.join('\n')
}
