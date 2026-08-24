import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export type ProcessSignal = 'SIGINT' | 'SIGTERM'

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

export function killProcessTree(
  pid: number,
  signal: ProcessSignal = 'SIGTERM',
  graceMs = 2_000,
): void {
  if (!isProcessAlive(pid)) {
    return
  }

  signalProcessTree(pid, signal)
  const escalation = setTimeout(() => signalProcessTree(pid, 'SIGKILL'), graceMs)
  escalation.unref()
}

function signalProcessTree(
  pid: number,
  signal: ProcessSignal | 'SIGKILL',
): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      return
    }
  }
}
