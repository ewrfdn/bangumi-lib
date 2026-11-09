import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { TaskService } from '../service/task.service.ts'

interface QueryRoute {
  Querystring: Record<string, unknown>
}
interface IdRoute {
  Params: { id: string }
}
interface BodyRoute {
  Body: unknown
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface TaskControllerDependencies {
  readonly taskService: TaskService
}

export function registerTaskController(app: FastifyInstance, { taskService }: TaskControllerDependencies): void {
  app.get<QueryRoute>('/api/tasks', async (request: FastifyRequest<QueryRoute>): Promise<unknown> => taskService.list(request.query))
  app.get<IdRoute>('/api/tasks/:id', async (request: FastifyRequest<IdRoute>): Promise<unknown> => ({ item: taskService.get(request.params.id) }))
  app.post<BodyRoute>('/api/tasks', async (request: FastifyRequest<BodyRoute>, reply: FastifyReply): Promise<FastifyReply> =>
    reply.code(201).send({ item: taskService.create(request.body) }))
  app.post<IdRoute>('/api/tasks/:id/cancel', async (request: FastifyRequest<IdRoute>): Promise<unknown> => ({ item: taskService.cancel(request.params.id) }))
  app.delete<IdRoute>('/api/tasks/:id', async (request: FastifyRequest<IdRoute>): Promise<unknown> => taskService.remove(request.params.id))
}
