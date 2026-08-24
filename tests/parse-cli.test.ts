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
  assert.deepEqual(parseCli(['-q', 'app', '--help', 'list']), { kind: 'help' })
  assert.deepEqual(parseCli(['-q', 'app', '-v']), { kind: 'version' })
  assert.deepEqual(parseCli(['--json', 'list']), { kind: 'list', json: true })
  assert.deepEqual(parseCli(['--all', 'clear']), { kind: 'clear', all: true })
})

test('help wins over an unsupported flag, wherever it appears', () => {
  const helpArgs = [
    ['--json', '--help'],
    ['--help', '--json'],
    ['--all', '--help'],
    ['--help', '--all'],
    ['--json', '--help', '--', 'ls'],
    ['-t', '30', '--help', 'list'],
    ['list', '-t', '30', '--help'],
    ['--json', '-h', 'run'],
    ['run', '--all', '-h'],
  ]
  helpArgs.forEach((argv) =>
    assert.deepEqual(parseCli(argv), { kind: 'help' }, argv.join(' ')),
  )
})

test('version wins over an unsupported flag, wherever it appears', () => {
  const versionArgs = [
    ['--json', '--version'],
    ['--version', '--json'],
    ['--all', '-v'],
    ['-t', '30', 'list', '-v'],
    ['clear', '--json', '-v'],
  ]
  versionArgs.forEach((argv) =>
    assert.deepEqual(parseCli(argv), { kind: 'version' }, argv.join(' ')),
  )
})

test('timeout is rejected by the commands that cannot honour it', () => {
  const timeoutArgs = [
    ['-t', '30', 'list'],
    ['list', '-t', '30'],
    ['-t', '30', 'peek'],
    ['-t', '30', 'status'],
    ['-t', '30', '--all', 'clear'],
    ['clear', '--timeout=30'],
  ]
  timeoutArgs.forEach((argv) =>
    assert.throws(
      () => parseCli(argv),
      /--timeout can only be used with run or a command/,
      argv.join(' '),
    ),
  )
})

test('list and clear reject the flags of a queued command', () => {
  assert.throws(() => parseCli(['clear', '--json']), /--json can only be used with list/)
  assert.throws(() => parseCli(['--json', 'clear']), /--json can only be used with list/)
})

test('run and exec reject the flags of an inspection command', () => {
  const rejected = [
    ['run', '--json', 'build'],
    ['--json', 'run', 'build'],
    ['run', '--all', 'build'],
    ['--all', 'run', 'build'],
    ['--json', '--', 'ls'],
    ['--all', '--', 'ls'],
    ['--json', 'vitest'],
    ['--all', 'vitest'],
  ]
  rejected.forEach((argv) =>
    assert.throws(
      () => parseCli(argv),
      /--json can only be used with list|--all can only be used with list or clear/,
      argv.join(' '),
    ),
  )
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
