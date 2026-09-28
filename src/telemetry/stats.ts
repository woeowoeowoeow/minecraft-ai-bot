import { emptyNavStats, type EventRecord, type NavStats, type SkillStats } from '../schema/index.js'

/** Folds skill_end / nav_end events into the per-run skill and nav stats (evaluation.md §4). Pure. */
export class StatsAccumulator {
  readonly skills: SkillStats = {}
  readonly nav: NavStats = emptyNavStats()

  add (ev: EventRecord): void {
    if (ev.type === 'skill_end') {
      const d = ev.data as { skill: string; status: string; durationMs: number; failure?: { class: string } | null }
      const s = (this.skills[d.skill] ??= { runs: 0, ok: 0, durationsS: [], failClasses: {} })
      s.runs++
      if (d.status === 'success') s.ok++
      s.durationsS.push(Math.round(d.durationMs / 100) / 10)
      const cls = d.failure?.class
      if (cls) s.failClasses[cls] = (s.failClasses[cls] ?? 0) + 1
    } else if (ev.type === 'nav_end') {
      const d = ev.data as { ok: boolean; class: string | null; profile: string; stuckEvents: number; blocksTravelled: number }
      const n = this.nav
      n.calls++
      if (d.ok) n.ok++
      if (d.class === 'NAV_STUCK') n.stuck++
      if (d.class === 'NAV_UNREACHABLE') n.unreachable++
      if (d.class === 'NAV_HAZARD') n.hazard++
      if (d.class === 'SKILL_TIMEOUT') n.timeout++
      if (d.class === 'CANCELLED') n.cancelled++
      n.stuckEvents += d.stuckEvents ?? 0
      n.blocksTravelled = Math.round(n.blocksTravelled + (d.blocksTravelled ?? 0))
      const p = (n.byProfile[d.profile] ??= { calls: 0, ok: 0 })
      p.calls++
      if (d.ok) p.ok++
    }
  }
}
