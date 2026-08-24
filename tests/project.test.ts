import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  detectPackageManager,
  findPackageRoot,
  findProjectRoot,
  resolveNpmScript,
} from '../src/project.js'
import { tempDir } from './helpers/temp-dir.js'

const fixtureApp = fileURLToPath(new URL('./fixtures/app', import.meta.url))

test('finds the fixture package root', () => {
  const nested = join(fixtureApp, 'src')
  assert.equal(findPackageRoot(nested), fixtureApp)
  assert.equal(detectPackageManager(fixtureApp), 'pnpm')
})

test('resolveNpmScript reads the hello script', () => {
  const resolved = resolveNpmScript(fixtureApp, 'hello')
  assert.equal(resolved.packageRoot, fixtureApp)
  assert.equal(resolved.packageManager, 'pnpm')
  assert.deepEqual(Object.keys(resolved).sort(), ['packageManager', 'packageRoot'])
})

test('findProjectRoot prefers a git root over a nested package', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'packages', 'web'), { recursive: true })
  writeFileSync(
    join(root, 'packages', 'web', 'package.json'),
    JSON.stringify({ name: 'web' }),
  )
  assert.equal(findProjectRoot(join(root, 'packages', 'web')), root)
})
