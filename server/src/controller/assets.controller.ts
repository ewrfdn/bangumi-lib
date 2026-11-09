import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../types.ts'

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface AssetRoute {
  Params: { '*': string | undefined }
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface AssetsControllerDependencies {
  readonly settings: AppConfig
}

/** 只读的静态资源目录：data/bangumi 下的封面与条目 JSON。 */
export function registerAssetsController(app: FastifyInstance, { settings }: AssetsControllerDependencies): void {
  const root = path.join(settings.dataDir, 'bangumi')

  app.get<AssetRoute>('/assets/bangumi/*', async (request: FastifyRequest<AssetRoute>, reply: FastifyReply): Promise<unknown> => {
    const wildcard = request.params['*']
    if (typeof wildcard !== 'string' || !wildcard) return reply.code(404).send({ error: '资源不存在' })
    let relative: string
    try { relative = decodeURIComponent(wildcard) } catch { return reply.code(400).send({ error: '资源路径无效' }) }
    if (relative.includes('\0') || relative.includes('\\') || relative.split('/').includes('..')) {
      return reply.code(403).send({ error: '资源路径越界' })
    }
    const target = path.resolve(root, relative)
    if (target !== root && !target.startsWith(root + path.sep)) return reply.code(403).send({ error: '资源路径越界' })
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isFile()) return reply.code(404).send({ error: '资源不存在' })
    return reply
      .header('cache-control', 'public, max-age=86400')
      .type(MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream')
      .send(await fs.readFile(target))
  })
}
