// Downloads the pinned vanilla server jar into .cache/ (evaluator-only).
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as wrapNs from 'minecraft-wrap'
import { JAR } from './run.js'
import { MC_VERSION } from './server.js'

type Wrap = { downloadServer (v: string, file: string, cb: (err: Error | null) => void): void }
const wrap = ((wrapNs as unknown as { default?: Wrap }).default ?? wrapNs) as unknown as Wrap

mkdirSync(dirname(JAR), { recursive: true })
wrap.downloadServer(MC_VERSION, JAR, (err) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`server ${MC_VERSION} → ${JAR}`)
})
