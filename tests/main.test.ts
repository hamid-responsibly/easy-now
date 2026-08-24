import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/main.js'
import { openQueue } from '../src/queue.js'
import { tempDir } from './helpers/temp-dir.js'

test('cli exec returns the command exit code', async () => {
  const code = await main([
    '--data-dir',
    tempDir(),
    '-q',
    'cli',
    '--',
    process.execPath,
    '-e',
    'process.exit(3)',
  ])
  assert.equal(code, 3)
})

test('cli list on an empty data dir names the current queue', async () => {
  const cwd = tempDir()
  const output = await captureLog(() =>
    main(['--data-dir', tempDir(), '-C', cwd, 'list']),
  )
  assert.equal(output.result, 0)
  assert.deepEqual(output.lines, [`${cwd}: 0 running, 0 waiting`])
})

test('cli list shows place in the current queue and ignores others', async () => {
  const dataDir = tempDir()
  const cwd = tempDir()
  const queue = openQueue(dataDir)
  const first = queue.enqueue({
    queueName: cwd,
    command: 'next build',
    cwd,
  })
  queue.enqueue({
    queueName: cwd,
    command: 'vitest run',
    cwd,
  })
  queue.enqueue({ queueName: 'other', command: 'ignored', cwd })
  assert.equal(queue.tryStart(first, cwd).started, true)
  queue.close()

  const output = await captureLog(() =>
    main(['--data-dir', dataDir, '-C', cwd, 'list']),
  )
  assert.equal(output.result, 0)
  const text = output.lines.join('\n')
  assert.match(text, new RegExp(`${escapeRegExp(cwd)}: 1 running, 1 waiting`))
  assert.match(text, new RegExp(`1\\s+running\\s+${process.pid}\\s+next build`))
  assert.match(text, new RegExp(`2\\s+waiting\\s+${process.pid}\\s+vitest run`))
  assert.doesNotMatch(text, /ignored/)
})

test('cli peek --json reports counts and place', async () => {
  const dataDir = tempDir()
  const queue = openQueue(dataDir)
  const first = queue.enqueue({
    queueName: 'app',
    command: 'next build',
    cwd: '/tmp',
  })
  const second = queue.enqueue({
    queueName: 'app',
    command: 'vitest run',
    cwd: '/tmp',
  })
  assert.equal(queue.tryStart(first, 'app').started, true)
  queue.close()

  const output = await captureLog(() =>
    main(['--data-dir', dataDir, '-q', 'app', 'peek', '--json']),
  )
  assert.equal(output.result, 0)
  assert.deepEqual(JSON.parse(output.lines.join('\n')), {
    queues: [
      {
        queue: 'app',
        running: 1,
        waiting: 1,
        jobs: [
          {
            place: 1,
            id: first,
            status: 'running',
            pid: process.pid,
            command: 'next build',
            cwd: '/tmp',
            queue: 'app',
          },
          {
            place: 2,
            id: second,
            status: 'waiting',
            pid: process.pid,
            command: 'vitest run',
            cwd: '/tmp',
            queue: 'app',
          },
        ],
      },
    ],
  })
})

test('cli list --all includes every queue', async () => {
  const dataDir = tempDir()
  const queue = openQueue(dataDir)
  queue.enqueue({ queueName: 'build', command: 'a', cwd: '/tmp' })
  queue.enqueue({ queueName: 'test', command: 'b', cwd: '/tmp' })
  queue.close()

  const output = await captureLog(() =>
    main(['--data-dir', dataDir, 'list', '--all']),
  )
  assert.equal(output.result, 0)
  const text = output.lines.join('\n')
  assert.match(text, /2 queues: 0 running, 2 waiting/)
  assert.match(text, /build: 0 running, 1 waiting/)
  assert.match(text, /test: 0 running, 1 waiting/)
})

test('cli list --json for an empty scoped queue still names it', async () => {
  const output = await captureLog(() =>
    main(['--data-dir', tempDir(), '-q', 'app', 'list', '--json']),
  )
  assert.equal(output.result, 0)
  assert.deepEqual(JSON.parse(output.lines.join('\n')), {
    queues: [{ queue: 'app', running: 0, waiting: 0, jobs: [] }],
  })
})

test('bare clear only removes the current project queue', async () => {
  const dataDir = tempDir()
  const projectRoot = tempDir()
  mkdirSync(join(projectRoot, '.git'))
  const queue = openQueue(dataDir)
  try {
    queue.enqueue({ queueName: projectRoot, command: 'a', cwd: projectRoot })
    queue.enqueue({ queueName: 'other', command: 'b', cwd: projectRoot })
  } finally {
    queue.close()
  }

  const output = await captureLog(() =>
    main(['--data-dir', dataDir, '-C', projectRoot, 'clear']),
  )
  assert.equal(output.result, 0)
  assert.deepEqual(output.lines, [
    `Cleared 1 task(s) in ${projectRoot}.`,
  ])

  const reopened = openQueue(dataDir)
  try {
    assert.deepEqual(
      reopened.list().map(({ queueName }) => queueName),
      ['other'],
    )
  } finally {
    reopened.close()
  }
})

test('clear --all removes every queue', async () => {
  const dataDir = tempDir()
  const queue = openQueue(dataDir)
  try {
    queue.enqueue({ queueName: 'a', command: 'a', cwd: '/tmp' })
    queue.enqueue({ queueName: 'b', command: 'b', cwd: '/tmp' })
  } finally {
    queue.close()
  }

  const output = await captureLog(() =>
    main(['--data-dir', dataDir, 'clear', '--all']),
  )
  assert.equal(output.result, 0)
  assert.deepEqual(output.lines, ['Cleared 2 task(s) in all queues.'])
})

test('cli run on a wrapped script does not deadlock', { timeout: 8_000 }, async () => {
  const packageRoot = tempDir()
  const dataDir = tempDir()
  const markerPath = join(packageRoot, 'ran.txt')
  const markJs = join(packageRoot, 'mark.js')
  const cli = join(process.cwd(), 'src/cli.ts')
  const tsxLoader = join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')
  writeFileSync(
    markJs,
    `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'yes')`,
  )
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      scripts: {
        mark: [
          process.execPath,
          `--import=${tsxLoader}`,
          cli,
          `--data-dir=${dataDir}`,
          '-q',
          'wrap',
          '--',
          process.execPath,
          markJs,
        ].join(' '),
      },
    }),
  )
  const code = await main([
    '--data-dir',
    dataDir,
    '-q',
    'wrap',
    '-C',
    packageRoot,
    'run',
    'mark',
  ])
  assert.equal(code, 0)
  assert.equal(readFileSync(markerPath, 'utf8'), 'yes')
})

test('cli run executes a package script', async () => {
  const packageRoot = tempDir()
  const markerPath = join(packageRoot, 'ran.txt')
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      scripts: {
        mark: `node -e "require('fs').writeFileSync('${markerPath}', 'yes')"`,
      },
    }),
  )
  const code = await main([
    '--data-dir',
    tempDir(),
    '-C',
    packageRoot,
    'run',
    'mark',
  ])
  assert.equal(code, 0)
  assert.equal(readFileSync(markerPath, 'utf8'), 'yes')
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function captureLog<T>(
  run: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(' '))
  }
  try {
    return { result: await run(), lines }
  } finally {
    console.log = original
  }
}
