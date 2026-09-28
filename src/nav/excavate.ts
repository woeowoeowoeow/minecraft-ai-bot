// Controlled excavation for underground targets (no unrestricted pathfinder search).
// Deterministic local planner: each step is a staircase step, a verified dig-down,
// a 2-high tunnel step or a stair-up step, chosen greedily toward the target after
// hazard checks on every block it would open. The dug staircase/tunnel is the
// return path. Pathfinder-agnostic: uses only Mineflayer dig and control states.
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { EventBus } from '../observer/events.js'
import type { V3 } from '../schema/index.js'
import { HARMFUL_FLOOR, liveView, type BlockView, type Cell } from './blocks.js'

export type ExcavationTarget = { y: number; xz?: [number, number] }
export type StepKind = 'stair_down' | 'shaft' | 'tunnel' | 'stair_up'

export type Step = {
  kind: StepKind
  dir: [number, number] | null
  /** Cells to clear, top to bottom. Already-passable cells are omitted. */
  dig: V3[]
  /** Feet cell after the step (after any short drop). */
  to: V3
  /** Blocks fallen after entering the column (0 for a normal step). */
  fall: number
  /** A gravity block sits above the top dug cell: expect refills. */
  gravityAbove: boolean
  score: number
}

export type Blocked = { kind: StepKind; dir: [number, number] | null; reason: string }

export const EXC = {
  /** Dig times above this are impractical for movement (stone by hand is 7.5 s). */
  maxDigMs: 3000,
  /** Total drop allowed after a step (fall damage starts above 3). */
  maxFall: 3,
  /** Score weight per block dug: prefers cheap progress, protects tool durability. */
  digWeight: 0.34,
  fallWeight: 0.5,
  /** Non-improving detours allowed (distance may grow by at most this). */
  maxDetour: 1,
}

const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const key = (v: V3) => `${v[0]},${v[1]},${v[2]}`

/** Remaining work: vertical distance plus Manhattan horizontal distance (steps are cardinal). */
export function excavationDistance (p: V3, t: ExcavationTarget): number {
  const dy = Math.abs(p[1] - t.y)
  return t.xz ? dy + Math.abs(p[0] - t.xz[0]) + Math.abs(p[2] - t.xz[1]) : dy
}

const NEIGHBORS: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

/** Why opening (digging) this cell is unsafe or impractical, or null if fine. */
function digProblem (view: BlockView, c: V3): string | null {
  const cell = view.at(...c)
  const own = cellProblem(cell)
  if (own) return own
  for (const n of NEIGHBORS) {
    const nb = view.at(c[0] + n[0], c[1] + n[1], c[2] + n[2])
    if (nb.kind === 'lava') return 'lava_adjacent'
    if (nb.kind === 'water') return 'water_adjacent'
  }
  return null
}

function cellProblem (cell: Cell): string | null {
  switch (cell.kind) {
    case 'unknown': return 'unloaded'
    case 'lava': return 'lava'
    case 'water': return 'water'
    case 'harmful': return `harmful:${cell.name}`
    case 'air': return null
    case 'solid':
      if (!Number.isFinite(cell.digMs)) return `unbreakable:${cell.name}`
      if (cell.digMs > EXC.maxDigMs) return cell.wantsPickaxe ? `needs_pickaxe:${cell.name}` : `too_hard:${cell.name}`
      return null
  }
}

/** Standing space must not touch lava (horizontal or above). */
function bodyProblem (view: BlockView, feet: V3): string | null {
  for (const dy of [0, 1]) {
    const c: V3 = [feet[0], feet[1] + dy, feet[2]]
    for (const n of NEIGHBORS) {
      if (n[1] === -1 && dy === 0) continue
      if (view.at(c[0] + n[0], c[1] + n[1], c[2] + n[2]).kind === 'lava') return 'lava_near_body'
    }
  }
  return null
}

/**
 * Where the bot ends up after entering column (x, z) with feet at `feetY`
 * (which is clear or will be dug). Returns the landing feet Y or a problem.
 */
function landing (view: BlockView, x: number, feetY: number, z: number, maxFall: number): { y: number } | { problem: string } {
  for (let y = feetY - 1, fell = 0; fell <= maxFall; y--, fell++) {
    const c = view.at(x, y, z)
    if (c.kind === 'solid') {
      if (HARMFUL_FLOOR.has(c.name)) return { problem: `harmful_floor:${c.name}` }
      const under = view.at(x, y - 1, z)
      if (under.kind === 'lava') return { problem: 'lava_below' }
      return { y: y + 1 }
    }
    if (c.kind === 'lava') return { problem: 'lava_below' }
    if (c.kind === 'water') return { problem: 'water_below' }
    if (c.kind !== 'air') return { problem: cellProblem(c) ?? 'no_floor' }
  }
  return { problem: 'drop_too_deep' }
}

/**
 * Picks the next excavation step from `p` (floored feet position, standing on
 * solid ground) toward `t`. Every candidate is checked for liquids and lava
 * around each block it opens, a safe landing, tool practicality and revisits.
 */
export function planStep (view: BlockView, p: V3, t: ExcavationTarget, visited: Set<string>, prevDir: [number, number] | null = null): { step: Step | null; blocked: Blocked[] } {
  const [x, y, z] = p
  const d0 = excavationDistance(p, t)
  const blocked: Blocked[] = []
  const cands: Step[] = []
  const dirs = prevDir ? [prevDir, ...DIRS.filter(d => d[0] !== prevDir[0] || d[1] !== prevDir[1])] : DIRS

  const consider = (kind: StepKind, dir: [number, number] | null, cells: V3[], enterFeetY: number, requireFloorAt: number | null) => {
    const nx = x + (dir?.[0] ?? 0)
    const nz = z + (dir?.[1] ?? 0)
    const dig: V3[] = []
    for (const c of cells) {
      const prob = digProblem(view, c)
      if (prob) return blocked.push({ kind, dir, reason: prob })
      if (view.at(...c).kind === 'solid') dig.push(c)
    }
    let toY: number
    if (requireFloorAt !== null) {
      // stair_up: the block we step onto must already be solid.
      const f = view.at(nx, requireFloorAt, nz)
      if (f.kind !== 'solid') return blocked.push({ kind, dir, reason: 'no_floor' })
      if (HARMFUL_FLOOR.has(f.name)) return blocked.push({ kind, dir, reason: `harmful_floor:${f.name}` })
      toY = requireFloorAt + 1
    } else {
      const l = landing(view, nx, enterFeetY, nz, EXC.maxFall - (y - enterFeetY))
      if ('problem' in l) return blocked.push({ kind, dir, reason: l.problem })
      toY = l.y
    }
    const to: V3 = [nx, toY, nz]
    const body = bodyProblem(view, to)
    if (body) return blocked.push({ kind, dir, reason: body })
    if (visited.has(key(to))) return blocked.push({ kind, dir, reason: 'visited' })
    const d1 = excavationDistance(to, t)
    if (d1 > d0 + EXC.maxDetour) return
    const top = cells[0]
    const gravityAbove = top ? view.at(top[0], top[1] + 1, top[2]).gravity : false
    const fall = enterFeetY - toY
    cands.push({ kind, dir, dig, to, fall, gravityAbove, score: d1 + EXC.digWeight * dig.length + EXC.fallWeight * fall })
  }

  // Verified dig-down: the block under the feet, landing checked below it.
  consider('shaft', null, [[x, y - 1, z]], y - 1, null)
  for (const [dx, dz] of dirs) {
    const nx = x + dx
    const nz = z + dz
    consider('stair_down', [dx, dz], [[nx, y + 1, nz], [nx, y, nz], [nx, y - 1, nz]], y - 1, null)
    consider('tunnel', [dx, dz], [[nx, y + 1, nz], [nx, y, nz]], y, null)
    if (view.at(x, y + 3, z).gravity || view.at(nx, y + 3, nz).gravity) {
      blocked.push({ kind: 'stair_up', dir: [dx, dz], reason: 'gravity_overhead' })
    } else {
      consider('stair_up', [dx, dz], [[x, y + 2, z], [nx, y + 2, nz], [nx, y + 1, nz]], y + 1, y)
    }
  }
  // Stable sort keeps the deterministic candidate order on ties.
  cands.sort((a, b) => a.score - b.score)
  return { step: cands[0] ?? null, blocked }
}

/** Summarizes blocked candidates into a failure class and reason. */
export function classifyBlocked (blocked: Blocked[]): { cls: 'MISSING_RESOURCE' | 'NAV_HAZARD' | 'NAV_UNREACHABLE'; reason: string } {
  const counts: Record<string, number> = {}
  for (const b of blocked) {
    const r = b.reason.split(':')[0]!
    counts[r] = (counts[r] ?? 0) + 1
  }
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}×${n}`).join(',')
  if (counts.needs_pickaxe) return { cls: 'MISSING_RESOURCE', reason: `needs_pickaxe (${summary})` }
  if (counts.lava || counts.lava_adjacent || counts.lava_below || counts.lava_near_body || counts.water || counts.water_adjacent || counts.water_below) {
    return { cls: 'NAV_HAZARD', reason: `hazards on every side (${summary})` }
  }
  return { cls: 'NAV_UNREACHABLE', reason: `no safe step (${summary || 'no progress possible'})` }
}

// ── execution ─────────────────────────────────────────────────────────────

export type ExcavationResult = {
  ok: boolean
  cls?: 'MISSING_RESOURCE' | 'NAV_HAZARD' | 'NAV_UNREACHABLE' | 'NAV_STUCK' | 'SKILL_TIMEOUT' | 'CANCELLED'
  reason?: string
  missing?: { item: string; count: number }[]
  steps: number
  dug: number
  falls: number
  byKind: Partial<Record<StepKind, number>>
  entry: V3
  /** Walkable return path: the excavated cells in order (capped). */
  path: V3[]
  lastBlocked?: string
}

export type ExcavateOptions = {
  signal: AbortSignal
  deadline: number
  isAborted: () => boolean
  onProgress?: (remaining: number) => void
  maxSteps?: number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Any pickaxe in inventory (the minimum for practical underground movement). */
export function hasPickaxe (bot: Bot): boolean {
  return bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
}

export class Excavator {
  constructor (private readonly bot: Bot, private readonly bus: EventBus) {}

  private feet (): V3 {
    const p = this.bot.entity.position
    return [Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z)]
  }

  async run (t: ExcavationTarget, done: (feet: V3) => boolean, o: ExcavateOptions): Promise<ExcavationResult> {
    const bot = this.bot
    const entry = this.feet()
    const res: ExcavationResult = { ok: false, steps: 0, dug: 0, falls: 0, byKind: {}, entry, path: [entry] }
    const visited = new Set<string>([key(entry)])
    const maxSteps = o.maxSteps ?? 3 * excavationDistance(entry, t) + 40
    let prevDir: [number, number] | null = null
    let stepFailures = 0
    const fail = (cls: NonNullable<ExcavationResult['cls']>, reason: string) => { res.cls = cls; res.reason = reason; return res }

    if (!hasPickaxe(bot)) {
      res.missing = [{ item: 'wooden_pickaxe', count: 1 }]
      return fail('MISSING_RESOURCE', 'no_pickaxe: underground excavation requires a pickaxe')
    }

    await this.settle(1500)
    for (;;) {
      if (o.isAborted()) return fail('CANCELLED', 'cancelled')
      if (Date.now() > o.deadline) return fail('SKILL_TIMEOUT', `excavation timeout after ${res.steps} steps`)
      const here = this.feet()
      const hz = this.hazardAtBody()
      if (hz) return fail('NAV_HAZARD', hz)
      if (done(here)) { res.ok = true; return res }
      if (res.steps >= maxSteps) return fail('NAV_UNREACHABLE', `step budget exhausted (${maxSteps})`)
      if (!hasPickaxe(bot)) {
        res.missing = [{ item: 'wooden_pickaxe', count: 1 }]
        return fail('MISSING_RESOURCE', 'pickaxe broke during excavation')
      }

      const { step, blocked } = planStep(liveView(bot), here, t, visited, prevDir)
      if (!step) {
        const c = classifyBlocked(blocked)
        if (c.cls === 'MISSING_RESOURCE') res.missing = [{ item: 'wooden_pickaxe', count: 1 }]
        return fail(c.cls, c.reason)
      }
      const ok = await this.execute(step, o)
      if (o.isAborted()) return fail('CANCELLED', 'cancelled')
      const now = this.feet()
      if (!ok || key(now) !== key(step.to)) {
        stepFailures++
        res.lastBlocked = `${step.kind} to ${key(step.to)} ended at ${key(now)}`
        this.bus.emit('excavation_step', { kind: step.kind, to: step.to, ok: false, at: now }, 'warn')
        // Never retry the same cell forever: mark it and let the planner pick another step.
        visited.add(key(step.to))
        if (stepFailures >= 4) return fail('NAV_STUCK', `excavation steps keep failing (${res.lastBlocked})`)
        visited.add(key(now))
        continue
      }
      stepFailures = 0
      visited.add(key(now))
      res.steps++
      res.dug += step.dig.length
      res.byKind[step.kind] = (res.byKind[step.kind] ?? 0) + 1
      if (step.fall > 0) res.falls++
      prevDir = step.dir ?? prevDir
      if (res.path.length < 400) res.path.push(now)
      this.bus.emit('excavation_step', { kind: step.kind, to: now, dug: step.dig.length, fall: step.fall, remaining: excavationDistance(now, t) }, 'debug')
      o.onProgress?.(excavationDistance(now, t))
    }
  }

  private hazardAtBody (): string | null {
    const p = this.bot.entity.position
    for (const dy of [0, 1]) {
      const b = this.bot.blockAt(p.offset(0, dy, 0), false)
      if (b?.name === 'lava') return 'in_lava'
    }
    const head = this.bot.blockAt(p.offset(0, 1.62, 0), false)
    if (head && (head.name === 'water' || head.name === 'bubble_column')) return 'flooded'
    return null
  }

  private async settle (ms: number): Promise<void> {
    const end = Date.now() + ms
    while (!this.bot.entity.onGround && Date.now() < end) await sleep(50)
  }

  private async execute (step: Step, o: ExcavateOptions): Promise<boolean> {
    const bot = this.bot
    // A 1×1 drop only works from the cell centre; staircase moves need it too for clean digging.
    if (!(await this.moveTo(this.feet(), 0.18, false, o))) return false
    for (const c of step.dig) {
      for (let refills = 0; ; refills++) {
        if (o.isAborted()) return false
        const b = bot.blockAt(new Vec3(...c), false)
        if (!b || b.boundingBox === 'empty') break
        if (b.name === 'water' || b.name === 'lava') return false
        if (refills > 8) return false
        if (!(await this.dig(b, o))) return false
        await sleep(step.gravityAbove ? 250 : 50)
      }
    }
    if (step.kind === 'shaft') {
      return this.waitFeet(step.to, 3000, o)
    }
    return this.moveTo(step.to, 0.22, step.kind === 'stair_up', o)
  }

  private async dig (b: import('prismarine-block').Block, o: ExcavateOptions): Promise<boolean> {
    const bot = this.bot
    let best: import('prismarine-item').Item | null = null
    let fastest = b.digTime(null, false, false, false, [], bot.entity.effects as never)
    for (const it of bot.inventory.items()) {
      const t = b.digTime(it.type, false, false, false, [], bot.entity.effects as never)
      if (t < fastest) { fastest = t; best = it }
    }
    try {
      if (best) await withTimeout(bot.equip(best, 'hand'), 3000)
      else if (bot.heldItem?.name.endsWith('_pickaxe')) await withTimeout(bot.unequip('hand'), 3000).catch(() => {})
      const onAbort = () => { try { bot.stopDigging() } catch { /* ignore */ } }
      o.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await withTimeout(bot.dig(b, true), bot.digTime(b) * 1.5 + 3000)
      } finally {
        o.signal.removeEventListener('abort', onAbort)
      }
      return true
    } catch {
      try { bot.stopDigging() } catch { /* ignore */ }
      return false
    }
  }

  private async waitFeet (to: V3, ms: number, o: ExcavateOptions): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end && !o.isAborted()) {
      const f = this.feet()
      if (f[1] === to[1] && this.bot.entity.onGround) return key(f) === key(to)
      await sleep(50)
    }
    return false
  }

  /** Walk to the centre of `cell` with plain control states; true when standing in it. */
  private async moveTo (cell: V3, tol: number, jump: boolean, o: ExcavateOptions): Promise<boolean> {
    const bot = this.bot
    const tx = cell[0] + 0.5
    const tz = cell[2] + 0.5
    const end = Date.now() + 4000
    // Sneaking stops the bot at ledges: only use it to centre within the current cell.
    const centring = key(cell) === key(this.feet())
    try {
      while (Date.now() < end && !o.isAborted()) {
        const p = bot.entity.position
        const dx = tx - p.x
        const dz = tz - p.z
        const f = this.feet()
        if (Math.hypot(dx, dz) <= tol && f[1] === cell[1] && bot.entity.onGround) return true
        if (Math.hypot(dx, dz) > tol) {
          await bot.look(Math.atan2(-dx, -dz), 0, true)
          bot.setControlState('forward', true)
          bot.setControlState('sneak', centring)
        } else {
          bot.setControlState('forward', false)
        }
        bot.setControlState('jump', jump && f[1] < cell[1])
        await sleep(50)
      }
      return false
    } finally {
      bot.clearControlStates()
    }
  }
}

function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(v => { clearTimeout(h); resolve(v) }, e => { clearTimeout(h); reject(e) })
  })
}
