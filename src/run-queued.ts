import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveDataDir } from './paths.js'
import {
  killProcessTree,
  type ProcessSignal,
} from './process-liveness.js'
import { heldTaskId, holdingChildEnv } from './queue-holding.js'
import { defaultQueueName } from './queue-name.js'
import {
  isSqliteBusy,
  openQueue,
  type TaskQueue,
} from './queue.js'

const DEFAULT_POLL_MS = 200
const MINIMUM_POLL_MS = 20
const HEARTBEAT_MS = 30_000

export type RunQueuedOptions = {
  command: string
  argv: string[]
  cwd: string
  queueName?: string
  dataDir?: string
  timeoutSeconds?: number
}

export type RunQueuedResult = {
  exitCode: number
  taskId: number
  queueName: string
}

export async function runQueued({
  command,
  argv,
  cwd,
  queueName: requestedQueueName,
  dataDir,
  timeoutSeconds,
}: RunQueuedOptions): Promise<RunQueuedResult> {
  const queueName = requestedQueueName ?? defaultQueueName(cwd)
  const resolvedDir = resolveDataDir(dataDir)
  const alreadyHeld = heldTaskId({ dataDir: resolvedDir, queueName })
  if (alreadyHeld != null) {
    process.stderr.write(
      `easy-now: already in ${queueName}; running without taking another slot\n`,
    )
    const exitCode = await runChild({
      command,
      argv,
      cwd,
      timeoutSeconds,
    })
    return { exitCode, taskId: alreadyHeld, queueName }
  }

  const queue = openQueue(resolvedDir)
  const displayCommand = [command, ...argv].join(' ')
  const taskId = queue.enqueue({
    queueName,
    command: displayCommand,
    cwd,
  })
  const pollMs = pollInterval(process.env.EASY_NOW_POLL_MS)

  try {
    await waitForTurn(queue, taskId, queueName, pollMs)
    const heartbeat = startHeartbeat(queue, taskId)
    try {
      const exitCode = await runChild({
        command,
        argv,
        cwd,
        timeoutSeconds,
        extraEnv: holdingChildEnv({
          dataDir: resolvedDir,
          queueName,
          taskId,
        }),
        onSpawn: (childPid) => queue.setChildPid(taskId, childPid),
      })
      return { exitCode, taskId, queueName }
    } finally {
      clearInterval(heartbeat)
    }
  } finally {
    queue.release(taskId)
    queue.close()
  }
}

async function waitForTurn(
  queue: TaskQueue,
  taskId: number,
  queueName: string,
  pollMs: number,
): Promise<void> {
  let lastLine: string | undefined
  for (;;) {
    try {
      queue.cleanup(queueName)
      const { started, position } = queue.tryStart(taskId, queueName)
      if (started) {
        return
      }
      const length = queue.list(queueName).length
      const line = `easy-now: place ${position} of ${length} in ${queueName}\n`
      if (line !== lastLine) {
        process.stderr.write(line)
        lastLine = line
      }
    } catch (error) {
      if (!isSqliteBusy(error)) {
        throw error
      }
    }
    await delay(pollMs)
  }
}

export function pollInterval(raw: string | undefined): number {
  const parsed = raw == null ? DEFAULT_POLL_MS : Number(raw)
  return Number.isFinite(parsed) && parsed >= MINIMUM_POLL_MS
    ? parsed
    : DEFAULT_POLL_MS
}

export function startHeartbeat(
  queue: TaskQueue,
  taskId: number,
  intervalMs = HEARTBEAT_MS,
): NodeJS.Timeout {
  const heartbeat = setInterval(() => queue.heartbeat(taskId), intervalMs)
  heartbeat.unref()
  return heartbeat
}

async function runChild({
  command,
  argv,
  cwd,
  timeoutSeconds,
  extraEnv,
  onSpawn,
}: {
  command: string
  argv: string[]
  cwd: string
  timeoutSeconds?: number
  extraEnv?: Record<string, string>
  onSpawn?: (childPid: number) => void
}): Promise<number> {
  const child = spawn(command, argv, {
    cwd,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: 'inherit',
    detached: true,
  })

  const childPid = child.pid
  if (childPid == null) {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 1))
    })
  }

  try {
    onSpawn?.(childPid)
  } catch (error) {
    killProcessTree(childPid)
    await new Promise<void>((resolve) => {
      child.once('error', () => resolve())
      child.once('close', () => resolve())
    })
    throw error
  }

  let timedOut = false
  let interruptedBy: ProcessSignal | undefined
  const timeoutHandle =
    timeoutSeconds != null && timeoutSeconds > 0
      ? setTimeout(() => {
          timedOut = true
          killProcessTree(childPid)
        }, timeoutSeconds * 1000)
      : undefined
  timeoutHandle?.unref()

  const closePromise = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (timedOut) {
        resolve(124)
        return
      }
      if (interruptedBy) {
        resolve(interruptedBy === 'SIGINT' ? 130 : 143)
        return
      }
      if (signal) {
        resolve(1)
        return
      }
      resolve(code ?? 1)
    })
  })

  const onAbort = (signal: ProcessSignal): void => {
    interruptedBy = signal
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    killProcessTree(childPid, signal)
  }
  const onSigint = (): void => onAbort('SIGINT')
  const onSigterm = (): void => onAbort('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  try {
    return await closePromise
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    clearTimeout(timeoutHandle)
  }
}
