// The single Minecraft target (PROJECT.md): vanilla Java Edition 1.16.1.
// Version facts that minecraft-data does not already provide for this version
// live here, so the rest of the code stays version-neutral. Pure constants: no
// seed, world or run data (evaluation.md §2.4).

export const MC_VERSION = '1.16.1'

/** Mojang's version manifest for 1.16.1 declares `javaVersion: jre-legacy, 8`. */
export const JAVA_MAJOR = 8

/** Pre-1.18 Overworld: bedrock floor at y 0–4, build limit 255, sea surface at y 62. */
export const OVERWORLD = { minY: 0, maxY: 255, seaLevel: 63 } as const

/**
 * Underground bands for 1.16.1 terrain (pre-1.18 carvers and uniform ore ranges):
 * - carvers fill cave and ravine air at y ≤ 10 with lava (the "lava level");
 * - iron ore y 0–63, gold y 0–31, redstone y 0–15, diamond y 0–15;
 * - there are no noise caves or aquifers, so caves are sparser than in 1.18+.
 */
export const UNDERGROUND = {
  /** Highest y where carvers place lava instead of air. */
  lavaLevel: 10,
  /** Navigation-benchmark cave targets: standable cave cells in this feet-y range. */
  caveBand: [12, 40] as const,
  /** Feet y for the benchmark's excavate-to-depth trial and for iron mining later (5 above lava level). */
  miningY: 16,
  /** Feet y for diamond-level strip mining later: the lowest level kept clear of lava lakes. */
  diamondY: 11,
} as const

/**
 * Entities minecraft-data leaves uncategorised (`UNKNOWN`) for 1.16.1, classified
 * by in-game behaviour. Neutral mobs count as passive until they target the bot.
 */
export const ENTITY_KIND_GAPS: Record<string, 'hostile' | 'passive'> = {
  piglin: 'hostile', hoglin: 'hostile', zoglin: 'hostile',
  zombified_piglin: 'passive', strider: 'passive', fox: 'passive', bee: 'passive',
}

// ── Milestone A game facts (architecture §14.1), all 1.16.1 ─────────────────
// minecraft-data 1.16.1 has crafting recipes, foods, durability and harvest tools,
// but no furnace recipes, fuel values or mob behaviour; those live here.

/**
 * Furnace recipes used by milestone A (1.16.1 jar `data/minecraft/recipes`).
 * Iron and gold ore drop the ore block and must be smelted (no raw ores before 1.17).
 */
export const SMELTING: Record<string, string> = {
  iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
  cobblestone: 'stone',
  sand: 'glass',
}

/** Furnace cook time per item (ticks). */
export const SMELT_TICKS = 200

/** Fuel burn time in ticks (1.16.1 `AbstractFurnaceBlockEntity.getFuel`). Names ending in _log/_planks/_wood are matched by `fuelTicks`. */
export const FUEL_TICKS: Record<string, number> = {
  coal: 1600, charcoal: 1600, coal_block: 16000, lava_bucket: 20000, blaze_rod: 2400, dried_kelp_block: 4001,
  stick: 100, crafting_table: 300, wooden_pickaxe: 200, wooden_axe: 200, wooden_shovel: 200, wooden_sword: 200, wooden_hoe: 200,
}

export function fuelTicks (name: string): number {
  if (FUEL_TICKS[name] !== undefined) return FUEL_TICKS[name]!
  if (/_(log|planks|wood|hyphae|stem)$/.test(name) && !/^(crimson|warped)_/.test(name)) return 300 // nether stems do not burn
  if (/_sapling$/.test(name)) return 100
  return 0
}

/** Tool material tiers (harvest level). Golden tools harvest like wooden ones. */
export const TOOL_TIER: Record<string, number> = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }

export function toolTier (name: string): number | null {
  const m = name.match(/^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)$/)
  return m ? TOOL_TIER[m[1]!]! : null
}

/** Gravel drops flint 10 % of the time without Fortune (1.16.1 loot table). */
export const GRAVEL_FLINT_CHANCE = 0.1

/** Hostile mobs spawn at light level ≤ 7 before 1.18 (0 from 1.18 on). */
export const MONSTER_SPAWN_LIGHT = 7

/** Phantoms need 3 days (72 000 ticks) without sleep; a 45-minute run is 54 000 ticks, so none appear in milestone A. */
export const PHANTOM_INSOMNIA_TICKS = 72_000

/** Surface monsters spawn once the sky darkens (≈ 13 000) until dawn (≈ 23 000). Beds work from 12 541 in clear weather. */
export const NIGHT = { start: 13_000, end: 23_000, sleepFrom: 12_541, sleepUntil: 23_458 } as const

/**
 * 1.9+ combat, unchanged through 1.16.1: attack-speed cooldowns (ms for a full
 * hit) and base damage by weapon. The hand is 4 attacks/s.
 */
export const WEAPONS: Record<string, { damage: number; cooldownMs: number }> = {
  hand: { damage: 1, cooldownMs: 250 },
  wooden_sword: { damage: 4, cooldownMs: 625 }, golden_sword: { damage: 4, cooldownMs: 625 },
  stone_sword: { damage: 5, cooldownMs: 625 }, iron_sword: { damage: 6, cooldownMs: 625 }, diamond_sword: { damage: 7, cooldownMs: 625 },
  wooden_axe: { damage: 7, cooldownMs: 1250 }, golden_axe: { damage: 7, cooldownMs: 1000 },
  stone_axe: { damage: 9, cooldownMs: 1250 }, iron_axe: { damage: 9, cooldownMs: 1111 }, diamond_axe: { damage: 9, cooldownMs: 1000 },
}

/** Armor points per piece (1.16.1). */
export const ARMOR_POINTS: Record<string, number> = {
  leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
  golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
  chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
  iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
  diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
  turtle_helmet: 2,
}

/**
 * Overworld hostile behaviour in 1.16.1, for the deterministic threat score.
 * `weight` is relative danger at close range; `range` is how far the mob hurts
 * the bot (ranged attackers); `neutral` mobs only count once they are close
 * (endermen, spiders in daylight, polar bears), zombified piglins never.
 * No goats, wardens, breezes or bogged exist in 1.16.1.
 */
export type MobThreat = { weight: number; range: number; explosive?: boolean; neutral?: boolean; ranged?: boolean }
export const MOB_THREATS: Record<string, MobThreat> = {
  zombie: { weight: 1.0, range: 2 }, husk: { weight: 1.1, range: 2 }, zombie_villager: { weight: 1.0, range: 2 },
  drowned: { weight: 1.0, range: 2 }, // with a trident it is ranged: see threat.ts
  skeleton: { weight: 1.5, range: 15, ranged: true }, stray: { weight: 1.6, range: 15, ranged: true },
  spider: { weight: 1.2, range: 2, neutral: true }, cave_spider: { weight: 1.4, range: 2 },
  creeper: { weight: 2.5, range: 3, explosive: true },
  enderman: { weight: 2.0, range: 2, neutral: true },
  witch: { weight: 1.6, range: 8, ranged: true },
  slime: { weight: 0.6, range: 2 }, phantom: { weight: 1.0, range: 2 },
  pillager: { weight: 1.6, range: 12, ranged: true }, vindicator: { weight: 2.5, range: 2 }, evoker: { weight: 2.5, range: 10, ranged: true },
  ravager: { weight: 4.0, range: 3 }, vex: { weight: 1.5, range: 2 }, illusioner: { weight: 2.0, range: 12, ranged: true },
  silverfish: { weight: 0.5, range: 2 }, endermite: { weight: 0.5, range: 2 },
  guardian: { weight: 1.5, range: 12, ranged: true }, elder_guardian: { weight: 3.0, range: 12, ranged: true },
  polar_bear: { weight: 1.5, range: 2, neutral: true }, wolf: { weight: 1.0, range: 2, neutral: true },
}

/** Creeper: swells within 3 blocks, fuse 30 ticks, stops swelling beyond 7 blocks (1.16.1 SwellGoal). */
export const CREEPER = { swellRange: 3, fuseMs: 1500, defuseRange: 7 } as const

/** 1.16.1 entity metadata indices (protocol 736) that Mineflayer does not name. */
export const METADATA = {
  /** AgeableMob: is_baby (boolean). */
  ageableBaby: 15,
  /** Creeper: swell direction (−1 idle, 1 swelling). */
  creeperSwell: 15,
} as const

/**
 * Food animals and their raw drops (1.16.1 entity loot tables; babies drop nothing).
 * Cod and salmon (3 HP, drop their raw fish; smelted they are cooked food) are the
 * source where land animals are scarce: in 4 of 6 food-failure runs of dev batches 8–9
 * land animals were nearly absent while fish were seen 200–990 times.
 */
export const FOOD_ANIMALS: Record<string, string[]> = {
  cow: ['beef'], mooshroom: ['beef'], pig: ['porkchop'], sheep: ['mutton'], chicken: ['chicken'], rabbit: ['rabbit'],
  cod: ['cod'], salmon: ['salmon'],
}

/** Food animals that live in water (hunted only near the surface, never foraged). */
export const FISH = new Set(['cod', 'salmon'])

/** Foods never eaten voluntarily (hunger, poison, nausea) and foods kept for special uses. */
export const UNSAFE_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit'])

/** Items that are the output of a furnace food recipe: what "cooked food" means for nether_ready. */
export const COOKED_FOODS = new Set(Object.entries(SMELTING).filter(([k]) => !/ore$|^cobblestone$|^sand$|^kelp$/.test(k)).map(([, v]) => v))
