// Resource-search section of the batch report (B round 3, evaluation.md): time and
// distance the bot spent acquiring wood, gravel (for flint) and food, the search
// relocations and exhausted regions behind them, remembered-spot visits, raw food
// eaten versus cooked, night time sheltering versus night fillers, and completion of
// food_10, flint and steel and nether_ready. Built from each run's events.jsonl and
// summary flags; runs from before round 3 show 0 relocations and fillers.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunSummary } from '../schema/index.js'
import { quantile } from './report.js'

type Ev = { t: number; type: string; data: Record<string, unknown> }
const WANTED = /"type":"(skill_start|skill_end|nav_end|search_relocation|search_region|search_step|schedule|objective|item_delta|interrupt_start)"/
const MAX_EVENTS_BYTES = 256 * 1024 * 1024
const RAW = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'])

export type Resource = 'wood' | 'gravel' | 'food'
export type ResourceRun = {
  timeS: Record<Resource, number>
  blocks: Record<Resource, number>
  relocations: Record<string, number>
  regions: Record<string, number>
  spotVisits: Record<string, number>
  shelterS: number
  fillers: Record<string, number>
  rawLost: number
  cooks: number
}

/** Which resource a skill invocation acquires (null: not a resource search). */
export function resourceOf (skill: string, params: Record<string, unknown> | undefined): Resource | null {
  const p = params ?? {}
  if (skill === 'collect' && p.block === 'log') return 'wood'
  if (skill === 'collect' && p.block === 'gravel') return 'gravel'
  if (skill === 'mine' && Array.isArray(p.blocks) && p.blocks.includes('gravel')) return 'gravel'
  if (skill === 'hunt') return 'food'
  return null
}

/** Per-run resource figures from the event stream (pure). */
export function resourceRun (events: Ev[]): ResourceRun {
  const r: ResourceRun = {
    timeS: { wood: 0, gravel: 0, food: 0 }, blocks: { wood: 0, gravel: 0, food: 0 },
    relocations: {}, regions: {}, spotVisits: {}, shelterS: 0, fillers: {}, rawLost: 0, cooks: 0,
  }
  const open = new Map<number, { skill: string; res: Resource | null }>()
  let shelterFrom: number | null = null
  const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }
  const endShelter = (t: number) => { if (shelterFrom !== null) { r.shelterS += t - shelterFrom; shelterFrom = null } }
  for (const e of events) {
    const d = e.data
    switch (e.type) {
      // Open skills by depth. An interrupt's start can arrive before the end of the skill it
      // preempted, so time comes from each end event itself (it carries the params).
      case 'skill_start': open.set(Number(d.depth ?? 0), { skill: String(d.skill), res: resourceOf(String(d.skill), d.params as Record<string, unknown>) }); break
      case 'skill_end': {
        const res = resourceOf(String(d.skill), d.params as Record<string, unknown>)
        if (res) r.timeS[res] += Number(d.durationMs ?? 0) / 1000
        const dep = Number(d.depth ?? 0)
        if (open.get(dep)?.skill === d.skill) open.delete(dep)
        break
      }
      case 'nav_end': {
        const res = [...open.entries()].sort((x, y) => y[0] - x[0]).find(([, o]) => o.res !== null)?.[1].res ?? null
        if (res) r.blocks[res] += Number(d.blocksTravelled ?? 0)
        break
      }
      case 'search_relocation': inc(r.relocations, String(d.kind)); break
      case 'search_region': inc(r.regions, String(d.kind)); break
      case 'search_step': if (['tree_spot', 'loaded_logs', 'animal_spot'].includes(String(d.mode))) inc(r.spotVisits, String(d.mode)); break
      case 'schedule':
        if (d.mode === 'night_shelter') { if (shelterFrom === null) shelterFrom = e.t } else endShelter(e.t)
        if (d.mode === 'night_filler') inc(r.fillers, String(d.chosen))
        break
      case 'objective': if (typeof d.id === 'string') endShelter(e.t); break
      case 'interrupt_start': if (d.id === 'cook') r.cooks++; break
      case 'item_delta': {
        const delta = (d.delta ?? {}) as Record<string, number>
        const cooked = Object.entries(delta).some(([k, v]) => k.startsWith('cooked_') && v > 0)
        if (!cooked) for (const [k, v] of Object.entries(delta)) if (RAW.has(k) && v < 0) r.rawLost -= v
        break
      }
    }
  }
  if (events.length) endShelter(events[events.length - 1]!.t)
  return r
}

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

const fmt = (xs: number[]) => { const a = quantile(xs, 0.5); const b = quantile(xs, 0.9); return a === null ? '–' : `${Math.round(a)} / ${Math.round(b!)}` }
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ') || '–'

export function renderResources (dir: string, runs: RunSummary[]): string {
  const L: string[] = ['## Resource search (wood, gravel, food) and nights', '']
  const rows = runs.map(s => ({ s, r: resourceRun(readEvents(join(dir, s.runId))) }))
  const total = (f: (r: ResourceRun) => Record<string, number>) => rows.reduce((m, { r }) => { for (const [k, v] of Object.entries(f(r))) m[k] = (m[k] ?? 0) + v; return m }, {} as Record<string, number>)
  const flag = (id: string) => runs.map(s => (s.flags as Record<string, number | null>)[id]).filter((x): x is number => typeof x === 'number')
  L.push('| resource | time/run p50 / p90 s | blocks/run p50 / p90 | total time s | total blocks |', '|---|---|---|---|---|')
  for (const k of ['wood', 'gravel', 'food'] as Resource[]) {
    const t = rows.map(x => x.r.timeS[k]); const b = rows.map(x => x.r.blocks[k])
    L.push(`| ${k} | ${fmt(t)} | ${fmt(b)} | ${Math.round(t.reduce((a, c) => a + c, 0))} | ${Math.round(b.reduce((a, c) => a + c, 0))} |`)
  }
  L.push('')
  L.push(`- **Relocations:** ${top(total(r => r.relocations))} · **exhausted regions marked:** ${top(total(r => r.regions))} · **remembered-spot visits:** ${top(total(r => r.spotVisits))}`)
  L.push(`- **Completion:** food_10 ${flag('food_10').length}/${runs.length} (p50 ${fmt(flag('food_10'))} s) · flint and steel ${flag('has_flint_and_steel').length}/${runs.length} (p50 ${fmt(flag('has_flint_and_steel'))} s) · nether_ready ${flag('nether_ready').length}/${runs.length} (p50 ${fmt(flag('nether_ready'))} s)`)
  L.push(`- **Food:** raw items eaten or lost uncooked ${rows.reduce((a, x) => a + x.r.rawLost, 0)} · cook interrupts ${rows.reduce((a, x) => a + x.r.cooks, 0)}`)
  L.push(`- **Nights:** sheltering ${fmt(rows.map(x => x.r.shelterS))} s/run (p50 / p90), ${Math.round(rows.reduce((a, x) => a + x.r.shelterS, 0))} s in all · night fillers ${top(total(r => r.fillers))}`)
  L.push('', '| run | wood s / blk | gravel s / blk | food s / blk | relocations | regions | spots | shelter s | fillers | raw lost | food_10 | flint | nether_ready |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const { s, r } of rows) {
    const f = s.flags as Record<string, number | null>
    const cell = (k: Resource) => `${Math.round(r.timeS[k])} / ${Math.round(r.blocks[k])}`
    L.push(`| ${s.runId.replace(/^.*-(r\d+)$/, '$1')} | ${cell('wood')} | ${cell('gravel')} | ${cell('food')} | ${sum(r.relocations)} | ${sum(r.regions)} | ${sum(r.spotVisits)} | ${Math.round(r.shelterS)} | ${sum(r.fillers)} | ${r.rawLost} | ${f.food_10 ?? '–'} | ${f.has_flint_and_steel ?? '–'} | ${f.nether_ready ?? '–'} |`)
  }
  return L.join('\n') + '\n'
}
