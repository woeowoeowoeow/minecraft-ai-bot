import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { freshSeed } from '../../src/evaluation/batch.js'
import { isAlive, ProcessRegistry } from '../../src/evaluation/procs.js'
import { runOne, type RunOptions } from '../../src/evaluation/run.js'

const FIX = join(import.meta.dirname, 'fixtures')

function opts (dir: string, server: string, bot: string, over: Partial<RunOptions> = {}): RunOptions & { registry: ProcessRegistry } {
  const registry = new ProcessRegistry(join(dir, 'pids'))
  return {
    batchId: 'test', runId: `test-${Math.random().toString(36).slice(2, 8)}`, runDir: join(dir, 'run'), seed: '-4242424242424242', seedSet: 'test',
    scenario: 'm0', reasoner: 'none', limitMs: 4000, port: 1, rngSeed: 1, target: 'M0', codeRev: { rev: 't', dirty: false }, registry,
    serverCommand: { cmd: process.execPath, args: [join(FIX, 'fake-server.mjs'), server] },
    botCommand: { cmd: process.execPath, args: [join(FIX, 'fake-bot.mjs'), bot] },
    serverReadyTimeoutMs: 3000,
    ...over,
  }
}

function assertClean (o: { registry: ProcessRegistry }, dir: string) {
  expect(o.registry.count()).toBe(0)
  const pidDir = join(dir, 'pids')
  expect(existsSync(pidDir) ? readdirSync(pidDir) : []).toEqual([])
}

describe('evaluator run lifecycle', () => {
  it('success: verifies ground truth, merges summary, cleans up, never leaks the seed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const o = opts(dir, 'normal', 'success')
    const s = await runOne(o)
    expect(s.outcome).toBe('goal_reached')
    expect(s.groundTruth.verified).toBe(true)
    expect(s.groundTruth.inventory).toEqual({ crafting_table: 1 })
    expect(readFileSync(join(o.runDir, 'private', 'seed.txt'), 'utf8').trim()).toBe(o.seed)
    expect(existsSync(join(o.runDir, 'summary.json'))).toBe(true)
    expect(existsSync(join(o.runDir, 'server.log'))).toBe(true)
    // The bot process saw neither the seed nor the world dir.
    const botSaw = readFileSync(join(o.runDir, 'env.json'), 'utf8')
    expect(botSaw).not.toContain(o.seed.slice(1))
    expect(botSaw).not.toContain('worlds')
    expect(botSaw).not.toContain('server.log')
    assertClean(o, dir)
  })

  it('bot crash → infra_error, server still stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const o = opts(dir, 'normal', 'crash')
    const s = await runOne(o)
    expect(s.outcome).toBe('infra_error')
    expect(s.botExit.code).toBe(1)
    expect(s.artifacts.complete).toBe(false)
    expect(s.artifacts.missing).toContain('bot_result.json')
    assertClean(o, dir)
  })

  it('timeout: bot that finishes on SIGTERM → outcome timeout with its result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const o = opts(dir, 'normal', 'slow', { limitMs: 1500 })
    const s = await runOne(o)
    expect(s.outcome).toBe('timeout')
    expect(s.outcomeReason).toBe('slow')
    assertClean(o, dir)
  })

  it('hung bot and server that ignore signals are force-killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const o = opts(dir, 'ignore-stop', 'hang', { limitMs: 1500 })
    const t0 = Date.now()
    const s = await runOne(o)
    expect(s.outcome).toBe('timeout')
    expect(s.botExit.signal).toBe('SIGKILL')
    expect(Date.now() - t0).toBeLessThan(60_000)
    assertClean(o, dir)
  }, 70_000)

  it('server that dies before ready → infra_error, bot never started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const o = opts(dir, 'die-early', 'success')
    const s = await runOne(o)
    expect(s.outcome).toBe('infra_error')
    expect(s.outcomeReason).toContain('server start failed')
    expect(existsSync(join(o.runDir, 'env.json'))).toBe(false)
    assertClean(o, dir)
  })

  it('server that never becomes ready → infra_error after the ready timeout, killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const o = opts(dir, 'never-ready', 'success', { serverReadyTimeoutMs: 800 })
    const s = await runOne(o)
    expect(s.outcome).toBe('infra_error')
    expect(s.outcomeReason).toContain('not ready')
    assertClean(o, dir)
  })
})

describe('process registry', () => {
  it('sweeps orphans left by a dead evaluator (matching marker only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const reg = new ProcessRegistry(join(dir, 'pids'))
    const child = spawn(process.execPath, [join(FIX, 'fake-server.mjs'), 'never-ready'], { stdio: 'ignore' })
    reg.track('server', child, 'fake-server.mjs')
    // Pretend the owner died: rewrite the pidfile with a dead owner pid.
    const f = join(dir, 'pids', `${child.pid}.json`)
    const rec = JSON.parse(readFileSync(f, 'utf8'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(f, JSON.stringify({ ...rec, owner: 999_999 }))
    const other = new ProcessRegistry(join(dir, 'pids'))
    const r = other.sweepOrphans()
    expect(r.killed).toEqual([child.pid])
    await new Promise(res => setTimeout(res, 200))
    expect(isAlive(child.pid!)).toBe(false)
  })

  it('killAll(SIGKILL) kills children and removes their pidfiles immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'))
    const reg = new ProcessRegistry(join(dir, 'pids'))
    const child = spawn(process.execPath, [join(FIX, 'fake-server.mjs'), 'never-ready'], { stdio: 'ignore' })
    reg.track('server', child, 'fake-server.mjs')
    reg.killAll('SIGKILL')
    expect(readdirSync(join(dir, 'pids'))).toEqual([])
    await new Promise(res => setTimeout(res, 200))
    expect(isAlive(child.pid!)).toBe(false)
  })

  it('fresh seeds are distinct 64-bit integers', () => {
    const s = new Set(Array.from({ length: 50 }, () => freshSeed()))
    expect(s.size).toBe(50)
    for (const x of s) expect(BigInt(x) >= -(2n ** 63n) && BigInt(x) < 2n ** 63n).toBe(true)
  })
})
