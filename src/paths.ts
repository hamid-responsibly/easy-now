import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_DATA_DIR = join(homedir(), '.easy-now')

export function resolveDataDir(override?: string): string {
  return override ?? process.env.EASY_NOW_DATA_DIR ?? DEFAULT_DATA_DIR
}

export function queueDatabasePath(dataDir: string): string {
  return join(dataDir, 'queue.db')
}
