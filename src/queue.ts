import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  getProcessStartTime,
  processIdentityMatches,
  terminateProcessGroup,
} from './process-liveness.js'
import { canonicalDataDir, queueDatabasePath } from './paths.js'

export const SCHEMA_VERSION = 1

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

export type StartAttempt =
  | { started: true }
  | { started: false; position: number; length: number }

export type RunningTaskClaim = {
  taskId: number
  queueName: string
  holderPid: number
}

export type TaskQueue = {
  enqueue(input: {
    queueName: string
    command: string
    cwd: string
  }): number
  tryStart(taskId: number): StartAttempt
  holdsRunningTask(claim: RunningTaskClaim): boolean
  setChildPid(taskId: number, childPid: number): void
  heartbeat(taskId: number): void
  release(taskId: number): void
  list(queueName?: string): QueueTask[]
  snapshot(queueName?: string): QueueTask[]
  /** Resolves once every command it stopped is really gone. */
  clear(queueName?: string): Promise<number>
  /** Resolves once every abandoned command it stopped is really gone. */
  cleanup(queueName: string): Promise<void>
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
type QueueNameRow = Pick<QueueRow, 'queue_name'>
type QueueHolderRow = Pick<QueueRow, 'queue_name' | 'status' | 'pid' | 'pid_started_at'>
type QueuePlaceRow = { position: number; length: number }

export class QueueClearedError extends Error {
  readonly exitCode = 75

  constructor(taskId: number) {
    super(`Task ${taskId} stopped because the queue was cleared by another process.`)
    this.name = 'QueueClearedError'
  }
}

export function openQueue(dataDir: string): TaskQueue {
  const canonicalDir = canonicalDataDir(dataDir)
  verifyDataDir(canonicalDir)
  const db = new DatabaseSync(queueDatabasePath(canonicalDir), { timeout: 60_000 })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 60000')
  db.exec(SCHEMA)
  migrate(db)

  const insertWaiting = db.prepare(
    `INSERT INTO queue (queue_name, status, pid, pid_started_at, command, cwd)
     VALUES (?, 'waiting', ?, ?, ?, ?)`,
  )
  const admitWaiting = db.prepare(
    `UPDATE queue AS task
     SET status = 'running', updated_at = datetime('now'),
         pid = :pid, pid_started_at = :ownerStartedAt
     WHERE task.id = :taskId AND task.status = 'waiting'
       AND NOT EXISTS (
         SELECT 1 FROM queue AS other
         WHERE other.queue_name = task.queue_name AND other.status = 'running'
       )
       AND NOT EXISTS (
         SELECT 1 FROM queue AS other
         WHERE other.queue_name = task.queue_name AND other.status = 'waiting'
           AND other.id < task.id
       )`,
  )
  const selectPlace = db.prepare(
    `SELECT
       COUNT(
         CASE WHEN status = 'running' OR (status = 'waiting' AND id <= ?)
           THEN 1
         END
       ) AS position,
       COUNT(*) AS length
     FROM queue
     WHERE queue_name = (SELECT queue_name FROM queue WHERE id = ?)`,
  ) as unknown as ReadStatement<QueuePlaceRow>
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
  const selectHolder = db.prepare(
    `SELECT queue_name, status, pid, pid_started_at FROM queue WHERE id = ?`,
  ) as unknown as ReadStatement<QueueHolderRow>
  const selectQueueNames = db.prepare(
    `SELECT DISTINCT queue_name FROM queue`,
  ) as unknown as ReadStatement<QueueNameRow>
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
  const deleteWaitingByQueue = db.prepare(
    `DELETE FROM queue WHERE queue_name = ? AND status = 'waiting'`,
  )
  const deleteAllWaiting = db.prepare(`DELETE FROM queue WHERE status = 'waiting'`)

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

  function tryStart(taskId: number): StartAttempt {
    const ownerStartedAt = getProcessStartTime(process.pid)
    if (!ownerStartedAt) {
      throw new Error(`Cannot read process start time for pid ${process.pid}`)
    }
    const updated = admitWaiting.run({
      ':taskId': taskId,
      ':pid': process.pid,
      ':ownerStartedAt': ownerStartedAt,
    })
    if (updated.changes > 0) {
      return { started: true }
    }
    if (!selectById.get(taskId)) {
      throw new QueueClearedError(taskId)
    }
    const place = selectPlace.get(taskId, taskId)
    return {
      started: false,
      position: Number(place?.position ?? 1),
      length: Number(place?.length ?? 1),
    }
  }

  function holdsRunningTask({
    taskId,
    queueName,
    holderPid,
  }: RunningTaskClaim): boolean {
    const holder = selectHolder.get(taskId)
    if (
      !holder ||
      holder.status !== 'running' ||
      holder.queue_name !== queueName ||
      holder.pid !== holderPid
    ) {
      return false
    }
    return processIdentityMatches(holder.pid, holder.pid_started_at) === true
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

  function snapshot(queueName?: string): QueueTask[] {
    const names = queueName
      ? [queueName]
      : selectQueueNames.all().map((row) => row.queue_name)
    names.forEach((name) => dropFinishedRows(name))
    return list(queueName)
  }

  /**
   * Waiters go first, so none of them takes the slot while the running command
   * is still being stopped. The running rows only go once their process groups
   * are gone. The count is taken up front because an owner can release its own
   * row while its command is stopping.
   */
  async function clear(queueName?: string): Promise<number> {
    const children = queueName
      ? selectQueueChildren.all(queueName)
      : selectAllChildren.all()
    const cleared = list(queueName).length
    if (queueName) {
      deleteWaitingByQueue.run(queueName)
    } else {
      deleteAllWaiting.run()
    }
    await Promise.all(
      liveChildPids(children).map((childPid) =>
        terminateProcessGroup(childPid),
      ),
    )
    if (queueName) {
      deleteByQueue.run(queueName)
    } else {
      deleteAll.run()
    }
    return cleared
  }

  async function cleanup(queueName: string): Promise<void> {
    const abandoned = dropFinishedRows(queueName)
    if (abandoned.length === 0) {
      return
    }
    await Promise.all(
      abandoned.map((childPid) => terminateProcessGroup(childPid)),
    )
    dropFinishedRows(queueName)
  }

  /**
   * Deletes rows whose owner died and whose command is gone. Returns the
   * commands that outlived their owner; their rows stay until they stop.
   */
  function dropFinishedRows(queueName: string): number[] {
    const deadOwners = selectCleanupRows
      .all(queueName)
      .filter(
        ({ pid, pid_started_at }) =>
          processIdentityMatches(pid, pid_started_at) === false,
      )
    deadOwners
      .filter(
        ({ child_pid, child_started_at }) =>
          child_pid == null ||
          processIdentityMatches(child_pid, child_started_at) === false,
      )
      .forEach(({ id }) => deleteById.run(id))
    return liveChildPids(deadOwners)
  }

  function close(): void {
    db.close()
  }

  return {
    enqueue,
    tryStart,
    holdsRunningTask,
    setChildPid,
    heartbeat,
    release,
    list,
    snapshot,
    clear,
    cleanup,
    close,
  }
}

function liveChildPids(
  rows: Array<Pick<QueueRow, 'child_pid' | 'child_started_at'>>,
): number[] {
  return rows.flatMap(({ child_pid, child_started_at }) =>
    child_pid != null &&
    processIdentityMatches(child_pid, child_started_at) === true
      ? [child_pid]
      : [],
  )
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

/**
 * Brings an older database up to SCHEMA_VERSION. Databases written before this
 * version was recorded report 0, so the identity columns are added by looking
 * at the table itself rather than by trying and failing.
 */
function migrate(db: DatabaseSync): void {
  if (readUserVersion(db) >= SCHEMA_VERSION) {
    return
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    if (readUserVersion(db) < SCHEMA_VERSION) {
      addMissingIdentityColumns(db)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function addMissingIdentityColumns(db: DatabaseSync): void {
  const existing = new Set(
    (
      db.prepare(`PRAGMA table_info(queue)`) as unknown as ReadStatement<{
        name: string
      }>
    )
      .all()
      .map((column) => column.name),
  )
  const identityColumns = ['pid_started_at', 'child_started_at'] as const
  identityColumns
    .filter((column) => !existing.has(column))
    .forEach((column) =>
      db.exec(`ALTER TABLE queue ADD COLUMN ${column} TEXT`),
    )
}

function readUserVersion(db: DatabaseSync): number {
  const row = (
    db.prepare(`PRAGMA user_version`) as unknown as ReadStatement<{
      user_version: number
    }>
  ).get()
  return Number(row?.user_version ?? 0)
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

/** Clearing stops live commands, so it cannot run through the sync withQueue. */
export async function clearQueue(
  dataDir: string,
  queueName?: string,
): Promise<number> {
  const queue = openQueue(dataDir)
  try {
    return await queue.clear(queueName)
  } finally {
    queue.close()
  }
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
