import type { QueueTask, TaskStatus } from './queue.js'

export type PeekedJob = {
  place: number
  id: number
  status: TaskStatus
  pid: number | null
  command: string | null
  cwd: string | null
  queue: string
}

export type QueuePeek = {
  queue: string
  running: number
  waiting: number
  jobs: PeekedJob[]
}

export function peekQueues(
  tasks: QueueTask[],
  emptyQueue?: string,
): QueuePeek[] {
  const names = [...new Set(tasks.map((task) => task.queueName))].sort()
  if (names.length === 0 && emptyQueue) {
    return [emptyPeek(emptyQueue)]
  }

  return names.map((name) => {
    const jobs = tasks
      .filter((task) => task.queueName === name)
      .slice()
      .sort((left, right) => compareJobs(left, right))
      .map((task, index) => ({
        place: index + 1,
        id: task.id,
        status: task.status,
        pid: task.pid,
        command: task.command,
        cwd: task.cwd,
        queue: task.queueName,
      }))
    return {
      queue: name,
      running: jobs.filter((job) => job.status === 'running').length,
      waiting: jobs.filter((job) => job.status === 'waiting').length,
      jobs,
    }
  })
}

function compareJobs(left: QueueTask, right: QueueTask): number {
  if (left.status === right.status) {
    return left.id - right.id
  }
  return left.status === 'running' ? -1 : 1
}

function emptyPeek(queue: string): QueuePeek {
  return { queue, running: 0, waiting: 0, jobs: [] }
}
