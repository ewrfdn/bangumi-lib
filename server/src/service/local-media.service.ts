import { createHash } from 'node:crypto'
import { baseName, id, mustExist, relativePath, resourceService, text } from './catalog-validation.ts'
import type { CatalogResource } from './catalog-validation.ts'
import type { CatalogModels } from '../model/catalog.model.ts'
import type { AppConfig, LocalMedia } from '../types.ts'

/** 目录身份 = 媒体库 + 规范化相对路径；与文件内容无关。 */
export function folderHash(libraryId: string, folderPath: string): string {
  const canonical = process.platform === 'win32' ? folderPath.toLowerCase() : folderPath
  return createHash('sha256').update(`${libraryId}\0${canonical}`).digest('hex')
}

export function createLocalMediaService(
  models: CatalogModels,
  settings: Pick<AppConfig, 'defaultLibraryId' | 'getLibrary'>,
): CatalogResource<LocalMedia> {
  return resourceService<LocalMedia>(models.localMedia, {
    validators: { libraryId: text('媒体库 ID', 64), folderName: text('文件夹名称'), folderPath: value => relativePath(value, true), mediaId: id },
    defaults: { libraryId: settings.defaultLibraryId }, required: ['folderPath', 'mediaId'], computed: ['folderHash'],
    // 动态行数据（合并后的 local_media 记录）：字段已由 validators 校验，故此处显式 any。
    normalize(data: Record<string, any>): Record<string, any> {
      const library = settings.getLibrary(data.libraryId)
      mustExist(models.media, { id: data.mediaId }, '影视')
      return {
        ...data,
        folderName: data.folderName || baseName(data.folderPath) || library.name,
        folderHash: folderHash(data.libraryId, data.folderPath),
      }
    },
    searchable: true, filters: { libraryId: text('媒体库 ID', 64), mediaId: id },
  })
}
