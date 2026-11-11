import { baseName, boolean, id, invalid, mustExist, nullable, number, relativePath, resourceService, text, videoIndex } from './catalog-validation.ts'
import type { CatalogResource } from './catalog-validation.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { LocalMediaVideo } from '../types.ts'

export function createLocalMediaVideoService(models: CatalogModels): CatalogResource<LocalMediaVideo> {
  return resourceService<LocalMediaVideo>(models.videos, {
    validators: {
      title: text('视频标题'), coverPath: nullable(relativePath), mediaId: id, videoIndex, mediaPath: relativePath, localMediaId: id,
      videoType: value => ['main', 'extra'].includes(value) ? value : invalid('视频类型必须为 main 或 extra'),
      durationMs: value => number(value, '视频时长'), width: nullable(value => number(value, '视频宽度', 0, 100000)),
      height: nullable(value => number(value, '视频高度', 0, 100000)), frameCount: nullable(value => number(value, '视频帧数')),
      sizeBytes: value => number(value, '文件大小'), mtimeMs: value => number(value, '修改时间'), missing: boolean,
    },
    defaults: {
      coverPath: null, videoType: 'main', durationMs: 0, width: null, height: null, frameCount: null,
      sizeBytes: 0, mtimeMs: 0, missing: false,
    },
    required: ['mediaPath', 'localMediaId', 'videoIndex'],
    // 动态行数据（合并后的 local_media_video 记录）：字段已由 validators 校验，故此处显式 any。
    normalize(data: Record<string, any>): Record<string, any> {
      const folder = mustExist(models.localMedia, { id: data.localMediaId }, '本地目录')
      if (data.mediaId !== undefined && data.mediaId !== folder.mediaId) invalid('视频所属影视必须与目录一致')
      return { ...data, mediaId: folder.mediaId, title: data.title || baseName(data.mediaPath) }
    },
    searchable: true, filters: { mediaId: id, localMediaId: id, videoType: value => ['main', 'extra'].includes(value) ? value : invalid('视频类型无效'),
      missing: value => ['true', 'false', '1', '0'].includes(value) ? ['true', '1'].includes(value) : invalid('missing 参数无效') },
  })
}
