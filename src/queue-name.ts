import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProjectRoot } from './project.js'

const GIT_TIMEOUT_MS = 2000

export function defaultQueueName(startDir: string): string {
  const remoteUrl = gitRemoteUrl(startDir)
  if (remoteUrl) {
    return normalizeGitRemoteUrl(remoteUrl)
  }

  const commonDir = gitCommonDir(startDir)
  if (commonDir) {
    return commonDir
  }

  return findProjectRoot(startDir)
}

export function normalizeGitRemoteUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error('Git remote URL must not be empty')
  }

  const withoutGitPlus = trimmed.replace(/^git\+/, '')
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(withoutGitPlus)) {
    return normalizeUrlRemote(withoutGitPlus)
  }

  const scp = /^([^@/?#]+)@([^:/?#]+):(.+)$/.exec(withoutGitPlus)
  if (scp) {
    const [, , host, path] = scp
    if (host == null || path == null) {
      throw new Error(`Invalid git remote URL: ${raw}`)
    }
    return normalizeNetworkIdentity(host, path)
  }

  return resolveExisting(withoutGitPlus)
}

function normalizeUrlRemote(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'file:') {
    return resolveExisting(fileURLToPath(url))
  }
  return normalizeNetworkIdentity(url.host, url.pathname)
}

function normalizeNetworkIdentity(host: string, path: string): string {
  const normalizedPath = stripGitSuffix(path).replace(/^\/+/, '')
  return `${host.toLowerCase()}/${normalizedPath}`.toLowerCase()
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '')
}

function gitRemoteUrl(startDir: string): string | null {
  if (git(startDir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return null
  }

  const origin = git(startDir, ['remote', 'get-url', 'origin'])
  if (origin) {
    return origin
  }

  const remotes = git(startDir, ['remote'])
  const firstRemote = remotes?.split('\n').find((name) => name.length > 0)
  if (!firstRemote) {
    return null
  }

  return git(startDir, ['remote', 'get-url', firstRemote])
}

function gitCommonDir(startDir: string): string | null {
  const commonDir = git(startDir, ['rev-parse', '--git-common-dir'])
  if (!commonDir) {
    return null
  }
  return resolveExisting(resolve(startDir, commonDir))
}

function resolveExisting(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    })
    if (result.status !== 0) {
      return null
    }
    const output = result.stdout.trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}
