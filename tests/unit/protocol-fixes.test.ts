import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installDigAck, type DigAckCorrection } from '../../src/bot/protocol-fixes.js'

/** Minimal bot: a client emitter and a one-block world whose state ids map to names. */
function fakeBot () {
  const names: Record<number, string> = { 0: 'air', 1: 'stone' }
  const world = new Map<string, number>()
  const client = new EventEmitter()
  const bot = {
    _client: client,
    blockAt: (p: { x: number; y: number; z: number }) => {
      const id = world.get(`${p.x},${p.y},${p.z}`) ?? 0
      return { stateId: id, name: names[id] }
    },
  } as Record<string, unknown>
  return { bot, client, world }
}

describe('dig acknowledgements (1.16.1)', () => {
  it('works when installed before Mineflayer attaches _updateBlockState (as in main.ts)', () => {
    const { bot, client, world } = fakeBot()
    const seen: DigAckCorrection[] = []
    installDigAck(bot as never, c => seen.push(c))
    const ack = { location: { x: 1, y: 2, z: 3 }, block: 1, status: 2, successful: true }
    expect(() => client.emit('acknowledge_player_digging', ack)).not.toThrow() // before the plugin loads: ignored
    bot._updateBlockState = (p: { x: number; y: number; z: number }, id: number) => { world.set(`${p.x},${p.y},${p.z}`, id) }
    client.emit('acknowledge_player_digging', ack) // client thinks air (ghost); server says stone
    expect(world.get('1,2,3')).toBe(1)
    expect(seen).toEqual([{ pos: [1, 2, 3], client: 'air', server: 'stone', status: 2, successful: true }])
    client.emit('acknowledge_player_digging', ack) // already in agreement: no change, no event
    expect(seen).toHaveLength(1)
  })
})
