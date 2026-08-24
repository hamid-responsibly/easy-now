# easy-now

Cross-process queue for npm scripts. If two terminals, agents, or tools start the same expensive script at once, the second waits its turn instead of fighting for CPU, memory, and disk.

This is not an in-process library like `p-queue`. Each `easy-now` process talks to a SQLite file, so the queue works across processes.

## Install

```bash
pnpm add -D easy-now
```

Node.js 22.16 or newer. Uses the built-in `node:sqlite` module.

## Platform support

easy-now supports macOS and Linux. It starts each command in a separate process group so it can stop the whole group on a timeout or interrupt. Windows uses different process-group rules and is not supported.

## Use it

Wrap the scripts that hurt when they overlap:

```json
{
  "scripts": {
    "build": "easy-now -- next build",
    "test": "easy-now -- vitest run"
  }
}
```

Or leave `package.json` alone and queue a script from the terminal:

```bash
easy-now run build
easy-now run test -- --watch
```

Pick one of those paths for a given script. If a script is already wrapped and you also run `easy-now run <script>`, the inner `easy-now` sees that an ancestor already holds the same queue and data dir, and runs the command without taking a second slot. Without that, the outer process holds the only slot and the inner one waits forever.

Any command works:

```bash
easy-now -- pnpm lint
easy-now -q docker -- docker build .
```

Put easy-now flags before the verb or command:

```bash
easy-now -t 30 run test -- -t 5
easy-now -q build -- next build
```

For `run`, `list`, `clear`, and `help`, flags can also go directly after the verb, before its first argument. Once a script or command starts, later flags belong to it. Everything after `--` is always literal command input. Use `--` when a command is named `run`, `list`, `peek`, `clear`, `status`, or `help` so easy-now does not read it as a verb.

## Queues

By default the queue name is the **git remote** (`origin`, else the first remote), normalized so `git@` and `https://` clones of the same repo share a line. Worktrees and extra clones of that remote wait on each other.

If the checkout has no remotes, the shared git directory is used, so worktrees of a local-only repo still share. If there is no git repo, the nearest `package.json` directory is used.

A clone of a fork does not share a queue with a clone of upstream: their `origin` URLs differ. Use `-q` to join or split queues by hand.

Use `--queue` when you want a different split:

```bash
easy-now -q build -- pnpm build    # capacity 1
easy-now -q test -- pnpm test      # can run while build runs
easy-now -q global -- pnpm build   # one machine-wide line
```

Each named queue runs **one command at a time**. That is the whole policy in v1.

## Inspect

```bash
easy-now list
easy-now peek --json
easy-now list --all
easy-now clear
easy-now clear -q build
easy-now clear --all
```

`list`, `peek`, and `status` are the same command. They show the current project queue: how many jobs are running and waiting, and each job's place in line. `--json` prints that as a stable object for agents. `--all` shows every queue on the machine.

`clear` only clears the current project queue unless `--queue` names another queue. `clear --all` clears every queue.

A waiter writes `easy-now: place N of M in <queue>` to stderr whenever its place changes, including when stderr is not a TTY, so agent logs can see progress.

State lives in `~/.easy-now/queue.db` (override with `--data-dir` or `EASY_NOW_DATA_DIR`). easy-now creates the directory with mode `0700` and rejects directories owned by another user or writable by a group or other users. The file is not compatible with [Block's agent-task-queue](https://github.com/block/agent-task-queue). Mixing the two on one database would be a good way to lose tasks.

If a process dies while it holds the queue, the next waiter notices the dead pid, kills any leftover child, and continues.

Queue waiting has no timeout. `--timeout` starts after the command gets its turn and only limits the command.

Commands run in detached process groups so easy-now can stop their descendants. This changes terminal behavior. The terminal sends interrupts and resize events to easy-now, which forwards interrupts but cannot forward every terminal event. Interactive full-screen tools can behave differently when wrapped.

## Programmatic API

```ts
import { runQueued } from 'easy-now'

const { exitCode } = await runQueued({
  command: 'pnpm',
  argv: ['test'],
  cwd: process.cwd(),
  queueName: 'tests', // Optional. Defaults to the git remote, else this checkout.
})
```

The package exports `runQueued` and its option, result, and queue-task types. The SQLite queue and CLI parser are internal.

## Why a CLI, not MCP

easy-now is for JS/TS projects that already run npm scripts. Agents that call those scripts through the shell will still hit the agent's own command timeout if they wait in the queue too long. If that becomes the real problem, an MCP server can sit on the same queue later. It is not in v1.

## License

MIT. The problem — serialize heavy local work so agents and humans do not thrash the machine — is the same one Block's agent-task-queue solves. This package is original Node code for npm scripts, not a port of that repository.
