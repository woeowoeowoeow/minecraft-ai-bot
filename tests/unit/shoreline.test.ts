// Shoreline food risk after the A re-gate 20260930 (6 of 11 deaths: drowned at sea level
// during food work) and the search-target NAV_UNREACHABLE termination (r03).
import { describe, expect, it } from 'vitest'
import { Cooldowns, forageTarget, selectInterrupt } from '../../src/controller/interrupts.js'
import { mapView } from '../../src/nav/blocks.js'
import type { EntityInfo, WorldState } from '../../src/observer/types.js'
import { Recovery, searchTargetUnreachable } from '../../src/recovery/ladder.js'
import { aquaticThreats, atWater, inlandPoint, waterWithin } from '../../src/skills/survival/aquatic.js'
import { assessThreat } from '../../src/skills/survival/threat.js'
import type { V3 } from '../../src/schema/index.js'
import { fakeState } from './helpers.js'

const ent = (name: string, kind: EntityInfo['kind'], pos: V3, over: Partial<EntityInfo> = {}): EntityInfo =>
  ({ id: Math.round(pos[0] * 7 + pos[2] * 13) + name.length, name, kind, pos, dist: Math.hypot(pos[0], pos[2]), los: true, ...over })
/** The sea lies at x ≤ -3 (water cells at y 62); land at x > -3. The bot stands at the origin. */
const sea: V3[] = Array.from({ length: 16 }, (_, i) => [-3 - (i % 4), 62, (i >> 2) - 2] as V3)
const day = (s: Partial<WorldState>) => fakeState({ pos: [0, 63, 0], ...s, vitals: { ...fakeState().vitals, timeOfDay: 3000, ...(s.vitals ?? {}) } })
const armed = { iron_sword: 1, shield: 1 }
const none = { skill: null, priority: null }

describe('aquatic zone helpers', () => {
  it('finds aquatic hostiles in the zone and water near the bot', () => {
    const s = day({ nearby: { entities: [ent('drowned', 'hostile', [-10, 62, 0]), ent('zombie', 'hostile', [5, 63, 0])], interestBlocks: { water: sea }, hazards: [] } })
    expect(aquaticThreats(s).map(e => e.name)).toEqual(['drowned'])
    expect(atWater(s)).toBe(true)
    expect(atWater(day({ nearby: { entities: [], interestBlocks: { water: sea.map(w => [w[0] - 10, w[1], w[2]] as V3) }, hazards: [] } }))).toBe(false)
  })

  it('the inland point lies away from the drowned and the water', () => {
    const s = day({ nearby: { entities: [ent('drowned', 'hostile', [-8, 62, 0])], interestBlocks: { water: sea }, hazards: [] } })
    const p = inlandPoint(s)!
    expect(p[0]).toBeGreaterThan(15)
    expect(Math.abs(p[2])).toBeLessThan(6)
    expect(inlandPoint(day({}))).toBeNull()
  })

  it('waterWithin sees water at a target from loaded blocks; unloaded counts as dry', () => {
    const v = mapView((x, y) => (y < 62 ? 'stone' : y === 62 && x <= -3 ? 'water' : 'air'))
    expect(waterWithin(v, [0, 63, 0])).toBe(true)
    expect(waterWithin(v, [10, 63, 0])).toBe(false)
    expect(waterWithin(mapView(() => 'unloaded'), [0, 63, 0])).toBe(false)
  })
})

describe('threat response to aquatic hostiles', () => {
  it('in water with a drowned: flee to land, never defend or cover (r14, r15)', () => {
    const drowned = ent('drowned', 'hostile', [3, 62, 0])
    const wet = day({ inventory: armed, armor: 4, inLiquid: 'water', body: { ...fakeState().body, feet: 'water' }, nearby: { entities: [drowned, ent('drowned', 'hostile', [10, 60, 0], { held: 'trident' })], interestBlocks: { water: sea }, hazards: [] } })
    expect(assessThreat(wet).action).toBe('flee')
    const i = selectInterrupt(wet, new Cooldowns(() => 0), none)
    expect(i?.skill).toBe('flee')
    // A flee cooldown never turns it into a defend in the water.
    const cd = new Cooldowns(() => 0)
    cd.set(`flee:${drowned.id}`, 30)
    expect(selectInterrupt(wet, cd, none)?.skill).toBe('flee')
  })

  it('on land a lone armed bot may still defend against a drowned', () => {
    const s = day({ inventory: armed, armor: 4, nearby: { entities: [ent('drowned', 'hostile', [3, 63, 0])], interestBlocks: {}, hazards: [] } })
    expect(assessThreat(s).action).toBe('defend')
  })
})

describe('forage skips shoreline prey while drowned are about', () => {
  const cow = (x: number) => ent('cow', 'passive', [x, 63, 0])
  it('a cow at the water is left while a drowned is in the zone, taken when none is', () => {
    const at = (entities: EntityInfo[]) => day({ nearby: { entities, interestBlocks: { water: sea }, hazards: [] } })
    expect(forageTarget(at([cow(-1)]), none, false)?.name).toBe('cow')
    expect(forageTarget(at([cow(-1), ent('drowned', 'hostile', [-20, 60, 0])]), none, false)).toBeNull()
    // Inland prey is still fine.
    expect(forageTarget(at([cow(8), ent('drowned', 'hostile', [-20, 60, 0])]), none, false)?.name).toBe('cow')
  })
})

describe('unreachable search targets (re-gate 20260930 r03)', () => {
  const o = { id: 'wooden_pickaxe', milestone: 'A', skill: 'obtain', params: {}, strategy: 'default', budgetMs: 1e9 }
  const nav = (detail: Record<string, unknown>) => ({ class: 'NAV_UNREACHABLE' as const, reason: 'x', detail, signature: 'NAV_UNREACHABLE|obtain|wooden_pickaxe|overworld|step=collect,target=log' })

  it('obtain → collect with unreachable logs relocates and suspends, never terminates', () => {
    const f = nav({ key: 'step=collect,target=log', child: { key: 'target=log', targetsTried: 3, searchTarget: true } })
    expect(searchTargetUnreachable(f)).toBe(true)
    const r = new Recovery(() => 0)
    const kinds = Array.from({ length: 20 }, () => r.handle(o, f).kind)
    expect(kinds).not.toContain('terminate')
    expect(kinds).toContain('relocate')
  })

  it('a plain unreachable navigation still terminates after 14 failures', () => {
    const f = nav({ key: 'step=navigate' })
    expect(searchTargetUnreachable(f)).toBe(false)
    const r = new Recovery(() => 0)
    expect(Array.from({ length: 14 }, () => r.handle(o, f).kind)).toContain('terminate')
  })
})

describe('hunt search stays on the surface (dev batch 13: ~800 s of daylight tunnelling for animals)', () => {
  it('a covered bot takes a surface step with { surface: true }, a tunnel step by default', async () => {
    const { Searcher } = await import('../../src/skills/generic/explore.js')
    const goals: unknown[] = []
    const covered = fakeState({ pos: [0, 63, 0], body: { ...fakeState().body, covered: true } })
    const ctx = {
      state: () => covered,
      log: () => {},
      progress: () => {},
      checkAbort: () => {},
      env: { random: () => 0.5 },
      nav: { goto: async (g: unknown) => { goals.push(g); return { ok: true } } },
    } as unknown as Parameters<InstanceType<typeof Searcher>['step']>[0]
    await new Searcher('cow', { surface: true }).step(ctx)
    await new Searcher('iron_ore').step(ctx)
    expect((goals[0] as { kind: string }).kind).toBe('xz')
    expect((goals[1] as { kind: string }).kind).toBe('near')
  })
})
