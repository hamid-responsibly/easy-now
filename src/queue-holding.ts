import { canonicalDataDir } from './paths.js'
import { isCurrentProcessOrAncestor } from './process-liveness.js'
import { withQueue } from './queue.js'

export const LEASES_ENV = 'EASY_NOW_LEASES'

/** A slot an ancestor process already holds, passed down through the environment. */
export type QueueLease = {
  dir: string
  queue: string
  task: number
  pid: number
}

/**
 * Every lease this process inherited, plus the one it just took. A nested chain
 * such as A -> B -> A only works when the inner A can still see the outer A.
 */
export function leaseChildEnv({
  dataDir,
  queueName,
  taskId,
  env = process.env,
}: {
  dataDir: string
  queueName: string
  taskId: number
  env?: NodeJS.ProcessEnv
}): Record<string, string> {
  const dir = canonicalDataDir(dataDir)
  const inherited = readLeases(env).filter(
    (lease) => lease.dir !== dir || lease.queue !== queueName,
  )
  return {
    [LEASES_ENV]: JSON.stringify([
      ...inherited,
      { dir, queue: queueName, task: taskId, pid: process.pid },
    ]),
  }
}

/**
 * The task an ancestor holds on this queue, or null. The environment is only a
 * claim: the queue database decides whether the slot is real.
 */
export function heldTaskId({
  dataDir,
  queueName,
  env = process.env,
}: {
  dataDir: string
  queueName: string
  env?: NodeJS.ProcessEnv
}): number | null {
  const dir = canonicalDataDir(dataDir)
  const lease = readLeases(env).find(
    (candidate) =>
      candidate.dir === dir &&
      candidate.queue === queueName &&
      isCurrentProcessOrAncestor(candidate.pid),
  )
  if (!lease) {
    return null
  }
  const held = withQueue(dataDir, (queue) =>
    queue.holdsRunningTask({
      taskId: lease.task,
      queueName,
      holderPid: lease.pid,
    }),
  )
  return held ? lease.task : null
}

export function readLeases(env: NodeJS.ProcessEnv = process.env): QueueLease[] {
  const raw = env[LEASES_ENV]
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.flatMap(toLease) : []
  } catch {
    return []
  }
}

function toLease(value: unknown): QueueLease[] {
  if (
    typeof value !== 'object' ||
    value == null ||
    !('dir' in value) ||
    !('queue' in value) ||
    !('task' in value) ||
    !('pid' in value)
  ) {
    return []
  }
  const { dir, queue, task, pid } = value
  return typeof dir === 'string' &&
    dir.length > 0 &&
    typeof queue === 'string' &&
    queue.length > 0 &&
    isPositiveInteger(task) &&
    isPositiveInteger(pid)
    ? [{ dir, queue, task, pid }]
    : []
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
