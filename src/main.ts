import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCli, type ParsedCli } from './parse-cli.js'
import { resolveDataDir } from './paths.js'
import {
  findProjectRoot,
  resolveNpmScript,
} from './project.js'
import {
  QueueClearedError,
  withQueue,
  type QueueTask,
} from './queue.js'
import { runQueued } from './run-queued.js'

export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(parseCli(argv))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    return error instanceof QueueClearedError ? error.exitCode : 1
  }
}

async function dispatch(parsed: ParsedCli): Promise<number> {
  switch (parsed.kind) {
    case 'help':
      printHelp()
      return 0
    case 'version':
      console.log(readVersion())
      return 0
    case 'list':
      printList(parsed.dataDir, parsed.queue)
      return 0
    case 'clear': {
      const cwd = resolve(parsed.cwd ?? process.cwd())
      const queueName = parsed.all
        ? undefined
        : parsed.queue ?? findProjectRoot(cwd)
      const removed = withQueue(resolveDataDir(parsed.dataDir), (queue) =>
        queue.clear(queueName),
      )
      console.log(
        parsed.all
          ? `Cleared ${removed} task(s) in all queues.`
          : `Cleared ${removed} task(s) in ${queueName}.`,
      )
      return 0
    }
    case 'run':
      return runNpmScript(parsed)
    case 'exec':
      return runExec(parsed)
    default: {
      const exhaustive: never = parsed
      return exhaustive
    }
  }
}

async function runNpmScript(parsed: Extract<ParsedCli, { kind: 'run' }>): Promise<number> {
  const cwd = resolve(parsed.cwd ?? process.cwd())
  const { packageRoot, packageManager } = resolveNpmScript(cwd, parsed.script)
  const argv =
    parsed.scriptArgs.length > 0
      ? ['run', parsed.script, '--', ...parsed.scriptArgs]
      : ['run', parsed.script]

  const result = await runQueued({
    command: packageManager,
    argv,
    cwd: packageRoot,
    queueName: parsed.queue,
    dataDir: parsed.dataDir,
    timeoutSeconds: parsed.timeoutSeconds,
  })
  return result.exitCode
}

async function runExec(parsed: Extract<ParsedCli, { kind: 'exec' }>): Promise<number> {
  const cwd = resolve(parsed.cwd ?? process.cwd())
  const [command, ...argv] = parsed.argv
  if (!command) {
    printHelp()
    return 1
  }

  const result = await runQueued({
    command,
    argv,
    cwd,
    queueName: parsed.queue,
    dataDir: parsed.dataDir,
    timeoutSeconds: parsed.timeoutSeconds,
  })
  return result.exitCode
}

function printList(dataDir: string | undefined, queueName: string | undefined): void {
  const tasks = withQueue(resolveDataDir(dataDir), (queue) => queue.list(queueName))
  if (tasks.length === 0) {
    console.log('Queue is empty.')
    return
  }

  const rows = tasks.map((task) => formatTask(task))
  const headers = ['ID', 'STATUS', 'QUEUE', 'PID', 'COMMAND'] as const
  const widths = headers.map((header) =>
    Math.max(header.length, ...rows.map((row) => row[header].length)),
  )

  const formatRow = (
    row: Record<(typeof headers)[number], string>,
  ): string =>
    headers
      .map((header, index) => row[header].padEnd(widths[index] as number))
      .join('  ')
  const headerRow = Object.fromEntries(
    headers.map((header) => [header, header]),
  ) as Record<(typeof headers)[number], string>
  console.log([formatRow(headerRow), ...rows.map(formatRow)].join('\n'))
}

function formatTask(task: QueueTask): Record<'ID' | 'STATUS' | 'QUEUE' | 'PID' | 'COMMAND', string> {
  return {
    ID: String(task.id),
    STATUS: task.status,
    QUEUE: task.queueName,
    PID: task.pid == null ? '-' : String(task.pid),
    COMMAND: task.command ?? '-',
  }
}

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgPath = join(here, '..', 'package.json')
  const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (
    typeof parsed === 'object' &&
    parsed != null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version
  }
  throw new Error(`Missing version in ${pkgPath}`)
}

function printHelp(): void {
  console.log(`easy-now — cross-process queue for npm scripts

Usage:
  easy-now [options] -- <command> [...args]
  easy-now [options] <command> [...args]
  easy-now [options] run <script> [-- ...args]
  easy-now [options] list
  easy-now [options] clear [--all]
  easy-now --help

Options:
  -q, --queue <name>     Queue name (default: git root, else package root)
  -t, --timeout <sec>    Kill the command after this many seconds
  -C, --cwd <dir>        Working directory
      --data-dir <dir>   SQLite directory (default: ~/.easy-now)
      --all              Clear every queue
  -h, --help             Show this help
  -v, --version          Show version

Put it on expensive scripts:

  {
    "scripts": {
      "build": "easy-now -- next build",
      "test": "easy-now -- vitest run"
    }
  }

Or call a script through the queue without changing package.json:

  easy-now run build

easy-now flags must come before a command argument. Use -- before literal
command flags:

  easy-now -t 30 run test -- -t 5
`)
}
