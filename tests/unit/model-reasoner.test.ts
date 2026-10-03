import { describe, expect, it } from 'vitest'
import { ModelReasoner, type ModelClient } from '../../src/planner/model.js'
import { buildDigest } from '../../src/observer/digest.js'
import type { DecisionRequest } from '../../src/schema/index.js'
import { fakeState } from './helpers.js'

const req: DecisionRequest = {
  id: 'r1', kind: 'choose_recovery', trigger: 'ladder_L4', digest: buildDigest(fakeState(), []), attempts: [],
  options: [{ id: 'retry', label: 'retry', detail: '', priorFailures: 1 }, { id: 'relocate', label: 'relocate', detail: '', priorFailures: 0 }],
}

function client (replies: unknown[]): ModelClient & { calls: string[] } {
  const calls: string[] = []
  return {
    id: 'fake', supportsImages: false, calls,
    async completeJSON (p) {
      calls.push(p.user)
      const r = replies.shift()
      if (r instanceof Error) throw r
      return { json: r, usage: { inputTokens: 10, outputTokens: 5 } }
    },
  }
}

describe('ModelReasoner (architecture §5.3, provider-neutral)', () => {
  const sig = new AbortController().signal
  it('accepts a valid menu choice', async () => {
    const r = await new ModelReasoner(client([{ choice: 'relocate', confidence: 0.9, rationale: 'r' }])).decide(req, sig)
    expect(r.choice).toBe('relocate')
  })
  it('retries once with the validation error, then accepts', async () => {
    const c = client([{ choice: 'teleport', confidence: 0.9, rationale: 'r' }, { choice: 'relocate', confidence: 0.8, rationale: 'r' }])
    const m = new ModelReasoner(c)
    expect((await m.decide(req, sig)).choice).toBe('relocate')
    expect(c.calls[1]).toContain('invalid')
    expect(m.stats.invalid).toBe(1)
  })
  it('falls back to the default after two invalid replies or a provider error', async () => {
    const m = new ModelReasoner(client([{ nope: 1 }, { choice: 'x', confidence: 2 }]))
    expect((await m.decide(req, sig)).choice).toBe('retry')
    expect(m.stats.fallbacks).toBe(1)
    expect((await new ModelReasoner(client([new Error('503')])).decide(req, sig)).choice).toBe('retry')
  })
  it('keeps the default on low confidence', async () => {
    expect((await new ModelReasoner(client([{ choice: 'relocate', confidence: 0.2, rationale: 'r' }])).decide(req, sig)).choice).toBe('retry')
  })
})
