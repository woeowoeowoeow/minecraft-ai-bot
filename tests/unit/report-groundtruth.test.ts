import { describe, expect, it } from 'vitest'
import { parseInventoryData, parseServerLine } from '../../src/evaluation/groundtruth.js'
import { aggregate, aggregateNavBench, quantile, renderReport, wilson } from '../../src/evaluation/report.js'
import { RunSummaryS, type NavBenchTrial, type RunSummary } from '../../src/schema/index.js'

function run (id: string, over: Partial<RunSummary> = {}): RunSummary {
  const base: RunSummary = {
    runId: id, batchId: 'b', seedSet: 'heldout-b', fixture: false, codeRev: 'x', dirty: false, mcVersion: '1.16.1',
    config: { scenario: 'm0', reasoner: 'scripted', limitMin: 10, target: 'M0', fixture: null },
    startedAt: '', endedAt: '', outcome: 'goal_reached', outcomeReason: 'ok', elapsedS: 60,
    timing: { serverStartS: 10, botConnectS: 12, botRunS: 60, teardownS: 2 }, gameTicks: 1200,
    milestones: { M0: 50 }, flags: {}, deaths: [], terminalFailure: null,
    failures: { total: 0, byClass: {}, bySignature: {} }, skills: { collect: { runs: 1, ok: 1, durationsS: [30], failClasses: {} } },
    nav: { calls: 5, ok: 5, stuck: 0, unreachable: 0, hazard: 0, timeout: 0, cancelled: 0, stuckEvents: 1, blocksTravelled: 500, byProfile: { overworld: { calls: 5, ok: 5 } } },
    reasoner: { calls: 3, byKind: { select_objective: 3 }, fallbacks: 0, impl: 'scripted' },
    groundTruth: { verified: true, inventory: { crafting_table: 1 }, deaths: 0, advancements: [], note: 'ok' },
    interventions: 0, physicsCorrections: 0, botExit: { code: 0, signal: null }, artifacts: { complete: true, missing: [] },
  }
  return { ...base, ...over }
}

describe('batch aggregation', () => {
  it('wilson interval and quantiles', () => {
    const [lo, hi] = wilson(8, 10)
    expect(lo).toBeCloseTo(0.49, 2)
    expect(hi).toBeCloseTo(0.943, 2)
    expect(wilson(0, 0)).toEqual([0, 0])
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([], 0.5)).toBeNull()
  })

  it('aggregates outcomes, funnel, signatures and nav', () => {
    const runs = [
      run('r1'),
      run('r2', { milestones: { M0: 700 } }),
      run('r3', { outcome: 'unrecoverable', outcomeReason: 'x', milestones: { M0: null }, terminalFailure: { class: 'NAV_STUCK', signature: 'NAV_STUCK|collect|collect_logs|overworld|target=log', bundle: 'failures/3-NAV_STUCK' } }),
      run('r4', { outcome: 'infra_error', outcomeReason: 'server start failed', milestones: { M0: null } }),
      run('r5', { groundTruth: { verified: false, inventory: {}, deaths: 0, advancements: [], note: 'mismatch' } }),
    ]
    expect(runs.every(r => RunSummaryS.safeParse(r).success)).toBe(true)
    const failures = [
      { runId: 'r3', t: 1, class: 'NAV_STUCK' as const, signature: 'NAV_STUCK|collect|collect_logs|overworld|target=log', objective: 'collect_logs', milestone: 'M0', ladderLevel: 'L2', bundle: 'failures/1-NAV_STUCK' },
      { runId: 'r1', t: 1, class: 'NAV_STUCK' as const, signature: 'NAV_STUCK|collect|collect_logs|overworld|target=log', objective: 'collect_logs', milestone: 'M0', ladderLevel: 'L2', bundle: 'failures/1-NAV_STUCK' },
    ]
    const agg = aggregate(runs, failures, 'M0', 600)
    expect(agg.outcomes).toEqual({ goal_reached: 3, unrecoverable: 1, infra_error: 1 })
    expect(agg.success.k).toBe(2) // r5 excluded by ground-truth mismatch
    expect(agg.groundTruthMismatches).toEqual(['r5'])
    expect(agg.infraRate).toBeCloseTo(0.2)
    expect(agg.milestone).toMatchObject({ reached: 3, withinLimit: 2 })
    expect(agg.signatures[0]).toMatchObject({ class: 'NAV_STUCK', terminated: 1, occurrences: 2, runs: 2 })
    expect(agg.signatures[0]!.examples).toEqual(['r3/failures/1-NAV_STUCK', 'r1/failures/1-NAV_STUCK'])
    expect(agg.signatures.find(s => s.class === 'infra_error')?.terminated).toBe(1)
    expect(agg.nav.calls).toBe(25)
    expect(agg.nav.stuckEventsPerKm).toBe(2)
    const md = renderReport({ batchId: 'b', seedSet: 's', codeRev: 'x', dirty: false, scenario: 'm0', reasoner: 'scripted', limitMin: 10, date: '', server: {} }, agg, runs)
    expect(md).toContain('Success: 2/5')
    expect(md).toContain('NAV_STUCK|collect|collect_logs|overworld|target=log')
  })

  it('navbench aggregation per target kind', () => {
    const t = (kind: NavBenchTrial['kind'], ok: boolean, cls: string | null = null): NavBenchTrial =>
      ({ i: 0, kind, profile: 'overworld', ok, class: cls, ms: 20_000, straightDist: 100, blocksTravelled: 120, stuckEvents: ok ? 0 : 2, replans: 0, endDist: ok ? 0 : 40, failureBundle: null })
    const agg = aggregateNavBench([t('surface100', true), t('surface100', false, 'NAV_STUCK'), t('cave', false, 'NO_TARGET')])
    expect(agg.surface100).toMatchObject({ trials: 2, ok: 1, rate: 0.5, secPerBlock: 0.2 })
    expect(agg.cave).toMatchObject({ trials: 1, ok: 0, rate: 0, classes: { NO_TARGET: 1 } })
    expect(agg.all!.trials).toBe(3)
  })
})

describe('ground truth parsing', () => {
  const L = (m: string, lvl = 'INFO') => `[12:00:00] [Server thread/${lvl}]: ${m}`
  it('parses joins, deaths, advancements, movement corrections', () => {
    expect(parseServerLine(L('Bot joined the game'), 'Bot', 1)?.kind).toBe('join')
    expect(parseServerLine(L('Bot was slain by Zombie'), 'Bot', 1)).toMatchObject({ kind: 'death', data: { message: 'Bot was slain by Zombie' } })
    expect(parseServerLine(L('Bot fell from a high place'), 'Bot', 1)?.kind).toBe('death')
    expect(parseServerLine(L('Bot drowned'), 'Bot', 1)?.kind).toBe('death')
    expect(parseServerLine(L('Bot has made the advancement [Monster Hunter]'), 'Bot', 1)).toMatchObject({ kind: 'advancement', data: { name: 'Monster Hunter' } })
    expect(parseServerLine(L('Bot moved wrongly!', 'WARN'), 'Bot', 1)?.kind).toBe('moved_wrongly')
    expect(parseServerLine(L('Bot lost connection: Disconnected'), 'Bot', 1)?.kind).toBe('leave')
    expect(parseServerLine(L('Done (3.2s)! For help, type "help"'), 'Bot', 1)?.kind).toBe('server_ready')
    expect(parseServerLine(L('Other was slain by Zombie'), 'Bot', 1)).toBeNull()
    expect(parseServerLine('garbage', 'Bot', 1)).toBeNull()
  })

  it('parses inventory SNBT from data get', () => {
    // 1.16.1 format: byte counts, item tags after the count.
    const snbt = '[{Slot: 0b, id: "minecraft:oak_log", Count: 3b}, {Slot: 1b, id: "minecraft:crafting_table", Count: 1b}, {Slot: 2b, id: "minecraft:oak_log", Count: 2b}, ' +
      '{Slot: 3b, id: "minecraft:stone_pickaxe", Count: 1b, tag: {Damage: 17}}, {Slot: 4b, id: "minecraft:iron_sword", Count: 1b, tag: {Enchantments: [{lvl: 1s, id: "minecraft:sharpness"}], display: {Name: \'{"text":"a}b"}\'}}}]'
    expect(parseInventoryData(snbt)).toEqual({ oak_log: 5, crafting_table: 1, stone_pickaxe: 1, iron_sword: 1 })
    expect(parseInventoryData('[]')).toEqual({})
  })
})
