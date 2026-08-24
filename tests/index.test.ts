import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as publicApi from '../src/index.js'
import type { RunQueuedResult } from '../src/index.js'

test('public runtime API only exports runQueued', () => {
  assert.deepEqual(Object.keys(publicApi), ['runQueued'])
})

test('a queued run only reports its exit code and its queue', () => {
  const result: RunQueuedResult = { exitCode: 0, queueName: 'app' }
  assert.deepEqual(Object.keys(result), ['exitCode', 'queueName'])
  // @ts-expect-error task ids stay inside the queue.
  const withTaskId: RunQueuedResult = { exitCode: 0, queueName: 'app', taskId: 1 }
  assert.equal(withTaskId.exitCode, 0)
})
