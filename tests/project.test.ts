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

test('a package in a pnpm workspace runs under the workspace manager', () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'web')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  writeFileSync(
    join(nested, 'package.json'),
    JSON.stringify({ name: 'web', scripts: { build: 'tsc' } }),
  )

  assert.equal(detectPackageManager(nested), 'pnpm')
  assert.deepEqual(resolveNpmScript(nested, 'build'), {
    packageRoot: nested,
    packageManager: 'pnpm',
  })
})

test('a package in a yarn workspace runs under the workspace manager', () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'web')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(root, 'yarn.lock'), '')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
  )
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }))

  assert.equal(detectPackageManager(nested), 'yarn')
})

test('a lockfile in the package itself beats the workspace root', () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'web')
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }))
  writeFileSync(join(nested, 'bun.lock'), '')

  assert.equal(detectPackageManager(nested), 'bun')
})

test('a packageManager declaration beats every lockfile', () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'web')
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'yarn.lock'), '')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', packageManager: 'pnpm@9.12.0' }),
  )
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }))
  writeFileSync(join(nested, 'package-lock.json'), '{}')

  assert.equal(detectPackageManager(nested), 'pnpm')
})

test('the nearest packageManager declaration wins', () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'web')
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', packageManager: 'yarn@4.5.0' }),
  )
  writeFileSync(
    join(nested, 'package.json'),
    JSON.stringify({ name: 'web', packageManager: 'bun@1.1.30' }),
  )

  assert.equal(detectPackageManager(nested), 'bun')
})

test('an unusable packageManager declaration falls back to a lockfile', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', packageManager: 'cargo@1.0.0' }),
  )
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')

  assert.equal(detectPackageManager(root), 'pnpm')
})

test('a malformed package.json never breaks detection', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'package.json'), '{ not json')
  writeFileSync(join(root, 'yarn.lock'), '')

  assert.equal(detectPackageManager(root), 'yarn')
})

test('nothing above a lone package counts', () => {
  const root = tempDir()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'lonely' }))

  assert.equal(detectPackageManager(root), 'npm')
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
