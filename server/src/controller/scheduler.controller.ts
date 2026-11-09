import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { createSchedulerManager } from '../scheduler/manager.ts'
import { HttpError } from '../errors.ts'

interface TypeRoute {
  Params: { type: string }
}

/** `runNow` returns a union; this is the subset the controller reads. */
interface RunNowOutcome {
  readonly skipped?: boolean
  readonly taskId?: number
}

/** `reload` returns a union (`{ skipped: true }` before the manager started); these are the fields read here. */
interface ReloadOutcome {
  readonly ok?: boolean
  readonly error?: string
  readonly skipped?: boolean
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface SchedulerControllerDependencies {
  readonly scheduler: ReturnType<typeof createSchedulerManager>
}

export function registerSchedulerController(app: FastifyInstance, { scheduler }: SchedulerControllerDependencies): void {
  app.get('/api/scheduler/tasks', async (): Promise<unknown> => ({
    timezone: scheduler.timezone,
    configPath: scheduler.configPath,
    tasks: scheduler.list(),
  }))

  app.post<TypeRoute>('/api/scheduler/tasks/:type/run', async (request: FastifyRequest<TypeRoute>, reply: FastifyReply): Promise<unknown> => {
    const { type } = request.params
    if (!scheduler.list().some((task) => task.type === type)) throw new HttpError(404, '定时任务不存在')
    // Bodies are dynamic JSON; the endpoint only needs to know whether any field was supplied.
    if (request.body && Object.keys(request.body as object).length) throw new HttpError(400, '该接口不接受参数')
    const result: RunNowOutcome = await scheduler.runNow(type, { wait: false })
    if (result?.skipped) throw new HttpError(409, '任务正在运行', 'TASK_RUNNING')
    return reply.code(202).send({ type, taskId: result.taskId })
  })

  app.post('/api/scheduler/reload', async (_request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const result: ReloadOutcome = await scheduler.reload()
    if (!result.ok) return reply.code(422).send(result)
    return result
  })
}
