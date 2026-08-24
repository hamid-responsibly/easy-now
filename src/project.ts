import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

const PACKAGE_MANAGERS: readonly PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun']

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

export function findProjectRoot(startDir: string): string {
  const fromGit = findUp(startDir, '.git')
  if (fromGit) {
    return fromGit
  }

  const fromPackage = findUp(startDir, 'package.json')
  if (fromPackage) {
    return fromPackage
  }

  return resolve(startDir)
}

export function findPackageRoot(startDir: string): string | null {
  return findUp(startDir, 'package.json')
}

/**
 * A package inside a workspace is installed by the workspace root's manager, so
 * the search climbs to the repository or workspace root. The nearest
 * `packageManager` declaration wins; otherwise the nearest lockfile does.
 */
export function detectPackageManager(packageRoot: string): PackageManager {
  const dirs = dirsUpToWorkspaceRoot(packageRoot)
  const declared = dirs.map(declaredPackageManager).find((name) => name != null)
  if (declared) {
    return declared
  }
  return dirs.map(lockedPackageManager).find((name) => name != null) ?? 'npm'
}

/**
 * `packageRoot` first, then its ancestors up to and including the repository or
 * workspace root. Without such a root, nothing above the package counts.
 */
function dirsUpToWorkspaceRoot(packageRoot: string): string[] {
  const chain = ancestors(resolve(packageRoot))
  const rootIndex = chain.findIndex(isWorkspaceRoot)
  return rootIndex < 0 ? chain.slice(0, 1) : chain.slice(0, rootIndex + 1)
}

function ancestors(startDir: string): string[] {
  const parent = dirname(startDir)
  return parent === startDir ? [startDir] : [startDir, ...ancestors(parent)]
}

function isWorkspaceRoot(dir: string): boolean {
  return (
    existsSync(join(dir, '.git')) ||
    existsSync(join(dir, 'pnpm-workspace.yaml')) ||
    declaresWorkspaces(dir)
  )
}

function declaresWorkspaces(dir: string): boolean {
  return readPackageJson(dir)?.workspaces != null
}

function declaredPackageManager(dir: string): PackageManager | null {
  const declaration = readPackageJson(dir)?.packageManager
  if (typeof declaration !== 'string') {
    return null
  }
  const name = declaration.split('@')[0]
  return PACKAGE_MANAGERS.find((manager) => manager === name) ?? null
}

function lockedPackageManager(dir: string): PackageManager | null {
  return (
    LOCKFILES.find(([lockfile]) => existsSync(join(dir, lockfile)))?.[1] ?? null
  )
}

/** Detection must survive an unreadable or malformed package.json. */
function readPackageJson(
  dir: string,
): { packageManager: unknown; workspaces: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    )
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
      return null
    }
    return {
      packageManager:
        'packageManager' in parsed ? parsed.packageManager : undefined,
      workspaces: 'workspaces' in parsed ? parsed.workspaces : undefined,
    }
  } catch {
    return null
  }
}

export function readPackageScripts(packageRoot: string): Record<string, string> {
  const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
    throw new Error(`Invalid package.json at ${packageRoot}`)
  }
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (scripts == null) {
    return {}
  }
  if (typeof scripts !== 'object' || Array.isArray(scripts)) {
    throw new Error(`Invalid scripts field in ${packageRoot}/package.json`)
  }

  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

export function resolveNpmScript(
  startDir: string,
  scriptName: string,
): { packageRoot: string; packageManager: PackageManager } {
  const packageRoot = findPackageRoot(startDir)
  if (!packageRoot) {
    throw new Error(`No package.json found from ${startDir}`)
  }

  const scripts = readPackageScripts(packageRoot)
  const script = scripts[scriptName]
  if (script == null) {
    throw new Error(`Script "${scriptName}" not found in ${packageRoot}/package.json`)
  }

  return {
    packageRoot,
    packageManager: detectPackageManager(packageRoot),
  }
}

function findUp(startDir: string, name: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, name))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}
