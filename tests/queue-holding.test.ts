import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { canonicalDataDir, queueDatabasePath } from '../src/paths.js'
import { getProcessStartTime, isProcessAlive } from '../src/process-liveness.js'
import {
  LEASES_ENV,
  heldTaskId,
  leaseChildEnv,
  readLeases,
} from '../src/queue-holding.js'
import { openQueue, withQueue } from '../src/queue.js'
import { tempDir } from './helpers/temp-dir.js'

test('a lease this process really holds skips the queue', () => {
  const dataDir = tempDir()
  const taskId = startTask(dataDir, 'app')
  const env = leaseChildEnv({ dataDir, queueName: 'app', taskId })
  assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), taskId)
})

test('a lease survives a nested chain through another queue', () => {
  const dataDir = tempDir()
  const outer = leaseChildEnv({ dataDir, queueName: 'a', taskId: 1 })
  const inner = leaseChildEnv({
    dataDir,
    queueName: 'b',
    taskId: 2,
    env: outer,
  })
  assert.deepEqual(readLeases(inner), [
    { dir: canonicalDataDir(dataDir), queue: 'a', task: 1, pid: process.pid },
    { dir: canonicalDataDir(dataDir), queue: 'b', task: 2, pid: process.pid },
  ])
})

test('re-taking the same queue replaces its lease instead of stacking it', () => {
  const dataDir = tempDir()
  const first = leaseChildEnv({ dataDir, queueName: 'a', taskId: 1 })
  const second = leaseChildEnv({
    dataDir,
    queueName: 'a',
    taskId: 9,
    env: first,
  })
  assert.deepEqual(readLeases(second), [
    { dir: canonicalDataDir(dataDir), queue: 'a', task: 9, pid: process.pid },
  ])
})

test('a symlinked data dir is the same storage as its target', () => {
  const target = tempDir()
  const link = join(tempDir(), 'alias')
  symlinkSync(target, link)
  const taskId = startTask(target, 'app')
  const env = leaseChildEnv({ dataDir: target, queueName: 'app', taskId })
  assert.equal(heldTaskId({ dataDir: link, queueName: 'app', env }), taskId)
})

test('a lease for another data dir or queue never skips this one', () => {
  const dataDir = tempDir()
  const otherDir = tempDir()
  const taskId = startTask(dataDir, 'app')
  const env = leaseChildEnv({ dataDir, queueName: 'app', taskId })
  assert.equal(heldTaskId({ dataDir: otherDir, queueName: 'app', env }), null)
  assert.equal(heldTaskId({ dataDir, queueName: 'other', env }), null)
})

test('a lease naming the wrong queue for a real task is rejected', () => {
  const dataDir = tempDir()
  const taskId = startTask(dataDir, 'app')
  const env = forgedLease({ dataDir, queue: 'other', task: taskId })
  assert.equal(heldTaskId({ dataDir, queueName: 'other', env }), null)
})

test('a lease for a task that does not exist is rejected', () => {
  const dataDir = tempDir()
  startTask(dataDir, 'app')
  const env = forgedLease({ dataDir, queue: 'app', task: 987_654 })
  assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), null)
})

test('a lease for a task that is still waiting is rejected', () => {
  const dataDir = tempDir()
  const taskId = withQueue(dataDir, (queue) =>
    queue.enqueue({ queueName: 'app', command: 'build', cwd: '/tmp' }),
  )
  const env = leaseChildEnv({ dataDir, queueName: 'app', taskId })
  assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), null)
})

test('a lease for a released task is rejected', () => {
  const dataDir = tempDir()
  const taskId = startTask(dataDir, 'app')
  const env = leaseChildEnv({ dataDir, queueName: 'app', taskId })
  withQueue(dataDir, (queue) => queue.release(taskId))
  assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), null)
})

test('a lease naming a pid that is not an ancestor is rejected', () => {
  const dataDir = tempDir()
  const taskId = startTask(dataDir, 'app')
  const env = forgedLease({ dataDir, queue: 'app', task: taskId, pid: 1 })
  assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), null)
})

test('a running task owned by an unrelated live process is rejected', async () => {
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'ignore' },
  )
  await once(unrelated, 'spawn')
  const unrelatedPid = unrelated.pid
  assert.ok(unrelatedPid)
  const startedAt = getProcessStartTime(unrelatedPid)
  assert.ok(startedAt)

  const dataDir = tempDir()
  const queue = openQueue(dataDir)
  try {
    const db = new DatabaseSync(queueDatabasePath(dataDir))
    try {
      db.prepare(
        `INSERT INTO queue (queue_name, status, pid, pid_started_at, command, cwd)
         VALUES ('app', 'running', ?, ?, 'build', '/tmp')`,
      ).run(unrelatedPid, startedAt)
    } finally {
      db.close()
    }
    const taskId = queue.list('app')[0]?.id
    assert.ok(taskId)
    const env = forgedLease({
      dataDir,
      queue: 'app',
      task: taskId,
      pid: unrelatedPid,
    })
    assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), null)
  } finally {
    if (isProcessAlive(unrelatedPid)) {
      process.kill(-unrelatedPid, 'SIGKILL')
    }
    queue.close()
  }
})

test('a task claimed under a pid that no longer owns it is rejected', () => {
  const dataDir = tempDir()
  const taskId = startTask(dataDir, 'app')
  const env = forgedLease({
    dataDir,
    queue: 'app',
    task: taskId,
    pid: process.ppid,
  })
  assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), null)
})

test('malformed lease markers are ignored and never claim task 0', () => {
  const dataDir = tempDir()
  const dir = canonicalDataDir(dataDir)
  startTask(dataDir, 'app')
  const malformed = [
    'not json',
    '{}',
    '[]',
    '[null]',
    '["app"]',
    '[{}]',
    JSON.stringify([{ dir, queue: 'app' }]),
    JSON.stringify([{ dir, queue: 'app', task: 0, pid: process.pid }]),
    JSON.stringify([{ dir, queue: 'app', task: -1, pid: process.pid }]),
    JSON.stringify([{ dir, queue: 'app', task: 1.5, pid: process.pid }]),
    JSON.stringify([{ dir, queue: 'app', task: '1', pid: process.pid }]),
    JSON.stringify([{ dir, queue: 'app', task: 1, pid: 0 }]),
    JSON.stringify([{ dir, queue: '', task: 1, pid: process.pid }]),
  ]
  malformed.forEach((raw) => {
    assert.equal(readLeases({ [LEASES_ENV]: raw }).length, 0, raw)
    assert.equal(
      heldTaskId({ dataDir, queueName: 'app', env: { [LEASES_ENV]: raw } }),
      null,
      raw,
    )
  })
})

function startTask(dataDir: string, queueName: string): number {
  return withQueue(dataDir, (queue) => {
    const taskId = queue.enqueue({ queueName, command: 'build', cwd: '/tmp' })
    assert.equal(queue.tryStart(taskId).started, true)
    return taskId
  })
}

function forgedLease({
  dataDir,
  queue,
  task,
  pid = process.pid,
}: {
  dataDir: string
  queue: string
  task: number
  pid?: number
}): NodeJS.ProcessEnv {
  return {
    [LEASES_ENV]: JSON.stringify([
      { dir: canonicalDataDir(dataDir), queue, task, pid },
    ]),
  }
}
