import { DecisionResponseS, type DecisionKind, type DecisionRequest, type DecisionResponse } from '../schema/index.js'

/** Model-agnostic reasoner (architecture §5.2). Nothing outside src/planner/providers/ may import a vendor SDK. */
export interface Reasoner {
  readonly id: string
  decide (req: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse>
}

/** Default reasoner: always the deterministic default (first option). No API key, no I/O. */
export class NoModelReasoner implements Reasoner {
  readonly id = 'none'
  async decide (req: DecisionRequest): Promise<DecisionResponse> {
    return { choice: req.options[0]?.id ?? null, confidence: 1, rationale: 'deterministic default (first option)' }
  }
}
/** Alias matching architecture §5.2 naming. */
export { NoModelReasoner as NoneReasoner }

export type Script = Partial<Record<DecisionKind, (string | null)[]>>

/**
 * Replays canned choices per decision kind, in order. A scripted choice is
 * consumed only when it is among the current options; otherwise the default
 * (first option) is returned and the cursor stays put. Deterministic.
 */
export class ScriptedReasoner implements Reasoner {
  readonly id = 'scripted'
  private cursor: Partial<Record<DecisionKind, number>> = {}

  constructor (private readonly script: Script) {}

  async decide (req: DecisionRequest): Promise<DecisionResponse> {
    const list = this.script[req.kind] ?? []
    const i = this.cursor[req.kind] ?? 0
    if (i < list.length) {
      const c = list[i]!
      if (c === null || req.options.some(o => o.id === c)) {
        this.cursor[req.kind] = i + 1
        return { choice: c, confidence: 1, rationale: `scripted #${i + 1}` }
      }
    }
    return { choice: req.options[0]?.id ?? null, confidence: 1, rationale: i < list.length ? `scripted #${i + 1} (${String(list[i])}) not available; default` : 'script exhausted; default' }
  }
}

export type Validated = { choice: string | null; accepted: boolean; error?: string; response: DecisionResponse | null }

/**
 * Validates a response against the schema and the option whitelist
 * (architecture §5.3). Invalid → deterministic default (first option).
 */
export function validateDecision (req: DecisionRequest, raw: unknown): Validated {
  const parsed = DecisionResponseS.safeParse(raw)
  const fallback = req.options[0]?.id ?? null
  if (!parsed.success) return { choice: fallback, accepted: false, error: 'schema: ' + parsed.error.issues.map(i => i.message).join('; '), response: null }
  const r = parsed.data
  if (r.choice !== null && !req.options.some(o => o.id === r.choice)) {
    return { choice: fallback, accepted: false, error: `choice ${r.choice} not in options`, response: r }
  }
  return { choice: r.choice, accepted: true, response: r }
}

export function makeReasoner (kind: 'none' | 'scripted', script: Script = {}): Reasoner {
  return kind === 'scripted' ? new ScriptedReasoner(script) : new NoModelReasoner()
}
