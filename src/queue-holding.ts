import { resolve } from 'node:path'
import { isCurrentProcessOrAncestor } from './process-liveness.js'

export const HOLDING_DIR_ENV = 'EASY_NOW_HOLDING_DIR'
export const HOLDING_QUEUE_ENV = 'EASY_NOW_HOLDING_QUEUE'
export const HOLDING_PID_ENV = 'EASY_NOW_HOLDING_PID'
export const HOLDING_TASK_ENV = 'EASY_NOW_HOLDING_TASK'

export function holdingChildEnv({
  dataDir,
  queueName,
  taskId,
}: {
  dataDir: string
  queueName: string
  taskId: number
}): Record<string, string> {
  return {
    [HOLDING_DIR_ENV]: resolve(dataDir),
    [HOLDING_QUEUE_ENV]: queueName,
    [HOLDING_PID_ENV]: String(process.pid),
    [HOLDING_TASK_ENV]: String(taskId),
  }
}

export function heldTaskId({
  dataDir,
  queueName,
  env = process.env,
}: {
  dataDir: string
  queueName: string
  env?: NodeJS.ProcessEnv
}): number | null {
  if (env[HOLDING_DIR_ENV] !== resolve(dataDir)) {
    return null
  }
  if (env[HOLDING_QUEUE_ENV] !== queueName) {
    return null
  }
  const holderPid = Number(env[HOLDING_PID_ENV])
  if (!Number.isInteger(holderPid) || isCurrentProcessOrAncestor(holderPid) === false) {
    return null
  }
  const taskId = Number(env[HOLDING_TASK_ENV])
  return Number.isInteger(taskId) && taskId > 0 ? taskId : 0
}
