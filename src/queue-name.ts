import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProjectRoot } from './project.js'

const GIT_TIMEOUT_MS = 2000

export function defaultQueueName(startDir: string): string {
  const remoteUrl = gitRemoteUrl(startDir)
  if (remoteUrl) {
    return normalizeRemoteUrl(remoteUrl, gitToplevel(startDir) ?? startDir)
  }

  const commonDir = gitCommonDir(startDir)
  if (commonDir) {
    return commonDir
  }

  return findProjectRoot(startDir)
}

/** Relative paths resolve against the caller's directory. */
export function normalizeGitRemoteUrl(raw: string): string {
  return normalizeRemoteUrl(raw, process.cwd())
}

/**
 * `baseDir` is the checkout that owns the remote, so a remote such as
 * `../upstream.git` names the same queue from any working directory.
 */
function normalizeRemoteUrl(raw: string, baseDir: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error('Git remote URL must not be empty')
  }

  const withoutGitPlus = trimmed.replace(/^git\+/, '')
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(withoutGitPlus)) {
    return normalizeUrlRemote(withoutGitPlus, baseDir)
  }

  const scp = /^([^@/?#]+)@([^:/?#]+):(.+)$/.exec(withoutGitPlus)
  if (scp) {
    const [, , host, path] = scp
    if (host == null || path == null) {
      throw new Error(`Invalid git remote URL: ${raw}`)
    }
    return normalizeNetworkIdentity(host, path)
  }

  return resolveExisting(withoutGitPlus, baseDir)
}

function normalizeUrlRemote(value: string, baseDir: string): string {
  const url = new URL(value)
  if (url.protocol === 'file:') {
    return resolveExisting(fileURLToPath(url), baseDir)
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
  return resolveExisting(commonDir, startDir)
}

function gitToplevel(startDir: string): string | null {
  return git(startDir, ['rev-parse', '--show-toplevel'])
}

function resolveExisting(path: string, baseDir: string): string {
  const absolute = resolve(baseDir, path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
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
