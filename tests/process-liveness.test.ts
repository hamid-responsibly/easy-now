import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  getProcessStartTime,
  isProcessAlive,
  killProcessTree,
  processIdentityMatches,
} from '../src/process-liveness.js'

test('reads and matches the current process start time', () => {
  const startedAt = getProcessStartTime(process.pid)
  assert.ok(startedAt)
  assert.equal(processIdentityMatches(process.pid, startedAt), true)
  assert.equal(processIdentityMatches(process.pid, 'not-the-start-time'), false)
})

test('killProcessTree escalates when a child ignores SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1000)",
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  await once(child, 'spawn')
  await once(child, 'message')
  const childPid = child.pid
  assert.ok(childPid)

  try {
    killProcessTree(childPid, 'SIGTERM', 100)
    await once(child, 'close')
    assert.equal(isProcessAlive(childPid), false)
  } finally {
    if (isProcessAlive(childPid)) {
      process.kill(-childPid, 'SIGKILL')
    }
  }
})
