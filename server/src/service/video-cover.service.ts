import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { extractVideoCover } from './ffmpeg.service.ts'
import type { AppConfig } from '../types.ts'

/** 扫描器调用的封面生成接口；测试可注入假实现。 */
export interface VideoCoverGenerator {
  ensure(videoAbsPath: string, localMediaId: number, mediaPath: string, options?: { force?: boolean }): Promise<string | null>
}

export interface VideoCoverService extends VideoCoverGenerator {
  absolutePath(relativePath: string): string
}

export const VIDEO_COVER_HEIGHT = 480

/**
 * 视频中间帧封面。文件放在 DATA_DIR/local-media/<localMediaId>/<hash>.jpg，
 * DB 的 local_media_video.cover_path 保存相对 DATA_DIR 的路径，经 /assets/local-media 提供。
 */
export function createVideoCoverService({ settings }: { settings: AppConfig }): VideoCoverService {
  const dataDir = path.resolve(settings.dataDir)
  const root = path.join(dataDir, 'local-media')
  const relativeOf = (localMediaId: number, mediaPath: string): string => {
    const hash = createHash('sha1').update(`${localMediaId}:${mediaPath}`).digest('hex').slice(0, 16)
    return `local-media/${localMediaId}/${hash}.jpg`
  }
  const absoluteOf = (relativePath: string): string => {
    const target = path.resolve(dataDir, relativePath)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('封面路径越界')
    return target
  }

  return {
    absolutePath: absoluteOf,
    async ensure(videoAbsPath, localMediaId, mediaPath, { force = false } = {}) {
      const relative = relativeOf(localMediaId, mediaPath)
      const target = absoluteOf(relative)
      if (!force) {
        const current = await fs.stat(target).catch(() => null)
        if (current?.isFile() && current.size > 0) return relative
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      // 先写临时文件再替换，避免在已有封面上留下半张图。
      const temporary = `${target}.tmp.jpg`
      await fs.rm(temporary, { force: true }).catch(() => {})
      const written = await extractVideoCover(videoAbsPath, temporary, { height: VIDEO_COVER_HEIGHT })
      if (!written) {
        await fs.rm(temporary, { force: true }).catch(() => {})
        const current = await fs.stat(target).catch(() => null)
        return current?.isFile() && current.size > 0 ? relative : null
      }
      await fs.rm(target, { force: true }).catch(() => {})
      await fs.rename(temporary, target)
      return relative
    },
  }
}
