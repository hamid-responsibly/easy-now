/** Which queue a command talks to. */
export type QueueTarget = {
  queue?: string
  cwd?: string
  dataDir?: string
}

/** A command that takes a slot in the queue and may be killed on a timeout. */
export type CommandOptions = QueueTarget & {
  timeoutSeconds?: number
}

/** One queue, or every queue on the machine. */
export type InspectScope = QueueTarget & {
  all?: boolean
}

export type ParsedCli =
  | { kind: 'help' }
  | { kind: 'version' }
  | ({ kind: 'list'; json?: boolean } & InspectScope)
  | ({ kind: 'clear' } & InspectScope)
  | ({ kind: 'run'; script: string; scriptArgs: string[] } & CommandOptions)
  | ({ kind: 'exec'; argv: string[] } & CommandOptions)

type Verb = 'run' | 'list' | 'clear' | 'status' | 'peek' | 'help'
type InternalFlags = CommandOptions &
  InspectScope & { json?: boolean; help?: true; version?: true }

const FLAGS = {
  '-q': 'queue',
  '--queue': 'queue',
  '-t': 'timeout',
  '--timeout': 'timeout',
  '-C': 'cwd',
  '--cwd': 'cwd',
  '--data-dir': 'dataDir',
  '--all': 'all',
  '--json': 'json',
  '-h': 'help',
  '--help': 'help',
  '-v': 'version',
  '--version': 'version',
} as const

const VERBS = new Set<string>(['run', 'list', 'clear', 'status', 'peek', 'help'])

export function parseCli(argv: string[]): ParsedCli {
  const leading = consumeLeadingFlags(argv)
  if (leading.sawDoubleDash) {
    return parseExec(leading.rest, leading.flags)
  }

  const [first, ...tail] = leading.rest
  if (!first || !isVerb(first)) {
    return parseExec(leading.rest, leading.flags)
  }

  const afterVerb = consumeLeadingFlags(tail)
  const flags = { ...leading.flags, ...afterVerb.flags }
  return parseMeta(flags) ?? parseVerb(first, afterVerb.rest, flags)
}

function consumeLeadingFlags(argv: string[]): {
  flags: InternalFlags
  rest: string[]
  sawDoubleDash: boolean
} {
  let index = 0
  let flags: InternalFlags = {}
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--') {
      return { flags, rest: argv.slice(index + 1), sawDoubleDash: true }
    }
    if (!arg?.startsWith('-')) {
      break
    }

    const equalsIndex = arg.indexOf('=')
    const name = equalsIndex < 0 ? arg : arg.slice(0, equalsIndex)
    const inlineValue = equalsIndex < 0 ? undefined : arg.slice(equalsIndex + 1)
    const flag = FLAGS[name as keyof typeof FLAGS]
    if (!flag) {
      throw new Error(`Unknown option ${name}`)
    }

    const takesValue =
      flag === 'queue' ||
      flag === 'timeout' ||
      flag === 'cwd' ||
      flag === 'dataDir'
    if (!takesValue && inlineValue != null) {
      throw new Error(`${name} does not accept a value`)
    }
    const nextValue = inlineValue ?? argv[index + 1]
    if (
      takesValue &&
      (nextValue == null || (inlineValue == null && nextValue.startsWith('-')))
    ) {
      throw new Error(`Missing value for ${name}`)
    }
    index += takesValue && inlineValue == null ? 1 : 0

    switch (flag) {
      case 'help':
        flags = { ...flags, help: true }
        break
      case 'version':
        flags = { ...flags, version: true }
        break
      case 'all':
        flags = { ...flags, all: true }
        break
      case 'json':
        flags = { ...flags, json: true }
        break
      case 'queue':
        flags = { ...flags, queue: nextValue }
        break
      case 'cwd':
        flags = { ...flags, cwd: nextValue }
        break
      case 'dataDir':
        flags = { ...flags, dataDir: nextValue }
        break
      case 'timeout':
        flags = { ...flags, timeoutSeconds: parseTimeout(nextValue ?? '') }
        break
      default: {
        const exhaustive: never = flag
        throw new Error(`Unknown option ${exhaustive}`)
      }
    }
    index += 1
  }
  return { flags, rest: argv.slice(index), sawDoubleDash: false }
}

function parseVerb(verb: Verb, rest: string[], flags: InternalFlags): ParsedCli {
  switch (verb) {
    case 'help':
      return { kind: 'help' }
    case 'list':
    case 'status':
    case 'peek':
      requireNoArguments(verb, rest)
      return flags.json
        ? { kind: 'list', json: true, ...inspectScope(flags) }
        : { kind: 'list', ...inspectScope(flags) }
    case 'clear':
      requireNoArguments(verb, rest)
      rejectJson(flags)
      return { kind: 'clear', ...inspectScope(flags) }
    case 'run': {
      const options = commandOptions(flags)
      const script = rest[0]
      if (!script) {
        throw new Error('Usage: easy-now run <script> [...args]')
      }
      const scriptArgs = rest.slice(1)
      return {
        kind: 'run',
        script,
        scriptArgs: scriptArgs[0] === '--' ? scriptArgs.slice(1) : scriptArgs,
        ...options,
      }
    }
    default: {
      const exhaustive: never = verb
      throw new Error(`Unknown command ${exhaustive}`)
    }
  }
}

/** Help and version win over every option check, whatever the argument order. */
function parseExec(argv: string[], flags: InternalFlags): ParsedCli {
  const meta = parseMeta(flags)
  if (meta) {
    return meta
  }
  const options = commandOptions(flags)
  return argv.length === 0
    ? { kind: 'help' }
    : { kind: 'exec', argv, ...options }
}

function parseMeta(flags: InternalFlags): ParsedCli | null {
  return flags.help
    ? { kind: 'help' }
    : flags.version
      ? { kind: 'version' }
      : null
}

function inspectScope({
  json: _json,
  help: _help,
  version: _version,
  timeoutSeconds,
  ...scope
}: InternalFlags): InspectScope {
  if (timeoutSeconds != null) {
    throw new Error('--timeout can only be used with run or a command')
  }
  if (scope.all && scope.queue) {
    throw new Error('--all and --queue cannot be used together')
  }
  return scope
}

function commandOptions(flags: InternalFlags): CommandOptions {
  rejectJson(flags)
  if (flags.all) {
    throw new Error('--all can only be used with list or clear')
  }
  const {
    all: _all,
    json: _json,
    help: _help,
    version: _version,
    ...options
  } = flags
  return options
}

function isVerb(value: string): value is Verb {
  return VERBS.has(value)
}

function requireNoArguments(verb: Verb, rest: string[]): void {
  if (rest.length > 0) {
    throw new Error(`${verb} does not accept arguments`)
  }
}

function rejectJson({ json }: InternalFlags): void {
  if (json) {
    throw new Error('--json can only be used with list')
  }
}

function parseTimeout(raw: string): number {
  const timeoutSeconds = Number(raw)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error(`Invalid --timeout value "${raw}". Use a whole number of seconds.`)
  }
  return timeoutSeconds
}
