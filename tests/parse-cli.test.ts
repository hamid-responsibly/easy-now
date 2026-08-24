import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCli } from '../src/parse-cli.js'

test('parses exec after --', () => {
  assert.deepEqual(parseCli(['-q', 'build', '--', 'next', 'build']), {
    kind: 'exec',
    argv: ['next', 'build'],
    queue: 'build',
  })
})

test('accepts equals syntax for value flags', () => {
  assert.deepEqual(parseCli(['--queue=build', '--', 'next']), {
    kind: 'exec',
    argv: ['next'],
    queue: 'build',
  })
})

test('parses a bare command as exec', () => {
  assert.deepEqual(parseCli(['vitest', '--run']), {
    kind: 'exec',
    argv: ['vitest', '--run'],
  })
})

test('parses run with extra script args', () => {
  assert.deepEqual(parseCli(['-t', '30', 'run', 'test', '--', '--watch']), {
    kind: 'run',
    script: 'test',
    scriptArgs: ['--watch'],
    timeoutSeconds: 30,
  })
})

test('parses list and clear', () => {
  assert.equal(parseCli(['list']).kind, 'list')
  assert.equal(parseCli(['-q', 'app', 'clear']).kind, 'clear')
  assert.deepEqual(parseCli(['status']), { kind: 'list' })
  assert.deepEqual(parseCli(['peek']), { kind: 'list' })
  assert.deepEqual(parseCli(['list', '--json', '--all']), {
    kind: 'list',
    json: true,
    all: true,
  })
})

test('each command keeps only the flags it can act on', () => {
  assert.deepEqual(parseCli(['-t', '30', 'list']), { kind: 'list' })
  assert.deepEqual(parseCli(['-t', '30', '--all', 'clear']), {
    kind: 'clear',
    all: true,
  })
  assert.deepEqual(parseCli(['-q', 'app', '--help', 'list']), { kind: 'help' })
  assert.deepEqual(parseCli(['-q', 'app', '-v']), { kind: 'version' })
})

test('accepts known flags immediately after a verb', () => {
  const parsed = parseCli(['clear', '-q', 'app', '--data-dir=/tmp/easy'])
  assert.equal(parsed.kind, 'clear')
  assert.equal(parsed.queue, 'app')
  assert.equal(parsed.dataDir, '/tmp/easy')
})

test('double dash always forces exec mode', () => {
  assert.deepEqual(parseCli(['--', 'clear']), {
    kind: 'exec',
    argv: ['clear'],
  })
  assert.deepEqual(parseCli(['--', 'list']), {
    kind: 'exec',
    argv: ['list'],
  })
  assert.deepEqual(parseCli(['--', 'peek']), {
    kind: 'exec',
    argv: ['peek'],
  })
  assert.deepEqual(parseCli(['--', 'run', 'build']), {
    kind: 'exec',
    argv: ['run', 'build'],
  })
})

test('passes script arguments after double dash verbatim', () => {
  assert.deepEqual(parseCli(['run', 'test', '--', '-t', '5']), {
    kind: 'run',
    script: 'test',
    scriptArgs: ['-t', '5'],
  })
})

test('does not steal flags from an exec command', () => {
  assert.deepEqual(parseCli(['vitest', '-q', 'build']), {
    kind: 'exec',
    argv: ['vitest', '-q', 'build'],
  })
})

test('flags after a bare exec command pass through untouched', () => {
  assert.deepEqual(parseCli(['vitest', '-t', '5']), {
    kind: 'exec',
    argv: ['vitest', '-t', '5'],
  })
})

test('empty argv is help', () => {
  assert.equal(parseCli([]).kind, 'help')
})

test('unknown option before a command throws', () => {
  assert.throws(() => parseCli(['--nope', 'build']), /Unknown option/)
})

test('unknown options after a verb throw', () => {
  assert.throws(() => parseCli(['clear', '-Q', 'app']), /Unknown option -Q/)
  assert.throws(
    () => parseCli(['clear', '--queue-name', 'app']),
    /Unknown option --queue-name/,
  )
})

test('extra positionals after list and clear throw', () => {
  assert.throws(() => parseCli(['clear', 'app']), /does not accept arguments/)
  assert.throws(() => parseCli(['list', 'app']), /does not accept arguments/)
  assert.throws(() => parseCli(['status', 'app']), /does not accept arguments/)
  assert.throws(() => parseCli(['peek', 'app']), /does not accept arguments/)
})

test('json is list-only and all is list or clear', () => {
  assert.throws(() => parseCli(['--json', 'clear']), /--json can only be used with list/)
  assert.throws(() => parseCli(['--json', '--', 'ls']), /--json can only be used with list/)
  assert.throws(
    () => parseCli(['--all', '--', 'ls']),
    /--all can only be used with list or clear/,
  )
})

test('all cannot be combined with a named queue', () => {
  assert.throws(
    () => parseCli(['--all', '-q', 'app', 'clear']),
    /cannot be used together/,
  )
})

test('missing run script throws', () => {
  assert.throws(() => parseCli(['run']), /Usage: easy-now run/)
})
