import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { ffmpegPath, buildTranscodeArgs } from './ffmpeg.js'

/**
 * 把 ffmpeg 的 MPEG-TS 输出按关键帧切成 .ts 分片，对外提供标准 HLS 播放列表。
 * 这样浏览器端只需要 hls.js 常规加载 m3u8 + 分片，避免了 MSE 直接喂连续 TS 流的兼容性问题。
 *
 * - 每个会话一个 ffmpeg 进程，会话空闲 TIMEOUT_MS 后自动结束
 * - 分片缓存到磁盘，拖动到已生成过的位置可直接复用（无需重新转码）
 */

const DIR = path.join(config.dataDir, 'hls')
const TIMEOUT_MS = Number(process.env.HLS_IDLE_TIMEOUT_MS || 5 * 60 * 1000)
const SEGMENT_SECONDS = Number(process.env.HLS_SEGMENT_SECONDS || 5)
const WINDOW = 10 // 播放列表里保留多少片
const PACKET = 188
const START_CODE = Buffer.from([0, 0, 1])

/** @type {Map<string, Session>} */
const sessions = new Map()

export function sessionIdFor(absPath, startTime, encoder) {
  const key = `${absPath}|${Math.floor(startTime)}|${encoder}`
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
}

class Session {
  constructor(id, absPath, info) {
    this.id = id
    this.absPath = absPath
    this.info = info
    this.dir = path.join(DIR, id)
    this.segments = [] // { name, start, duration }
    this.sync = Buffer.alloc(0)
    this.segStart = -1 // 当前片起始 PTS
    this.minSegment = Number(process.env.HLS_MIN_SEGMENT || 2) // 秒
    this.segBuffers = []
    this.segBytes = 0
    this.lastActive = Date.now()
    this.createdAt = Date.now()
    this.ended = false
    this.error = null
    this.child = null
    this.pending = 0
    this.fallbackTries = 0
    this.sawPts = false
    this.annexB = Buffer.alloc(0)
    this.lastPts = null
    this.videoIsH264 = undefined
  }

  get targetDuration() {
    return SEGMENT_SECONDS
  }

  async start() {
    await fsp.mkdir(this.dir, { recursive: true })
    // 清理旧文件
    for (const f of await fsp.readdir(this.dir).catch(() => [])) {
      if (f.endsWith('.ts')) await fsp.rm(path.join(this.dir, f)).catch(() => {})
    }
    const built = await buildTranscodeArgs(this.absPath, this.info, {
      startTime: this.startTime,
      segmentSeconds: SEGMENT_SECONDS,
    })
    if (built.error) throw new Error(built.error)
    this.encoder = built.encoder
    this.spawnFfmpeg(built.args)
  }

  spawnFfmpeg(args) {
    // 输出编码决定 NAL 解析方式
    const ci = args.indexOf('-c:v')
    const vcodec = ci >= 0 ? args[ci + 1] : 'libx264'
    this.isH264 = /264|x264|avc/i.test(vcodec)
    this.child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.gotPts = false
    let errBuf = ''
    this.child.stderr.on('data', (d) => { errBuf += d.toString(); if (errBuf.length > 4000) errBuf = errBuf.slice(-2000) })
    this.errBuf = () => errBuf
    this.child.on('error', (err) => {
      this.error = err.message
      this.ended = true
    })
    this.child.on('close', (code) => {
      if (code && !this.segments.length && !this.sawPts && this.fallbackTries < 2) {
        this.fallbackTries++
        return this.retryArgs()
      }
      // 正常结束：把剩余数据包成最后一片
      this.flushTail()
      this.ended = true
      if (code && !this.segments.length) this.error = `ffmpeg 退出码 ${code}: ` + this.errBuf().slice(-300)
    })
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
  }

  async retryArgs() {
    // 第一轮：去掉自适应滤镜，纯软解 + 软编（最兼容）；再不行就报错
    const { buildTranscodeArgs } = await import('./ffmpeg.js')
    const opts = { startTime: this.startTime, segmentSeconds: SEGMENT_SECONDS, forceSoftware: true }
    const built = await buildTranscodeArgs(this.absPath, this.info, opts)
    if (built.error) {
      this.ended = true
      this.error = built.error
      return
    }
    this.errBuf = () => '重试编码'
    this.spawnFfmpeg(built.args)
  }

  onData(chunk) {
    this.lastActive = Date.now()
    this.sync = this.sync.length ? Buffer.concat([this.sync, chunk]) : chunk
    let off = 0
    const buf = this.sync
    while (off + PACKET <= buf.length) {
      if (buf[off] !== 0x47) {
        // 重新同步
        const next = buf.indexOf(0x47, off + 1)
        if (next === -1) {
          off = buf.length
          break
        }
        off = next
        continue
      }
      // 第一个视频包决定本片起点（有的编码器片头 PTS 为 0，属正常）
      if (this.segStart < 0 && (buf[off + 1] & 0x40)) {
        const pts = readPts(buf, off) ?? 0
        this.sawPts = true
        this.segStart = pts
      }
      const pkt = buf.subarray(off, off + PACKET)
      // 每个视频包都记录 PTS（mpegts 每包都带 PES 头，重复的 PTS 无害）
      const pusi = (pkt[1] & 0x40) !== 0
      const pktPts = readPts(buf, off)
      if (pktPts !== null) this.lastPts = pktPts
      // 边收边拼 Annex-B NAL，检测 IDR（NAL 可能跨 TS 包 / 每包都可能带 PES 头）
      const keyPts = feedNal(this, pkt, pktPts)
      if (keyPts !== null && this.segBytes > 0 && this.segStart >= 0 && keyPts - this.segStart >= this.minSegment) {
        this.cutSegment(keyPts)
      }
      this.segBuffers.push(Buffer.from(pkt))
      this.segBytes += PACKET
      off += PACKET
    }
    this.sync = Buffer.from(buf.subarray(off))
    // 限制残留，避免一包都不同步时无限增长
    if (this.sync.length > PACKET * 4) this.sync = this.sync.subarray(0, PACKET * 4)
  }

  cutSegment(nextStart) {
    if (!this.segBuffers.length || this.segStart < 0 || nextStart - this.segStart < this.minSegment) {
      // 关键帧距离过近（GOP 太短 / 片头）→ 不切
      return
    }
    const name = `seg-${String(this.segments.length).padStart(5, '0')}.ts`
    const data = Buffer.concat(this.segBuffers)
    const start = this.segStart
    const duration = Math.max(0.1, nextStart - start)
    this.segments.push({ name, start, duration })
    this.segBuffers = []
    this.segBytes = 0
    this.segStart = nextStart
    this.pending++
    fsp.writeFile(path.join(this.dir, name), data).finally(() => {
      this.pending--
    })
    // 窗口外的旧分片保留在磁盘上（支持回看拖动），但目录别无限增长
    if (this.segments.length > 4000) {
      const old = this.segments.splice(0, 1000)
      for (const s of old) fsp.rm(path.join(this.dir, s.name)).catch(() => {})
    }
  }

  flushTail() {
    if (this.segBuffers.length) {
      const name = `seg-${String(this.segments.length).padStart(5, '0')}.ts`
      const data = Buffer.concat(this.segBuffers)
      const duration = Math.max(0.1, this.segBytes / (this.info?.bitrate ? this.info.bitrate / 8 : 2e6))
      this.segments.push({ name, start: this.segStart, duration })
      this.segBuffers = []
      this.segBytes = 0
      fsp.writeFile(path.join(this.dir, name), data).catch(() => {})
    }
  }

  /**
   * 生成 m3u8。
   * mode=event：从 startTime 开始连续转码的伪直播流，hls.js 可在已生成分片间原生拖动；
   * mode=window：按客户端位置给出窗口（备用）。
   */
  playlist(position) {
    const segs = this.segments
    if (!segs.length) return null
    // 首片太短时先等一会儿，避免整个流的时间轴起点过短
    if (!this.ended && segs.length === 1 && segs[0].duration < this.minSegment * 0.8) return null
    const finished = this.ended
    const startIdx = 0
    const windowSegs = segs.slice(startIdx, startIdx + 4000)
    const target = Math.max(SEGMENT_SECONDS, ...windowSegs.map((s) => Math.ceil(s.duration)))

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${startIdx}`,
      '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      `#EXT-X-START:TIME-OFFSET=${(this.startTime || 0).toFixed(3)}`,
    ]
    if (finished) lines.push('#EXT-X-ENDLIST')
    for (const s of windowSegs) {
      lines.push(`#EXTINF:${s.duration.toFixed(3)},`)
      lines.push(`seg/${s.name}`)
    }
    return lines.join('\n') + '\n'
  }

  segmentFile(name) {
    if (!/^seg-\d{5}\.ts$/.test(name)) return null
    const file = path.join(this.dir, name)
    return fs.existsSync(file) ? file : null
  }

  stop() {
    try {
      this.child?.kill('SIGKILL')
    } catch {}
  }
}

const PTS_WRAP = 2 ** 33 / 90000 // 33bit 90kHz ≈ 95443.7s（约 26.5 小时）回绕

/** 从 TS 包读 PTS（33bit，90kHz），无 PES 头时返回 null；自动处理 26.5 小时回绕 */
let lastPts = null
function readPts(buf, off) {
  const pkt = buf.subarray(off, off + PACKET)
  const pusi = (pkt[1] & 0x40) !== 0
  const afc = (pkt[3] >> 4) & 0x3
  if (!pusi) return null
  let p = 4
  if (afc & 0x2) p += 1 + pkt[4]
  if (p + 14 > PACKET) return null
  // PES 起始码 00 00 01
  if (pkt[p] !== 0 || pkt[p + 1] !== 0 || pkt[p + 2] !== 1) return null
  const flags = pkt[p + 7]
  const ptsDts = (flags >> 6) & 0x3
  if (ptsDts !== 2 && ptsDts !== 3) return null
  const b = pkt.subarray(p + 9, p + 14)
  const pts =
    ((b[0] >> 1) & 0x07) * 2 ** 30 +
    ((b[1] << 7) | (b[2] >> 1)) * 2 ** 15 +
    ((b[3] << 7) | (b[4] >> 1))
  let t = pts / 90000
  if (lastPts !== null && t + PTS_WRAP / 2 < lastPts) t += PTS_WRAP // 回绕
  if (t > lastPts || lastPts === null) lastPts = t
  return t
}

/**
 * 取出一个 TS 包里视频 PES 的负载（跳过 TS 头、自适应字段、PES 头）。
 * mpegts 封装常常每包都带 PES 头，所以不能假设「只有 PUSI 包有 PES 头」。
 */
function videoPayload(pkt) {
  const pid = ((pkt[1] & 0x1f) << 8) | pkt[2]
  if (pid === 0 || pid === 0x11 || pid === 0x1fff) return null
  const afc = (pkt[3] >> 4) & 0x3
  let p = 4
  if (afc & 0x2) p += 1 + pkt[4]
  if (p + 9 > PACKET) return null
  if (pkt[p] === 0 && pkt[p + 1] === 0 && pkt[p + 2] === 1) {
    const streamId = pkt[p + 3]
    if (streamId < 0xe0 || streamId > 0xef) return null // 非视频流
    p += 9 + pkt[p + 8]
  }
  if (p >= PACKET) return null
  let end = PACKET
  while (end > p && pkt[end - 1] === 0xff) end-- // 去掉 CBR/TS 填充
  return end > p ? pkt.subarray(p, end) : null
}

/**
 * 逐 NAL 扫描（Annex-B）。CBR 填充会伪造出 00 00 01，因此用 NAL header 合法性过滤。
 * 返回是否遇到关键帧（H.264 IDR / HEVC IRAP）。
 */
function scanNals(buf, session) {
  const isH264 = session.isH264
  let key = false
  let i = 0
  while (true) {
    const sc = buf.indexOf(START_CODE, i)
    if (sc < 0) break
    const h = sc + 3
    if (h >= buf.length) break
    const raw = buf[h]
    // 编码格式由输出参数决定：libx264/vaapi/nvenc h264 → H.264，否则 HEVC
    if (isH264 ? (raw & 0x1f) === 5 : (raw >> 1) >= 16 && (raw >> 1) <= 21) key = true
    i = h + 1
  }
  return key
}

/**
 * 把视频负载拼进滚动 Annex-B 缓冲并检测关键帧。
 * 若本块内出现关键帧，返回该包 PTS（切片点）。
 */
function feedNal(session, pkt, pktPts) {
  const payload = videoPayload(pkt)
  if (!payload) return null
  const buf = session.annexB.length ? Buffer.concat([session.annexB, payload]) : Buffer.from(payload)
  const key = scanNals(buf, session)
  if (key) {
    session.annexB = Buffer.alloc(0)
    session.keyCount = (session.keyCount || 0) + 1
    return pktPts ?? session.lastPts ?? 0
  }
  // 未命中关键帧：只保留最后一段可能未完成的 NAL，避免无限增长
  const lastSc = buf.lastIndexOf(START_CODE)
  session.annexB = lastSc > 0 && buf.length - lastSc < 8192 ? Buffer.from(buf.subarray(lastSc)) : Buffer.alloc(0)
  return null
}

export async function getOrCreateSession(absPath, startTime, info) {
  const probe = await buildTranscodeArgs(absPath, info, { startTime: 0 })
  const id = sessionIdFor(absPath, startTime, probe.encoder || '')
  let s = sessions.get(id)
  if (s && !s.ended) {
    s.lastActive = Date.now()
    return s
  }
  s = new Session(id, absPath, info)
  s.startTime = Math.floor(startTime)
  sessions.set(id, s)
  await s.start()
  return s
}

/** 启动时清空上次运行残留的分片（磁盘缓存只用于单次播放进程内复用） */
Promise.resolve()
  .then(async () => {
    const entries = await fsp.readdir(DIR).catch(() => [])
    for (const e of entries) await fsp.rm(path.join(DIR, e), { recursive: true, force: true }).catch(() => {})
    console.log(`[hls] 已清理 ${entries.length} 个上次残留的分片目录`)
  })
  .catch(() => {})

/** 定时清理空闲会话 */
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastActive > TIMEOUT_MS) {
      s.stop()
      sessions.delete(id)
    }
  }
}, 30_000).unref()

/** 分片目录用久了会变大：超过上限时清理最久未使用的会话目录 */
async function pruneCache() {
  const MAX_BYTES = Number(process.env.HLS_CACHE_MAX_MB || 4096) * 1024 * 1024
  let total = 0
  const dirs = []
  try {
    for (const name of await fsp.readdir(DIR)) {
      if (sessions.has(name)) continue
      const full = path.join(DIR, name)
      let size = 0
      for (const f of await fsp.readdir(full).catch(() => [])) {
        size += (await fsp.stat(path.join(full, f)).catch(() => ({ size: 0 }))).size
      }
      const st = await fsp.stat(full).catch(() => ({ mtimeMs: 0 }))
      dirs.push({ full, size, mtime: st.mtimeMs })
      total += size
    }
  } catch {
    return
  }
  if (total <= MAX_BYTES) return
  dirs.sort((a, b) => a.mtime - b.mtime)
  for (const d of dirs) {
    if (total <= MAX_BYTES * 0.8) break
    await fsp.rm(d.full, { recursive: true, force: true }).catch(() => {})
    total -= d.size
  }
}
setInterval(() => pruneCache().catch(() => {}), 5 * 60_000).unref()
setTimeout(() => pruneCache().catch(() => {}), 10_000).unref()

export function sessionById(id) {
  const s = sessions.get(id)
  if (s) s.lastActive = Date.now()
  return s
}

export const HLS_DIR = DIR

/** 进程退出时结束全部转码会话 */
export function stopAllSessions() {
  for (const s of sessions.values()) s.stop()
  sessions.clear()
}
