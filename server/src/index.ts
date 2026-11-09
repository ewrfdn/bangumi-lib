import os from 'node:os'
import v8 from 'node:v8'
import { config } from './config.ts'
import { createApp } from './app.ts'

// 内存上限（MB）：限制了 cgroup / 容器内存时，把 V8 堆压到 60%，避免 Node 与 ffmpeg 争抢导致 OOM
const limitMb = Number(process.env.MEMORY_LIMIT_MB || 0)
if (limitMb > 0 && !process.env.NODE_OPTIONS?.includes('--max-old-space-size')) {
  const heap = Math.round(limitMb * 0.6)
  try {
    v8.setFlagsFromString(`--max-old-space-size=${heap}`)
  } catch {}
}

const app = await createApp()

function localAddresses(port: number): string[] {
  const out = [`http://127.0.0.1:${port}`]
  for (const list of Object.values(os.networkInterfaces())) {
    for (const network of list ?? []) {
      if (network.family === 'IPv4' && !network.internal && !network.address.startsWith('172.1')) {
        out.push(`http://${network.address}:${port}`)
      }
    }
  }
  return out
}

try {
  await app.listen({ host: config.host, port: config.port })
  for (const library of config.libraries) app.log.info(`媒体库 ${library.name} (${library.id}): ${library.root}`)
  app.log.info(`SQLite: ${config.dbPath}`)
  app.log.info(`访问密钥登录: ${config.authSecret ? '已启用' : '未启用（可设置 AUTH_SECRET）'}`)
  for (const url of localAddresses(config.port)) app.log.info(`访问: ${url}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

// 退出时结束所有转码进程
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    try {
      await app.close()
    } catch {}
    process.exit(0)
  })
}
