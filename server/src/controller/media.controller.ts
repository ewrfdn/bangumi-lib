import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MediaService } from '../service/media.service.ts'
import { stringValue } from './http.ts'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.flv': 'video/x-flv', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif', '.flac': 'audio/flac', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
}
const CACHEABLE: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.flac', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav'])

interface QueryRoute {
  Querystring: Record<string, unknown>
}

/** A resolved single-range request. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface MediaControllerDependencies {
  readonly mediaService: MediaService
}

/** Parse a single HTTP byte range; transport concerns stay out of domain services. */
export function parseByteRange(header: string | undefined, size: number): ByteRange | null | false {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return false
  const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1])
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false
  return { start, end }
}

export function registerMediaController(app: FastifyInstance, { mediaService }: MediaControllerDependencies): void {
  app.get<QueryRoute>('/api/video', (request: FastifyRequest<QueryRoute>) =>
    mediaService.video(stringValue(request.query.path), stringValue(request.query.library)))
  const serveFile = (request: FastifyRequest<QueryRoute>, reply: FastifyReply): FastifyReply => {
    const file = mediaService.file(stringValue(request.query.path), stringValue(request.query.library))
    const range = parseByteRange(request.headers.range, file.size)
    if (range === false) return reply.code(416).header('Content-Range', `bytes */${file.size}`).send()
    reply.header('Accept-Ranges', 'bytes').type(MIME[file.ext] || 'application/octet-stream')
      .header('Last-Modified', file.mtime.toUTCString())
      .header('Cache-Control', CACHEABLE.has(file.ext) ? 'public, max-age=86400' : 'no-cache')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    if (range) {
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
        .header('Content-Length', String(range.end - range.start + 1))
    } else reply.header('Content-Length', String(file.size))
    if (request.method === 'HEAD') return reply.send()
    return reply.send(file.open(range || undefined))
  }
  // Explicit HEAD routes preserve the selected byte length without opening the file.
  app.get<QueryRoute>('/api/stream', { exposeHeadRoute: false }, serveFile)
  app.head<QueryRoute>('/api/stream', serveFile)
  app.get<QueryRoute>('/api/file', { exposeHeadRoute: false }, serveFile)
  app.head<QueryRoute>('/api/file', serveFile)
  app.get<QueryRoute>('/api/subtitle', async (request: FastifyRequest<QueryRoute>, reply: FastifyReply): Promise<FastifyReply> => {
    const text = await mediaService.externalSubtitle(stringValue(request.query.path), stringValue(request.query.library))
    return reply.header('Cache-Control', 'public, max-age=3600').type('text/vtt; charset=utf-8').send(text)
  })
  app.get<QueryRoute>('/api/stream-subtitle', async (request: FastifyRequest<QueryRoute>, reply: FastifyReply): Promise<FastifyReply> => {
    const text = await mediaService.embeddedSubtitle(
      stringValue(request.query.path), Number(stringValue(request.query.index)), stringValue(request.query.library),
    )
    return reply.header('Cache-Control', 'public, max-age=3600').type('text/vtt; charset=utf-8').send(text)
  })
}
