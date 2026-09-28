import type { EventRecord, EventType, Severity } from '../schema/index.js'

export type Listener = (ev: EventRecord) => void

/**
 * In-process event bus. Keeps a ring buffer of recent events for failure
 * bundles and the digest; telemetry subscribes to persist everything.
 */
export class EventBus {
  private listeners: Listener[] = []
  private ring: EventRecord[] = []
  private readonly t0: number

  constructor (
    private readonly clock: () => number = Date.now,
    private readonly tickFn: () => number = () => 0,
    private readonly ringSize = 200,
  ) {
    this.t0 = clock()
  }

  /** Seconds since the bus was created (= bot run start). */
  now (): number {
    return Math.round((this.clock() - this.t0) / 100) / 10
  }

  emit (type: EventType, data: Record<string, unknown> = {}, sev: Severity = 'info'): EventRecord {
    const ev: EventRecord = { t: this.now(), tick: this.tickFn(), type, sev, data }
    this.ring.push(ev)
    if (this.ring.length > this.ringSize) this.ring.shift()
    for (const l of this.listeners) {
      try { l(ev) } catch { /* a broken listener must never break the bot */ }
    }
    return ev
  }

  on (l: Listener): () => void {
    this.listeners.push(l)
    return () => { this.listeners = this.listeners.filter(x => x !== l) }
  }

  tail (n = this.ringSize): EventRecord[] {
    return this.ring.slice(-n)
  }
}

const MICRO = new Set<EventType>(['nav_start', 'nav_end', 'item_delta', 'search_step', 'reasoner_call', 'reasoner_result'])

/**
 * Coalesced one-line summaries for the digest's `recent` list (architecture §9):
 * keeps sev ≥ info, drops nav/item micro-events, collapses repeats.
 */
export function summarizeRecent (events: EventRecord[], cap = 20): string[] {
  const out: string[] = []
  for (const ev of events) {
    if (ev.sev === 'debug' || MICRO.has(ev.type)) continue
    const line = describe(ev)
    if (!line) continue
    const last = out[out.length - 1]
    if (last !== undefined && last.replace(/ ×\d+$/, '') === line) {
      const m = last.match(/ ×(\d+)$/)
      out[out.length - 1] = `${line} ×${m ? Number(m[1]) + 1 : 2}`
    } else {
      out.push(line)
    }
  }
  return out.slice(-cap)
}

function describe (ev: EventRecord): string | null {
  const d = ev.data
  switch (ev.type) {
    case 'skill_end': {
      const fail = (d.failure as { class?: string } | undefined)?.class
      return `${String(d.skill)} ${String(d.status)}${fail ? ` ${fail}` : ''} ${Math.round(Number(d.durationMs ?? 0) / 1000)}s`
    }
    case 'skill_start': return null
    case 'damage': return `hp ${String(d.from)}→${String(d.to)}`
    case 'stuck_detected': return `stuck (${String(d.reason)})`
    case 'milestone': return `milestone ${String(d.id)}`
    case 'objective': return `objective ${String(d.id)}`
    case 'death': return `died${d.message ? `: ${String(d.message)}` : ''}`
    case 'failure': return `failure ${String(d.class)} in ${String(d.skill)}`
    default: return ev.type
  }
}
