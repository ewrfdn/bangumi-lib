import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MediaTracksService } from '../service/media-tracks.service.ts'

interface QueryRoute {
  Querystring: Record<string, unknown>
}
interface TrackRoute {
  Params: { mediaId: string; videoIndex: string }
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface MediaTracksControllerDependencies {
  readonly mediaTracksService: MediaTracksService
}

export function registerMediaTracksController(app: FastifyInstance, { mediaTracksService }: MediaTracksControllerDependencies): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (new URL(request.url, 'http://localhost').pathname.startsWith('/api/media-tracks')) reply.header('Cache-Control', 'no-store')
    return payload
  })
  app.get<QueryRoute>('/api/media-tracks', async (request: FastifyRequest<QueryRoute>): Promise<unknown> => mediaTracksService.list(request.query))
  const route = '/api/media-tracks/:mediaId/:videoIndex'
  app.get<TrackRoute>(route, async (request: FastifyRequest<TrackRoute>): Promise<unknown> => ({
    item: mediaTracksService.get(request.params.mediaId, request.params.videoIndex),
  }))
  app.put<TrackRoute>(route, async (request: FastifyRequest<TrackRoute>): Promise<unknown> => ({
    item: mediaTracksService.save(request.params.mediaId, request.params.videoIndex, request.body),
  }))
  app.delete<TrackRoute>(route, async (request: FastifyRequest<TrackRoute>): Promise<unknown> =>
    mediaTracksService.remove(request.params.mediaId, request.params.videoIndex))
}
