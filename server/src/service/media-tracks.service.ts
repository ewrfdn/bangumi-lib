import { HttpError } from '../errors.ts'
import { bodyFields, boolean, id, invalid, mustExist, number, page, videoIndex, write } from './catalog-validation.ts'
import type { QueryParams } from './catalog-validation.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { ListResult, MediaTrack } from '../types.ts'

/** Composite key of one playback track; also usable as a model filter. */
type TrackKey = { mediaId: number; videoIndex: number }

export interface MediaTracksService {
  list(query?: QueryParams): ListResult<MediaTrack>
  get(mediaId: unknown, index: unknown): MediaTrack
  save(mediaId: unknown, index: unknown, body: unknown): MediaTrack | null
  remove(mediaId: unknown, index: unknown): { ok: true }
}

export function createMediaTracksService(models: CatalogModels): MediaTracksService {
  const keyFor = (mediaId: unknown, index: unknown): TrackKey => ({ mediaId: id(mediaId), videoIndex: videoIndex(index) })
  return {
    list(query?: QueryParams): ListResult<MediaTrack> { return models.tracks.list(page(query, { mediaId: id })) },
    get(mediaId: unknown, index: unknown): MediaTrack { return mustExist(models.tracks, keyFor(mediaId, index), '观看记录') },
    save(mediaId: unknown, index: unknown, body: unknown): MediaTrack | null {
      const key = keyFor(mediaId, index)
      mustExist(models.media, { id: key.mediaId }, '影视')
      if (!models.videos.list({ limit: 1, offset: 0, filters: key }).total) throw new HttpError(404, '影视下没有对应集号的视频')
      const current = models.tracks.find(key)
      const value = bodyFields(body, {
        positionMs: value => number(value, '播放位置'), durationMs: value => number(value, '视频时长'), completed: boolean,
        watchedAt: value => Math.min(number(value, '观看时间', 1, Date.now() + 60000), Date.now()),
      }, { durationMs: current?.durationMs ?? 0, completed: current?.completed ?? false, watchedAt: Date.now() }, ['positionMs'])
      if (value.durationMs && value.positionMs > value.durationMs) invalid('播放位置不能超过视频时长')
      return write(() => models.tracks.save({ ...key, ...value }))
    },
    remove(mediaId: unknown, index: unknown): { ok: true } {
      const key = keyFor(mediaId, index)
      mustExist(models.tracks, key, '观看记录')
      write(() => models.tracks.remove(key))
      return { ok: true }
    },
  }
}
