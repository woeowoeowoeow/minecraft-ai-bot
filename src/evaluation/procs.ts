import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tracks every child process the evaluator starts (servers, bots) so they are
 * killed on any evaluator exit path, and leaves pidfiles so a later evaluator
 * can sweep orphans left by a hard crash (kill -9 of the evaluator).
 */
export class ProcessRegistry {
  private readonly live = new Map<number, { kind: string; child: ChildProcess }>()
  private installed = false

  constructor (readonly pidDir: string) {}

  track (kind: string, child: ChildProcess, marker: string): void {
    if (!child.pid) return
    this.live.set(child.pid, { kind, child })
    mkdirSync(this.pidDir, { recursive: true })
    const file = join(this.pidDir, `${child.pid}.json`)
    writeFileSync(file, JSON.stringify({ pid: child.pid, kind, marker, owner: process.pid, at: new Date().toISOString() }))
    child.once('exit', () => {
      this.live.delete(child.pid!)
      rmSync(file, { force: true })
    })
  }

  count (): number { return this.live.size }

  killAll (signal: NodeJS.Signals = 'SIGKILL'): void {
    for (const [pid] of this.live) {
      try { process.kill(pid, signal) } catch { /* already gone */ }
      // SIGKILL is final; drop the pidfile now since we may exit before the child's 'exit' event.
      if (signal === 'SIGKILL') rmSync(join(this.pidDir, `${pid}.json`), { force: true })
    }
  }

  /** True if some other evaluator process that recorded children is still alive. */
  otherEvaluatorAlive (): boolean {
    let files: string[] = []
    try { files = readdirSync(this.pidDir).filter(f => f.endsWith('.json')) } catch { return false }
    return files.some(f => {
      try { const r = JSON.parse(readFileSync(join(this.pidDir, f), 'utf8')) as { owner: number }; return r.owner !== process.pid && isAlive(r.owner) } catch { return false }
    })
  }

  /** Kill children on evaluator exit, Ctrl-C, SIGTERM, and uncaught errors. */
  installExitHandlers (): void {
    if (this.installed) return
    this.installed = true
    process.on('exit', () => this.killAll('SIGKILL'))
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(sig, () => {
        console.error(`evaluator: ${sig}, killing ${this.live.size} child process(es)`)
        this.killAll('SIGKILL')
        process.exit(130)
      })
    }
  }

  /**
   * Kill processes recorded by evaluators that are no longer alive, but only if
   * the pid still runs a command containing the recorded marker (pid reuse safety).
   */
  sweepOrphans (): { killed: number[]; cleared: number } {
    const killed: number[] = []
    let cleared = 0
    let files: string[] = []
    try { files = readdirSync(this.pidDir).filter(f => f.endsWith('.json')) } catch { return { killed, cleared } }
    for (const f of files) {
      const path = join(this.pidDir, f)
      let rec: { pid: number; marker: string; owner: number }
      try { rec = JSON.parse(readFileSync(path, 'utf8')) } catch { rmSync(path, { force: true }); continue }
      if (rec.owner !== process.pid && isAlive(rec.owner)) continue // another evaluator is running it
      if (isAlive(rec.pid) && commandOf(rec.pid).includes(rec.marker)) {
        try { process.kill(rec.pid, 'SIGKILL'); killed.push(rec.pid) } catch { /* ignore */ }
      }
      rmSync(path, { force: true })
      cleared++
    }
    return { killed, cleared }
  }
}

export function isAlive (pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function commandOf (pid: number): string {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }) } catch { return '' }
}

/** Wait for a child to exit; resolves with its exit info, or null on timeout. */
export function waitExit (child: ChildProcess, ms: number): Promise<{ code: number | null; signal: string | null } | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise(resolve => {
    const h = setTimeout(() => { child.off('exit', onExit); resolve(null) }, ms)
    const onExit = (code: number | null, signal: string | null) => { clearTimeout(h); resolve({ code, signal }) }
    child.once('exit', onExit)
  })
}

/** SIGTERM, then SIGKILL after `graceMs`. Always resolves once the process is gone. */
export async function terminate (child: ChildProcess, graceMs: number): Promise<{ code: number | null; signal: string | null; forced: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode, forced: false }
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  const r = await waitExit(child, graceMs)
  if (r) return { ...r, forced: false }
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  const r2 = await waitExit(child, 5000)
  return { code: r2?.code ?? null, signal: r2?.signal ?? 'SIGKILL', forced: true }
}
