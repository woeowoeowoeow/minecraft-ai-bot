import type { GroundTruth } from '../schema/index.js'

const PREFIX = /^\[[^\]]*\] \[Server thread\/(INFO|WARN|ERROR)\]: (.*)$/

// Vanilla death message stems (en_us). Matches "<name> <stem>…".
const DEATH_STEMS = [
  'was ', 'drowned', 'died', 'experienced kinetic energy', 'blew up', 'hit the ground too hard', 'fell ', 'went up in flames',
  'burned to death', 'walked into', 'tried to swim in lava', 'discovered the floor was lava', 'suffocated', 'starved',
  'froze to death', 'withered away', 'left the confines', "didn't want to live", 'went off with a bang', 'was killed',
]

/** Parses one server log line into an evaluator ground-truth record (or null). */
export function parseServerLine (line: string, username: string, t: number): GroundTruth | null {
  const m = line.match(PREFIX)
  if (!m) return null
  const msg = m[2]!
  if (/^Done \(/.test(msg)) return { t, kind: 'server_ready', data: {} }
  if (msg.startsWith(username + ' ')) {
    const rest = msg.slice(username.length + 1)
    if (rest === 'joined the game') return { t, kind: 'join', data: {} }
    if (rest === 'left the game') return { t, kind: 'leave', data: {} }
    if (rest.startsWith('lost connection:')) return { t, kind: 'leave', data: { reason: rest.slice(17).trim() } }
    const adv = rest.match(/^has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]$/)
    if (adv) return { t, kind: 'advancement', data: { name: adv[1] } }
    if (/^moved (too quickly|wrongly)/.test(rest)) return { t, kind: 'moved_wrongly', data: { msg: rest } }
    if (rest.startsWith('has the following entity data')) return null // query responses are parsed by the caller
    if (DEATH_STEMS.some(s => rest.startsWith(s))) return { t, kind: 'death', data: { message: msg } }
  }
  if (msg.startsWith(`Kicked ${username}`) || msg.startsWith(`Disconnecting ${username}`)) return { t, kind: 'kick', data: { msg } }
  if (m[1] === 'ERROR') return { t, kind: 'server_error', data: { msg: msg.slice(0, 300) } }
  return null
}

/** Top-level `{…}` compounds of an SNBT list (nested tags stay inside their item). */
function topLevelCompounds (snbt: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let quoted = false
  for (let i = 0; i < snbt.length; i++) {
    const c = snbt[i]
    if (c === '"' && snbt[i - 1] !== '\\') quoted = !quoted
    if (quoted) continue
    if (c === '{' && depth++ === 0) start = i
    else if (c === '}' && --depth === 0) out.push(snbt.slice(start, i + 1))
  }
  return out
}

/**
 * Parses the SNBT list from `data get entity <name> Inventory` into item → count.
 * 1.16.1 prints `{Slot: 0b, id: "minecraft:oak_log", Count: 4b}`, with any
 * `tag: {…}` (damage, enchantments) after the count.
 */
export function parseInventoryData (snbt: string): Record<string, number> {
  const inv: Record<string, number> = {}
  for (const item of topLevelCompounds(snbt)) {
    const id = item.match(/id: "minecraft:([a-z0-9_]+)"/)?.[1]
    const count = item.match(/\bCount: (\d+)b/)?.[1]
    if (id && count) inv[id] = (inv[id] ?? 0) + Number(count)
  }
  return inv
}

const COOKED = /^(cooked_(beef|porkchop|chicken|mutton|rabbit|cod|salmon)|baked_potato)$/

/**
 * Server-side check of nether_ready's inventory clauses (milestones.md A). The
 * lava-pool half of option B is bot memory and cannot be checked from the
 * inventory; a water bucket stands in for it here.
 */
export function netherReadyInventory (inv: Record<string, number>): boolean {
  const n = (k: string) => inv[k] ?? 0
  const armor = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].filter(k => n(k) > 0).length
  const cooked = Object.entries(inv).filter(([k]) => COOKED.test(k)).reduce((a, [, v]) => a + v, 0)
  return n('iron_pickaxe') >= 1 && n('iron_sword') >= 1 && n('shield') >= 1 && n('bucket') >= 1 && armor >= 2 &&
    n('flint_and_steel') >= 1 && cooked >= 10 && (n('obsidian') >= 10 || n('water_bucket') >= 1)
}

/** 1.16.1 advancement title for entering the Nether (story/enter_the_nether). */
export const NETHER_ADVANCEMENT = 'We Need to Go Deeper'

/** `data get entity <name> Dimension` → dimension id without the namespace, or null. */
export function parseDimension (line: string, username: string): string | null {
  const m = line.match(new RegExp(`${username} has the following entity data: "minecraft:([a-z_]+)"`))
  return m ? m[1]! : null
}

/**
 * Server-side check of milestone B: the Nether-entry advancement was granted, the bot
 * ends the run in the Overworld (return_ok), and a lit portal block stands where the bot
 * says it built one. Bot memory (which portal it used) is not visible to the server.
 */
export function milestoneBVerified (g: { advancements: string[]; dimension: string | null; portalCheck: boolean | null }): boolean {
  return g.advancements.includes(NETHER_ADVANCEMENT) && g.dimension === 'overworld' && g.portalCheck === true
}

/**
 * Server-side check of milestone C: milestone B's checks (Nether-entry advancement, a lit portal
 * at the cell the bot reports having built, Overworld at the end), plus ≥ 7 blaze rods and
 * ≥ 14 ender pearls in the server's inventory of the bot.
 */
export function milestoneCVerified (g: { advancements: string[]; dimension: string | null; portalCheck: boolean | null; inventory: Record<string, number> | null }, rods = 7, pearls = 14): boolean {
  return milestoneBVerified(g) && !!g.inventory && (g.inventory.blaze_rod ?? 0) >= rods && (g.inventory.ender_pearl ?? 0) >= pearls
}
