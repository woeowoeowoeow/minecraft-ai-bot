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

/** Parses the SNBT list from `data get entity <name> Inventory` into item → count. */
export function parseInventoryData (snbt: string): Record<string, number> {
  const inv: Record<string, number> = {}
  for (const item of snbt.match(/\{[^{}]*\}/g) ?? []) {
    const id = item.match(/id: "minecraft:([a-z0-9_]+)"/)?.[1]
    const count = Number(item.match(/count: (\d+)/)?.[1] ?? '1')
    if (id) inv[id] = (inv[id] ?? 0) + count
  }
  return inv
}
