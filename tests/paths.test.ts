import assert from 'node:assert/strict'
import { existsSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_DATA_DIR,
  canonicalDataDir,
  resolveDataDir,
} from '../src/paths.js'
import { tempDir } from './helpers/temp-dir.js'

test('default queue directory is inside the current home directory', () => {
  const fromHome = relative(homedir(), DEFAULT_DATA_DIR)
  assert.equal(fromHome.startsWith('..'), false)
  assert.equal(resolveDataDir(), DEFAULT_DATA_DIR)
})

test('a symlink and its target canonicalize to one directory', () => {
  const target = tempDir()
  const link = join(tempDir(), 'alias')
  symlinkSync(target, link)
  assert.equal(canonicalDataDir(link), canonicalDataDir(target))
})

test('canonicalDataDir creates a missing directory', () => {
  const dir = join(tempDir(), 'nested', 'queue')
  assert.equal(existsSync(dir), false)
  assert.equal(canonicalDataDir(dir).endsWith(join('nested', 'queue')), true)
  assert.equal(existsSync(dir), true)
})
