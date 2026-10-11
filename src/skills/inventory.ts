// Inventory policy shared by pickup (P2) and inventory-space handling (P2).
// Pure data and functions over item names and counts.

/** Never worth a slot (1.16.1 names); milestone C adds the piglin barter leftovers. */
const JUNK = /^(andesite|diorite|granite|rotten_flesh|bone|string|spider_eye|arrow|wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds|poppy|dandelion|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|.*_sapling|feather|gunpowder|egg|snowball|ink_sac|seagrass|kelp|lily_pad|dead_bush|grass|fern|tall_grass|large_fern|vine|.*_mushroom|leather|(?!white_).*_wool|.*_carpet|clay_ball|sugar_cane|bamboo|cactus|netherrack|tuff|mossy_cobblestone|.*_terracotta|terracotta|red_sand|sandstone|flower_pot|rail|quartz|glowstone_dust|magma_cream|nether_brick|crying_obsidian|soul_sand|soul_soil|fire_charge|iron_nugget|enchanted_book|book|basalt|crimson_fungus|warped_fungus|crimson_roots|warped_roots|nether_sprouts|weeping_vines|twisting_vines|nether_wart)$/

/** Keep at most this many; the surplus is junk. Scaffolding and furnace stone stay. White wool: one bed (milestone C respawn point). */
const CAPS: Record<string, number> = { white_wool: 3, dirt: 64, cobblestone: 128, gravel: 16, sand: 8, stone: 32, coarse_dirt: 0, podzol: 0, blackstone: 32, obsidian: 16 }

export function isJunk (name: string): boolean {
  return JUNK.test(name)
}

/** Worth picking up given the current inventory. */
export function isUsefulDrop (name: string, inv: Record<string, number>): boolean {
  if (isJunk(name)) return false
  const cap = CAPS[name]
  return cap === undefined || (inv[name] ?? 0) < cap
}

/** Items to toss (name → count) to free space: all junk, then surplus over caps. */
export function surplus (inv: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, n] of Object.entries(inv)) {
    if (isJunk(name)) out[name] = n
    else if (CAPS[name] !== undefined && n > CAPS[name]!) out[name] = n - CAPS[name]!
  }
  return out
}
