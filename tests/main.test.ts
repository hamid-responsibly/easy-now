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

test('cli list on an empty data dir says the queue is empty', async () => {
  const output = await captureLog(() => main(['--data-dir', tempDir(), 'list']))
  assert.equal(output.result, 0)
  assert.deepEqual(output.lines, ['Queue is empty.'])
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
