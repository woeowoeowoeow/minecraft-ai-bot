// Inventory clicks on 1.16.1 (pre-`stateId` protocol). Every click carries the item the
// client believes is in the slot; the server rejects the click when it disagrees and then
// resends the whole window (`window_items`). Mineflayer throws "Server rejected
// transaction" and leaves the retry to the caller. B gate 20261002: 20 portal-build
// failures in 7 runs, plus eat, smelt and fillBucket, all on a bucket or food slot the
// server had just changed (a bucket use, a meal) before its `set_slot` reached the client.
// Here: one inventory action at a time per bot, and a bounded retry after the resend.
import { once } from 'node:events'
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

type Dest = 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'

export const EQUIP = {
  /** Attempts per equip (the first plus retries after a rejection). */
  attempts: 3,
  /** Wait for the server's window resend after a rejection. */
  resendMs: 1200,
  /** Per-click timeout (Mineflayer's own window timeout is longer). */
  clickMs: 3000,
} as const

/** Click action id for resync probes: negative, so it never collides with Mineflayer's own (positive) ids. */
const RESYNC_ACTION = -7

function timeout<T> (p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(h); resolve(v) }, e => { clearTimeout(h); reject(e) })
  })
}

/**
 * Ask the server for the authoritative inventory contents. Mineflayer's 2×2
 * craft never confirms its last click (it only syncs table windows), so the
 * client model can drift; architecture §7.2 requires a resync before trusting it.
 *
 * 1.16.1 (pre-`stateId` protocol): Mineflayer's `_syncWindow` is a no-op there,
 * so we use the vanilla mechanism instead. A click outside the window with an
 * empty cursor changes nothing on the server; claiming it produced an item makes
 * the server reject it, and a rejected click makes the server resend the whole
 * inventory (`window_items`). Mineflayer answers the rejection with the
 * acknowledgement that re-enables syncing. Returns false (no resync) when the
 * cursor holds an item, because a click outside the window would drop it.
 */
export async function resyncInventory (bot: Bot): Promise<boolean> {
  const b = bot as Bot & { _syncWindow?: (w: unknown) => Promise<void>; _client: { write (name: string, data: unknown): void } }
  if (bot.supportFeature('stateIdUsed')) {
    if (!b._syncWindow) return false
    try { await timeout(b._syncWindow(bot.inventory), 3000, 'inventory sync'); return true } catch { return false }
  }
  if (!bot.supportFeature('actionIdUsed') || bot.inventory.selectedItem) return false
  const synced = once(bot, 'setWindowItems:0')
  const claimed = bot.registry.itemsByName.stone!.id
  b._client.write('window_click', { windowId: 0, slot: -999, mouseButton: 0, action: RESYNC_ACTION, mode: 0, item: { present: true, itemId: claimed, itemCount: 1 } })
  try { await timeout(synced, 3000, 'inventory sync'); return true } catch { return false }
}

const chains = new WeakMap<Bot, Promise<unknown>>()
const retryListeners = new WeakMap<Bot, (r: EquipRetry) => void>()

/** Report every rejected-and-retried equip of this bot (telemetry: `inventory_retry`). */
export function onInventoryRetry (bot: Bot, fn: (r: EquipRetry) => void): void {
  retryListeners.set(bot, fn)
}

/** Run `fn` after every inventory action already queued for this bot (never two click sequences at once). */
export function serialInventory<T> (bot: Bot, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(bot) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  chains.set(bot, next.catch(() => {}))
  return next
}

/** A click the server refused (or never answered): the client's slot model was stale. */
export function isRejection (e: unknown): boolean {
  return /rejected transaction|didn't respond to transaction/.test(String((e as Error)?.message ?? e))
}

/** An equip the server never answered (our click timeout): the server is ignoring window-0 clicks. */
export function isUnanswered (e: unknown): boolean {
  return /didn't respond to transaction|equip .* timed out/.test(String((e as Error)?.message ?? e))
}

/**
 * The 1.16.1 server silently ignores clicks for a window other than the container it has
 * open, and closes whatever container is open on any `close_window`. Dev batch
 * 20261003-041048 r05: after a crafting-table click went unanswered, every later equip timed
 * out for 41 minutes (stone_pickaxe failed 14×, run terminated). Close both sides, then resync.
 */
export async function resetWindows (bot: Bot): Promise<boolean> {
  const b = bot as Bot & { _client: { write (name: string, data: unknown): void } }
  try {
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
    else b._client.write('close_window', { windowId: 0 })
  } catch { /* the resync below decides */ }
  await new Promise(r => setTimeout(r, 300))
  return resyncInventory(bot)
}

export type EquipRetry = { item: string; dest: Dest; attempt: number; error: string; resent: boolean; resynced: boolean; windowsReset?: boolean }

/** After a rejection: wait for the server's resend; probe for one when it does not come. */
async function settleAfterRejection (bot: Bot, resent: Promise<unknown>): Promise<{ resent: boolean; resynced: boolean }> {
  const got = await timeout(resent, EQUIP.resendMs, 'window resend').then(() => true, () => false)
  await new Promise(r => setTimeout(r, 100)) // the cursor packet follows the window resend
  if (got) return { resent: true, resynced: false }
  return { resent: false, resynced: await resyncInventory(bot) }
}

/**
 * A stack left on the cursor (the first click of an interrupted move was accepted, a later
 * one rejected) is put into an empty inventory slot: one click, which the server accepts
 * because it agrees that slot is empty. False when nothing could be done.
 */
export async function clearCursor (bot: Bot): Promise<boolean> {
  if (!bot.inventory.selectedItem) return true
  const empty = bot.inventory.firstEmptyInventorySlot()
  if (empty === null || empty === undefined) return false
  try { await timeout(bot.clickWindow(empty, 0, 0), EQUIP.clickMs, 'cursor put-away') } catch { return false }
  return !bot.inventory.selectedItem
}

/**
 * Equip `name` (looked up again on every attempt, since a resend can move or change it)
 * into `dest`, serialized with every other inventory action of this bot. A server
 * rejection waits for the authoritative resend and retries, at most EQUIP.attempts
 * times; anything else, or the last rejection, is thrown. Never spams clicks: each
 * retry follows a resend or a resync.
 */
export function safeEquip (bot: Bot, name: string, dest: Dest = 'hand', opts: { slot?: number; onRetry?: (r: EquipRetry) => void } = {}): Promise<Item> {
  const onRetry = opts.onRetry ?? retryListeners.get(bot)
  return serialInventory(bot, async () => {
    let last: unknown = null
    for (let attempt = 1; attempt <= EQUIP.attempts; attempt++) {
      if (dest === 'off-hand' && bot.inventory.slots[45]?.name === name) return bot.inventory.slots[45]!
      // A stack stranded on the cursor by an earlier interrupted move goes back first (the item
      // looked up below may be that very stack).
      if (bot.inventory.selectedItem) await clearCursor(bot)
      // The caller's chosen stack (e.g. the most worn pickaxe) while it is still there.
      const pref = opts.slot !== undefined ? bot.inventory.slots[opts.slot] : null
      const it = pref?.name === name ? pref : bot.inventory.items().find(i => i.name === name)
      if (!it) throw new Error(`no ${name} in inventory`)
      // Registered before the click: the resend follows the rejection packet immediately.
      const ac = new AbortController()
      const resent = once(bot, 'setWindowItems:0', { signal: ac.signal })
      resent.catch(() => {})
      try {
        await timeout(bot.equip(it, dest), EQUIP.clickMs, `equip ${name}`)
        return it
      } catch (e) {
        last = e
        const unanswered = isUnanswered(e)
        if ((!isRejection(e) && !unanswered) || attempt === EQUIP.attempts) throw e
        const error = String((e as Error)?.message ?? e).slice(0, 120)
        if (unanswered) onRetry?.({ item: name, dest, attempt, error, resent: false, resynced: await resetWindows(bot), windowsReset: true })
        else onRetry?.({ item: name, dest, attempt, error, ...(await settleAfterRejection(bot, resent)) })
      } finally {
        ac.abort()
      }
    }
    throw last
  })
}

/** Wait until the client's inventory reflects a server-side change (`changed` true) or `ms` passes. */
export async function awaitInventory (bot: Bot, changed: () => boolean, ms = 1500): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (changed()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return changed()
}
