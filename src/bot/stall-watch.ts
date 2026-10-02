// Event-loop stall diagnostics (telemetry only; never changes behaviour).
//
// The main thread bumps a shared counter every 500 ms. A worker thread watches it;
// when it has not moved for STALL_MS, the worker connects to the main thread's
// inspector, pauses V8 wherever the main thread is spinning, records the call
// stack to RUN_DIR/stalls.jsonl, and resumes. Motivation: dev batch 3 lost two
// runs to keepAlive disconnects after multi-minute synchronous stalls with no
// events (architecture §9: observable failures).
import { Worker } from 'node:worker_threads'

const STALL_MS = 12_000

const WORKER = `
const { workerData, parentPort } = require('node:worker_threads')
const { Session } = require('node:inspector')
const { appendFileSync } = require('node:fs')
const beat = new Int32Array(workerData.buf)
let last = Atomics.load(beat, 0), since = Date.now(), reported = false
setInterval(() => {
  const v = Atomics.load(beat, 0)
  if (v !== last) { last = v; since = Date.now(); reported = false; return }
  if (reported || Date.now() - since < workerData.stallMs) return
  reported = true
  const s = new Session()
  try {
    s.connectToMainThread()
    s.on('Debugger.paused', (m) => {
      const frames = m.params.callFrames.slice(0, 40).map(f => (f.functionName || '(anonymous)') + ' ' + f.url.replace(/^.*\\/(node_modules|src)\\//, '$1/') + ':' + (f.location.lineNumber + 1))
      appendFileSync(workerData.file, JSON.stringify({ at: new Date().toISOString(), stalledMs: Date.now() - since, frames }) + '\\n')
      s.post('Debugger.resume', () => { s.post('Debugger.disable', () => s.disconnect()) })
    })
    s.post('Debugger.enable', () => s.post('Debugger.pause'))
  } catch (e) {
    appendFileSync(workerData.file, JSON.stringify({ at: new Date().toISOString(), error: String(e) }) + '\\n')
  }
}, 2000)
`

/** Start the watchdog; returns a stop function. Never throws. */
export function startStallWatch (file: string): () => void {
  try {
    const buf = new SharedArrayBuffer(4)
    const beat = new Int32Array(buf)
    const w = new Worker(WORKER, { eval: true, workerData: { buf, file, stallMs: STALL_MS } })
    w.unref()
    const iv = setInterval(() => Atomics.add(beat, 0, 1), 500)
    iv.unref()
    return () => { clearInterval(iv); void w.terminate() }
  } catch {
    return () => {}
  }
}
