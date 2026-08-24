import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { relative } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_DATA_DIR, resolveDataDir } from '../src/paths.js'

test('default queue directory is inside the current home directory', () => {
  const fromHome = relative(homedir(), DEFAULT_DATA_DIR)
  assert.equal(fromHome.startsWith('..'), false)
  assert.equal(resolveDataDir(), DEFAULT_DATA_DIR)
})
