import { config } from '../config.ts'
import { HttpError } from '../errors.ts'
import { resolveVirtual, assertFile, cachedSegmentResource } from '../model/media.model.ts'
import { probe } from './ffmpeg.service.ts'
import { getOrCreateSession, sessionById, stopAllSessions } from './hls.service.ts'
import type { ReadStream } from 'node:fs'
import type { AppConfig } from '../types.ts'

/** hls.service.ts 尚未迁移：这里只描述播放服务实际用到的会话成员。 */
interface HlsSessionView {
  readonly id: string
  readonly startTime: number
  encoder?: string
  readonly targetDuration: number
  readonly error: string | null
  playlist(): string | null
  info(): HlsSessionInfo
  segmentFile(name: string): string | null
  stop(): void
}

/** 会话进度：分片覆盖的源文件时间轴区间（秒）。 */
export interface HlsSessionInfo {
  id: string
  start: number
  firstStart: number
  frontier: number
  ended: boolean
  error: string | null
  encoder?: string
}

export interface PlaybackStartResult {
  m3u8: string
  id: string
  libraryId: string
  start: number
  encoder?: string
  segmentSeconds: number
}

/** 分片资源：只暴露大小与只读流，传输层决定响应头。 */
export interface SegmentResource {
  size: number
  open(): ReadStream
}

export interface PlaybackService {
  start(virtualPath: string, time: unknown, libraryId?: string): Promise<PlaybackStartResult>
  playlist(id: string): Promise<string>
  info(id: string): HlsSessionInfo
  segment(id: string, name: string): Promise<SegmentResource>
  stop(id: string): { ok: boolean }
  stopAll(): void
}

export function createPlaybackService(settings: AppConfig = config): PlaybackService {
  return {
    async start(virtualPath: string, time: unknown, libraryId?: string): Promise<PlaybackStartResult> {
      const library = settings.getLibrary(libraryId || settings.defaultLibraryId)
      const absolutePath = resolveVirtual(virtualPath, library.id)
      await assertFile(absolutePath)
      const start = Math.max(0, Number(time) || 0)
      const session: HlsSessionView = await getOrCreateSession(absolutePath, start, await probe(absolutePath))
      return {
        m3u8: `/api/hls/${session.id}/index.m3u8`, id: session.id, libraryId: library.id,
        start: session.startTime, encoder: session.encoder, segmentSeconds: session.targetDuration,
      }
    },
    async playlist(id: string): Promise<string> {
      const session: HlsSessionView | undefined = sessionById(id)
      if (!session) throw new HttpError(404, '# session expired')
      const started = Date.now()
      let text: string | null = null
      while (Date.now() - started < 45_000) {
        text = session.playlist()
        if (text || session.error) break
        await new Promise<void>((resolve) => setTimeout(resolve, 120))
      }
      if (!text) throw new HttpError(503, `# transcode not ready${session.error ? ': ' + session.error : ''}`)
      return text
    },
    info(id: string): HlsSessionInfo {
      const session: HlsSessionView | undefined = sessionById(id)
      if (!session) throw new HttpError(404, '会话不存在或已过期')
      return session.info()
    },
    async segment(id: string, name: string): Promise<SegmentResource> {
      const absolutePath: string | null | undefined = sessionById(id)?.segmentFile(name)
      if (!absolutePath) throw new HttpError(404, '分片不存在')
      const resource: SegmentResource | null = await cachedSegmentResource(absolutePath)
      if (!resource) throw new HttpError(404, '分片不存在')
      return resource
    },
    stop(id: string): { ok: boolean } { sessionById(id)?.stop(); return { ok: true } },
    stopAll: stopAllSessions,
  }
}
