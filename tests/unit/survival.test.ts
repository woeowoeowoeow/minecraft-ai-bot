import { describe, expect, it } from 'vitest'
import { Cooldowns, selectInterrupt } from '../../src/controller/interrupts.js'
import type { EntityInfo } from '../../src/observer/types.js'
import { armorUpgrades, chooseFood } from '../../src/skills/food.js'
import { isUsefulDrop, surplus } from '../../src/skills/inventory.js'
import { assessThreat, capacity, mobThreat } from '../../src/skills/survival/threat.js'
import { mapView } from '../../src/nav/blocks.js'
import { safeCells } from '../../src/nav/hazards.js'
import { fakeState } from './helpers.js'

const mob = (name: string, dist: number, over: Partial<EntityInfo> = {}): EntityInfo => ({ id: Math.round(dist * 100) + name.length, name, kind: 'hostile', pos: [dist, 64, 0], dist, los: true, ...over })
const cd = () => new Cooldowns(() => 0)
const none = { skill: null, priority: null }

describe('threat score (1.16.1 mobs)', () => {
  it('ignores neutral and out-of-sight mobs, counts ranged mobs at range', () => {
    const s = fakeState()
    expect(mobThreat(mob('zombified_piglin', 2), s)).toBeNull()
    expect(mobThreat(mob('enderman', 6), s)).toBeNull()
    expect(mobThreat(mob('zombie', 6, { los: false }), s)).toBeNull()
    expect(mobThreat(mob('skeleton', 14), s)).not.toBeNull()
    expect(mobThreat(mob('zombie', 14), s)).toBeNull()
    // spiders are neutral in daylight on the surface, hostile at night
    expect(mobThreat(mob('spider', 5), fakeState({ vitals: { ...s.vitals, timeOfDay: 6000 } }))).toBeNull()
    expect(mobThreat(mob('spider', 5), fakeState({ vitals: { ...s.vitals, timeOfDay: 18000 } }))).not.toBeNull()
    // a drowned with a trident is a ranged threat
    expect(mobThreat(mob('drowned', 11, { held: 'trident' }), s)?.ranged).toBe(true)
  })

  it('defends against one zombie with a sword, flees a crowd or at low health', () => {
    const armed = fakeState({ inventory: { stone_sword: 1 }, nearby: { entities: [mob('zombie', 3)], interestBlocks: {}, hazards: [] } })
    expect(assessThreat(armed)).toMatchObject({ engage: true, action: 'defend' })
    const crowd = fakeState({ nearby: { entities: [mob('zombie', 2), mob('zombie', 3.5), mob('skeleton', 8), mob('creeper', 4)], interestBlocks: {}, hazards: [] } })
    expect(assessThreat(crowd).action).toBe('flee')
    const weak = fakeState({ inventory: { iron_sword: 1 }, vitals: { ...armed.vitals, health: 5 }, nearby: armed.nearby })
    expect(assessThreat(weak).action).toBe('flee')
    const swelling = fakeState({ inventory: { iron_sword: 1 }, nearby: { entities: [mob('creeper', 2.5, { swelling: true })], interestBlocks: {}, hazards: [] } })
    expect(assessThreat(swelling).action).toBe('flee')
  })

  it('bare hands never take on a zombie; a stone sword does', () => {
    const z = { entities: [mob('zombie', 3)], interestBlocks: {}, hazards: [] }
    expect(assessThreat(fakeState({ nearby: z })).action).toBe('flee')
    // even a distant drowned whose scaled threat is below an unarmed capacity (dev batch 4)
    expect(assessThreat(fakeState({ nearby: { entities: [mob('drowned', 8)], interestBlocks: {}, hazards: [] } })).action).toBe('flee')
    expect(assessThreat(fakeState({ inventory: { stone_sword: 1 }, nearby: z })).action).toBe('defend')
  })

  it('armor, weapon and shield raise capacity; water lowers it', () => {
    const base = capacity(fakeState())
    expect(capacity(fakeState({ inventory: { iron_sword: 1 } }))).toBeGreaterThan(base)
    expect(capacity(fakeState({ inventory: { iron_sword: 1, shield: 1 }, armor: 4 }))).toBeGreaterThan(capacity(fakeState({ inventory: { iron_sword: 1 } })))
    expect(capacity(fakeState({ inLiquid: 'water' }))).toBeLessThan(base)
  })
})

describe('interrupt selection (P0 > P1 > P2)', () => {
  it('lava and fire beat everything; low air under water surfaces', () => {
    const s = fakeState({ body: { feet: 'lava', head: 'air', velY: 0, fallDist: 0, light: null, covered: false }, nearby: { entities: [mob('zombie', 2)], interestBlocks: {}, hazards: [] } })
    expect(selectInterrupt(s, cd(), none)).toMatchObject({ id: 'escape_lava', priority: 0 })
    const drowning = fakeState({ body: { feet: 'water', head: 'water', velY: 0, fallDist: 0, light: null, covered: false }, vitals: { ...s.vitals, air: 6 } })
    expect(selectInterrupt(drowning, cd(), none)).toMatchObject({ id: 'surface', priority: 0 })
    const suffocating = fakeState({ body: { feet: 'air', head: 'solid', velY: 0, fallDist: 0, light: null, covered: true } })
    expect(selectInterrupt(suffocating, cd(), none)).toMatchObject({ id: 'suffocation' })
  })

  it('threats beat maintenance; a failed defend against a mob turns into flee', () => {
    const s = fakeState({ inventory: { stone_sword: 1, cooked_beef: 3 }, vitals: { ...fakeState().vitals, food: 5 }, nearby: { entities: [mob('zombie', 3)], interestBlocks: {}, hazards: [] } })
    const i = selectInterrupt(s, cd(), none)!
    expect(i).toMatchObject({ id: 'defend', priority: 1 })
    const c = cd()
    c.set(`defend:${i.params.targetId as number}`, 20)
    expect(selectInterrupt(s, c, none)).toMatchObject({ id: 'flee' })
    c.set(`flee:${i.params.targetId as number}`, 20)
    expect(selectInterrupt(s, c, none)).toMatchObject({ id: 'eat', priority: 2 })
  })

  it('maintenance: eat, equip, free space, pick up useful drops (not bulk during mining)', () => {
    expect(selectInterrupt(fakeState({ inventory: { bread: 1 }, vitals: { ...fakeState().vitals, food: 12 } }), cd(), none)).toMatchObject({ id: 'eat' })
    // hurt but fed: rest instead of eating (natural regeneration works from food 18)
    expect(selectInterrupt(fakeState({ vitals: { ...fakeState().vitals, health: 8, food: 19 } }), cd(), none)).toMatchObject({ id: 'rest' })
    expect(selectInterrupt(fakeState({ inventory: { iron_helmet: 1 } }), cd(), none)).toMatchObject({ id: 'equip' })
    expect(selectInterrupt(fakeState({ inventory: { shield: 1 } }), cd(), none)).toMatchObject({ id: 'equip' })
    expect(selectInterrupt(fakeState({ freeSlots: 0, inventory: { andesite: 64 } }), cd(), none)).toMatchObject({ id: 'inventory' })
    const drop = (name: string, ageS = 10): EntityInfo => ({ id: 7, name: 'item', kind: 'item', pos: [3, 64, 0], dist: 3, item: { name, count: 1 }, ageS })
    const withDrop = (name: string, inv: Record<string, number> = {}) => fakeState({ inventory: inv, nearby: { entities: [drop(name)], interestBlocks: {}, hazards: [] } })
    expect(selectInterrupt(withDrop('iron_ore'), cd(), { skill: 'mine', priority: 3 })).toMatchObject({ id: 'pickup' })
    expect(selectInterrupt(withDrop('rotten_flesh'), cd(), none)).toBeNull()
    expect(selectInterrupt(withDrop('cobblestone', { cobblestone: 40 }), cd(), { skill: 'mine', priority: 3 })).toBeNull()
  })
})

describe('food, gear and inventory choices', () => {
  it('eats safe non-goal food first, then cooked, never poisonous', () => {
    expect(chooseFood({ cooked_beef: 3, bread: 1 }, 10)).toBe('bread')
    expect(chooseFood({ cooked_beef: 3, beef: 2 }, 10)).toBe('cooked_beef')
    expect(chooseFood({ beef: 2, chicken: 2 }, 10)).toBe('beef') // raw chicken can poison (hunger)
    expect(chooseFood({ spider_eye: 3, rotten_flesh: 2 }, 10)).toBeNull()
    expect(chooseFood({ rotten_flesh: 2 }, 5)).toBe('rotten_flesh')
    // raw meat is the input for cooked food: kept unless the bot is really hungry
    expect(chooseFood({ mutton: 5 }, 14)).toBeNull()
    expect(chooseFood({ mutton: 5 }, 9)).toBe('mutton')
    expect(chooseFood({ mutton: 5 }, 16, 3)).toBe('mutton') // badly hurt: regeneration first
  })

  it('wears only upgrades', () => {
    expect(armorUpgrades({ iron_helmet: 1, leather_boots: 1 }, { head: null, chest: null, legs: null, feet: 'iron_boots' })).toEqual([{ item: 'iron_helmet', slot: 'head' }])
  })

  it('junk and surplus are tossed; ores and tools are kept', () => {
    expect(surplus({ andesite: 12, cobblestone: 200, iron_ore: 20, stone_pickaxe: 1 })).toEqual({ andesite: 12, cobblestone: 72 })
    expect(isUsefulDrop('iron_ore', {})).toBe(true)
    expect(isUsefulDrop('dirt', { dirt: 64 })).toBe(false)
  })
})

describe('lava escape cells', () => {
  it('finds dry ground away from lava, preferring higher cells', () => {
    const fill = (x: number, y: number) => (y <= 63 ? (x >= -2 && x <= 2 ? 'lava' : 'stone') : 'air')
    const cells = safeCells(mapView(fill, {}), [0, 64, 0])
    expect(cells.length).toBeGreaterThan(0)
    for (const c of cells) expect(Math.abs(c[0])).toBeGreaterThanOrEqual(3) // off the lava, on solid floor
  })
})
