import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { queueDatabasePath } from '../src/paths.js'
import {
  SCHEMA_VERSION,
  isSqliteBusy,
  openQueue,
  withQueue,
} from '../src/queue.js'
import {
  getProcessStartTime,
  isProcessAlive,
  isProcessGroupAlive,
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
    const result = queue.tryStart(id)
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
    assert.equal(queue.tryStart(first).started, true)
    assert.deepEqual(queue.tryStart(second), {
      started: false,
      position: 2,
      length: 2,
    })
    queue.release(first)
    assert.equal(queue.tryStart(second).started, true)
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
    assert.equal(queue.tryStart(build).started, true)
    assert.equal(queue.tryStart(testId).started, true)
  } finally {
    queue.close()
  }
})

test('cleanup drops waiters whose process is dead', async () => {
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
    await reopened.cleanup('app')
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
    assert.equal(queue.tryStart(alive).started, true)
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

test('tryStart fails if the task was cleared', async () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({
      queueName: 'app',
      command: 'gone',
      cwd: '/tmp',
    })
    await queue.clear('app')
    assert.throws(
      () => queue.tryStart(id),
      /queue was cleared by another process/,
    )
  } finally {
    queue.close()
  }
})

test('clear removes every task in a named queue', async () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    queue.enqueue({ queueName: 'app', command: 'a', cwd: '/tmp' })
    queue.enqueue({ queueName: 'other', command: 'b', cwd: '/tmp' })
    assert.equal(await queue.clear('app'), 1)
    assert.equal(queue.list().length, 1)
    assert.equal(queue.list()[0]?.queueName, 'other')
    assert.equal(await queue.clear(), 1)
    assert.equal(queue.list().length, 0)
  } finally {
    queue.close()
  }
})

test('cleanup keeps an old running task whose owner is alive', async () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({ queueName: 'app', command: 'watch', cwd: '/tmp' })
    assert.equal(queue.tryStart(id).started, true)
    const db = new DatabaseSync(queueDatabasePath(dir))
    try {
      db.prepare(
        `UPDATE queue SET updated_at = datetime('now', '-181 minutes') WHERE id = ?`,
      ).run(id)
    } finally {
      db.close()
    }

    await queue.cleanup('app')
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
    queue.tryStart(id)
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

test('cleanup reaps a running task whose owner is dead', async () => {
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

    await queue.cleanup('app')
    assert.equal(queue.list('app').length, 0)
  } finally {
    queue.close()
  }
})

test('cleanup treats a reused owner pid as dead', async () => {
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

    await queue.cleanup('app')
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

    await queue.cleanup('app')
    assert.equal(isProcessAlive(childPid), true)
  } finally {
    if (isProcessAlive(childPid)) {
      process.kill(-childPid, 'SIGKILL')
    }
    queue.close()
  }
})

test('cleanup holds the slot until a dead owner command really stops', async () => {
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

    await queue.cleanup('app')
    assert.equal(isProcessGroupAlive(childPid), false)
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

    assert.equal(await queue.clear('app'), 1)
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

test('a fresh database records the schema version', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({ queueName: 'app', command: 'build', cwd: '/tmp' })
    assert.equal(queue.tryStart(id).started, true)
  } finally {
    queue.close()
  }
  assert.equal(userVersion(dir), SCHEMA_VERSION)
})

test('a legacy database gains the identity columns once', () => {
  const dir = tempDir()
  writeLegacySchema(dir)

  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({ queueName: 'app', command: 'build', cwd: '/tmp' })
    assert.equal(queue.tryStart(id).started, true)
  } finally {
    queue.close()
  }
  assert.equal(userVersion(dir), SCHEMA_VERSION)
  assert.deepEqual(columnNames(dir).filter((name) => name.endsWith('started_at')), [
    'pid_started_at',
    'child_started_at',
  ])

  const reopened = openQueue(dir)
  try {
    assert.deepEqual(
      reopened.list('app').map(({ command }) => command),
      ['build'],
    )
  } finally {
    reopened.close()
  }
  assert.equal(userVersion(dir), SCHEMA_VERSION)
})

test('a current-schema database that never recorded a version still opens', () => {
  const dir = tempDir()
  const first = openQueue(dir)
  try {
    first.enqueue({ queueName: 'app', command: 'build', cwd: '/tmp' })
  } finally {
    first.close()
  }
  const columnsBefore = columnNames(dir)
  const db = new DatabaseSync(queueDatabasePath(dir))
  try {
    db.exec('PRAGMA user_version = 0')
  } finally {
    db.close()
  }

  const reopened = openQueue(dir)
  try {
    assert.deepEqual(
      reopened.list('app').map(({ command }) => command),
      ['build'],
    )
  } finally {
    reopened.close()
  }
  assert.equal(userVersion(dir), SCHEMA_VERSION)
  assert.deepEqual(columnNames(dir), columnsBefore)
})

test('one queue admits one task, whatever order the callers ask in', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const first = queue.enqueue({ queueName: 'app', command: 'a', cwd: '/tmp' })
    const second = queue.enqueue({ queueName: 'app', command: 'b', cwd: '/tmp' })
    assert.equal(queue.tryStart(second).started, false)
    assert.equal(queue.tryStart(first).started, true)
    assert.equal(queue.tryStart(second).started, false)
    assert.equal(
      queue.list('app').filter(({ status }) => status === 'running').length,
      1,
    )
  } finally {
    queue.close()
  }
})

test('tryStart cannot be told a queue name at all', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const id = queue.enqueue({ queueName: 'app', command: 'a', cwd: '/tmp' })
    // @ts-expect-error the queue name comes from the task row, never the caller.
    queue.tryStart(id, 'other')
    assert.equal(queue.list('other').length, 0)
    assert.equal(queue.list('app')[0]?.status, 'running')
  } finally {
    queue.close()
  }
})

test('a task admitted by id never frees a slot in another queue', () => {
  const dir = tempDir()
  const queue = openQueue(dir)
  try {
    const held = queue.enqueue({ queueName: 'app', command: 'held', cwd: '/tmp' })
    assert.equal(queue.tryStart(held).started, true)
    const blocked = queue.enqueue({
      queueName: 'app',
      command: 'blocked',
      cwd: '/tmp',
    })
    const elsewhere = queue.enqueue({
      queueName: 'other',
      command: 'free',
      cwd: '/tmp',
    })
    assert.equal(queue.tryStart(elsewhere).started, true)
    assert.equal(queue.tryStart(blocked).started, false)
  } finally {
    queue.close()
  }
})

test(
  'clear frees the slot only after the old command group is gone',
  { timeout: 30_000 },
  async () => {
    const dir = tempDir()
    const pidPath = join(dir, 'grandchild.pid')
    const holder = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        `--data-dir=${dir}`,
        '-q',
        'capacity',
        '--',
        process.execPath,
        '-e',
        stubbornCommand(pidPath),
      ],
      { cwd: process.cwd(), stdio: 'ignore' },
    )
    const holderExit = once(holder, 'exit')
    const childPid = await waitForRunningChildPid(dir, 'capacity')
    const grandchildPid = Number(await readWhenWritten(pidPath))
    assert.equal(isProcessGroupAlive(childPid), true)
    assert.equal(isProcessAlive(grandchildPid), true)

    const queue = openQueue(dir)
    try {
      assert.equal(await queue.clear('capacity'), 1)
      assert.equal(isProcessGroupAlive(childPid), false)
      assert.equal(isProcessAlive(grandchildPid), false)
      const replacement = queue.enqueue({
        queueName: 'capacity',
        command: 'next',
        cwd: '/tmp',
      })
      assert.equal(queue.tryStart(replacement).started, true)
    } finally {
      queue.close()
      if (isProcessGroupAlive(childPid)) {
        process.kill(-childPid, 'SIGKILL')
      }
      if (isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL')
      }
      holder.kill('SIGKILL')
      await holderExit
    }
  },
)

/**
 * Neither the command nor the grandchild it starts answers SIGTERM. The pid
 * file is written last, so waiting for it means both handlers are installed.
 */
function stubbornCommand(pidPath: string): string {
  return [
    "process.on('SIGTERM', () => {})",
    `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(stubbornGrandchild(pidPath))}],{stdio:'ignore'})`,
    'setInterval(() => {}, 1000)',
  ].join(';')
}

function stubbornGrandchild(pidPath: string): string {
  return [
    "process.on('SIGTERM', () => {})",
    `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
    'setInterval(() => {}, 1000)',
  ].join(';')
}

async function readWhenWritten(path: string): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`)
    }
    if (existsSync(path)) {
      const contents = readFileSync(path, 'utf8')
      if (contents.length > 0) {
        return contents
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForRunningChildPid(
  dataDir: string,
  queueName: string,
): Promise<number> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a running child in ${queueName}`)
    }
    const childPid = readRunningChildPid(dataDir, queueName)
    if (childPid != null) {
      return childPid
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function readRunningChildPid(
  dataDir: string,
  queueName: string,
): number | null {
  try {
    const db = new DatabaseSync(queueDatabasePath(dataDir))
    try {
      const row = db
        .prepare(
          `SELECT child_pid FROM queue
           WHERE queue_name = ? AND status = 'running' AND child_pid IS NOT NULL`,
        )
        .get(queueName) as { child_pid: number } | undefined
      return row?.child_pid ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function writeLegacySchema(dir: string): void {
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
}

function userVersion(dir: string): number {
  const db = new DatabaseSync(queueDatabasePath(dir))
  try {
    const row = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    return Number(row.user_version)
  } finally {
    db.close()
  }
}

function columnNames(dir: string): string[] {
  const db = new DatabaseSync(queueDatabasePath(dir))
  try {
    const rows = db.prepare('PRAGMA table_info(queue)').all() as Array<{
      name: string
    }>
    return rows.map(({ name }) => name)
  } finally {
    db.close()
  }
}

test('withQueue rejects async callbacks at compile time', () => {
  if (false) {
    // @ts-expect-error withQueue closes before a promise settles.
    withQueue('/tmp/easy-now-type-test', async (queue) => queue.list())
    // @ts-expect-error stopping commands outlives the open database.
    withQueue('/tmp/easy-now-type-test', (queue) => queue.clear())
    // @ts-expect-error stopping commands outlives the open database.
    withQueue('/tmp/easy-now-type-test', (queue) => queue.cleanup('app'))
  }
  assert.equal(typeof withQueue, 'function')
})

test('recognizes SQLite busy and locked errors', () => {
  assert.equal(isSqliteBusy({ code: 'ERR_SQLITE_BUSY' }), true)
  assert.equal(isSqliteBusy({ code: 'ERR_SQLITE_ERROR', errcode: 5 }), true)
  assert.equal(isSqliteBusy(new Error('database is locked')), true)
  assert.equal(isSqliteBusy(new Error('syntax error')), false)
})
