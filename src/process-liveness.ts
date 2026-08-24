import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

export type ProcessSignal = 'SIGINT' | 'SIGTERM'

/** Whether a signal can still reach a process group. */
type GroupReach = 'gone' | 'alive' | 'unreachable'

const TERMINATION_POLL_MS = 25

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (pid == null || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function getParentPid(pid: number): number | null {
  if (pid <= 0) {
    return null
  }

  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fieldsAfterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const parent = Number(fieldsAfterName[1])
      return Number.isInteger(parent) && parent >= 0 ? parent : null
    }
    if (process.platform === 'darwin') {
      const raw = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim()
      const parent = Number(raw)
      return Number.isInteger(parent) && parent >= 0 ? parent : null
    }
    return null
  } catch {
    return null
  }
}

export function isCurrentProcessOrAncestor(pid: number): boolean {
  if (pid === process.pid) {
    return true
  }
  if (pid <= 1) {
    return false
  }

  const seen = new Set<number>()
  let current = process.ppid
  while (current > 0 && seen.has(current) === false) {
    if (current === pid) {
      return true
    }
    seen.add(current)
    const parent = getParentPid(current)
    if (parent == null || parent === current) {
      return false
    }
    current = parent
  }
  return false
}

export function getProcessStartTime(pid: number): string | null {
  if (!isProcessAlive(pid)) {
    return null
  }

  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fieldsAfterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return fieldsAfterName[19] ?? null
    }
    if (process.platform === 'darwin') {
      return (
        execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf8',
        }).trim() || null
      )
    }
    return null
  } catch {
    return null
  }
}

export function processIdentityMatches(
  pid: number | null | undefined,
  startedAt: string | null | undefined,
): boolean | null {
  if (pid == null || pid <= 0 || !isProcessAlive(pid)) {
    return false
  }
  if (!startedAt) {
    return null
  }
  const currentStartTime = getProcessStartTime(pid)
  return currentStartTime == null ? null : currentStartTime === startedAt
}

/**
 * Stops the process group led by `leaderPid` and resolves only once the whole
 * group is gone. Commands are spawned detached, so the direct child leads the
 * group and its descendants share the group id.
 */
export async function terminateProcessGroup(
  leaderPid: number,
  signal: ProcessSignal = 'SIGTERM',
  graceMs = 2_000,
): Promise<void> {
  if (groupReach(leaderPid) !== 'alive') {
    return
  }

  signalGroup(leaderPid, signal)
  const escalateAt = Date.now() + graceMs
  for (;;) {
    await delay(TERMINATION_POLL_MS)
    const reach = groupReach(leaderPid)
    switch (reach) {
      case 'gone':
      case 'unreachable':
        return
      case 'alive':
        break
      default: {
        const exhaustive: never = reach
        throw new Error(`Unknown process group state: ${String(exhaustive)}`)
      }
    }
    if (Date.now() >= escalateAt) {
      signalGroup(leaderPid, 'SIGKILL')
    }
  }
}

export function isProcessGroupAlive(leaderPid: number): boolean {
  return groupReach(leaderPid) === 'alive'
}

function groupReach(leaderPid: number): GroupReach {
  if (leaderPid <= 1) {
    return 'gone'
  }

  try {
    process.kill(-leaderPid, 0)
    return 'alive'
  } catch (error) {
    return errorCode(error) === 'EPERM' ? 'unreachable' : 'gone'
  }
}

function signalGroup(
  leaderPid: number,
  signal: ProcessSignal | 'SIGKILL',
): void {
  if (leaderPid <= 1) {
    return
  }

  try {
    process.kill(-leaderPid, signal)
  } catch {
    return
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error != null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}
