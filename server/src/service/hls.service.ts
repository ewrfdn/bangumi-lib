import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Readable } from 'node:stream'
import { config } from '../config.ts'
import { ffmpegPath, buildTranscodeArgs } from './ffmpeg.service.ts'
import type { MediaProbe } from './ffmpeg.service.ts'

/**
 * 把 ffmpeg 的 MPEG-TS 输出按关键帧切成 .ts 分片，对外提供标准 HLS 播放列表。
 * 这样浏览器端只需要 hls.js 常规加载 m3u8 + 分片，避免了 MSE 直接喂连续 TS 流的兼容性问题。
 *
 * - 每个会话一个 ffmpeg 进程，会话空闲 TIMEOUT_MS 后自动结束
 * - 分片缓存到磁盘，拖动到已生成过的位置可直接复用（无需重新转码）
 */

const DIR: string = path.join(config.dataDir, 'hls')
const TIMEOUT_MS = Number(process.env.HLS_IDLE_TIMEOUT_MS || 5 * 60 * 1000)
const SEGMENT_SECONDS = Number(process.env.HLS_SEGMENT_SECONDS || 5)
const PACKET = 188
const START_CODE = Buffer.from([0, 0, 1])

/**
 * 一个已产出的分片：文件名（seg-00000.ts）+ 源时间轴起点/时长（秒）。
 */
export interface SegmentInfo {
  name: string
  start: number
  duration: number
}

/** /api/hls/:id/info 返回给前端的会话进度。 */
export interface SessionInfo {
  id: string
  start: number
  firstStart: number
  frontier: number
  ended: boolean
  error: string | null
  encoder: string | undefined
}

/** 分片目录缓存统计项，用于 pruneCache 按最久未使用淘汰。 */
interface CacheEntry {
  full: string
  size: number
  mtime: number
}

const sessions: Map<string, Session> = new Map()

export function sessionIdFor(absPath: string, startTime: number, encoder: string): string {
  const key = `${absPath}|${Math.floor(startTime)}|${encoder}`
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
}

class Session {
  id: string
  absPath: string
  probeInfo: MediaProbe | null
  dir: string
  segments: SegmentInfo[]
  sync: Buffer
  segStart: number
  minSegment: number
  segBuffers: Buffer[]
  segBytes: number
  lastActive: number
  createdAt: number
  ended: boolean
  error: string | null
  child: ChildProcessByStdio<null, Readable, Readable> | null
  pending: number
  fallbackTries: number
  sawPts: boolean
  annexB: Buffer
  lastPts: number | null
  basePts: number | null
  videoIsH264: boolean | undefined
  /** 起始位置（源文件时间轴秒），由 createSession 写入 */
  startTime!: number
  /** 实际选中的视频编码器名，start() 成功后才确定 */
  encoder: string | undefined
  /** 当前是否 H.264 输出（决定 NAL 解析方式），spawnFfmpeg 里按参数设置 */
  isH264!: boolean
  gotPts!: boolean
  keyCount?: number
  /** 取最近 ffmpeg stderr 尾部，用于错误消息 */
  errBuf!: () => string

  constructor(id: string, absPath: string, info: MediaProbe | null) {
    this.id = id
    this.absPath = absPath
    this.probeInfo = info
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
    this.basePts = null // 首个视频包的原始 PTS，用于还原 B 帧造成的 33bit 回绕
    this.videoIsH264 = undefined
  }

  get targetDuration(): number {
    return SEGMENT_SECONDS
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    // 清理旧文件
    for (const f of await fsp.readdir(this.dir).catch(() => [])) {
      if (f.endsWith('.ts')) await fsp.rm(path.join(this.dir, f)).catch(() => {})
    }
    const built = await buildTranscodeArgs(this.absPath, this.probeInfo, {
      startTime: this.startTime,
      segmentSeconds: SEGMENT_SECONDS,
    })
    if (built.error) throw new Error(built.error)
    this.encoder = built.encoder
    // TranscodeBuildResult 的 error 分支已抛出；成功分支必有 args。`!` 仅为类型收窄，运行时不变
    this.spawnFfmpeg(built.args!)
  }

  spawnFfmpeg(args: string[]): void {
    // 输出编码决定 NAL 解析方式
    const ci = args.indexOf('-c:v')
    const vcodec = ci >= 0 ? args[ci + 1] : 'libx264'
    this.isH264 = /264|x264|avc/i.test(vcodec)
    // 没有可用 ffmpeg 时 buildTranscodeArgs 会返回 error，这里必有路径；`!` 仅为类型收窄，运行时仍是同一个值
    const child = spawn(ffmpegPath()!, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.gotPts = false
    let errBuf = ''
    child.stderr.on('data', (d) => { errBuf += d.toString(); if (errBuf.length > 4000) errBuf = errBuf.slice(-2000) })
    this.errBuf = () => errBuf
    child.on('error', (err) => {
      this.error = err.message
      this.ended = true
    })
    child.on('close', (code) => {
      if (code && !this.segments.length && !this.sawPts && this.fallbackTries < 2) {
        this.fallbackTries++
        return this.retryArgs()
      }
      // 正常结束：把剩余数据包成最后一片
      this.flushTail()
      this.ended = true
      if (code && !this.segments.length) this.error = `ffmpeg 退出码 ${code}: ` + this.errBuf().slice(-300)
    })
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
  }

  async retryArgs(): Promise<void> {
    // 第一轮：去掉自适应滤镜，纯软解 + 软编（最兼容）；再不行就报错
    const { buildTranscodeArgs } = await import('./ffmpeg.service.ts')
    const opts = { startTime: this.startTime, segmentSeconds: SEGMENT_SECONDS, forceSoftware: true }
    const built = await buildTranscodeArgs(this.absPath, this.probeInfo, opts)
    if (built.error) {
      this.ended = true
      this.error = built.error
      return
    }
    this.errBuf = () => '重试编码'
    // 同上：error 分支已 return，成功分支必有 args；`!` 仅为类型收窄
    this.spawnFfmpeg(built.args!)
  }

  onData(chunk: Buffer): void {
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
        const raw = readPts(buf, off) ?? 0
        if (this.basePts === null) this.basePts = raw
        this.segStart = normalizePts(raw, this.basePts)
        this.sawPts = true
      }
      const pkt = buf.subarray(off, off + PACKET)
      // 每个视频包都记录 PTS（mpegts 每包都带 PES 头，重复的 PTS 无害）
      const rawPts = readPts(buf, off)
      const pktPts = rawPts === null ? null : normalizePts(rawPts, this.basePts)
      // 边收边拼 Annex-B NAL，检测 IDR（NAL 可能跨 TS 包 / 每包都可能带 PES 头）
      const keyPts = feedNal(this, pkt, pktPts)
      if (keyPts !== null && this.segBytes > 0 && this.segStart >= 0) this.cutSegment(keyPts)
      this.segBuffers.push(Buffer.from(pkt))
      this.segBytes += PACKET
      off += PACKET
    }
    this.sync = Buffer.from(buf.subarray(off))
    // 限制残留，避免一包都不同步时无限增长
    if (this.sync.length > PACKET * 4) this.sync = this.sync.subarray(0, PACKET * 4)
  }

  cutSegment(nextStart: number): void {
    // 关键帧过近（片头残留、B 帧重排导致的伪关键帧）不切；否则每 keyint 一刀。
    // 间隔超过 1.8 个片长时必须切，避免长片导致播放卡在片尾。
    const sinceLast = nextStart - this.segStart
    if (!this.segBuffers.length || this.segStart < 0) return
    if (sinceLast < SEGMENT_SECONDS * 0.6 && sinceLast < SEGMENT_SECONDS * 1.8) return
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

  flushTail(): void {
    if (this.segBuffers.length) {
      const name = `seg-${String(this.segments.length).padStart(5, '0')}.ts`
      const data = Buffer.concat(this.segBuffers)
      const duration = Math.max(0.1, this.segBytes / (this.probeInfo?.bitrate ? this.probeInfo.bitrate / 8 : 2e6))
      this.segments.push({ name, start: this.segStart, duration })
      this.segBuffers = []
      this.segBytes = 0
      fsp.writeFile(path.join(this.dir, name), data).catch(() => {})
    }
  }

  /**
   * 生成 m3u8（伪直播 EVENT 流）。
   *
   * 播放列表从本会话已生成的第一片开始（MEDIA-SEQUENCE 固定），hls.js 增量解析；
   * 同时通过 info() 告诉前端：本会话起点、已转码到的最远位置、第一个分片起点，
   * 前端据此决定“直接静默跳转”还是“换会话 / 等转码追上”。
   */
  playlist(): string | null {
    const segs = this.segments
    if (!segs.length) return null
    // 首片太短时先等一会儿，避免整个流的时间轴起点过短
    if (!this.ended && segs.length === 1 && segs[0].duration < this.minSegment * 0.8) return null
    const finished = this.ended
    const windowSegs = segs.slice(0, 4000)
    const target = Math.max(SEGMENT_SECONDS, ...windowSegs.map((s) => Math.ceil(s.duration)))
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${target}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
    ]
    if (finished) lines.push('#EXT-X-ENDLIST')
    for (const s of windowSegs) {
      lines.push(`#EXTINF:${s.duration.toFixed(3)},`)
      lines.push(`seg/${s.name}`)
    }
    return lines.join('\n') + '\n'
  }

  /** 本会话进度：分片覆盖的全局时间轴区间（秒，源文件时间轴） */
  info(): SessionInfo {
    const segs = this.segments
    const last = segs[segs.length - 1]
    return {
      id: this.id,
      start: this.startTime || 0,
      // 分片在全局时间轴上对应 [firstStart, frontier]
      firstStart: segs.length && this.startTime > 0 ? this.startTime : 0,
      frontier: last ? (this.startTime || 0) + last.start + last.duration : this.startTime || 0,
      ended: this.ended,
      error: this.error || null,
      encoder: this.encoder,
    }
  }

  segmentFile(name: string): string | null {
    if (!/^seg-\d{5}\.ts$/.test(name)) return null
    const file = path.join(this.dir, name)
    return fs.existsSync(file) ? file : null
  }

  stop(): void {
    try {
      this.child?.kill('SIGKILL')
    } catch {}
  }
}

/** 时间戳归一：-ss 到 5 秒多重映射点附近时，前面的 B 帧 PTS 会变成超大值（33bit 边界），这里还原 */
const PTS_MAX = 2 ** 33 / 90000
function normalizePts(t: number, base: number | null | undefined): number {
  if (base === undefined || base === null) return t
  let v = t
  while (v - base > PTS_MAX / 2) v -= PTS_MAX
  while (base - v > PTS_MAX / 2) v += PTS_MAX
  return v
}

const PTS_WRAP = 2 ** 33 / 90000 // 33bit 90kHz ≈ 95443.7s（约 26.5 小时）回绕

/** 从 TS 包读 PTS（33bit，90kHz），无 PES 头时返回 null；自动处理 26.5 小时回绕 */
let lastPts: number | null = null
function readPts(buf: Buffer, off: number): number | null {
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
  // null 在关系比较里经 ToNumber 等价于 0，显式写出以保持原有求值顺序与结果
  if (t > (lastPts ?? 0) || lastPts === null) lastPts = t
  return t
}

/**
 * 取出一个 TS 包里视频 PES 的负载（跳过 TS 头、自适应字段、PES 头）。
 * mpegts 封装常常每包都带 PES 头，所以不能假设「只有 PUSI 包有 PES 头」。
 */
function videoPayload(pkt: Buffer): Buffer | null {
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
function scanNals(buf: Buffer, session: Session): boolean {
  const isH264 = session.isH264
  let key = false
  let count = 0
  let i = 0
  while (true) {
    const sc = buf.indexOf(START_CODE, i)
    if (sc < 0) break
    const h = sc + 3
    if (h >= buf.length) break
    const raw = buf[h]
    // 编码格式由输出参数决定：libx264/vaapi/nvenc h264 → H.264，否则 HEVC
    // 一次 scan 里可能扫到多个 NAL（跨包拼接），只认第一个 IDR
    if (isH264 ? (raw & 0x1f) === 5 : (raw >> 1) >= 16 && (raw >> 1) <= 21) {
      if (!key) {
        key = true
        count++
      }
    }
    i = h + 1
  }
  return key
}

/**
 * 把视频负载拼进滚动 Annex-B 缓冲并检测关键帧。
 * 若本块内出现关键帧，返回该包 PTS（切片点）。
 */
function feedNal(session: Session, pkt: Buffer, pktPts: number | null): number | null {
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

/** Register session state before starting its ffmpeg producer. */
export function createSession(id: string, absPath: string, startTime: number, info: MediaProbe | null): Session {
  const session = new Session(id, absPath, info)
  // 起始位置限制在时长内（避免 -ss 超过片长导致空流）
  const dur = Number(info?.duration) || 0
  session.startTime = dur > 0 ? Math.max(0, Math.min(Math.floor(startTime), Math.floor(dur) - 2)) : Math.floor(startTime)
  sessions.set(id, session)
  return session
}

export async function getOrCreateSession(absPath: string, startTime: number, info: MediaProbe | null): Promise<Session> {
  const probe = await buildTranscodeArgs(absPath, info, { startTime: 0 })
  const id = sessionIdFor(absPath, startTime, probe.encoder || '')
  let s = sessions.get(id)
  if (s && !s.ended) {
    s.lastActive = Date.now()
    return s
  }
  s = createSession(id, absPath, startTime, info)
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
const idleTimer: NodeJS.Timeout = setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastActive > TIMEOUT_MS) {
      s.stop()
      sessions.delete(id)
    }
  }
}, 30_000)
idleTimer.unref()

/** 分片目录用久了会变大：超过上限时清理最久未使用的会话目录 */
async function pruneCache(): Promise<void> {
  const MAX_BYTES = Number(process.env.HLS_CACHE_MAX_MB || 4096) * 1024 * 1024
  let total = 0
  const dirs: CacheEntry[] = []
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
const pruneTimer: NodeJS.Timeout = setInterval(() => pruneCache().catch(() => {}), 5 * 60_000)
pruneTimer.unref()
const initialPruneTimer: NodeJS.Timeout = setTimeout(() => pruneCache().catch(() => {}), 10_000)
initialPruneTimer.unref()

export function sessionById(id: string): Session | undefined {
  const s = sessions.get(id)
  if (s) s.lastActive = Date.now()
  return s
}

export const HLS_DIR: string = DIR

/** 进程退出时结束全部转码会话 */
export function stopAllSessions(): void {
  for (const s of sessions.values()) s.stop()
  sessions.clear()
}
