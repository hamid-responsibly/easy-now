import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  getParentPid,
  getProcessStartTime,
  isCurrentProcessOrAncestor,
  isProcessAlive,
  isProcessGroupAlive,
  processIdentityMatches,
  terminateProcessGroup,
} from '../src/process-liveness.js'

test('reads the parent pid of this process', () => {
  assert.equal(getParentPid(process.pid), process.ppid)
  assert.equal(isCurrentProcessOrAncestor(process.pid), true)
  assert.equal(isCurrentProcessOrAncestor(process.ppid), true)
})

test('reads and matches the current process start time', () => {
  const startedAt = getProcessStartTime(process.pid)
  assert.ok(startedAt)
  assert.equal(processIdentityMatches(process.pid, startedAt), true)
  assert.equal(processIdentityMatches(process.pid, 'not-the-start-time'), false)
})

test('terminateProcessGroup escalates when a child ignores SIGTERM', async () => {
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
    await terminateProcessGroup(childPid, 'SIGTERM', 100)
    assert.equal(isProcessGroupAlive(childPid), false)
  } finally {
    if (isProcessAlive(childPid)) {
      process.kill(-childPid, 'SIGKILL')
    }
  }
})

test('terminateProcessGroup waits for a grandchild that ignores SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        "process.on('SIGTERM', () => {})",
        "const grandchild = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>{},1000)\"], { stdio: ['ignore','ignore','ignore','ipc'] })",
        "grandchild.on('message', () => process.send?.(grandchild.pid))",
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  const [grandchildPid] = (await once(child, 'message')) as [number]
  const childPid = child.pid
  assert.ok(childPid)
  assert.equal(isProcessAlive(grandchildPid), true)

  try {
    await terminateProcessGroup(childPid, 'SIGTERM', 100)
    assert.equal(isProcessAlive(grandchildPid), false)
    assert.equal(isProcessGroupAlive(childPid), false)
  } finally {
    if (isProcessAlive(grandchildPid)) {
      process.kill(grandchildPid, 'SIGKILL')
    }
    if (isProcessAlive(childPid)) {
      process.kill(-childPid, 'SIGKILL')
    }
  }
})

test('terminating a process group that is already gone is a no-op', async () => {
  const child = spawn(process.execPath, ['-e', ''], {
    detached: true,
    stdio: 'ignore',
  })
  await once(child, 'close')
  const childPid = child.pid
  assert.ok(childPid)
  await terminateProcessGroup(childPid, 'SIGTERM', 100)
  assert.equal(isProcessGroupAlive(childPid), false)
})
