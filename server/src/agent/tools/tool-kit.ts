import path from 'node:path'
import { HttpError } from '../../errors.ts'
import { relativePath } from '../../service/catalog-validation.ts'
import type { AgentToolResult } from '../types.ts'
import type { Media } from '../../types.ts'

/**
 * Agent 工具参数使用标准 JSON Schema；这里只提供项目实际用到的构造器，
 * 保证各工具的参数描述风格一致。参数由 Pi SDK 在调用前按 schema 校验。
 */
export type JsonSchema = Record<string, unknown>

export const text = (description: string): JsonSchema => ({ type: 'string', description })

export const integer = (description: string): JsonSchema => ({ type: 'integer', description })

export const number = (description: string): JsonSchema => ({ type: 'number', description })

export const boolean = (description: string): JsonSchema => ({ type: 'boolean', description })

export const array = (items: JsonSchema, description: string): JsonSchema => ({ type: 'array', items, description })

export const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
})

/** 工具成功的统一返回：正文是 JSON 文本，details 供服务端与测试读取。 */
export const ok = (data: unknown): AgentToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }], details: data,
})

/** 参数或业务校验失败；HttpError 会被运行时转成错误结果喂回模型，不会中断整轮。 */
export const fail: (message: string) => never = (message: string): never => { throw new HttpError(400, message) }

export interface ResolvedLibraryPath {
  /** 相对媒体库根目录的规范路径（正斜杠；根目录为空字符串）。 */
  rel: string
  absolute: string
}

/**
 * 把工具参数里的相对路径安全解析到媒体库根目录内。
 * 绝对路径、盘符、`..` 越界由 `relativePath` 拒绝（HttpError 400）；
 * 解析结果再做一次前缀校验，避免软链接/平台差异导致的逃逸。
 */
export function resolveInside(root: string, value: unknown): ResolvedLibraryPath {
  const rel = relativePath(value ?? '', true)
  const absolute = path.resolve(root, rel)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new HttpError(403, '路径越界')
  return { rel, absolute }
}

/** 工具结果里统一使用的影视摘要；不含大段简介，避免占用模型上下文。 */
export interface MediaSummary {
  mediaId: number
  title: string
  season: number | null
  episodeCount: number | null
  dataSource: string | null
  needsReview: boolean
}

export function mediaSummary(media: Media | null): MediaSummary | null {
  return media && ({
    mediaId: media.id, title: media.title, season: media.season, episodeCount: media.episodeCount,
    dataSource: media.dataSource,
    needsReview: Boolean((media.attribute?.scan as { needsReview?: boolean } | undefined)?.needsReview),
  })
}
