import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PlaybackService } from '../service/playback.service.ts'
import { stringValue } from './http.ts'

interface QueryRoute {
  Querystring: Record<string, unknown>
}
interface SessionRoute {
  Params: { id: string }
}
interface SegmentRoute {
  Params: { id: string; name: string }
}

/** Service errors are plain Error objects carrying HTTP fields; read them structurally. */
interface HttpFailure {
  status?: number
  message?: string
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface PlaybackControllerDependencies {
  readonly playbackService: PlaybackService
}

export function registerPlaybackController(app: FastifyInstance, { playbackService }: PlaybackControllerDependencies): void {
  app.get<QueryRoute>('/api/hls/start', async (request: FastifyRequest<QueryRoute>, reply: FastifyReply): Promise<unknown> => {
    reply.header('Cache-Control', 'no-store')
    return playbackService.start(stringValue(request.query.path), stringValue(request.query.t), stringValue(request.query.library))
  })
  app.get<SessionRoute>('/api/hls/:id/index.m3u8', async (request: FastifyRequest<SessionRoute>, reply: FastifyReply): Promise<FastifyReply> => {
    try {
      const playlist = await playbackService.playlist(stringValue(request.params.id))
      return reply.header('Cache-Control', 'no-store').type('application/vnd.apple.mpegurl').send(playlist)
    } catch (error) {
      const failure = error as HttpFailure
      const status = failure.status
      if (status === 404 || status === 503) return reply.code(status).send(failure.message)
      throw error
    }
  })
  app.get<SessionRoute>('/api/hls/:id/info', (request: FastifyRequest<SessionRoute>, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store')
    return playbackService.info(stringValue(request.params.id))
  })
  app.get<SegmentRoute>('/api/hls/:id/seg/:name', async (request: FastifyRequest<SegmentRoute>, reply: FastifyReply): Promise<FastifyReply> => {
    const resource = await playbackService.segment(stringValue(request.params.id), stringValue(request.params.name))
    return reply.type('video/mp2t').header('Content-Length', String(resource.size))
      .header('Cache-Control', 'public, max-age=600').send(resource.open())
  })
  app.delete<SessionRoute>('/api/hls/:id', (request: FastifyRequest<SessionRoute>) => playbackService.stop(stringValue(request.params.id)))
}
