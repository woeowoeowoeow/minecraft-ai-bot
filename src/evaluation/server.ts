import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { ProcessRegistry } from './procs.js'
import { terminate, waitExit } from './procs.js'

export const MC_VERSION = '1.21.4'

/** Fixed per-batch server settings (evaluation.md §2.6). Recorded in batch.json. */
export const SERVER_PROPERTIES: Record<string, string> = {
  'online-mode': 'false',
  difficulty: 'normal',
  gamemode: 'survival',
  'view-distance': '10',
  'simulation-distance': '10',
  'enable-command-block': 'false',
  'spawn-protection': '0',
  'max-players': '4',
  'player-idle-timeout': '0',
  'enforce-secure-profile': 'false',
  'generate-structures': 'true',
  'allow-nether': 'true',
  'level-type': 'minecraft\\:normal',
  'sync-chunk-writes': 'false',
  'enable-rcon': 'false',
  'enable-query': 'false',
  'server-ip': '127.0.0.1',
  motd: 'eval',
}

export type ServerOptions = {
  worldDir: string
  port: number
  seed: string
  jarPath: string
  memMb?: number
  /** Replace the java command (tests use a fake server). */
  command?: { cmd: string; args: string[] }
  readyTimeoutMs?: number
  /** Fixture scenarios only (never scored batches): overrides for SERVER_PROPERTIES. */
  properties?: Record<string, string>
}

const READY_RE = /\]: Done \([\d.]+s\)!/
const FATAL_RE = /FAILED TO BIND TO PORT|Failed to start the minecraft server|Exception in server tick loop|has been compiled by a more recent version/

/**
 * Vanilla server child process. Evaluator-only: the seed and world dir never
 * leave this module except through the private run directory.
 */
export class ServerProcess extends EventEmitter {
  child: ChildProcess | null = null
  private log: WriteStream | null = null
  readonly logPath: string
  private recent: string[] = []

  constructor (readonly o: ServerOptions, private readonly registry: ProcessRegistry) {
    super()
    this.logPath = join(o.worldDir, 'evaluator-server.log')
  }

  private writeConfig (): void {
    mkdirSync(this.o.worldDir, { recursive: true })
    const props = { ...SERVER_PROPERTIES, ...this.o.properties, 'server-port': String(this.o.port), 'level-seed': this.o.seed }
    writeFileSync(join(this.o.worldDir, 'server.properties'), Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
    writeFileSync(join(this.o.worldDir, 'eula.txt'), 'eula=true\n')
    for (const f of ['ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json']) writeFileSync(join(this.o.worldDir, f), '[]')
  }

  /** Resolves when the server logs "Done"; rejects on early exit, fatal line, or timeout. */
  async start (): Promise<void> {
    this.writeConfig()
    const mem = this.o.memMb ?? 2048
    const { cmd, args } = this.o.command ?? { cmd: 'java', args: [`-Xms${Math.min(1024, mem)}M`, `-Xmx${mem}M`, '-jar', this.o.jarPath, 'nogui'] }
    this.log = createWriteStream(this.logPath, { flags: 'a' })
    const child = spawn(cmd, args, { cwd: this.o.worldDir, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.registry.track('server', child, this.o.command ? cmd : this.o.jarPath)
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        this.log?.write(line + '\n')
        this.recent.push(line)
        if (this.recent.length > 20) this.recent.shift()
        this.emit('line', line)
      }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.on('exit', (code, signal) => this.emit('exit', { code, signal }))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`server not ready after ${(this.o.readyTimeoutMs ?? 240_000) / 1000}s`)), this.o.readyTimeoutMs ?? 240_000)
      const onLine = (line: string) => {
        if (READY_RE.test(line)) done()
        else if (FATAL_RE.test(line)) done(new Error(`server fatal: ${line}`))
      }
      const onExit = ({ code, signal }: { code: number | null; signal: string | null }) =>
        done(new Error(`server exited before ready (code ${code}, signal ${signal}): ${this.recent.slice(-5).join(' | ')}`))
      const done = (err?: Error) => {
        clearTimeout(timer)
        this.off('line', onLine)
        this.off('exit', onExit)
        if (err) reject(err)
        else resolve()
      }
      this.on('line', onLine)
      this.on('exit', onExit)
    })
  }

  get running (): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Evaluator-only console command (ground-truth queries, fixtures). */
  command (line: string): void {
    if (this.running) this.child!.stdin!.write(line + '\n')
  }

  /** Send a command and resolve with the first matching output line (or null on timeout). */
  query (line: string, match: RegExp, ms = 5000): Promise<RegExpMatchArray | null> {
    if (!this.running) return Promise.resolve(null)
    return new Promise(resolve => {
      const onLine = (l: string) => {
        const m = l.match(match)
        if (m) { clearTimeout(h); this.off('line', onLine); resolve(m) }
      }
      const h = setTimeout(() => { this.off('line', onLine); resolve(null) }, ms)
      this.on('line', onLine)
      this.command(line)
    })
  }

  /** Graceful `stop`, then SIGTERM/SIGKILL. Always leaves no process behind. */
  async stop (graceMs = 20_000): Promise<{ forced: boolean }> {
    const child = this.child
    let forced = false
    if (child && this.running) {
      this.command('stop')
      const r = await waitExit(child, graceMs)
      if (!r) { await terminate(child, 5000); forced = true }
    }
    await new Promise<void>(res => (this.log ? this.log.end(() => res()) : res()))
    this.log = null
    return { forced }
  }
}
