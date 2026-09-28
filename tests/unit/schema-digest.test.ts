import { describe, expect, it } from 'vitest'
import { buildDigest, compass, DIGEST_CAPS } from '../../src/observer/digest.js'
import { EventBus, summarizeRecent } from '../../src/observer/events.js'
import { BotConfigS, DecisionResponseS, EventRecordS, StateDigestS } from '../../src/schema/index.js'
import { fakeState } from './helpers.js'

describe('schemas', () => {
  it('bot config is strict: unknown keys (e.g. a seed) are rejected', () => {
    const base = { host: '127.0.0.1', port: 1, username: 'Bot', runDir: '/tmp/x', scenario: 'm0', reasoner: 'none', limitMs: 1000 }
    expect(BotConfigS.safeParse(base).success).toBe(true)
    expect(BotConfigS.safeParse({ ...base, seed: '123' }).success).toBe(false)
  })

  it('events validate', () => {
    const bus = new EventBus()
    const ev = bus.emit('skill_end', { skill: 'collect', status: 'success', durationMs: 1000 })
    expect(EventRecordS.safeParse(ev).success).toBe(true)
    expect(EventRecordS.safeParse({ ...ev, type: 'bogus' }).success).toBe(false)
  })

  it('decision responses cap rationale length and confidence range', () => {
    expect(DecisionResponseS.safeParse({ choice: 'a', confidence: 1.5, rationale: '' }).success).toBe(false)
    expect(DecisionResponseS.safeParse({ choice: 'a', confidence: 0.5, rationale: 'x'.repeat(601) }).success).toBe(false)
    expect(DecisionResponseS.safeParse({ choice: null, confidence: 0.5, rationale: 'ok' }).success).toBe(true)
  })
})

describe('StateDigest', () => {
  it('is schema-valid and enforces caps', () => {
    const inventory: Record<string, number> = {}
    for (let i = 0; i < 40; i++) inventory[`item_${i}`] = i + 1
    const entities = Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'zombie', kind: 'hostile' as const, pos: [i, 64, 0] as [number, number, number], dist: i }))
    const s = fakeState({ inventory, nearby: { entities, interestBlocks: { oak_log: [[5, 64, 5]] }, hazards: [] } })
    const bus = new EventBus()
    for (let i = 0; i < 50; i++) bus.emit('damage', { from: 20 - i * 0.1, to: 19 - i * 0.1 })
    const d = buildDigest(s, bus.tail())
    expect(StateDigestS.safeParse(d).success).toBe(true)
    expect(Object.keys(d.inv).length).toBeLessThanOrEqual(DIGEST_CAPS.invKinds + 1)
    expect(d.nearby.hostile.length).toBeLessThanOrEqual(DIGEST_CAPS.entities)
    expect(d.recent.length).toBeLessThanOrEqual(DIGEST_CAPS.recent)
    expect(d.nearby.blocks.oak_log).toBe(1)
    expect(JSON.stringify(d).length).toBeLessThan(6000) // ≈ 1.5k tokens
  })

  it('coalesces repeated recent events and drops micro events', () => {
    const bus = new EventBus()
    bus.emit('stuck_detected', { reason: 'no_displacement' })
    bus.emit('stuck_detected', { reason: 'no_displacement' })
    bus.emit('nav_end', { ok: true })
    bus.emit('milestone', { id: 'M0' })
    expect(summarizeRecent(bus.tail())).toEqual(['stuck (no_displacement) ×2', 'milestone M0'])
  })

  it('compass directions follow Minecraft axes', () => {
    expect(compass([0, 0, 0], [0, 0, -10])).toBe('N')
    expect(compass([0, 0, 0], [10, 0, 0])).toBe('E')
    expect(compass([0, 0, 0], [0, 0, 10])).toBe('S')
    expect(compass([0, 0, 0], [-10, 0, -10])).toBe('NW')
  })
})
