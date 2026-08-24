import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const packageJson: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

test('npm release metadata preserves the CLI and public registry', () => {
  assert.ok(packageJson && typeof packageJson === 'object')
  assert.ok('bin' in packageJson)
  assert.deepEqual(packageJson.bin, { 'easy-now': 'dist/cli.js' })
  assert.ok('publishConfig' in packageJson)
  assert.deepEqual(packageJson.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org',
  })
})
