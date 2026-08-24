import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_DATA_DIR = join(homedir(), '.easy-now')

export function resolveDataDir(override?: string): string {
  return override ?? process.env.EASY_NOW_DATA_DIR ?? DEFAULT_DATA_DIR
}

/** One directory reached through a symlink and through its target is one queue. */
export function canonicalDataDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return realpathSync(dataDir)
}

export function queueDatabasePath(dataDir: string): string {
  return join(dataDir, 'queue.db')
}
