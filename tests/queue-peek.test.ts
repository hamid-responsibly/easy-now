import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { QueueTask } from '../src/queue.js'
import { peekQueues } from '../src/queue-peek.js'

test('peekQueues puts running jobs first and numbers place from 1', () => {
  const peeks = peekQueues([
    task({ id: 2, queueName: 'app', status: 'waiting', command: 'wait' }),
    task({ id: 5, queueName: 'app', status: 'running', command: 'run' }),
  ])
  assert.deepEqual(
    peeks[0]?.jobs.map(({ place, id, status }) => ({ place, id, status })),
    [
      { place: 1, id: 5, status: 'running' },
      { place: 2, id: 2, status: 'waiting' },
    ],
  )
})

test('peekQueues keeps an empty named queue so agents can see zeros', () => {
  assert.deepEqual(peekQueues([], 'app'), [
    { queue: 'app', running: 0, waiting: 0, jobs: [] },
  ])
})

function task(
  fields: Pick<QueueTask, 'id' | 'queueName' | 'status'> &
    Partial<Pick<QueueTask, 'command'>>,
): QueueTask {
  return {
    pid: 1,
    childPid: null,
    command: fields.command ?? 'cmd',
    cwd: '/tmp',
    createdAt: 'now',
    updatedAt: 'now',
    ...fields,
  }
}
