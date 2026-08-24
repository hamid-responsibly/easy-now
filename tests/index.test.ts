import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as publicApi from '../src/index.js'

test('public runtime API only exports runQueued', () => {
  assert.deepEqual(Object.keys(publicApi), ['runQueued'])
})
