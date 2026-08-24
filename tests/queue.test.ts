import assert from 'node:assert/strict'
import { chmodSync, symlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { queueDatabasePath } from '../src/paths.js'
import { isSqliteBusy, openQueue, withQueue } from '../src/queue.js'
import {
  getProcessStartTime,
  isProcessAlive,
} from '../src/process-liveness.js'
import { startHeartbeat } from '../src/run-queued.js'
import { tempDir } from './helpers/temp-dir.js'

test('first waiter acquires an empty queue', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({
      queueName: 'app',
      command: 'vitest',
      cwd: '/tmp',
    })
    const result = queue.tryStart(id, 'app')
    assert.deepEqual(result, { started: true })
    assert.equal(queue.list('app')[0]?.status, 'running')
  } finally {
    queue.close()
  }
})

test('second waiter stays waiting while the first is running', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const first = queue.enqueue({
      queueName: 'app',
      command: 'build',
      cwd: '/tmp',
    })
    const second = queue.enqueue({
      queueName: 'app',
      command: 'test',
      cwd: '/tmp',
    })
    assert.equal(queue.tryStart(first, 'app').started, true)
    assert.deepEqual(queue.tryStart(second, 'app'), {
      started: false,
      position: 2,
      length: 2,
    })
    queue.release(first)
    assert.equal(queue.tryStart(second, 'app').started, true)
  } finally {
    queue.close()
  }
})

test('different queue names do not block each other', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const build = queue.enqueue({
      queueName: 'build',
      command: 'next build',
      cwd: '/tmp',
    })
    const testId = queue.enqueue({
      queueName: 'test',
      command: 'vitest',
      cwd: '/tmp',
    })
    assert.equal(queue.tryStart(build, 'build').started, true)
    assert.equal(queue.tryStart(testId, 'test').started, true)
  } finally {
    queue.close()
  }
})

test('cleanup drops waiters whose process is dead', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    queue.enqueue({
      queueName: 'app',
      command: 'alive',
      cwd: '/tmp',
    })
  } finally {
    queue.close()
  }

  const db = new DatabaseSync(queueDatabasePath(dir))
  try {
    db.prepare(
      `INSERT INTO queue (queue_name, status, pid, pid_started_at, command, cwd)
       VALUES ('app', 'waiting', 2147483647, 'dead', 'dead', '/tmp')`,
    ).run()
  } finally {
    db.close()
  }

  const reopened = openQueue(dir)
  try {
    reopened.cleanup('app')
    const remaining = reopened.list('app')
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]?.command, 'alive')
  } finally {
    reopened.close()
  }
})

test('snapshot drops dead rows in every queue and returns what is left', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const alive = queue.enqueue({ queueName: 'app', command: 'alive', cwd: '/tmp' })
    assert.equal(queue.tryStart(alive, 'app').started, true)
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `INSERT INTO queue (queue_name, status, pid, pid_started_at, command, cwd)
         VALUES ('other', 'running', 2147483647, 'dead', 'dead', '/tmp')`,
      ).run()
    } finally {
      db.close()
    }

    assert.deepEqual(
      queue.snapshot().map(({ queueName, command }) => ({ queueName, command })),
      [{ queueName: 'app', command: 'alive' }],
    )
  } finally {
    queue.close()
  }
})

test('a scoped snapshot leaves other queues untouched', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    queue.enqueue({ queueName: 'app', command: 'a', cwd: '/tmp' })
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `INSERT INTO queue (queue_name, status, pid, pid_started_at, command, cwd)
         VALUES ('other', 'running', 2147483647, 'dead', 'dead', '/tmp')`,
      ).run()
    } finally {
      db.close()
    }

    assert.deepEqual(
      queue.snapshot('app').map(({ command }) => command),
      ['a'],
    )
    assert.equal(queue.list('other').length, 1)
  } finally {
    queue.close()
  }
})

test('a symlinked data dir opens the same queue storage as its target', () => {
  const target = tempDir()
  const link = join(tempDir(), 'alias')
  symlinkSync(target, link)
  const viaTarget = openQueue(target)
  try {
    viaTarget.enqueue({ queueName: 'app', command: 'build', cwd: '/tmp' })
  } finally {
    viaTarget.close()
  }

  const viaLink = openQueue(link)
  try {
    assert.deepEqual(
      viaLink.list('app').map(({ command }) => command),
      ['build'],
    )
  } finally {
    viaLink.close()
  }
})

test('tryStart fails if the task was cleared', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({
      queueName: 'app',
      command: 'gone',
      cwd: '/tmp',
    })
    queue.clear('app')
    assert.throws(
      () => queue.tryStart(id, 'app'),
      /queue was cleared by another process/,
    )
  } finally {
    queue.close()
  }
})

test('clear removes every task in a named queue', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    queue.enqueue({ queueName: 'app', command: 'a', cwd: '/tmp' })
    queue.enqueue({ queueName: 'other', command: 'b', cwd: '/tmp' })
    assert.equal(queue.clear('app'), 1)
    assert.equal(queue.list().length, 1)
    assert.equal(queue.list()[0]?.queueName, 'other')
    assert.equal(queue.clear(), 1)
    assert.equal(queue.list().length, 0)
  } finally {
    queue.close()
  }
})

test('cleanup keeps an old running task whose owner is alive', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({ queueName: 'app', command: 'watch', cwd: '/tmp' })
    assert.equal(queue.tryStart(id, 'app').started, true)
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `UPDATE queue SET updated_at = datetime('now', '-181 minutes') WHERE id = ?`,
      ).run(id)
    } finally {
      db.close()
    }

    queue.cleanup('app')
    assert.equal(queue.list('app')[0]?.status, 'running')
  } finally {
    queue.close()
  }
})

test('heartbeat refreshes a running task timestamp', async () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({ queueName: 'app', command: 'watch', cwd: '/tmp' })
    queue.tryStart(id, 'app')
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `UPDATE queue SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`,
      ).run(id)
    } finally {
      db.close()
    }

    const heartbeat = startHeartbeat(queue, id, 10)
    await new Promise((resolve) => setTimeout(resolve, 30))
    clearInterval(heartbeat)
    assert.notEqual(queue.list('app')[0]?.updatedAt, '2000-01-01 00:00:00')
  } finally {
    queue.close()
  }
})

test('cleanup reaps a running task whose owner is dead', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `INSERT INTO queue
           (queue_name, status, pid, pid_started_at, command, cwd)
         VALUES ('app', 'running', 2147483647, 'dead', 'build', '/tmp')`,
      ).run()
    } finally {
      db.close()
    }

    queue.cleanup('app')
    assert.equal(queue.list('app').length, 0)
  } finally {
    queue.close()
  }
})

test('cleanup treats a reused owner pid as dead', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `INSERT INTO queue
           (queue_name, status, pid, pid_started_at, command, cwd)
         VALUES ('app', 'running', ?, 'different-start', 'build', '/tmp')`,
      ).run(process.pid)
    } finally {
      db.close()
    }

    queue.cleanup('app')
    assert.equal(queue.list('app').length, 0)
  } finally {
    queue.close()
  }
})

test('cleanup never signals a child whose process identity changed', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  await once(child, 'spawn')
  const childPid = child.pid
  assert.ok(childPid)

  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `INSERT INTO queue
           (queue_name, status, pid, pid_started_at, child_pid, child_started_at, command, cwd)
         VALUES ('app', 'running', 2147483647, 'dead', ?, 'different-start', 'build', '/tmp')`,
      ).run(childPid)
    } finally {
      db.close()
    }

    queue.cleanup('app')
    assert.equal(isProcessAlive(childPid), true)
  } finally {
    if (isProcessAlive(childPid)) {
      process.kill(-childPid, 'SIGKILL')
    }
    queue.close()
  }
})

test('cleanup keeps the queue held until a dead owner child exits', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {});process.send?.('ready');setInterval(() => {}, 1000)",
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  await once(child, 'message')
  const childPid = child.pid
  assert.ok(childPid)
  const childStartedAt = getProcessStartTime(childPid)
  assert.ok(childStartedAt)

  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `INSERT INTO queue
           (queue_name, status, pid, pid_started_at, child_pid, child_started_at, command, cwd)
         VALUES ('app', 'running', 2147483647, 'dead', ?, ?, 'build', '/tmp')`,
      ).run(childPid, childStartedAt)
    } finally {
      db.close()
    }

    queue.cleanup('app')
    assert.equal(queue.list('app').length, 1)
    await once(child, 'close')
    queue.cleanup('app')
    assert.equal(queue.list('app').length, 0)
  } finally {
    if (isProcessAlive(childPid)) {
      process.kill(-childPid, 'SIGKILL')
    }
    queue.close()
  }
})

test('clear never signals a child whose process identity changed', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  await once(child, 'spawn')
  const childPid = child.pid
  assert.ok(childPid)

  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `INSERT INTO queue
           (queue_name, status, pid, pid_started_at, child_pid, child_started_at, command, cwd)
         VALUES ('app', 'running', ?, 'different-owner', ?, 'different-child', 'build', '/tmp')`,
      ).run(process.pid, childPid)
    } finally {
      db.close()
    }

    assert.equal(queue.clear('app'), 1)
    assert.equal(isProcessAlive(childPid), true)
  } finally {
    if (isProcessAlive(childPid)) {
      process.kill(-childPid, 'SIGKILL')
    }
    queue.close()
  }
})

test('openQueue rejects a group-writable directory', () => {
  const dir = tempDir()
  chmodSync(dir, 0o770)
  assert.throws(() => openQueue(dir), /must not be group- or other-writable/)
})

test('openQueue adds process identity columns to an existing database', () => {
  const dir = tempDir()
  const db = new DatabaseSync(queueDatabasePath(dir))
  try {
    db.exec(`
      CREATE TABLE queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_name TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        child_pid INTEGER,
        command TEXT,
        cwd TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  } finally {
    db.close()
  }

  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({ queueName: 'app', command: 'build', cwd: '/tmp' })
    assert.equal(queue.tryStart(id, 'app').started, true)
  } finally {
    queue.close()
  }
})

test('withQueue rejects async callbacks at compile time', () => {
  if (false) {
    // @ts-expect-error withQueue closes before a promise settles.
    withQueue('/tmp/easy-now-type-test', async (queue) => queue.list())
  }
  assert.equal(typeof withQueue, 'function')
})

test('recognizes SQLite busy and locked errors', () => {
  assert.equal(isSqliteBusy({ code: 'ERR_SQLITE_BUSY' }), true)
  assert.equal(isSqliteBusy({ code: 'ERR_SQLITE_ERROR', errcode: 5 }), true)
  assert.equal(isSqliteBusy(new Error('database is locked')), true)
  assert.equal(isSqliteBusy(new Error('syntax error')), false)
})
