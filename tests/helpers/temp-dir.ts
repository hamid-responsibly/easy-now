import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'node:test'

const tempDirs = new Set<string>()

export function tempDir(prefix = 'easy-now-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

afterEach(() => {
  tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  tempDirs.clear()
})
