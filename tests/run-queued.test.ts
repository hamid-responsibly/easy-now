import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { queueDatabasePath } from '../src/paths.js'
import { findProjectRoot } from '../src/project.js'
import { openQueue } from '../src/queue.js'
import { pollInterval, runQueued } from '../src/run-queued.js'
import { tempDir } from './helpers/temp-dir.js'

process.env.EASY_NOW_POLL_MS = '40'

test('runs a command and returns its exit code', async () => {
  const result = await runQueued({
    command: process.execPath,
    argv: ['-e', 'process.exit(7)'],
    cwd: process.cwd(),
    queueName: 'exit-code',
    dataDir: tempDir(),
  })
  assert.equal(result.exitCode, 7)
})

test('same queue runs commands one after another', async () => {
  const dataDir = tempDir()
  const markerPath = join(dataDir, 'serial.log')
  const runMarked = (label: string): ReturnType<typeof runQueued> =>
    runQueued({
      command: process.execPath,
      argv: [
        '-e',
        `const fs=require('fs');fs.appendFileSync(${JSON.stringify(markerPath)},${JSON.stringify(`${label}-start\n`)});setTimeout(()=>fs.appendFileSync(${JSON.stringify(markerPath)},${JSON.stringify(`${label}-end\n`)}),100)`,
      ],
      cwd: process.cwd(),
      queueName: 'serial',
      dataDir,
    })

  await Promise.all([runMarked('a'), runMarked('b')])
  const markers = readFileSync(markerPath, 'utf8').trim().split('\n')
  assert.match(markers[0] ?? '', /^[ab]-start$/)
  assert.equal(markers[1], `${markers[0]?.[0]}-end`)
  assert.match(markers[2] ?? '', /^[ab]-start$/)
  assert.equal(markers[3], `${markers[2]?.[0]}-end`)
})

test('named queues can run at the same time', async () => {
  const dataDir = tempDir()
  const markerPath = join(dataDir, 'parallel.log')
  const runMarked = (label: string): ReturnType<typeof runQueued> =>
    runQueued({
      command: process.execPath,
      argv: [
        '-e',
        `const fs=require('fs');const p=${JSON.stringify(markerPath)};fs.appendFileSync(p,${JSON.stringify(`${label}-start `)}+Date.now()+'\\n');setTimeout(()=>fs.appendFileSync(p,${JSON.stringify(`${label}-end `)}+Date.now()+'\\n'),150)`,
      ],
      cwd: process.cwd(),
      queueName: label,
      dataDir,
    })

  await Promise.all([
    runMarked('a'),
    runMarked('b'),
  ])
  const times = Object.fromEntries(
    readFileSync(markerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [marker, rawTime] = line.split(' ')
        return [marker, Number(rawTime)]
      }),
  )
  assert.ok((times['a-start'] ?? Infinity) < (times['b-end'] ?? -Infinity))
  assert.ok((times['b-start'] ?? Infinity) < (times['a-end'] ?? -Infinity))
})

test('timeout escalates when a command ignores SIGTERM', async () => {
  const begin = Date.now()
  const result = await runQueued({
    command: process.execPath,
    argv: [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    cwd: process.cwd(),
    queueName: 'timeout',
    dataDir: tempDir(),
    timeoutSeconds: 1,
  })
  const elapsed = Date.now() - begin
  assert.equal(result.exitCode, 124)
  assert.ok(elapsed < 4000, `timeout took ${elapsed}ms`)
})

test('releases the queue row when spawning throws', async () => {
  const dataDir = tempDir()
  await assert.rejects(
    runQueued({
      command: join(dataDir, 'missing-command'),
      argv: [],
      cwd: process.cwd(),
      queueName: 'spawn-error',
      dataDir,
    }),
    /ENOENT|Failed to spawn/,
  )

  const queue = openQueue(dataDir)
  try {
    assert.equal(queue.list('spawn-error').length, 0)
  } finally {
    queue.close()
  }
})

test('defaults nested directories to the project root queue', async () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'app')
  mkdirSync(join(root, '.git'))
  mkdirSync(nested, { recursive: true })
  const result = await runQueued({
    command: process.execPath,
    argv: ['-e', ''],
    cwd: nested,
    dataDir: tempDir(),
  })
  assert.equal(result.queueName, findProjectRoot(root))
})

test('invalid poll intervals fall back to the default', () => {
  assert.equal(pollInterval('abc'), 200)
  assert.equal(pollInterval('0'), 200)
  assert.equal(pollInterval('4'), 200)
  assert.equal(pollInterval('40'), 40)
})

test('a TTY sees its queue position while waiting', async () => {
  const dataDir = tempDir()
  const writes: string[] = []
  const originalWrite = process.stderr.write
  const originalIsTTY = process.stderr.isTTY
  Object.defineProperty(process.stderr, 'isTTY', {
    configurable: true,
    value: true,
  })
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  try {
    const first = runQueued({
      command: process.execPath,
      argv: ['-e', 'setTimeout(() => {}, 120)'],
      cwd: process.cwd(),
      queueName: 'progress',
      dataDir,
    })
    const second = runQueued({
      command: process.execPath,
      argv: ['-e', ''],
      cwd: process.cwd(),
      queueName: 'progress',
      dataDir,
    })
    await Promise.all([first, second])
  } finally {
    process.stderr.write = originalWrite
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    })
  }

  assert.match(writes.join(''), /waiting behind 1 task\(s\) in progress/)
})

test('an interrupt releases the queue row and returns a signal exit code', async () => {
  const dataDir = tempDir()
  const signalPath = join(dataDir, 'signal.txt')
  const readyPath = join(dataDir, 'ready.txt')
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/cli.ts',
      `--data-dir=${dataDir}`,
      '-q',
      'interrupt',
      '--',
      process.execPath,
      '-e',
      `const fs=require('fs');process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(signalPath)},'SIGINT');process.exit()});fs.writeFileSync(${JSON.stringify(readyPath)},'ready');setInterval(()=>{},1000)`,
    ],
    { cwd: process.cwd(), stdio: 'ignore' },
  )
  await once(child, 'spawn')

  const deadline = Date.now() + 5_000
  let foundRunningTask = false
  while (Date.now() < deadline) {
    try {
      const db = new DatabaseSync(queueDatabasePath(dataDir))
      const running = db
        .prepare(
          `SELECT COUNT(*) AS count FROM queue
           WHERE queue_name = 'interrupt' AND status = 'running' AND child_pid IS NOT NULL`,
        )
        .get() as { count: number }
      db.close()
      if (running.count === 1) {
        foundRunningTask = true
        break
      }
    } catch {
      foundRunningTask = false
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(foundRunningTask, true)
  while (!existsSync(readyPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(existsSync(readyPath), true)

  child.kill('SIGINT')
  const [code, signal] = (await once(child, 'exit')) as [
    number | null,
    NodeJS.Signals | null,
  ]
  assert.equal(signal, null)
  assert.equal(code, 130)
  assert.equal(readFileSync(signalPath, 'utf8'), 'SIGINT')

  const queue = openQueue(dataDir)
  try {
    assert.equal(queue.list('interrupt').length, 0)
  } finally {
    queue.close()
  }
})

test('a cleared waiter exits with the queue-cleared code', async () => {
  const dataDir = tempDir()
  const cliArgs = [
    '--import',
    'tsx',
    'src/cli.ts',
    `--data-dir=${dataDir}`,
    '-q',
    'cleared',
    '--',
    process.execPath,
  ]
  const holder = spawn(
    process.execPath,
    [...cliArgs, '-e', 'setInterval(() => {}, 1000)'],
    { cwd: process.cwd(), stdio: 'ignore' },
  )
  await once(holder, 'spawn')
  await waitForQueueRows(dataDir, 'cleared', 1)

  const waiter = spawn(
    process.execPath,
    [...cliArgs, '-e', ''],
    { cwd: process.cwd(), stdio: 'ignore' },
  )
  await once(waiter, 'spawn')
  await waitForQueueRows(dataDir, 'cleared', 2)

  const holderExit = once(holder, 'exit')
  const waiterExit = once(waiter, 'exit')
  const queue = openQueue(dataDir)
  try {
    queue.clear('cleared')
  } finally {
    queue.close()
  }

  const [waiterCode] = (await waiterExit) as [number | null]
  await holderExit
  assert.equal(waiterCode, 75)
})

test('real processes never overlap in one queue', async () => {
  const dataDir = tempDir()
  const lockPath = join(dataDir, 'exclusive.lock')
  const command = [
    "const fs=require('fs')",
    `const p=${JSON.stringify(lockPath)}`,
    "let fd",
    "try{fd=fs.openSync(p,'wx')}catch{process.exit(90)}",
    "setTimeout(()=>{fs.closeSync(fd);fs.unlinkSync(p)},50)",
  ].join(';')
  const children = Array.from({ length: 8 }, () =>
    spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        `--data-dir=${dataDir}`,
        '-q',
        'stress',
        '--',
        process.execPath,
        '-e',
        command,
      ],
      { cwd: process.cwd(), stdio: 'ignore' },
    ),
  )
  const exits = await Promise.all(
    children.map(async (child) => {
      const [code] = (await once(child, 'exit')) as [number | null]
      return code
    }),
  )
  assert.deepEqual(exits, Array.from({ length: 8 }, () => 0))
})

async function waitForQueueRows(
  dataDir: string,
  queueName: string,
  expectedRows: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expectedRows} row(s) in ${queueName}`)
    }
    try {
      const db = new DatabaseSync(queueDatabasePath(dataDir))
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM queue WHERE queue_name = ?`,
        )
        .get(queueName) as { count: number }
      db.close()
      if (row.count === expectedRows) {
        return
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
