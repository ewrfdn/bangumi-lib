import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import {
  HttpError,
  resolveVirtual,
  assertFile,
  listDirectory,
  scanLibrary,
  findSubtitlesFor,
  fallbackSubtitles,
  toVirtual,
  extOf,
  IMAGE_SUB_EXTS,
} from './media.js'
import { probe, subtitleToVtt, capabilities, hasFFmpeg } from './ffmpeg.js'
import { getOrCreateSession, sessionById } from './hls.js'

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}

const str = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '')

/** 从文件名猜字幕语言 */
function detectLang(name) {
  const n = name.toLowerCase()
  if (/(cht|tc\b|繁|zh-hant|zh_tw|big5|sc_tc)/.test(n) && !/(chs|sc\b|简)/.test(n)) return 'zh-TW'
  if (/(chs|sc\b|简|zh-hans|zh_cn|gb)/.test(n)) return 'zh-CN'
  if (/(cht|繁)/.test(n)) return 'zh-TW'
  if (/(jpn|jap|jp\b|日)/.test(n)) return 'ja'
  if (/(eng|english|en\b|英)/.test(n)) return 'en'
  return ''
}

/** 把各种文本字幕统一成 WebVTT */
function toWebVtt(text, fromExt) {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (/^\s*WEBVTT/.test(t)) return t
  if (fromExt === '.srt') {
    // SRT: 序号行 + 时间行；WebVTT 允许直接去掉序号行
    return 'WEBVTT\n\n' + t.replace(/^\s*\d+\s*$/gm, '')
  }
  return 'WEBVTT\n\n' + t
}

/** 支持 Range 的文件响应 */
function serveFile(req, reply) {
  const rawPath = str(req.query.path)
  const abs = resolveVirtual(rawPath)
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    return reply.code(404).send({ error: '文件不存在' })
  }
  if (!st.isFile()) return reply.code(400).send({ error: '不是文件' })

  const total = st.size
  const ext = extOf(abs)
  const mime = MIME[ext] || 'application/octet-stream'
  const isStatic = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.flac', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav'].includes(ext)

  let start = 0
  let end = total - 1
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!m) return reply.code(416).header('Content-Range', `bytes */${total}`).send()
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, total - Number(m[2]))
      end = total - 1
    } else {
      start = Number(m[1])
      end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
    }
    if (start > end || start >= total) {
      return reply.code(416).header('Content-Range', `bytes */${total}`).send()
    }
  }

  reply.header('Accept-Ranges', 'bytes')
  reply.header('Content-Type', mime)
  reply.header('Last-Modified', st.mtime.toUTCString())
  reply.header('Cache-Control', isStatic ? 'public, max-age=86400' : 'no-cache')
  reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`)

  if (range) {
    reply.code(206)
    reply.header('Content-Range', `bytes ${start}-${end}/${total}`)
    reply.header('Content-Length', String(end - start + 1))
    if (req.method === 'HEAD') return reply.send()
    return reply.send(fs.createReadStream(abs, { start, end, highWaterMark: 1024 * 1024 }))
  }
  reply.header('Content-Length', String(total))
  if (req.method === 'HEAD') return reply.send()
  return reply.send(fs.createReadStream(abs, { highWaterMark: 1024 * 1024 }))
}

export default async function registerRoutes(app) {
  app.get('/api/status', async () => {
    const caps = await capabilities()
    return {
      ok: true,
      root: config.mediaRoot,
      rootExists: fs.existsSync(config.mediaRoot),
      ...caps,
      version: '0.1.0',
    }
  })

  app.get('/api/library', async () => {
    try {
      const series = await scanLibrary()
      return { root: config.mediaRoot, series }
    } catch (err) {
      return {
        root: config.mediaRoot,
        series: [],
        error: `无法读取媒体目录：${config.mediaRoot}（${err.message}）`,
      }
    }
  })

  app.get('/api/list', async (req) => {
    const dirPath = str(req.query.path) || '/'
    const virtual = dirPath.startsWith('/') ? dirPath : '/' + dirPath
    const items = await listDirectory(virtual)
    return { path: virtual, root: config.mediaRoot, items }
  })

  app.get('/api/video', async (req) => {
    const videoPath = str(req.query.path)
    const abs = resolveVirtual(videoPath)
    const st = await assertFile(abs)
    const info = await probe(abs)

    const dirVirtual = toVirtual(path.dirname(abs))
    const canonPath = toVirtual(abs)
    const siblings = await listDirectory(dirVirtual)
    const videoSiblings = siblings.filter((i) => i.kind === 'video')
    let subFiles = findSubtitlesFor(path.basename(abs), siblings)
    if (!subFiles.length) {
      // 兜底：目录里只有一个视频 + 有字幕 → 全部当作它的字幕
      subFiles = fallbackSubtitles(videoSiblings, siblings)
    }
    const subs = subFiles.map((f) => ({
      path: f.path,
      name: f.name,
      ext: f.ext,
      image: IMAGE_SUB_EXTS.has(f.ext),
      lang: detectLang(f.name),
    }))

    const ext = extOf(abs)
    const v = info?.video
    const audio = info?.audio || []
    const containerOk = ['.mp4', '.m4v', '.webm', '.mov'].includes(ext)
    const audioOk = audio.length ? audio.every((a) => ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(a.codec)) : true
    const videoOk = v ? v.browserPlayable : null
    const directPlay = info ? Boolean(containerOk && videoOk && audioOk) : containerOk
    const needsTranscode = !directPlay

    let reason = '浏览器原生可播放'
    if (!directPlay) {
      if (!info) reason = hasFFmpeg() ? '无法分析编码，尝试转码' : '服务端未安装 ffmpeg，且容器不受支持'
      else if (v?.hevc) reason = 'HEVC / H.265 编码——浏览器无法原生解码，由服务端实时转码为 H.264 播放'
      else if (!containerOk) reason = `${ext.slice(1).toUpperCase()} 容器不被浏览器支持，服务端实时转码`
      else if (!videoOk) reason = `${v?.codec || '未知'} 编码不被浏览器支持，服务端实时转码`
      else if (!audioOk) reason = '音频编码不被浏览器支持，服务端实时转码'
    }

    // 同目录的剧集列表（用于上一集/下一集）
    const episodes = siblings
      .filter((i) => i.kind === 'video')
      .map((i) => ({ name: i.name, path: i.path, size: i.size, total: i.episode?.total || 0, season: i.episode?.season || 0 }))
    const currentIndex = episodes.findIndex((e) => e.path === canonPath)
    // 供前端记录播放进度用的 key
    const playKey = canonPath

    return {
      path: canonPath,
      playKey,
      name: path.basename(abs),
      dir: dirVirtual,
      dirName: path.basename(path.dirname(abs)) || path.basename(config.mediaRoot),
      size: st.size,
      mtime: st.mtimeMs,
      duration: info?.duration || 0,
      probe: info,
      subs,
      streams: info?.subtitles || [],
      episodes: episodes.map((e) => ({ ...e, current: e.path === canonPath })),
      episodeIndex: currentIndex,
      playback: { directPlay, needsTranscode, reason },
    }
  })

  // Fastify 的 GET 路由同时处理 HEAD
  app.get('/api/stream', (req, reply) => serveFile(req, reply))
  app.get('/api/file', (req, reply) => serveFile(req, reply))

  /** 外挂字幕 → WebVTT */
  app.get('/api/subtitle', async (req, reply) => {
    const abs = resolveVirtual(str(req.query.path))
    await assertFile(abs)
    const ext = extOf(abs)
    if (IMAGE_SUB_EXTS.has(ext)) {
      return reply.code(415).send({ error: '图形字幕（sup/sub/idx）无法以文本形式外挂' })
    }
    let vtt = null
    if (hasFFmpeg()) {
      vtt = (await subtitleToVtt(abs, null)).vtt
    }
    if (!vtt) {
      const raw = await fsp.readFile(abs, 'utf8').catch(() => null)
      if (raw === null) return reply.code(415).send({ error: '无法读取字幕' })
      vtt = toWebVtt(raw, ext)
    }
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.type('text/vtt; charset=utf-8').send(vtt)
  })

  /** 内挂字幕（mkv 内封）→ WebVTT */
  app.get('/api/stream-subtitle', async (req, reply) => {
    const abs = resolveVirtual(str(req.query.path))
    await assertFile(abs)
    const idx = Number(str(req.query.index))
    if (!Number.isInteger(idx) || idx < 0) throw new HttpError(400, 'index 无效')
    const r = await subtitleToVtt(abs, idx)
    if (!r.vtt) return reply.code(500).send({ error: r.error || '字幕提取失败' })
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.type('text/vtt; charset=utf-8').send(r.vtt)
  })

  /** 创建/复用转码 HLS 会话：返回 m3u8 地址 */
  app.get('/api/hls/start', async (req, reply) => {
    const abs = resolveVirtual(str(req.query.path))
    await assertFile(abs)
    const start = Math.max(0, Number(str(req.query.t)) || 0)
    const info = await probe(abs)
    let session
    try {
      session = await getOrCreateSession(abs, start, info)
    } catch (err) {
      return reply.code(500).send({ error: err.message || '无法启动转码' })
    }
    reply.header('Cache-Control', 'no-store')
    return {
      m3u8: `/api/hls/${session.id}/index.m3u8`,
      id: session.id,
      start: Math.floor(start),
      encoder: session.encoder,
      segmentSeconds: session.targetDuration,
    }
  })

  /** HLS 播放列表 */
  app.get('/api/hls/:id/index.m3u8', async (req, reply) => {
    const s = sessionById(str(req.params.id))
    if (!s) return reply.code(404).send('# session expired')
    const pos = Number(str(req.query.pos)) || s.startTime
    let text = null
    const t0 = Date.now()
    while (Date.now() - t0 < 45_000) {
      text = s.playlist(pos)
      if (text) break
      if (s.error) break
      await new Promise((r) => setTimeout(r, 120))
    }
    if (!text) {
      return reply.code(503).send(`# transcode not ready${s.error ? ': ' + s.error : ''}`)
    }
    reply.header('Cache-Control', 'no-store')
    reply.header('Access-Control-Allow-Origin', '*')
    return reply.type('application/vnd.apple.mpegurl').send(text)
  })

  /** HLS 分片 */
  app.get('/api/hls/:id/seg/:name', async (req, reply) => {
    const s = sessionById(str(req.params.id))
    if (!s) return reply.code(404).send()
    const file = s.segmentFile(str(req.params.name))
    if (!file) return reply.code(404).send()
    const st = await fsp.stat(file).catch(() => null)
    if (!st) return reply.code(404).send()
    reply.header('Content-Type', 'video/mp2t')
    reply.header('Content-Length', String(st.size))
    reply.header('Cache-Control', 'public, max-age=600')
    reply.header('Access-Control-Allow-Origin', '*')
    return reply.send(fs.createReadStream(file))
  })

  /** 停止 HLS 会话（离开播放页时调用） */
  app.delete('/api/hls/:id', async (req) => {
    const s = sessionById(str(req.params.id))
    if (s) s.stop()
    return { ok: true }
  })

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || err.status || 500
    if (status >= 500) app.log.error(err)
    reply.code(status).send({ error: err.message || '服务器内部错误' })
  })
}
