import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

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

export function detectPackageManager(packageRoot: string): PackageManager {
  if (existsSync(join(packageRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (
    existsSync(join(packageRoot, 'bun.lock')) ||
    existsSync(join(packageRoot, 'bun.lockb'))
  ) {
    return 'bun'
  }
  if (existsSync(join(packageRoot, 'yarn.lock'))) {
    return 'yarn'
  }
  return 'npm'
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
