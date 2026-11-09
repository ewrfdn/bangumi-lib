import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../types.ts'
import type { createScanService } from '../service/scan.service.ts'
import type { createTaskRunner } from '../service/task-runner.service.ts'
import { HttpError } from '../errors.ts'

const SCAN_TIMEOUT = 15 * 60 * 1000

interface ScanRoute {
  Params: { libraryId: string }
  Body: unknown
}

/** `taskRunner.start` returns a discriminated union; this is the subset the controller reads. */
interface TaskStartOutcome {
  readonly skipped?: boolean
  readonly taskId?: number
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface ScanControllerDependencies {
  readonly scanService: ReturnType<typeof createScanService>
  readonly taskRunner: ReturnType<typeof createTaskRunner>
  readonly settings: AppConfig
}

/** 手动触发一次媒体库扫描；实际执行走 taskRunner，接口立即返回任务 ID。 */
export function registerScanController(app: FastifyInstance, { scanService, taskRunner, settings }: ScanControllerDependencies): void {
  app.post<ScanRoute>('/api/libraries/:libraryId/scan', async (request: FastifyRequest<ScanRoute>, reply: FastifyReply): Promise<unknown> => {
    const library = settings.getLibrary(request.params.libraryId)
    const raw = request.body ?? {}
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, '请求正文必须为对象')
    const body = raw as Record<string, unknown>
    for (const key of Object.keys(body)) if (key !== 'maxDepth') throw new HttpError(400, `不支持字段：${key}`)
    const requestedDepth = body.maxDepth ?? 4
    if (typeof requestedDepth !== 'number' || !Number.isInteger(requestedDepth) || requestedDepth < 0 || requestedDepth > 10) {
      throw new HttpError(400, 'maxDepth 必须是 0 到 10 的整数')
    }
    const maxDepth = requestedDepth

    const started: TaskStartOutcome = taskRunner.start({
      key: `scan:${library.id}`,
      type: 'scan_library',
      payload: { libraryId: library.id, maxDepth },
      timeoutMs: SCAN_TIMEOUT,
    }, ({ signal }: { signal: AbortSignal }) => {
      // Passed as a variable so the loosely-typed service options keep accepting `signal`.
      const scanOptions = { maxDepth, signal }
      return scanService.scanLibrary(library.id, scanOptions)
    })

    if (started.skipped) throw new HttpError(409, '该媒体库正在扫描', 'SCAN_RUNNING')
    return reply.code(202).send({ taskId: started.taskId, libraryId: library.id, maxDepth })
  })
}
