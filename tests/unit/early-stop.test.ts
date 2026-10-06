import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EARLY_STOP, EarlyStopMonitor, JsonlTail, maintenanceIds, remainingLowerBoundS, replayEarlyStop, terminalTrigger, type Ev } from '../../src/evaluation/early-stop.js'
import { ProcessRegistry } from '../../src/evaluation/procs.js'
import { runOne } from '../../src/evaluation/run.js'

const LIMIT = 4200
const FIX = join(import.meta.dirname, 'fixtures')

const obj = (t: number, id: string, skill = 'obtain'): Ev => ({ t, type: 'objective', data: { id, skill } })
const step = (t: number, objective: string, action = 'retry', level = 'L2', note = ''): Ev => ({ t, type: 'recovery_step', data: { level, action, objective, note, signature: `SEARCH_EXHAUSTED|obtain|${objective}` } })
const exhaust = (t: number, objective: string): Ev[] => [
  step(t, objective, 'suspend', 'L3', `strategies exhausted for ${objective}`),
  step(t + 30, objective, 'suspend_skipped', 'L3', 'no other objective available; relocating instead'),
]
const ok = (t: number, skill = 'obtain'): Ev => ({ t, type: 'skill_end', data: { skill, status: 'success', depth: 0 } })

function run (events: Ev[], until = 0, remainderRule = false): ReturnType<EarlyStopMonitor['check']> {
  const m = new EarlyStopMonitor({ limitS: LIMIT, remainderRule })
  for (const e of events) if (m.feed(e)) return m.decision
  return until ? m.check(until) : null
}

describe('early-fail rule 2: repeated objective exhaustion', () => {
  it('fires on the second full exhaustion with no alternate objective', () => {
    const d = run([obj(1, 'wooden_pickaxe'), ...exhaust(100, 'wooden_pickaxe'), ...exhaust(700, 'wooden_pickaxe')])
    expect(d?.rule).toBe('objective_exhausted')
    expect(d?.atS).toBe(730)
    expect(d?.evidence.objective).toBe('wooden_pickaxe')
    expect(d?.stage).toContain('requirement=wooden_pickaxe')
  })

  it('one exhaustion is not repeated exhaustion', () => {
    expect(run([obj(1, 'wooden_pickaxe'), ...exhaust(100, 'wooden_pickaxe')], 200)).toBeNull()
  })

  it('an exhaustion with an alternate objective (no suspend_skipped) does not count', () => {
    expect(run([obj(1, 'food'), step(100, 'food', 'suspend', 'L3', 'strategies exhausted for food'), obj(101, 'flint_and_steel'),
      step(700, 'food', 'suspend', 'L3', 'strategies exhausted for food')], 800)).toBeNull()
  })

  it('progress between exhaustions resets the count', () => {
    expect(run([obj(1, 'food'), ...exhaust(100, 'food'), { t: 400, type: 'milestone', data: { id: 'has_bucket', flag: true } }, ...exhaust(700, 'food')])).toBeNull()
  })

  it('upkeep objectives (bounded + persistent food reserves) never trigger it', () => {
    expect(maintenanceIds().has('emergency_food')).toBe(true)
    expect(maintenanceIds().has('food')).toBe(false) // the cooked-food stock is a real A requirement
    expect(run([obj(1, 'emergency_food'), ...exhaust(100, 'emergency_food'), ...exhaust(700, 'emergency_food')])).toBeNull()
  })

  it('suspend_skipped after a non-exhaustion suspend does not count', () => {
    const bounded = (t: number): Ev[] => [step(t, 'nether_portal', 'suspend', 'L3', 'nether_portal succeeds without meeting'), step(t + 1, 'nether_portal', 'suspend_skipped', 'L3')]
    expect(run([obj(1, 'nether_portal', 'buildNetherPortal'), ...bounded(100), ...bounded(700)])).toBeNull()
  })
})

describe('early-fail rule 3: hard controller stall', () => {
  const cycles = (id: string, ts: number[]) => ts.map(t => step(t, id))

  it('fires after 15 min without progress, ≥ 3 cycles of the active requirement, nothing discovered', () => {
    const d = run([obj(50, 'kit_wood'), ...cycles('kit_wood', [200, 500, 800])], 900)
    expect(d?.rule).toBe('controller_stall')
    expect(d?.evidence.requirement).toBe('kit_wood')
    expect((d?.evidence.cycles as string[]).length).toBe(3)
  })

  it('needs the full 15 minutes', () => {
    expect(run([obj(50, 'kit_wood'), ...cycles('kit_wood', [200, 500, 800])], EARLY_STOP.stallS - 1)).toBeNull()
  })

  it('needs 3 cycles in the window', () => {
    expect(run([obj(50, 'kit_wood'), ...cycles('kit_wood', [200, 500])], 1200)).toBeNull()
    // Cycles before the window do not count.
    expect(run([obj(50, 'kit_wood'), ...cycles('kit_wood', [100, 200, 300, 1500])], 1300)).toBeNull()
  })

  it('a discovery in the window blocks it: an observed location or a first-time item', () => {
    const base = [obj(50, 'kit_wood'), ...cycles('kit_wood', [200, 500, 800])]
    expect(run([...base, { t: 850, type: 'location_discovered', data: { kind: 'lava_pool', source: 'observed' } }], 900)).toBeNull()
    expect(run([...base, { t: 850, type: 'item_delta', data: { delta: { gravel: 1 } } }], 900)).toBeNull()
    // The bot's own placements are not discoveries; neither is more of an item already held.
    expect(run([{ t: 10, type: 'item_delta', data: { delta: { dirt: 3 } } }, ...base, { t: 850, type: 'location_discovered', data: { kind: 'crafting_table', source: 'built' } },
      { t: 860, type: 'item_delta', data: { delta: { dirt: 1 } } }], 1000)?.rule).toBe('controller_stall')
  })

  it('milestone flags and met requirements are progress; upkeep and unsatisfied successes are not', () => {
    const tail = cycles('iron_ingots', [1000, 1300, 1600])
    // A met requirement at 800 → no stall until 1700.
    expect(run([obj(10, 'stone_pickaxe'), ok(800), obj(801, 'iron_ingots'), ...tail], 1650)).toBeNull()
    expect(run([obj(10, 'stone_pickaxe'), ok(800), obj(801, 'iron_ingots'), ...tail], 1700)?.rule).toBe('controller_stall')
    // A milestone flag at 800 → same.
    expect(run([obj(10, 'iron_ingots'), { t: 800, type: 'milestone', data: { id: 'has_iron_ingot', flag: true } }, ...tail], 1650)).toBeNull()
    // Success immediately followed by OBJECTIVE_NOT_SATISFIED is not progress.
    expect(run([obj(10, 'iron_ingots'), ok(800), { t: 800, type: 'failure', data: { class: 'OBJECTIVE_NOT_SATISFIED', objective: 'iron_ingots' } }, ...tail], 1650)?.rule).toBe('controller_stall')
    // Hunting emergency food (upkeep) or an interrupt's success is not progress either.
    expect(run([obj(10, 'iron_ingots'), obj(700, 'emergency_food'), ok(800), obj(801, 'iron_ingots'),
      { t: 900, type: 'interrupt_start', data: { id: 'cook' } }, ok(950), { t: 951, type: 'interrupt_end', data: {} }, ...tail], 1650)?.rule).toBe('controller_stall')
  })

  it('counts cycles of the requirement the run is blocked on, not of upkeep objectives', () => {
    expect(run([obj(10, 'kit_wood'), obj(20, 'emergency_food'), ...cycles('emergency_food', [200, 500, 800])], 1000)).toBeNull()
    expect(run([obj(10, 'kit_wood'), obj(20, 'emergency_food'), ...cycles('kit_wood', [200, 500, 800])], 1000)?.evidence.requirement).toBe('kit_wood')
  })
})

describe('early-fail rule 4: impossible-to-finish remainder', () => {
  it('lower bound uses only game-mechanics minima', () => {
    const exc = 2 * 12 / EARLY_STOP.sprintBps
    expect(remainingLowerBoundS({ inNether: false, excursionDone: false, returned: false })).toBeCloseTo(8 + exc, 1)
    expect(remainingLowerBoundS({ inNether: true, excursionDone: false, returned: false })).toBeCloseTo(4 + exc, 1)
    expect(remainingLowerBoundS({ inNether: true, excursionDone: true, returned: false })).toBe(4)
    expect(remainingLowerBoundS({ inNether: true, excursionDone: true, returned: true })).toBe(0)
  })

  it('fires only when the remaining time is below the bound', () => {
    expect(run([obj(1, 'iron_ingots')], LIMIT - 13, true)).toBeNull()
    const d = run([obj(1, 'iron_ingots')], LIMIT - 12, true)
    expect(d?.rule).toBe('impossible_remainder')
    expect(d?.evidence.lowerBoundS).toBeGreaterThan(12)
    // In the Nether after the excursion, only the return transit remains.
    expect(run([{ t: 1, type: 'milestone', data: { id: 'in_nether' } }, { t: 2, type: 'milestone', data: { id: 'excursion' } }], LIMIT - 5, true)).toBeNull()
  })

  it('is off in the gate: the bound (≤ 12.3 s) could only relabel natural timeouts', () => {
    expect(EARLY_STOP.remainderRule).toBe(false)
    expect(run([obj(1, 'iron_ingots')], LIMIT - 1)).toBeNull()
  })
})

describe('early-fail rule 1 and plumbing', () => {
  it('labels the existing terminal conditions', () => {
    expect(terminalTrigger('death_limit')).toBe('death_limit')
    expect(terminalTrigger('unrecoverable')).toBe('recovery_L5')
    expect(terminalTrigger('infra_error')).toBe('crash')
    expect(terminalTrigger('timeout')).toBeNull()
    expect(terminalTrigger('goal_reached')).toBeNull()
  })

  it('JsonlTail returns complete lines only and resumes after a partial line', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'tail-')), 'events.jsonl')
    const tail = new JsonlTail(p)
    expect(tail.read()).toEqual([])
    writeFileSync(p, '{"t":1,"type":"a","data":{}}\n{"t":2,"ty')
    expect(tail.read().map(e => e.t)).toEqual([1])
    appendFileSync(p, 'pe":"b","data":{}}\n')
    expect(tail.read().map(e => e.type)).toEqual(['b'])
    expect(tail.read()).toEqual([])
  })

  it('evaluator: a live early stop is a scored failure that keeps its deaths and evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const registry = new ProcessRegistry(join(dir, 'pids'))
    const runDir = join(dir, 'run')
    const s = await runOne({
      batchId: 'test', runId: 'test-early', runDir, seed: '-1', seedSet: 'test', scenario: 'm0', reasoner: 'none', limitMs: 60_000, port: 1, rngSeed: 1,
      target: 'M0', codeRev: { rev: 't', dirty: false }, registry, earlyStop: true, serverReadyTimeoutMs: 3000,
      serverCommand: { cmd: process.execPath, args: [join(FIX, 'fake-server.mjs'), 'normal'] },
      botCommand: { cmd: process.execPath, args: [join(FIX, 'fake-bot.mjs'), 'exhaust'] },
    })
    expect(s.outcome).toBe('early_fail')
    expect(s.outcomeReason).toContain('objective_exhausted')
    expect(s.deaths).toHaveLength(1)
    expect(s.earlyStop?.rule).toBe('objective_exhausted')
    expect(s.earlyStop?.savedS).toBeGreaterThan(30)
    expect(JSON.parse(readFileSync(join(runDir, 'early_stop.json'), 'utf8')).rule).toBe('objective_exhausted')
    expect(readFileSync(join(runDir, 'ground_truth.jsonl'), 'utf8')).toContain('"early_stop"')
    expect(registry.count()).toBe(0)
  }, 30_000)
})

describe('replay of historical B runs (trimmed event streams)', () => {
  const load = (name: string) => {
    const [head, ...rest] = readFileSync(join(FIX, 'early-stop', `${name}.jsonl`), 'utf8').trim().split('\n')
    return { meta: JSON.parse(head!).meta as { outcome: string; elapsedS: number; B: number | null }, events: rest.map(l => JSON.parse(l) as Ev) }
  }

  it.each([
    ['b2-gate-r09', 'controller_stall', 1700], // food hunt in an animal-poor world; timed out at 4200 s
    ['b2-gate-r10', 'objective_exhausted', 1500], // food exhausted 4× with nothing else to do; L5 at 3794 s
    ['b-gate-part2-r01', 'controller_stall', 2600], // wood stalls (stale Mining Fatigue); L5 at 3875 s
  ])('failed run %s stops earlier (%s)', (name, rule, before) => {
    const { meta, events } = load(name)
    expect(meta.B).toBeNull()
    const { decision } = replayEarlyStop(events, LIMIT)
    expect(decision?.rule).toBe(rule)
    expect(decision!.atS).toBeLessThan(before)
    expect(decision!.atS).toBeLessThan(meta.elapsedS - 1000)
  })

  it.each(['b3-gate-r15', 'b2-gate-r18', 'b3-dev1-r06'])('slow success %s is never stopped', name => {
    const { meta, events } = load(name)
    expect(meta.B).not.toBeNull()
    expect(replayEarlyStop(events, LIMIT).decision).toBeNull()
  })

  it('fixtures cover ≥ 2 successes slower than 55 min', () => {
    const slow = readdirSync(join(FIX, 'early-stop')).map(f => load(f.replace('.jsonl', '')).meta).filter(m => m.B !== null && m.B > 55 * 60)
    expect(slow.length).toBeGreaterThanOrEqual(2)
  })
})
