import mcData from 'minecraft-data'
import { describe, expect, it } from 'vitest'
import { countOf, planObtain, recipeFor, ResolveError, smeltCapacity, sourceFor, type Step } from '../../src/skills/sources.js'
import { MC_VERSION, SMELTING } from '../../src/version.js'

const kinds = (steps: Step[]) => steps.map(s => `${s.kind}:${s.item}`)

describe('source table (1.16.1)', () => {
  it('iron and gold ore are mined and smelted; ores need the right pickaxe tier', () => {
    expect(sourceFor('iron_ingot')).toEqual({ kind: 'smelt', input: 'iron_ore' })
    expect(sourceFor('gold_ingot')).toEqual({ kind: 'smelt', input: 'gold_ore' })
    expect(sourceFor('iron_ore')).toMatchObject({ kind: 'gather', blocks: ['iron_ore'], tool: { tool: 'pickaxe', minTier: 1 } })
    expect(sourceFor('gold_ore')).toMatchObject({ tool: { minTier: 2 } })
    expect(sourceFor('obsidian')).toMatchObject({ tool: { minTier: 3 } })
  })

  it('every smelting output is a real 1.16.1 item and every input exists', () => {
    const d = mcData(MC_VERSION)
    for (const [i, o] of Object.entries(SMELTING)) {
      expect(d.itemsByName[i], i).toBeDefined()
      expect(d.itemsByName[o], o).toBeDefined()
    }
  })

  it('normalises recipe variants to groups', () => {
    expect(recipeFor('stick')).toEqual({ result: 4, ingredients: { planks: 2 }, table: false })
    expect(recipeFor('crafting_table')).toEqual({ result: 1, ingredients: { planks: 4 }, table: false })
    expect(recipeFor('shield')).toEqual({ result: 1, ingredients: { planks: 6, iron_ingot: 1 }, table: true })
    expect(recipeFor('bucket')).toEqual({ result: 1, ingredients: { iron_ingot: 3 }, table: true })
    expect(recipeFor('flint_and_steel')).toEqual({ result: 1, ingredients: { iron_ingot: 1, flint: 1 }, table: false })
    expect(recipeFor('stone_pickaxe')).toEqual({ result: 1, ingredients: { cobblestone: 3, stick: 2 }, table: true })
    expect(recipeFor('furnace')).toEqual({ result: 1, ingredients: { cobblestone: 8 }, table: true })
    expect(recipeFor('iron_helmet')).toEqual({ result: 1, ingredients: { iron_ingot: 5 }, table: true })
  })

  it('tools and tables are not fuel', () => {
    expect(smeltCapacity({ wooden_pickaxe: 1, crafting_table: 1 })).toBe(0)
    expect(smeltCapacity({ coal: 2, oak_planks: 2, stick: 1 })).toBe(19)
  })
})

describe('planObtain', () => {
  it('wooden pickaxe from nothing: logs → planks → table → sticks → pickaxe, no double-counted planks', () => {
    const { steps, inv } = planObtain('wooden_pickaxe', 1, {})
    // one trip for all three logs (later gathers are folded into the first)
    expect(kinds(steps)).toEqual(['gather:log', 'craft:planks', 'craft:planks', 'craft:stick', 'craft:planks', 'craft:crafting_table', 'craft:wooden_pickaxe'])
    expect(steps[0]).toMatchObject({ count: 3 })
    expect(inv.wooden_pickaxe).toBe(1)
    expect(inv.crafting_table).toBe(1)
    for (const v of Object.values(inv)) expect(v).toBeGreaterThanOrEqual(0)
  })

  it('reuses what the inventory has and targets absolute counts', () => {
    const { steps } = planObtain('stone_pickaxe', 1, { crafting_table: 1, stick: 2, wooden_pickaxe: 1 })
    expect(steps).toEqual([
      { kind: 'gather', item: 'cobblestone', count: 3, blocks: ['stone', 'cobblestone'], skill: 'mine', chance: undefined },
      { kind: 'craft', item: 'stone_pickaxe', count: 1 },
    ])
  })

  it('iron ingots need ore, a stone pickaxe, fuel and a furnace', () => {
    const { steps } = planObtain('iron_ingot', 3, { crafting_table: 1, wooden_pickaxe: 1, stick: 4, oak_log: 3 })
    expect(kinds(steps)).toEqual(['gather:cobblestone', 'craft:stone_pickaxe', 'gather:iron_ore', 'craft:furnace', 'smelt:iron_ingot'])
    expect(steps[0]).toMatchObject({ count: 11 }) // 3 for the pickaxe + 8 for the furnace, one trip
    // with coal ore known, fuel is coal instead of logs
    const withCoal = planObtain('iron_ingot', 20, { crafting_table: 1, stone_pickaxe: 1, furnace: 1 }, { coalOreKnown: true })
    expect(kinds(withCoal.steps)).toEqual(['gather:iron_ore', 'gather:coal_any', 'smelt:iron_ingot'])
    expect(withCoal.steps[1]).toMatchObject({ count: 3 })
  })

  it('shield: planks and one ingot; the table is kept', () => {
    const { steps, inv } = planObtain('shield', 1, { crafting_table: 1, iron_ingot: 1, oak_planks: 6 })
    expect(kinds(steps)).toEqual(['craft:shield'])
    expect(inv).toMatchObject({ shield: 1, crafting_table: 1 })
    expect(countOf(inv, 'planks')).toBe(0)
  })

  it('water bucket: fill a bucket (crafted from 3 ingots if needed)', () => {
    expect(kinds(planObtain('water_bucket', 1, { bucket: 1 }).steps)).toEqual(['fill:water_bucket'])
    expect(kinds(planObtain('water_bucket', 1, { iron_ingot: 3, crafting_table: 1 }).steps)).toEqual(['craft:bucket', 'fill:water_bucket'])
  })

  it('cooked food: hunt raw meat, smelt it with wood fuel and a furnace', () => {
    const { steps } = planObtain('cooked_food', 10, { crafting_table: 1, furnace: 1, oak_log: 8, cooked_beef: 2 })
    expect(kinds(steps)).toEqual(['hunt:raw_meat', 'smelt:cooked_food'])
    expect(steps[0]).toMatchObject({ count: 8 })
    expect(steps[1]).toMatchObject({ count: 10, input: 'raw_meat' })
  })

  it('flint is a chance drop knapped from one mined gravel block', () => {
    // B round 3: the gravel block comes from controlled mining (never lake-bed gravel from the water).
    expect(planObtain('flint', 1, {}).steps.slice(0, 2)).toMatchObject([
      { kind: 'gather', item: 'gravel', count: 1, blocks: ['gravel'], skill: 'mine' },
      { kind: 'gather', item: 'flint', blocks: ['gravel'], skill: 'collect', chance: true },
    ])
    // Carried gravel (picked up while mining) is knapped at once.
    expect(planObtain('flint', 1, { gravel: 2 }).steps).toMatchObject([{ kind: 'gather', item: 'flint', chance: true }])
  })

  it('fails cleanly for unknown sources and never recurses forever', () => {
    expect(() => planObtain('dragon_egg', 1, {})).toThrow(ResolveError)
  })

  it('a full nether_ready iron kit resolves from a stone-age inventory', () => {
    const inv = { crafting_table: 1, stone_pickaxe: 2, stone_sword: 1, stick: 6, oak_log: 10, furnace: 1, cooked_beef: 12 }
    for (const item of ['iron_pickaxe', 'iron_sword', 'shield', 'bucket', 'iron_helmet', 'iron_boots', 'flint_and_steel', 'water_bucket']) {
      const { steps, inv: after } = planObtain(item, 1, inv, { coalOreKnown: true })
      expect(countOf(after, item), item).toBeGreaterThanOrEqual(1)
      expect(steps.length, item).toBeGreaterThan(0)
      for (const v of Object.values(after)) expect(v, item).toBeGreaterThanOrEqual(0)
    }
  })
})
