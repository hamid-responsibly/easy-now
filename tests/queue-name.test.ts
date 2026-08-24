import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  defaultQueueName,
  normalizeGitRemoteUrl,
} from '../src/queue-name.js'
import { tempDir } from './helpers/temp-dir.js'

test('normalizeGitRemoteUrl maps clone URLs of one repo to one name', () => {
  const expected = 'github.com/acme/app'
  const remotes = [
    'git@github.com:acme/app.git',
    'git@github.com:Acme/App.git',
    'ssh://git@github.com/acme/app.git',
    'https://github.com/acme/app.git',
    'https://github.com/acme/app',
    'https://github.com/acme/app.git/',
    'https://x-access-token:secret@github.com/acme/app.git',
    'git+https://github.com/acme/app.git',
  ]
  for (const remote of remotes) {
    assert.equal(normalizeGitRemoteUrl(remote), expected, remote)
  }
})

test('normalizeGitRemoteUrl keeps a local remote as an absolute path', () => {
  const root = tempDir()
  const bare = join(root, 'app.git')
  assert.equal(normalizeGitRemoteUrl(bare), bare)
  assert.equal(normalizeGitRemoteUrl(`file://${bare}`), bare)
})

test('independent clones of the same origin share a queue name', () => {
  const first = gitRepo(tempDir(), 'git@github.com:acme/app.git')
  const second = gitRepo(tempDir(), 'https://github.com/acme/app.git')
  assert.equal(defaultQueueName(first), 'github.com/acme/app')
  assert.equal(defaultQueueName(second), defaultQueueName(first))
})

test('clones of different remotes stay on different queues', () => {
  const app = gitRepo(tempDir(), 'git@github.com:acme/app.git')
  const fork = gitRepo(tempDir(), 'git@github.com:other/app.git')
  assert.notEqual(defaultQueueName(app), defaultQueueName(fork))
})

test('a worktree shares the main checkout queue', () => {
  const main = gitRepo(tempDir(), 'git@github.com:acme/app.git')
  git(main, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'init'])
  const worktree = join(tempDir(), 'copy')
  git(main, ['worktree', 'add', worktree])
  assert.equal(defaultQueueName(worktree), defaultQueueName(main))
  assert.equal(defaultQueueName(worktree), 'github.com/acme/app')
})

test('worktrees of a local-only repo share the common git directory', () => {
  const main = gitRepo(tempDir())
  git(main, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'init'])
  const worktree = join(tempDir(), 'copy')
  git(main, ['worktree', 'add', worktree])
  assert.equal(defaultQueueName(worktree), defaultQueueName(main))
  assert.match(defaultQueueName(main), /\.git$/)
})

test('a directory without git falls back to the package root', () => {
  const root = tempDir()
  mkdirSync(join(root, 'packages', 'web'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }))
  assert.equal(defaultQueueName(join(root, 'packages', 'web')), root)
})

function gitRepo(dir: string, origin?: string): string {
  git(dir, ['init'])
  if (origin) {
    git(dir, ['remote', 'add', 'origin', origin])
  }
  return dir
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
}
