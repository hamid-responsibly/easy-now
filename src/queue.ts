import { mkdirSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  getProcessStartTime,
  killProcessTree,
  processIdentityMatches,
} from './process-liveness.js'
import { queueDatabasePath } from './paths.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  pid_started_at TEXT,
  child_pid INTEGER,
  child_started_at TEXT,
  command TEXT,
  cwd TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_name_status ON queue (queue_name, status);
`

export type TaskStatus = 'waiting' | 'running'

export type QueueTask = {
  id: number
  queueName: string
  status: TaskStatus
  pid: number | null
  childPid: number | null
  command: string | null
  cwd: string | null
  createdAt: string
  updatedAt: string
}

type QueueRow = {
  id: number
  queue_name: string
  status: string
  pid: number | null
  pid_started_at: string | null
  child_pid: number | null
  child_started_at: string | null
  command: string | null
  cwd: string | null
  created_at: string
  updated_at: string
}

export type TaskQueue = {
  enqueue(input: {
    queueName: string
    command: string
    cwd: string
  }): number
  tryStart(taskId: number, queueName: string): { started: boolean; position: number }
  setChildPid(taskId: number, childPid: number): void
  heartbeat(taskId: number): void
  release(taskId: number): void
  list(queueName?: string): QueueTask[]
  clear(queueName?: string): number
  cleanup(queueName: string): void
  close(): void
}

type ReadStatement<Row> = {
  all(...values: Array<string | number>): Row[]
  get(...values: Array<string | number>): Row | undefined
}

type QueueIdRow = Pick<QueueRow, 'id'>
type QueueCleanupRow = Pick<
  QueueRow,
  'id' | 'pid' | 'pid_started_at' | 'child_pid' | 'child_started_at'
>
type QueueChildRow = Pick<QueueRow, 'child_pid' | 'child_started_at'>
type QueuePositionRow = { count: number }

export class QueueClearedError extends Error {
  readonly exitCode = 75

  constructor(taskId: number) {
    super(`Task ${taskId} stopped because the queue was cleared by another process.`)
    this.name = 'QueueClearedError'
  }
}

export function openQueue(dataDir: string): TaskQueue {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  verifyDataDir(dataDir)
  const db = new DatabaseSync(queueDatabasePath(dataDir), { timeout: 60_000 })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 60000')
  db.exec(SCHEMA)
  addIdentityColumn(db, 'pid_started_at')
  addIdentityColumn(db, 'child_started_at')

  const insertWaiting = db.prepare(
    `INSERT INTO queue (queue_name, status, pid, pid_started_at, command, cwd)
     VALUES (?, 'waiting', ?, ?, ?, ?)`,
  )
  const admitWaiting = db.prepare(
    `UPDATE queue
     SET status = 'running', updated_at = datetime('now'),
         pid = :pid, pid_started_at = :ownerStartedAt
     WHERE id = :taskId AND status = 'waiting'
       AND NOT EXISTS (
         SELECT 1 FROM queue
         WHERE queue_name = :queueName AND status = 'running'
       )
       AND NOT EXISTS (
         SELECT 1 FROM queue
         WHERE queue_name = :queueName AND status = 'waiting' AND id < :taskId
       )`,
  )
  const selectPosition = db.prepare(
    `SELECT COUNT(*) AS count
     FROM queue
     WHERE queue_name = ?
       AND (
         status = 'running'
         OR (status = 'waiting' AND id <= ?)
       )`,
  ) as unknown as ReadStatement<QueuePositionRow>
  const updateChildPid = db.prepare(
    `UPDATE queue
     SET child_pid = ?, child_started_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )
  const updateHeartbeat = db.prepare(
    `UPDATE queue SET updated_at = datetime('now') WHERE id = ?`,
  )
  const selectById = db.prepare(
    `SELECT id FROM queue WHERE id = ?`,
  ) as unknown as ReadStatement<QueueIdRow>
  const deleteById = db.prepare(`DELETE FROM queue WHERE id = ?`)
  const selectByQueue = db.prepare(
    `SELECT id, queue_name, status, pid, pid_started_at,
            child_pid, child_started_at, command, cwd, created_at, updated_at
     FROM queue
     WHERE queue_name = ?
     ORDER BY id`,
  ) as unknown as ReadStatement<QueueRow>
  const selectAll = db.prepare(
    `SELECT id, queue_name, status, pid, pid_started_at,
            child_pid, child_started_at, command, cwd, created_at, updated_at
     FROM queue
     ORDER BY id`,
  ) as unknown as ReadStatement<QueueRow>
  const selectCleanupRows = db.prepare(
    `SELECT id, pid, pid_started_at, child_pid, child_started_at
     FROM queue
     WHERE queue_name = ?`,
  ) as unknown as ReadStatement<QueueCleanupRow>
  const selectQueueChildren = db.prepare(
    `SELECT child_pid, child_started_at
     FROM queue
     WHERE queue_name = ? AND status = 'running' AND child_pid IS NOT NULL`,
  ) as unknown as ReadStatement<QueueChildRow>
  const selectAllChildren = db.prepare(
    `SELECT child_pid, child_started_at
     FROM queue
     WHERE status = 'running' AND child_pid IS NOT NULL`,
  ) as unknown as ReadStatement<QueueChildRow>
  const deleteByQueue = db.prepare(`DELETE FROM queue WHERE queue_name = ?`)
  const deleteAll = db.prepare(`DELETE FROM queue`)

  function enqueue(input: {
    queueName: string
    command: string
    cwd: string
  }): number {
    const ownerStartedAt = getProcessStartTime(process.pid)
    if (!ownerStartedAt) {
      throw new Error(`Cannot read process start time for pid ${process.pid}`)
    }
    const result = insertWaiting.run(
      input.queueName,
      process.pid,
      ownerStartedAt,
      input.command,
      input.cwd,
    )
    return Number(result.lastInsertRowid)
  }

  function tryStart(
    taskId: number,
    queueName: string,
  ): { started: boolean; position: number } {
    const ownerStartedAt = getProcessStartTime(process.pid)
    if (!ownerStartedAt) {
      throw new Error(`Cannot read process start time for pid ${process.pid}`)
    }
    const updated = admitWaiting.run({
      ':taskId': taskId,
      ':queueName': queueName,
      ':pid': process.pid,
      ':ownerStartedAt': ownerStartedAt,
    })
    if (updated.changes > 0) {
      return { started: true, position: 0 }
    }
    if (!selectById.get(taskId)) {
      throw new QueueClearedError(taskId)
    }
    const position = Number(selectPosition.get(queueName, taskId)?.count ?? 1)
    return { started: false, position }
  }

  function setChildPid(taskId: number, childPid: number): void {
    const childStartedAt = getProcessStartTime(childPid)
    if (!childStartedAt) {
      throw new Error(`Cannot read process start time for child pid ${childPid}`)
    }
    const updated = updateChildPid.run(childPid, childStartedAt, taskId)
    if (updated.changes === 0) {
      throw new QueueClearedError(taskId)
    }
  }

  function heartbeat(taskId: number): void {
    updateHeartbeat.run(taskId)
  }

  function release(taskId: number): void {
    deleteById.run(taskId)
  }

  function list(queueName?: string): QueueTask[] {
    const rows = queueName ? selectByQueue.all(queueName) : selectAll.all()
    return rows.map(toQueueTask)
  }

  function clear(queueName?: string): number {
    const children = queueName
      ? selectQueueChildren.all(queueName)
      : selectAllChildren.all()
    children
      .filter(
        ({ child_pid, child_started_at }) =>
          processIdentityMatches(child_pid, child_started_at) === true,
      )
      .forEach(({ child_pid }) => {
        if (child_pid != null) {
          killProcessTree(child_pid)
        }
      })
    const deleted = queueName
      ? deleteByQueue.run(queueName)
      : deleteAll.run()
    return Number(deleted.changes)
  }

  function cleanup(queueName: string): void {
    selectCleanupRows
      .all(queueName)
      .filter(
        ({ pid, pid_started_at }) =>
          processIdentityMatches(pid, pid_started_at) === false,
      )
      .forEach(({ id, child_pid, child_started_at }) => {
        const childMatches =
          child_pid == null
            ? false
            : processIdentityMatches(child_pid, child_started_at)
        if (child_pid != null && childMatches === true) {
          killProcessTree(child_pid)
          return
        }
        if (childMatches == null) {
          return
        }
        deleteById.run(id)
      })
  }

  function close(): void {
    db.close()
  }

  return {
    enqueue,
    tryStart,
    setChildPid,
    heartbeat,
    release,
    list,
    clear,
    cleanup,
    close,
  }
}

function toQueueTask(row: QueueRow): QueueTask {
  const status = row.status
  if (status !== 'waiting' && status !== 'running') {
    throw new Error(`Unknown task status: ${status}`)
  }

  return {
    id: row.id,
    queueName: row.queue_name,
    status,
    pid: row.pid,
    childPid: row.child_pid,
    command: row.command,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function verifyDataDir(dataDir: string): void {
  const stats = statSync(dataDir)
  const currentUid = process.getuid?.()
  if (currentUid != null && stats.uid !== currentUid) {
    throw new Error(
      `Queue directory ${dataDir} is owned by uid ${stats.uid}, not uid ${currentUid}.`,
    )
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(
      `Queue directory ${dataDir} must not be group- or other-writable.`,
    )
  }
}

function addIdentityColumn(
  db: DatabaseSync,
  column: 'pid_started_at' | 'child_started_at',
): void {
  try {
    db.exec(`ALTER TABLE queue ADD COLUMN ${column} TEXT`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('duplicate column name')) {
      throw error
    }
  }
}

export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) {
    return false
  }
  const code = 'code' in error ? error.code : undefined
  const errcode = 'errcode' in error ? error.errcode : undefined
  const message = error instanceof Error ? error.message : ''
  return (
    code === 'ERR_SQLITE_BUSY' ||
    code === 'ERR_SQLITE_LOCKED' ||
    errcode === 5 ||
    errcode === 6 ||
    message.includes('database is locked')
  )
}

export function withQueue<T>(
  dataDir: string,
  read: (queue: TaskQueue) => T extends Promise<unknown> ? never : T,
): T {
  const queue = openQueue(dataDir)
  try {
    return read(queue)
  } finally {
    queue.close()
  }
}
