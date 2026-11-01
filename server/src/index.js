import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { config, PROJECT_ROOT } from './config.js'
import registerRoutes from './routes.js'
import { stopAllSessions } from './hls.js'

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info', disableRequestLogging: true },
  bodyLimit: 1024 * 1024,
})

// 流式传输需要长连接
app.server.keepAliveTimeout = 120_000
app.server.headersTimeout = 121_000
app.server.requestTimeout = 0

await app.register(registerRoutes)

const distDir = path.join(PROJECT_ROOT, 'web', 'dist')
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  await app.register(fastifyStatic, { root: distDir, prefix: '/' })
}

app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || '/'
  if (url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' })
  const indexFile = path.join(distDir, 'index.html')
  if (fs.existsSync(indexFile) && (req.method === 'GET' || req.method === 'HEAD')) {
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(indexFile))
  }
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(
      `<pre style="font:14px/1.6 ui-monospace,monospace;padding:24px">前端尚未构建。
开发模式：npm run dev
生产模式：npm run build &amp;&amp; npm start
媒体目录：${config.mediaRoot}</pre>`,
    )
})

function localAddresses(port) {
  const out = [`http://127.0.0.1:${port}`]
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('172.1')) out.push(`http://${n.address}:${port}`)
    }
  }
  return out
}

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(`媒体目录: ${config.mediaRoot}`)
  for (const url of localAddresses(config.port)) app.log.info(`访问: ${url}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

// 退出时结束所有转码进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      stopAllSessions()
      await app.close()
    } catch {}
    process.exit(0)
  })
}
