import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  HOLDING_DIR_ENV,
  HOLDING_PID_ENV,
  HOLDING_QUEUE_ENV,
  HOLDING_TASK_ENV,
  heldTaskId,
  holdingChildEnv,
} from '../src/queue-holding.js'
import { tempDir } from './helpers/temp-dir.js'

test('heldTaskId matches the same queue and data dir when this process holds it', () => {
  const dataDir = tempDir()
  const env = holdingChildEnv({
    dataDir,
    queueName: 'app',
    taskId: 12,
  })
  assert.equal(heldTaskId({ dataDir, queueName: 'app', env }), 12)
})

test('heldTaskId ignores a different queue, data dir, or unrelated pid', () => {
  const dataDir = tempDir()
  const otherDir = tempDir()
  const env = {
    [HOLDING_DIR_ENV]: resolve(dataDir),
    [HOLDING_QUEUE_ENV]: 'app',
    [HOLDING_PID_ENV]: String(process.pid),
    [HOLDING_TASK_ENV]: '12',
  }
  assert.equal(heldTaskId({ dataDir, queueName: 'other', env }), null)
  assert.equal(heldTaskId({ dataDir: otherDir, queueName: 'app', env }), null)
  assert.equal(
    heldTaskId({
      dataDir,
      queueName: 'app',
      env: { ...env, [HOLDING_PID_ENV]: '1' },
    }),
    null,
  )
})
