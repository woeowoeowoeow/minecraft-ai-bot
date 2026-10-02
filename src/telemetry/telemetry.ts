import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventBus } from '../observer/events.js'
import type { WorldState } from '../observer/types.js'
import type { BotResult, EventRecord, Failure, FailureEntry, StateDigest } from '../schema/index.js'
import { StatsAccumulator } from './stats.js'

export type TraceRow = { t: number; dim: string; pos: number[]; hp: number; food: number; skill: string | null }

/** What telemetry needs from the live bot; kept narrow so tests can fake it. */
export interface TelemetrySource {
  state (): WorldState
  digest (): StateDigest
  navRecent (): unknown[]
  voxels (): unknown
}

function jsonReplacer (_k: string, v: unknown): unknown {
  if (v instanceof Set) return v.size > 1000 ? { size: v.size } : [...v]
  return v
}

/**
 * Persists events, trace, digests, snapshots and failure bundles into RUN_DIR
 * (architecture §9). Only writes; never builds state itself.
 */
export class Telemetry {
  readonly stats = new StatsAccumulator()
  readonly failures: FailureEntry[] = []
  private trace: TraceRow[] = []
  private timers: NodeJS.Timeout[] = []
  private bundleN = 0
  private unsub: (() => void) | null = null

  constructor (readonly runDir: string, private readonly bus: EventBus, private readonly src: TelemetrySource) {
    mkdirSync(runDir, { recursive: true })
  }

  private path (...p: string[]): string { return join(this.runDir, ...p) }

  private append (file: string, obj: unknown): void {
    appendFileSync(this.path(file), JSON.stringify(obj, jsonReplacer) + '\n')
  }

  start (): void {
    this.unsub = this.bus.on(ev => {
      this.append('events.jsonl', ev)
      this.stats.add(ev)
      if (ev.type === 'skill_end' && (ev.data as { depth?: number }).depth === 0) this.writeDigest('skill_end')
    })
    this.timers.push(setInterval(() => this.sampleTrace(), 1000))
    this.timers.push(setInterval(() => this.writeDigest('periodic'), 60_000))
  }

  stop (): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.unsub?.()
  }

  sampleTrace (): void {
    try {
      const s = this.src.state()
      const row: TraceRow = {
        t: s.t, dim: s.dim, pos: s.pos.map(v => Math.round(v * 10) / 10), hp: Math.round(s.vitals.health * 10) / 10,
        food: s.vitals.food, skill: s.control.skillStack.map(x => x.skill).join('>') || null,
      }
      this.trace.push(row)
      const cutoff = row.t - 300
      while (this.trace.length && this.trace[0]!.t < cutoff) this.trace.shift()
      this.append('trace.jsonl', row)
    } catch { /* bot not ready */ }
  }

  writeDigest (reason: string): void {
    try { this.append('state.jsonl', { reason, ...this.src.digest() }) } catch { /* bot not ready */ }
  }

  snapshot (label: string): string {
    mkdirSync(this.path('snapshots'), { recursive: true })
    const rel = join('snapshots', `${label}.json`)
    try { writeFileSync(this.path(rel), JSON.stringify(this.src.state(), jsonReplacer, 1)) } catch (e) {
      writeFileSync(this.path(rel), JSON.stringify({ error: String(e) }))
    }
    this.bus.emit('capture', { label, path: rel }, 'debug')
    return rel
  }

  /** Current state digest (architecture §8.2), for events that carry one. */
  digest (): StateDigest | null {
    try { return this.src.digest() } catch { return null }
  }

  /**
   * Failure bundle (architecture §9): state, digest, events tail, trace tail,
   * skill stack, nav diagnostics, voxel slice. Returns its path relative to RUN_DIR.
   */
  failureBundle (label: string, failure: Failure | null, extra: Record<string, unknown> = {}, traceSeconds = 120): string {
    const rel = join('failures', `${++this.bundleN}-${label}`)
    const dir = this.path(rel)
    mkdirSync(dir, { recursive: true })
    const safe = (name: string, fn: () => unknown) => {
      let v: unknown
      try { v = fn() } catch (e) { v = { error: String(e) } }
      writeFileSync(join(dir, name), JSON.stringify(v, jsonReplacer, 1))
    }
    safe('failure.json', () => ({ label, failure, ...extra }))
    safe('state.json', () => this.src.state())
    safe('digest.json', () => this.src.digest())
    safe('skill_stack.json', () => this.src.state().control.skillStack)
    safe('nav.json', () => this.src.navRecent())
    safe('voxels.json', () => this.src.voxels())
    const tail: EventRecord[] = this.bus.tail(200)
    writeFileSync(join(dir, 'events_tail.jsonl'), tail.map(e => JSON.stringify(e)).join('\n') + '\n')
    const lastT = this.trace[this.trace.length - 1]?.t ?? 0
    writeFileSync(join(dir, 'trace_tail.jsonl'), this.trace.filter(r => r.t >= lastT - traceSeconds).map(r => JSON.stringify(r)).join('\n') + '\n')
    return rel
  }

  recordFailure (entry: FailureEntry): void {
    this.failures.push(entry)
    this.bus.emit('failure', { ...entry }, 'warn')
  }

  writeResult (r: BotResult): void {
    writeFileSync(this.path('bot_result.json'), JSON.stringify(r, jsonReplacer, 1))
  }
}
