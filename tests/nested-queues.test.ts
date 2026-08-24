import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { queueDatabasePath } from '../src/paths.js'
import { runQueued } from '../src/run-queued.js'
import { tempDir } from './helpers/temp-dir.js'

process.env.EASY_NOW_POLL_MS = '40'

const BYPASS_MESSAGE = /already in .*; running without taking another slot/

test('a -> b -> a nested chain completes', { timeout: 20_000 }, async () => {
  const dataDir = tempDir()
  const markerPath = join(dataDir, 'chain.txt')
  const run = await runCliTree(
    easyNow(dataDir, 'a', easyNow(dataDir, 'b', easyNow(dataDir, 'a', writeMarker(markerPath)))),
  )

  assert.equal(run.code, 0, run.stderr)
  assert.equal(readFileSync(markerPath, 'utf8'), 'ok')
  assert.match(run.stderr, /already in a; running without taking another slot/)
})

test('a symlinked data dir reuses the slot of its target', { timeout: 15_000 }, async () => {
  const target = tempDir()
  const link = join(tempDir(), 'alias')
  symlinkSync(target, link)
  const markerPath = join(target, 'alias.txt')
  const run = await runCliTree(
    easyNow(target, 'app', easyNow(link, 'app', writeMarker(markerPath))),
  )

  assert.equal(run.code, 0, run.stderr)
  assert.equal(readFileSync(markerPath, 'utf8'), 'ok')
  assert.match(run.stderr, BYPASS_MESSAGE)
})

test('another data dir takes its own slot', { timeout: 15_000 }, async () => {
  const outerDir = tempDir()
  const innerDir = tempDir()
  const markerPath = join(outerDir, 'other-dir.txt')
  const run = await runCliTree(
    easyNow(outerDir, 'app', easyNow(innerDir, 'app', writeMarker(markerPath))),
  )

  assert.equal(run.code, 0, run.stderr)
  assert.equal(readFileSync(markerPath, 'utf8'), 'ok')
  assert.doesNotMatch(run.stderr, BYPASS_MESSAGE)
  assert.equal(existsSync(queueDatabasePath(innerDir)), true)
})

test('another queue name takes its own slot', { timeout: 15_000 }, async () => {
  const dataDir = tempDir()
  const markerPath = join(dataDir, 'other-queue.txt')
  const run = await runCliTree(
    easyNow(dataDir, 'app', easyNow(dataDir, 'docker', writeMarker(markerPath))),
  )

  assert.equal(run.code, 0, run.stderr)
  assert.equal(readFileSync(markerPath, 'utf8'), 'ok')
  assert.doesNotMatch(run.stderr, BYPASS_MESSAGE)
})

test('one queue name in two data dirs does not serialize', async () => {
  const markerPath = join(tempDir(), 'independent.log')
  const runMarked = (label: string): ReturnType<typeof runQueued> =>
    runQueued({
      command: process.execPath,
      argv: [
        '-e',
        `const fs=require('fs');const p=${JSON.stringify(markerPath)};fs.appendFileSync(p,${JSON.stringify(`${label}-start `)}+Date.now()+'\\n');setTimeout(()=>fs.appendFileSync(p,${JSON.stringify(`${label}-end `)}+Date.now()+'\\n'),150)`,
      ],
      cwd: process.cwd(),
      queueName: 'shared',
      dataDir: tempDir(),
    })

  await Promise.all([runMarked('a'), runMarked('b')])
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

function easyNow(dataDir: string, queueName: string, command: string[]): string[] {
  return [
    process.execPath,
    '--import',
    'tsx',
    'src/cli.ts',
    `--data-dir=${dataDir}`,
    '-q',
    queueName,
    '--',
    ...command,
  ]
}

function writeMarker(markerPath: string): string[] {
  return [
    process.execPath,
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ok')`,
  ]
}

/** Stops a deadlocked chain rather than letting it hold the test runner open. */
async function runCliTree(
  command: string[],
  graceMs = 10_000,
): Promise<{ code: number | null; stderr: string }> {
  const [executable, ...argv] = command
  assert.ok(executable)
  const child = spawn(executable, argv, {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const chunks: string[] = []
  child.stderr.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString())
  })
  const deadline = setTimeout(() => child.kill('SIGTERM'), graceMs)
  try {
    const [code] = (await once(child, 'close')) as [number | null]
    return { code, stderr: chunks.join('') }
  } finally {
    clearTimeout(deadline)
  }
}
