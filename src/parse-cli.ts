export type SharedCliFlags = {
  queue?: string
  timeoutSeconds?: number
  cwd?: string
  dataDir?: string
  all?: boolean
}

export type ParsedCli =
  | ({ kind: 'help' } & SharedCliFlags)
  | ({ kind: 'version' } & SharedCliFlags)
  | ({ kind: 'list' } & SharedCliFlags)
  | ({ kind: 'clear' } & SharedCliFlags)
  | ({ kind: 'run'; script: string; scriptArgs: string[] } & SharedCliFlags)
  | ({ kind: 'exec'; argv: string[] } & SharedCliFlags)

type Verb = 'run' | 'list' | 'clear' | 'status' | 'help'
type InternalFlags = SharedCliFlags & { help?: true; version?: true }

const FLAGS = {
  '-q': 'queue',
  '--queue': 'queue',
  '-t': 'timeout',
  '--timeout': 'timeout',
  '-C': 'cwd',
  '--cwd': 'cwd',
  '--data-dir': 'dataDir',
  '--all': 'all',
  '-h': 'help',
  '--help': 'help',
  '-v': 'version',
  '--version': 'version',
} as const

const VERBS = new Set<string>(['run', 'list', 'clear', 'status', 'help'])

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
  return parseMeta(flags) ?? parseVerb(first, afterVerb.rest, sharedFlags(flags))
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

function parseVerb(
  verb: Verb,
  rest: string[],
  flags: SharedCliFlags,
): ParsedCli {
  if (flags.all && flags.queue) {
    throw new Error('--all and --queue cannot be used together')
  }
  switch (verb) {
    case 'help':
      return { kind: 'help', ...flags }
    case 'list':
    case 'status':
      requireNoArguments(verb, rest)
      requireClearForAll(flags)
      return { kind: 'list', ...flags }
    case 'clear':
      requireNoArguments(verb, rest)
      return { kind: 'clear', ...flags }
    case 'run': {
      requireClearForAll(flags)
      const script = rest[0]
      if (!script) {
        throw new Error('Usage: easy-now run <script> [...args]')
      }
      const scriptArgs = rest.slice(1)
      return {
        kind: 'run',
        script,
        scriptArgs: scriptArgs[0] === '--' ? scriptArgs.slice(1) : scriptArgs,
        ...flags,
      }
    }
    default: {
      const exhaustive: never = verb
      throw new Error(`Unknown command ${exhaustive}`)
    }
  }
}

function parseExec(argv: string[], flags: InternalFlags): ParsedCli {
  requireClearForAll(flags)
  return (
    parseMeta(flags) ??
    (argv.length === 0
      ? { kind: 'help', ...sharedFlags(flags) }
      : { kind: 'exec', argv, ...sharedFlags(flags) })
  )
}

function parseMeta(flags: InternalFlags): ParsedCli | null {
  const shared = sharedFlags(flags)
  return flags.help
    ? { kind: 'help', ...shared }
    : flags.version
      ? { kind: 'version', ...shared }
      : null
}

function sharedFlags({
  help: _help,
  version: _version,
  ...shared
}: InternalFlags): SharedCliFlags {
  return shared
}

function isVerb(value: string): value is Verb {
  return VERBS.has(value)
}

function requireNoArguments(verb: Verb, rest: string[]): void {
  if (rest.length > 0) {
    throw new Error(`${verb} does not accept arguments`)
  }
}

function requireClearForAll({ all }: SharedCliFlags): void {
  if (all) {
    throw new Error('--all can only be used with clear')
  }
}

function parseTimeout(raw: string): number {
  const timeoutSeconds = Number(raw)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error(`Invalid --timeout value "${raw}". Use a whole number of seconds.`)
  }
  return timeoutSeconds
}
