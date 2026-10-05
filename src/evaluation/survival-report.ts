// Milestone A survival section of the batch report (evaluation.md §5, deaths): each
// death with the killer, what the bot was doing (interrupt or skill), the objective,
// its weapon and armor, and whether cover was attempted just before; ranged-threat
// cover outcomes kept apart from flee/defend; day/night scheduling decisions; and
// OBJECTIVE_NOT_SATISFIED counts. Runs from before the `death_context` event get the
// same row derived from their event stream (objective, open interrupt, lost items).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunSummary } from '../schema/index.js'

type Ev = { t: number; tick: number; type: string; data: Record<string, unknown> }
export type DeathRow = { runId: string; t: number; killer: string; cause: string; during: string; objective: string; weapon: string; armor: number; night: boolean; cover: string }

const MAX_EVENTS_BYTES = 256 * 1024 * 1024
const WANTED = /"type":"(death|death_context|cover|schedule|objective|interrupt_start|interrupt_end|failure|food_risk|respawn_plan|inventory_retry|effects_reset)"/
/** Inventory clicks the server rejected and the skill could not absorb (B gate 20261002: 26). */
const REJECTED = /"type":"skill_end".*rejected transaction/
/** Two deaths of one run closer than this are a cascade. */
export const CASCADE_S = 300
/** P1 interrupts on drowned this close together belong to one encounter. */
const ENCOUNTER_GAP_S = 60
const FOOD_OBJECTIVES = new Set(['food', 'food_buffer', 'emergency_food'])

export function killerOf (cause: string): string {
  const m = cause.match(/by (?:a |an )?([A-Z][A-Za-z ]+?)(?: using| whilst|$)/)
  if (m) return m[1]!.toLowerCase().replace(/ /g, '_')
  if (/drowned$/.test(cause)) return 'drowning'
  if (/lava/.test(cause)) return 'lava'
  if (/fell|high place/.test(cause)) return 'fall'
  if (/berry bush/.test(cause)) return 'sweet_berry_bush'
  return 'other'
}

function readEvents (runDir: string): Ev[] {
  const p = join(runDir, 'events.jsonl')
  if (!existsSync(p) || statSync(p).size > MAX_EVENTS_BYTES) return []
  const out: Ev[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!WANTED.test(line) && !REJECTED.test(line)) continue
    try { out.push(JSON.parse(line) as Ev) } catch { /* partial line */ }
  }
  return out
}

const WEAPONS = ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword', 'iron_axe', 'stone_axe', 'wooden_axe']
const ARMOR_PTS: Record<string, number> = { iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2, leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1, golden_helmet: 2, chainmail_helmet: 2 }

export function deathRows (runId: string, events: Ev[]): DeathRow[] {
  const rows: DeathRow[] = []
  let objective = '-'
  let interrupt: string | null = null
  let lastCover: { t: number; ok: boolean; method: string } | null = null
  const ctxs = events.filter(e => e.type === 'death_context')
  let ci = 0
  for (const e of events) {
    const d = e.data
    if (e.type === 'objective' && typeof d.id === 'string') objective = d.id
    else if (e.type === 'interrupt_start' && typeof d.id === 'string') interrupt = d.id
    else if (e.type === 'interrupt_end') interrupt = null
    else if (e.type === 'cover' && !d.step) lastCover = { t: e.t, ok: Boolean(d.ok), method: String(d.method) }
    else if (e.type === 'death') {
      const cause = String(d.message ?? 'unknown').replace(/^Bot /, '')
      const lost = (d.lost ?? {}) as Record<string, number>
      const ctx = ctxs.find((c, i) => i >= ci && c.t >= e.t && c.t - e.t < 10)
      if (ctx) ci = ctxs.indexOf(ctx) + 1
      const c = (ctx?.data ?? {}) as Record<string, unknown>
      const tod = typeof c.timeOfDay === 'number' ? c.timeOfDay : e.tick % 24000
      const cov = (c.cover ?? (lastCover && e.t - lastCover.t <= 20 ? lastCover : null)) as { ok: boolean; method: string } | null
      rows.push({
        runId, t: e.t, cause, killer: killerOf(cause),
        during: String(c.interrupt ?? interrupt ?? 'objective'),
        objective: String(c.objective ?? c.lastObjective ?? objective),
        weapon: String(c.weapon ?? (WEAPONS.find(w => lost[w]) ?? 'hand')),
        armor: typeof c.armor === 'number' ? c.armor : Object.keys(lost).reduce((a, k) => a + (ARMOR_PTS[k] ?? 0), 0),
        night: tod >= 13_000 && tod < 23_000,
        cover: cov ? `${cov.method}${cov.ok ? '' : ' (failed)'}` : '–',
      })
    }
  }
  return rows
}

/** Death-cascade figures (B round 2): repeat deaths, deaths before nether_ready, what follows a respawn. */
export type CascadeStats = { deaths: number; beforeA: number; afterFirst: number; within5: number; cascadeRuns: number; respawnObjectives: Record<string, number>; woodStalls: number; woodStallRuns: number; rejected: number; rejectedRuns: number; retried: number; effectsReset: number }

export function cascadeStats (perRun: { deaths: DeathRow[]; aAt: number | null; events: Ev[] }[]): CascadeStats {
  const st: CascadeStats = { deaths: 0, beforeA: 0, afterFirst: 0, within5: 0, cascadeRuns: 0, respawnObjectives: {}, woodStalls: 0, woodStallRuns: 0, rejected: 0, rejectedRuns: 0, retried: 0, effectsReset: 0 }
  for (const r of perRun) {
    st.deaths += r.deaths.length
    st.beforeA += r.deaths.filter(d => r.aAt === null || d.t < r.aAt).length
    st.afterFirst += Math.max(0, r.deaths.length - 1)
    const quick = r.deaths.filter((d, i) => i > 0 && d.t - r.deaths[i - 1]!.t < CASCADE_S).length
    st.within5 += quick
    if (quick) st.cascadeRuns++
    let stalls = 0
    let rej = 0
    for (const e of r.events) {
      if (e.type === 'respawn_plan') { const k = String(e.data.shelter ? 'shelter' : e.data.objective ?? 'none'); st.respawnObjectives[k] = (st.respawnObjectives[k] ?? 0) + 1 }
      if (e.type === 'failure' && e.data.class === 'STALLED' && /step=collect/.test(String(e.data.signature ?? ''))) stalls++
      if (e.type === 'skill_end' && /rejected transaction/.test(JSON.stringify(e.data.failure ?? ''))) rej++
      if (e.type === 'inventory_retry') st.retried++
      if (e.type === 'effects_reset') st.effectsReset++
    }
    st.woodStalls += stalls
    if (stalls) st.woodStallRuns++
    st.rejected += rej
    if (rej) st.rejectedRuns++
  }
  return st
}

export function renderSurvival (dir: string, runs: RunSummary[]): string {
  const deaths: DeathRow[] = []
  const perRun: { deaths: DeathRow[]; aAt: number | null; events: Ev[] }[] = []
  const cover: Record<string, { n: number; ok: number }> = {}
  const coverWhy: Record<string, number> = {}
  const sched: Record<string, number> = {}
  let notSatisfied = 0
  const risk: Record<string, number> = {}
  let encounters = 0
  let encounterRuns = 0
  for (const r of runs) {
    const ev = readEvents(join(dir, r.runId))
    const rows = deathRows(r.runId, ev)
    deaths.push(...rows)
    perRun.push({ deaths: rows, aAt: (r.milestones as Record<string, number | null> | undefined)?.A ?? null, events: ev })
    let lastDrowned = -Infinity
    let runEncounters = 0
    for (const e of ev) {
      if (e.type === 'food_risk') { const k = e.data.kind === 'rejected' ? `rejected:${String(e.data.why)}` : String(e.data.kind); risk[k] = (risk[k] ?? 0) + 1 }
      if (e.type === 'interrupt_start' && e.data.priority === 1 && /^drowned@/.test(String(e.data.reason ?? ''))) {
        if (e.t - lastDrowned > ENCOUNTER_GAP_S) runEncounters++
        lastDrowned = e.t
      }
      if (e.type === 'cover' && !e.data.step) {
        const m = String(e.data.method)
        const c = (cover[m] ??= { n: 0, ok: 0 })
        c.n++
        if (e.data.ok) c.ok++
        else coverWhy[String(e.data.why)] = (coverWhy[String(e.data.why)] ?? 0) + 1
      }
      if (e.type === 'schedule') sched[String(e.data.mode)] = (sched[String(e.data.mode)] ?? 0) + 1
      if (e.type === 'failure' && e.data.class === 'OBJECTIVE_NOT_SATISFIED') notSatisfied++
    }
    encounters += runEncounters
    if (runEncounters) encounterRuns++
  }
  const L: string[] = ['## Survival (milestone A)', '']
  const n = deaths.length
  const count = (f: (d: DeathRow) => boolean) => deaths.filter(f).length
  const by = (k: (d: DeathRow) => string) => {
    const m: Record<string, number> = {}
    for (const d of deaths) m[k(d)] = (m[k(d)] ?? 0) + 1
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([a, v]) => `${a} ×${v}`).join(', ') || '–'
  }
  L.push(`${n} deaths in ${new Set(deaths.map(d => d.runId)).size} runs. By killer: ${by(d => d.killer)}.`, '')
  L.push(`- during: ${by(d => d.during)}`)
  L.push(`- objective: ${by(d => d.objective)}`)
  L.push(`- food objectives: ${count(d => FOOD_OBJECTIVES.has(d.objective))} · at night: ${count(d => d.night)} · during flee: ${count(d => d.during === 'flee')} · during cover: ${count(d => d.during === 'cover')}`)
  L.push(`- weapon: ${by(d => d.weapon)} · armor points: ${by(d => String(d.armor))}`)
  L.push(`- cover attempted ≤ 20 s before: ${by(d => d.cover)}`, '')
  if (n) {
    L.push('| run | t | killer | during | objective | weapon | armor | night | cover |', '|---|---|---|---|---|---|---|---|---|')
    for (const d of deaths) L.push(`| ${d.runId.replace(/^.*-(r\d+)$/, '$1')} | ${Math.round(d.t)} | ${d.killer} | ${d.during} | ${d.objective} | ${d.weapon} | ${d.armor} | ${d.night ? 'yes' : ''} | ${d.cover} |`)
    L.push('')
  }
  const tot = Object.values(cover).reduce((a, c) => a + c.n, 0)
  const ok = Object.values(cover).reduce((a, c) => a + c.ok, 0)
  L.push(`**Ranged-threat cover:** ${tot} attempts, ${ok} ok${tot ? ` (${Math.round((ok / tot) * 100)} %)` : ''}. By method: ${Object.entries(cover).map(([m, c]) => `${m} ${c.ok}/${c.n}`).join(', ') || '–'}. Failures: ${Object.entries(coverWhy).map(([w, v]) => `${w} ×${v}`).join(', ') || '–'}.`, '')
  const drownedDeaths = count(d => d.killer === 'drowned')
  L.push(`**Shoreline / drowned:** ${encounters} drowned encounters in ${encounterRuns} runs (P1 responses ≤ ${ENCOUNTER_GAP_S} s apart = one) · drowned deaths ${drownedDeaths} (${count(d => d.killer === 'drowned' && FOOD_OBJECTIVES.has(d.objective))} in food objectives) · food targets: ${Object.entries(risk).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ') || '–'}`, '')
  L.push(`**Day/night schedule:** ${Object.entries(sched).map(([m, v]) => `${m} ×${v}`).join(', ') || '–'} · OBJECTIVE_NOT_SATISFIED: ${notSatisfied}`, '')
  const c = cascadeStats(perRun)
  L.push(`**Death cascades:** ${c.deaths} deaths, ${c.beforeA} before nether_ready, ${c.afterFirst} after a run's first death · repeat deaths < ${CASCADE_S / 60} min after the previous one: ${c.within5} (in ${c.cascadeRuns} runs) · first objective after a respawn: ${Object.entries(c.respawnObjectives).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ') || '–'}`, '')
  L.push(`**Wood-search stalls** (STALLED at step=collect): ${c.woodStalls} in ${c.woodStallRuns} runs · stale client effects cleared on respawn: ${c.effectsReset}`, '')
  L.push(`**Inventory click rejections:** ${c.rejected} skill failures in ${c.rejectedRuns} runs · retried and absorbed: ${c.retried}`, '')
  return L.join('\n')
}
