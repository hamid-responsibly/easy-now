import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCli, type ParsedCli } from './parse-cli.js'
import { resolveDataDir } from './paths.js'
import { resolveNpmScript } from './project.js'
import { defaultQueueName } from './queue-name.js'
import {
  peekQueues,
  type PeekedJob,
  type QueuePeek,
} from './queue-peek.js'
import { QueueClearedError, withQueue } from './queue.js'
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
      printList(parsed)
      return 0
    case 'clear': {
      const cwd = resolve(parsed.cwd ?? process.cwd())
      const queueName = parsed.all
        ? undefined
        : parsed.queue ?? defaultQueueName(cwd)
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

function printList(parsed: Extract<ParsedCli, { kind: 'list' }>): void {
  const cwd = resolve(parsed.cwd ?? process.cwd())
  const scopedName = parsed.all
    ? undefined
    : parsed.queue ?? defaultQueueName(cwd)
  const tasks = withQueue(resolveDataDir(parsed.dataDir), (queue) => {
    const names = scopedName
      ? [scopedName]
      : [...new Set(queue.list().map((task) => task.queueName))]
    for (const name of names) {
      queue.cleanup(name)
    }
    return queue.list(scopedName)
  })
  const peeks = peekQueues(tasks, scopedName)
  if (parsed.json) {
    console.log(JSON.stringify({ queues: peeks }, null, 2))
    return
  }
  console.log(formatPeekText(peeks))
}

function formatPeekText(peeks: QueuePeek[]): string {
  if (peeks.length === 0) {
    return 'No queues.'
  }
  if (peeks.length === 1 && peeks[0]) {
    return formatQueuePeek(peeks[0])
  }
  const running = peeks.reduce((sum, peek) => sum + peek.running, 0)
  const waiting = peeks.reduce((sum, peek) => sum + peek.waiting, 0)
  const headline = `${peeks.length} queues: ${running} running, ${waiting} waiting`
  return [headline, '', peeks.map(formatQueuePeek).join('\n\n')].join('\n')
}

function formatQueuePeek(peek: QueuePeek): string {
  const summary = `${peek.queue}: ${peek.running} running, ${peek.waiting} waiting`
  if (peek.jobs.length === 0) {
    return summary
  }
  const rows = peek.jobs.map(formatJob)
  const headers = ['PLACE', 'STATUS', 'PID', 'COMMAND'] as const
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
  return [summary, formatRow(headerRow), ...rows.map(formatRow)].join('\n')
}

function formatJob(
  job: PeekedJob,
): Record<'PLACE' | 'STATUS' | 'PID' | 'COMMAND', string> {
  return {
    PLACE: String(job.place),
    STATUS: job.status,
    PID: job.pid == null ? '-' : String(job.pid),
    COMMAND: job.command ?? '-',
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
  easy-now [options] list [--json] [--all]
  easy-now [options] peek [--json] [--all]
  easy-now [options] clear [--all]
  easy-now --help

Options:
  -q, --queue <name>     Queue name (default: git remote, else this checkout)
  -t, --timeout <sec>    Kill the command after this many seconds
  -C, --cwd <dir>        Working directory
      --data-dir <dir>   SQLite directory (default: ~/.easy-now)
      --all              Every queue (list or clear)
      --json             Machine-readable list output
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
