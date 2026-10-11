// Milestone C section of the batch report (evaluation.md §5): the legs from B to the
// fortress, rods, pearls and the return; fortress search (legs, travel mode, time);
// blaze fights (kills, retreats, deaths, failures); gold and bartering (ingots given,
// pearls from barter, refusals, provoked piglins); the enderman alternate; Nether
// deaths; the return trip (trail); reasoner calls and infra errors. Built from summary
// flags and each run's events.jsonl.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunSummary } from '../schema/index.js'
import { quantile } from './report.js'

type Ev = { t: number; type: string; data: Record<string, unknown> }
const WANTED = /"type":"(barter|fortress|blaze|enderman|trail|objective|recovery_step|death_context|failure|skill_end|item_delta|bastion|stash|location_discovered|dimension_change|death)"/
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

export type CRunStats = {
  searchLegs: number; legsVia: Record<string, number>; barterGiven: number; barterPearls: number; barterSkillPearls: number; refused: number; provoked: number; goldSkips: number; piglinsUnreachable: number
  blazeKills: number; blazeRetreats: number; potions: number; endermanKills: number; endermenStrategy: boolean; trail: Record<string, number>
  objectiveTime: Record<string, number>; resupplies: number
  /** C round 2 (opportunity route, bastion gold, death recovery). */
  route: string | null; firstStructure: { kind: string; t: number } | null
  bastionBlocks: number; bastionChests: number; bastionChestIngots: number; bastionGuarded: number; oreIngots: number
  cDeaths: number; recoveries: number[]; stash: boolean; bed: boolean; respawnAtBed: number; kitTaken: number
}

/** The C route a run took: the first route-setting objective after its C re-entry (policy cRoute). */
function routeOf (objs: { id: string; skill: string }[]): string | null {
  for (const o of objs) {
    // Fortress-first barters for a fire resistance potion (gold from ore) before the rods (ckit-r2b r02).
    if (o.id === 'c_rods' || o.id === 'c_fire_res') return 'fortress-first'
    if (o.id === 'c_gold' && o.skill === 'bastionGold') return 'bastion-first'
    if (o.id === 'c_structure') {
      const next = routeOf(objs.slice(objs.indexOf(o) + 1).filter(x => x.id !== 'c_structure'))
      return `search→${next ?? '?'}`
    }
    if (o.id === 'c_pearls') return 'piglins/ore'
  }
  return objs.some(o => o.id === 'c_gold') ? 'piglins/ore' : null
}

/** Per-run milestone C statistics from its event stream (exported for tests). */
export function cRunStats (ev: Ev[]): CRunStats {
  const st: CRunStats = { searchLegs: 0, legsVia: {}, barterGiven: 0, barterPearls: 0, barterSkillPearls: 0, refused: 0, provoked: 0, goldSkips: 0, piglinsUnreachable: 0, blazeKills: 0, blazeRetreats: 0, potions: 0, endermanKills: 0, endermenStrategy: false, trail: {}, objectiveTime: {}, resupplies: 0,
    route: null, firstStructure: null, bastionBlocks: 0, bastionChests: 0, bastionChestIngots: 0, bastionGuarded: 0, oreIngots: 0, cDeaths: 0, recoveries: [], stash: false, bed: false, respawnAtBed: 0, kitTaken: 0 }
  // The C trip starts at the first Nether entry after B (cEntries); route objectives and deaths count from there.
  const bAt = ev.find(e => e.type === 'objective' && String(e.data.id).startsWith('c_'))?.t ?? null
  const cEntry = bAt === null ? null : ev.find(e => e.type === 'dimension_change' && e.t >= bAt && e.data.to === 'the_nether' && e.data.cause === 'portal')?.t ?? null
  const routeObjs: { id: string; skill: string }[] = []
  let deadAt: number | null = null
  let nuggets = 0
  for (const e of ev) {
    const d = e.data
    if (e.type === 'location_discovered' && (d.kind === 'fortress' || d.kind === 'bastion') && !st.firstStructure) st.firstStructure = { kind: String(d.kind), t: e.t }
    if (e.type === 'objective' && cEntry !== null && e.t >= cEntry && ['c_rods', 'c_gold', 'c_pearls', 'c_structure', 'c_fire_res'].includes(String(d.id))) routeObjs.push({ id: String(d.id), skill: String(d.skill) })
    if (e.type === 'bastion') {
      if (d.kind === 'gold_block' && d.picked) st.bastionBlocks++
      else if (d.kind === 'chest') { st.bastionChests++; st.bastionChestIngots += Number(d.ingots ?? 0) }
      else if (d.kind === 'guarded') st.bastionGuarded++
    }
    if (e.type === 'stash') {
      if (d.kind === 'staged') st.stash = true
      else if (d.kind === 'bed' && d.set) st.bed = true
      else if (d.kind === 'respawn_at_bed') st.respawnAtBed++
      else if (d.kind === 'taken') st.kitTaken++
    }
    if (e.type === 'death' && cEntry !== null && e.t >= cEntry) { st.cDeaths++; deadAt = e.t }
    if (e.type === 'dimension_change' && deadAt !== null && d.to === 'the_nether' && d.cause === 'portal') { st.recoveries.push(Math.round(e.t - deadAt)); deadAt = null }
    if (e.type === 'item_delta' && cEntry !== null && e.t >= cEntry) {
      const k = Number((d.delta as Record<string, number> | undefined)?.gold_nugget ?? 0)
      if (k > 0) nuggets += k
    }
    if (e.type === 'fortress') {
      if (d.kind === 'search') st.searchLegs++
      else if (d.kind === 'leg') inc(st.legsVia, `${String(d.for)}:${String(d.via)}:${d.ok ? 'ok' : 'fail'}`)
    } else if (e.type === 'barter') {
      if (d.kind === 'give') st.barterGiven++
      else if (d.kind === 'pearls') st.barterSkillPearls += Number(d.gained ?? 0)
      else if (d.kind === 'refused') st.refused++
      else if (d.kind === 'provoked') st.provoked++
      else if (d.kind === 'gold_skip') st.goldSkips++
      else if (d.kind === 'unreachable') st.piglinsUnreachable++
    } else if (e.type === 'blaze') {
      if (d.kind === 'kill') st.blazeKills++
      else if (d.kind === 'retreat') st.blazeRetreats++
      else if (d.kind === 'potion' && d.ok) st.potions++
    } else if (e.type === 'item_delta') {
      // Pearls picked up by any skill or the P2 pickup (barter loot often lands while another skill runs).
      const k = Number((d.delta as Record<string, number> | undefined)?.ender_pearl ?? 0)
      if (k > 0) st.barterPearls += k
    } else if (e.type === 'enderman' && d.kind === 'kill') st.endermanKills++
    else if (e.type === 'trail') inc(st.trail, String(d.kind))
    else if (e.type === 'objective' && d.id === 'c_pearls' && d.strategy === 'endermen') st.endermenStrategy = true
    else if (e.type === 'recovery_step' && d.action === 'resupply') st.resupplies++
    else if (e.type === 'skill_end' && d.depth === 0 && typeof d.durationMs === 'number') {
      const sk = String(d.skill)
      if (['findFortress', 'collectBlazeRods', 'barterPearls', 'huntEndermen'].includes(sk)) inc(st.objectiveTime, sk, Math.round(Number(d.durationMs) / 1000))
    }
  }
  st.route = routeOf(routeObjs)
  // Nuggets picked up in the C trip (nether gold ore; chest nuggets are a small part), as ingots.
  st.oreIngots = Math.floor(nuggets / 9)
  return st
}

export function renderC (dir: string, runs: RunSummary[]): string {
  const L: string[] = ['## Milestone C: fortress, blaze rods, ender pearls, return', '']
  const pairs: [string, string][] = [['B', 'c_reentered'], ['c_reentered', 'fortress_found'], ['fortress_found', 'rod_1'], ['rod_1', 'rods_7'], ['c_reentered', 'pearl_1'], ['c_reentered', 'pearls_14'], ['c_kit', 'C'], ['B', 'C']]
  const legs: Record<string, number[]> = {}
  const reached: Record<string, number> = {}
  const netherDeathCauses: Record<string, number> = {}
  const deathObjective: Record<string, number> = {}
  const legsVia: Record<string, number> = {}
  const trail: Record<string, number> = {}
  let netherDeaths = 0
  let blazeDeaths = 0
  let given = 0
  let pearlsBarter = 0
  let refused = 0
  let provoked = 0
  let goldSkips = 0
  let unreachable = 0
  let kills = 0
  let retreats = 0
  let potions = 0
  let ekills = 0
  let endermenRuns = 0
  let resupplies = 0
  let searchLegs = 0
  let returnOk = 0
  let kitRuns = 0
  let infra = 0
  let reasoner = 0
  const rows: string[] = []
  const rows2: string[] = []
  const routes: Record<string, number> = {}
  const recov: number[] = []
  const toPearls: number[] = []
  const toRods: number[] = []
  let cDeaths = 0
  for (const r of runs) {
    const f = { ...r.flags, ...r.milestones }
    for (const k of ['B', 'c_reentered', 'piglins_seen', 'pearl_1', 'pearls_14', 'fortress_found', 'blaze_spawner_found', 'rod_1', 'rods_7', 'c_kit', 'C']) if (typeof f[k] === 'number') inc(reached, k)
    for (const [a, b] of pairs) if (typeof f[a] === 'number' && typeof f[b] === 'number') (legs[`${a} → ${b}`] ??= []).push(Math.round(f[b]! - f[a]!))
    if (r.outcome === 'infra_error') infra++
    reasoner += r.reasoner.calls
    if (typeof f.c_kit === 'number') { kitRuns++; if (typeof f.C === 'number') returnOk++ }
    for (const d of r.deaths) if (d.dim === 'the_nether' && typeof f.B === 'number' && d.t >= f.B!) { netherDeaths++; inc(netherDeathCauses, (d.cause ?? 'unknown').replace(/^Bot /, '')) }
    const ev = readEvents(join(dir, r.runId))
    for (const e of ev) {
      if (e.type === 'death_context' && typeof f.B === 'number' && e.t >= f.B!) {
        inc(deathObjective, String(e.data.lastObjective ?? e.data.objective ?? '-'))
        if (e.data.lastObjective === 'c_rods' || /blaze/i.test(String(e.data.cause ?? ''))) blazeDeaths++
      }
    }
    const st = cRunStats(ev)
    given += st.barterGiven; pearlsBarter += st.barterPearls; refused += st.refused; provoked += st.provoked; goldSkips += st.goldSkips; unreachable += st.piglinsUnreachable
    kills += st.blazeKills; retreats += st.blazeRetreats; potions += st.potions; ekills += st.endermanKills; resupplies += st.resupplies; searchLegs += st.searchLegs
    if (st.endermenStrategy) endermenRuns++
    for (const [k, v] of Object.entries(st.legsVia)) inc(legsVia, k, v)
    for (const [k, v] of Object.entries(st.trail)) inc(trail, k, v)
    const inv = r.groundTruth.inventory ?? {}
    const t = (k: string) => (typeof f[k] === 'number' ? String(Math.round(f[k]!)) : '–')
    const since = (k: string, from = 'c_reentered') => (typeof f[k] === 'number' && typeof f[from] === 'number' ? Math.round(f[k]! - f[from]!) : null)
    if (st.route) inc(routes, st.route)
    recov.push(...st.recoveries)
    cDeaths += st.cDeaths
    const tp = since('pearls_14'); const tr = since('rods_7')
    if (tp !== null) toPearls.push(tp)
    if (tr !== null) toRods.push(tr)
    const fs = st.firstStructure ? `${st.firstStructure.kind} ${Math.round(st.firstStructure.t)}` : '–'
    rows2.push(`| ${r.runId.slice(-3)} | ${since('C', 'B') ?? '–'} | ${fs} | ${st.route ?? '–'} | ${st.bastionBlocks}×9 + ${st.bastionChestIngots} (${st.bastionChests} chests, ${st.bastionGuarded} guarded) / ore ≈${st.oreIngots} | ${since('gold_ingot_n') ?? '–'} | ${st.barterGiven} / ${st.barterPearls} | ${tp ?? '–'} | ${tr ?? '–'} | ${st.cDeaths} | ${st.recoveries.join(', ') || '–'} | ${st.stash ? 'kit' : '–'}${st.bed ? '+bed' : ''}${st.respawnAtBed ? ` (${st.respawnAtBed} bed respawns)` : ''} | ${typeof f.C === 'number' ? 'yes' : typeof f.c_kit === 'number' ? 'no' : '–'} |`)
    rows.push(`| ${r.runId.slice(-3)} | ${r.outcome} | ${t('B')} | ${t('c_reentered')} | ${t('fortress_found')} | ${t('rods_7')} | ${t('pearls_14')} | ${t('C')} | ${inv.blaze_rod ?? 0}/${inv.ender_pearl ?? 0} | ${st.barterGiven}→${st.barterPearls} | ${st.blazeKills} | ${r.deaths.length} | ${r.groundTruth.verified === null ? '–' : r.groundTruth.verified ? 'ok' : 'MISMATCH'} |`)
  }
  const n = runs.length
  L.push(`Reached (of ${n}): ${['B', 'c_reentered', 'piglins_seen', 'pearl_1', 'pearls_14', 'fortress_found', 'blaze_spawner_found', 'rod_1', 'rods_7', 'c_kit', 'C'].map(k => `${k} ${reached[k] ?? 0}`).join(' · ')}.`, '')
  L.push('| leg | n | p50 / p90 s |', '|---|---|---|')
  for (const [k, xs] of Object.entries(legs)) L.push(`| ${k} | ${xs.length} | ${fmt(xs)} |`)
  L.push('')
  L.push(`- **Fortress search:** ${searchLegs} search legs; legs by purpose/mode: ${top(legsVia, 10)}.`)
  L.push(`- **Blazes:** ${kills} kills, ${retreats} retreats, ${potions} fire resistance potions drunk, ${blazeDeaths} deaths in the rods objective or to blazes.`)
  L.push(`- **Gold and bartering:** ${given} ingots given → ${pearlsBarter} pearls picked up (all sources; endermen are listed below) (${given ? (pearlsBarter / given).toFixed(3) : '–'} per ingot; 1.16.1 expectation 0.284). ${refused} refusals, ${provoked} piglin provocations, ${goldSkips} gold digs skipped (piglins watching), ${unreachable} piglins left as unreachable, ${resupplies} gold resupply hand-overs.`)
  L.push(`- **Enderman alternate:** used in ${endermenRuns}/${n} runs, ${ekills} endermen killed.`)
  L.push(`- **Nether deaths after B:** ${netherDeaths}${netherDeaths ? ` (${top(netherDeathCauses)})` : ''}; deaths after B by objective: ${top(deathObjective)}.`)
  L.push(`- **Return:** ${returnOk}/${kitRuns} runs holding rods and pearls got back to the Overworld (C). Trail events: ${top(trail)}.`)
  L.push(`- **Reasoner calls:** ${reasoner} (reasoner=none). **Infra errors:** ${infra}/${n}.`, '')
  L.push('| run | outcome | B | c_reentered | fortress | rods_7 | pearls_14 | C | GT rods/pearls | gold→pearls | blaze kills | deaths | GT |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows, '')
  L.push(`**C route and recovery (round 2 metrics).** Routes: ${top(routes)}. Re-entry → 14 pearls p50/p90 ${fmt(toPearls)} s; re-entry → 7 rods ${fmt(toRods)} s. C-phase deaths ${cDeaths}; death → back in the Nether ${fmt(recov)} s (n = ${recov.length}).`, '')
  L.push('| run | B→C s | first structure (kind, t) | route | gold: bastion blocks + chest ingots / ore | re-entry → first ingot s | ingots given / pearls | re-entry → 14 pearls s | re-entry → 7 rods s | C deaths | death → re-entry s | kit / bed | returned |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows2, '')
  return L.join('\n')
}
