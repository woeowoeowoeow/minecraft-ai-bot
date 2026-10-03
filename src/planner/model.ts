// Model-backed reasoner behind the provider-neutral ModelClient boundary
// (architecture §5.2–5.3). Vendor adapters would live in src/planner/providers/
// and implement only ModelClient; none is shipped (milestones.md, milestone B
// note): runtime reasoning stays disabled, `reasoner=none` is the gate
// configuration, and no run depends on a model or an API key.
import type { DecisionRequest, DecisionResponse } from '../schema/index.js'
import { validateDecision, type Reasoner } from './reasoner.js'

export type Usage = { inputTokens: number; outputTokens: number }

/** The only vendor boundary (architecture §5.2). */
export interface ModelClient {
  readonly id: string
  readonly supportsImages: boolean
  completeJSON (p: { system: string; user: string; schema: Record<string, unknown>; image?: Buffer; maxTokens: number; signal: AbortSignal }): Promise<{ json: unknown; usage: Usage }>
}

/** JSON schema of DecisionResponse handed to the provider (validation is still zod's, after the call). */
export const DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['choice', 'confidence', 'rationale'],
  properties: {
    choice: { type: ['string', 'null'] },
    params: {},
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    diagnosis: { type: 'object', properties: { failureClass: { type: 'string' }, hypothesis: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } } },
    proposal: { type: 'object', properties: { skill: { type: 'string' }, change: { type: 'string' }, rationale: { type: 'string' } } },
    rationale: { type: 'string', maxLength: 600 },
  },
}

const SYSTEM = [
  'You choose for a Minecraft bot from a fixed menu. Reply with JSON only, matching the schema.',
  '`choice` must be one of the option ids, or null when no option is acceptable.',
  'Never invent coordinates, commands or new actions. Keep `rationale` under 600 characters.',
].join(' ')

export function renderPrompt (req: DecisionRequest, error?: string): { system: string; user: string } {
  const user = JSON.stringify({ kind: req.kind, trigger: req.trigger, objective: req.objective ?? null, failure: req.failure ?? null, attempts: req.attempts, options: req.options, digest: req.digest })
  return { system: SYSTEM, user: error ? `${user}\n\nYour previous reply was invalid: ${error}. Reply again with valid JSON.` : user }
}

export type ModelStats = { calls: number; invalid: number; fallbacks: number; tokensIn: number; tokensOut: number }

/**
 * §5.3: invalid JSON, a choice outside the menu or a schema failure retries once with the
 * error appended, then falls back to the deterministic default (first option). A provider
 * error or timeout falls back at once. Low confidence (< 0.5) keeps the default.
 */
export class ModelReasoner implements Reasoner {
  readonly id: string
  readonly stats: ModelStats = { calls: 0, invalid: 0, fallbacks: 0, tokensIn: 0, tokensOut: 0 }

  constructor (private readonly client: ModelClient, private readonly o: { timeoutMs?: number; maxTokens?: number } = {}) {
    this.id = `model:${client.id}`
  }

  private fallback (req: DecisionRequest, why: string): DecisionResponse {
    this.stats.fallbacks++
    return { choice: req.options[0]?.id ?? null, confidence: 0, rationale: `deterministic default (${why})`.slice(0, 600) }
  }

  async decide (req: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse> {
    let error: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const ac = new AbortController()
      const onAbort = () => ac.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 90_000)
      let raw: unknown
      try {
        this.stats.calls++
        const { system, user } = renderPrompt(req, error)
        const r = await this.client.completeJSON({ system, user, schema: DECISION_JSON_SCHEMA, maxTokens: this.o.maxTokens ?? 800, signal: ac.signal })
        this.stats.tokensIn += r.usage.inputTokens
        this.stats.tokensOut += r.usage.outputTokens
        raw = r.json
      } catch (e) {
        return this.fallback(req, `provider error: ${(e as Error)?.message ?? String(e)}`)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const v = validateDecision(req, raw)
      if (v.accepted && v.response) {
        if (v.response.confidence < 0.5) return { ...v.response, choice: req.options[0]?.id ?? null, rationale: `low confidence; default kept. ${v.response.rationale}`.slice(0, 600) }
        return v.response
      }
      this.stats.invalid++
      error = v.error
    }
    return this.fallback(req, `invalid twice: ${error}`)
  }
}
