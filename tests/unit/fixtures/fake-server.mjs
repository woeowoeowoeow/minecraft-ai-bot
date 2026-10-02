// Fake vanilla 1.16.1 server for evaluator lifecycle tests. Modes: normal | ignore-stop | die-early | never-ready
const mode = process.argv[2] ?? 'normal'
const say = (m) => console.log(`[00:00:00] [Server thread/INFO]: ${m}`)
if (mode === 'die-early') { console.log('boom'); process.exit(3) }
if (mode !== 'never-ready') setTimeout(() => say('Done (0.1s)! For help, type "help"'), 100)
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  const lines = buf.split('\n'); buf = lines.pop()
  for (const line of lines) {
    if (line === 'stop' && mode !== 'ignore-stop') { say('Stopping server'); process.exit(0) }
    if (line === 'data get entity Bot Inventory') say('Bot has the following entity data: [{Slot: 0b, id: "minecraft:crafting_table", Count: 1b}]')
    if (line === 'data get entity Bot Pos') say('Bot has the following entity data: [1.5d, 64.0d, -2.5d]')
  }
})
if (mode === 'ignore-stop') process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
