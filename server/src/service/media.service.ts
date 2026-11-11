import path from 'node:path'
import { config } from '../config.ts'
import { HttpError } from '../errors.ts'
import {
  resolveVirtual, assertFile, listDirectory, findPoster, findSubtitlesFor, fallbackSubtitles,
  toVirtual, extOf, IMAGE_SUB_EXTS, fileResource,
} from '../model/media.model.ts'
import { probe, hasFFmpeg } from './ffmpeg.service.ts'
import { createSubtitleService } from './subtitle.service.ts'
import type { MediaProbe, MediaProbeSubtitle } from './ffmpeg.service.ts'
import type { SubtitleService, SubtitleStream } from './subtitle.service.ts'
import type { FileResource, MediaEntry } from '../model/media.model.ts'
import type { AppConfig, Library } from '../types.ts'

/** A listing row plus the episode hint some callers attach at runtime. */
interface DirectoryEntry extends MediaEntry {
  episode?: { total?: number; season?: number }
}

interface SubtitleEntry {
  path: string
  libraryId: string
  name: string
  ext: string
  image: boolean
  lang: string
}

interface EpisodeEntry {
  name: string
  path: string
  libraryId: string
  size: number | undefined
  total: number
  season: number
  current: boolean
}

interface PlaybackDecision {
  directPlay: boolean
  needsTranscode: boolean
  reason: string
}

export interface VideoPayload {
  path: string
  libraryId: string
  libraryName: string
  seriesPath: string
  seriesTitle: string
  poster: string | null
  playKey: string
  name: string
  dir: string
  dirName: string
  size: number
  mtime: number
  duration: number
  probe: MediaProbe | null
  subs: SubtitleEntry[]
  streams: MediaProbeSubtitle[]
  episodes: EpisodeEntry[]
  episodeIndex: number
  playback: PlaybackDecision
}

export interface MediaService {
  file(virtualPath: string, libraryId?: string): FileResource
  video(virtualPath: string, libraryId?: string): Promise<VideoPayload>
  externalSubtitle(virtualPath: string, libraryId?: string): Promise<string>
  openEmbeddedSubtitle(virtualPath: string, index: number, libraryId?: string): Promise<SubtitleStream>
}

function detectLanguage(name: string): string {
  const value = name.toLowerCase()
  if (/(cht|tc\b|繁|zh-hant|zh_tw|big5|sc_tc)/.test(value) && !/(chs|sc\b|简)/.test(value)) return 'zh-TW'
  if (/(chs|sc\b|简|zh-hans|zh_cn|gb)/.test(value)) return 'zh-CN'
  if (/(cht|繁)/.test(value)) return 'zh-TW'
  if (/(jpn|jap|jp\b|日)/.test(value)) return 'ja'
  if (/(eng|english|en\b|英)/.test(value)) return 'en'
  return ''
}

export function createMediaService(
  settings: AppConfig = config,
  subtitles: SubtitleService = createSubtitleService({ dataDir: settings.dataDir }),
): MediaService {
  const libraryFor = (id?: string): Library => settings.getLibrary(id || settings.defaultLibraryId)
  return {
    file(virtualPath: string, libraryId?: string): FileResource {
      return fileResource(virtualPath, libraryFor(libraryId).id)
    },
    async video(virtualPath: string, libraryId?: string): Promise<VideoPayload> {
      const library = libraryFor(libraryId)
      const absolutePath = resolveVirtual(virtualPath, library.id)
      const stat = await assertFile(absolutePath)
      const information = await probe(absolutePath)
      const directory = toVirtual(path.dirname(absolutePath), library.id)
      const canonicalPath = toVirtual(absolutePath, library.id)
      const siblings: DirectoryEntry[] = await listDirectory(directory, library.id)
      const relativeParts = path.relative(library.root, absolutePath).split(path.sep)
      const seriesAbsolutePath = relativeParts.length > 1 ? path.join(library.root, relativeParts[0]) : absolutePath
      const seriesPath = toVirtual(seriesAbsolutePath, library.id)
      const poster: string | null = relativeParts.length > 1 ? await findPoster(seriesAbsolutePath, 2, library.id) : null
      const videoSiblings = siblings.filter((item) => item.kind === 'video')
      let subtitleFiles: DirectoryEntry[] = findSubtitlesFor(path.basename(absolutePath), siblings)
      if (!subtitleFiles.length) subtitleFiles = fallbackSubtitles(videoSiblings, siblings)
      const subs: SubtitleEntry[] = subtitleFiles.map((file) => ({
        path: file.path, libraryId: library.id, name: file.name, ext: file.ext,
        image: IMAGE_SUB_EXTS.has(file.ext), lang: detectLanguage(file.name),
      }))

      const extension = extOf(absolutePath)
      const video = information?.video
      const audio = information?.audio || []
      const containerOk = ['.mp4', '.m4v', '.webm', '.mov'].includes(extension)
      const audioOk = audio.every((track) => ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(track.codec))
      const directPlay = information ? Boolean(containerOk && video?.browserPlayable && audioOk) : containerOk
      let reason = '浏览器原生可播放'
      if (!directPlay) {
        if (!information) reason = hasFFmpeg() ? '无法分析编码，尝试转码' : '服务端未安装 ffmpeg，且容器不受支持'
        else if (video?.hevc) reason = 'HEVC / H.265 编码——浏览器无法原生解码，由服务端实时转码为 H.264 播放'
        else if (!containerOk) reason = `${extension.slice(1).toUpperCase()} 容器不被浏览器支持，服务端实时转码`
        else if (!video?.browserPlayable) reason = `${video?.codec || '未知'} 编码不被浏览器支持，服务端实时转码`
        else if (!audioOk) reason = '音频编码不被浏览器支持，服务端实时转码'
      }
      const episodes: EpisodeEntry[] = videoSiblings.map((item) => ({
        name: item.name, path: item.path, libraryId: library.id, size: item.size,
        total: item.episode?.total || 0, season: item.episode?.season || 0,
        current: item.path === canonicalPath,
      }))
      return {
        path: canonicalPath, libraryId: library.id, libraryName: library.name,
        seriesPath, seriesTitle: relativeParts[0], poster, playKey: canonicalPath,
        name: path.basename(absolutePath), dir: directory,
        dirName: path.basename(path.dirname(absolutePath)) || library.name,
        size: stat.size, mtime: stat.mtimeMs, duration: information?.duration || 0,
        probe: information, subs, streams: information?.subtitles || [], episodes,
        episodeIndex: episodes.findIndex((item) => item.current),
        playback: { directPlay, needsTranscode: !directPlay, reason },
      }
    },
    async externalSubtitle(virtualPath: string, libraryId?: string): Promise<string> {
      const absolutePath = resolveVirtual(virtualPath, libraryFor(libraryId).id)
      await assertFile(absolutePath)
      const extension = extOf(absolutePath)
      if (IMAGE_SUB_EXTS.has(extension)) throw new HttpError(415, '图形字幕（sup/sub/idx）无法以文本形式外挂')
      return subtitles.externalVtt(absolutePath, extension)
    },
    async openEmbeddedSubtitle(virtualPath: string, index: number, libraryId?: string): Promise<SubtitleStream> {
      // 先解析路径/媒体库，未知库等错误优先返回 404，再校验字幕流序号。
      const absolutePath = resolveVirtual(virtualPath, libraryFor(libraryId).id)
      await assertFile(absolutePath)
      if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'index 无效')
      return subtitles.openEmbedded(absolutePath, index)
    },
  }
}
