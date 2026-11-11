import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Readable } from 'node:stream'
import { HttpError } from '../errors.ts'
import { ffmpegPath, hasFFmpeg, subtitleToVtt } from './ffmpeg.service.ts'

/**
 * 字幕转换缓存。
 *
 * 内挂字幕只能由 ffmpeg 顺序解封装整个视频才能取到——慢速磁盘 / 网络存储上一次要几十秒到数分钟。
 * 因此这里做三件事：
 * 1. 按「源文件 + 大小 + mtime + 轨道」缓存 WebVTT，重复选择同一字幕直接命中；
 * 2. 首次提取时把 ffmpeg stdout 边产生边推给浏览器（原生 <track> 会渐进解析），首条字幕很快就能显示；
 * 3. 同一字幕的并发请求共享同一次提取，客户端全部断开时停止提取，避免白占磁盘带宽。
 */

/** 内挂字幕提取上限；读整个视频文件在慢速存储上可能很慢，超时只影响本次会话。 */
const DEFAULT_TIMEOUT_MS = Math.max(60_000, Number(process.env.SUBTITLE_EXTRACT_TIMEOUT_MS) || 30 * 60 * 1000)
/** 内存里保留的 VTT 上限，超过后只继续流式转发、不再缓存（内挂文本字幕通常只有几十 KB）。 */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
/** 非 UTF-8 外挂字幕的常见编码，和旧逻辑保持一致。 */
const CHARSET_CANDIDATES = ['gb18030', 'big5', 'shift_jis', 'euc-kr'] as const

/** 一次字幕请求：命中缓存时 stream 从本地缓存文件读取，否则是提取进程的实时输出。 */
export interface SubtitleStream {
  cached: boolean
  length?: number
  stream: Readable
}

export interface SubtitleServiceOptions {
  dataDir: string
  timeoutMs?: number
}

export interface SubtitleService {
  /** 内挂字幕：命中缓存直接返回，否则开始（或加入）一次提取并把输出流式返回。 */
  openEmbedded(absPath: string, streamIndex: number): Promise<SubtitleStream>
  /** 外挂字幕：转成 WebVTT 并缓存；失败时回退为按文本读取。 */
  externalVtt(absPath: string, extension: string): Promise<string>
  close(): void
}

interface CacheStat {
  size: number
  mtimeMs: number
}

function toWebVtt(text: string, extension: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (/^\s*WEBVTT/.test(normalized)) return normalized
  return 'WEBVTT\n\n' + (extension === '.srt' ? normalized.replace(/^\s*\d+\s*$/gm, '') : normalized)
}

function cacheKey(absPath: string, stat: CacheStat, streamIndex: number | null): string {
  const identity = `${absPath}|${stat.size}|${stat.mtimeMs}|${streamIndex === null ? 'external' : `s${streamIndex}`}`
  return crypto.createHash('sha1').update(identity).digest('hex')
}

async function readCache(file: string): Promise<string | null> {
  try {
    const text = await fs.readFile(file, 'utf8')
    return text || null
  } catch {
    return null
  }
}

async function statCache(file: string): Promise<CacheStat | null> {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

/** 一次正在进行的提取：缓存已产出的字节、广播给实时客户端。 */
class Extraction {
  readonly absPath: string
  readonly streamIndex: number | null
  readonly cacheFile: string
  readonly tmpFile: string
  private readonly timeoutMs: number
  private readonly onSettled: () => void
  private readonly chunks: Buffer[] = []
  private bufferedBytes = 0
  private bytes = 0
  private overflow = false
  private attemptIndex = 0
  private timedOut = false
  private settled = false
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private stderr = ''
  private readers = new Set<PassThrough>()

  constructor(
    absPath: string,
    streamIndex: number,
    cacheFile: string,
    tmpFile: string,
    timeoutMs: number,
    onSettled: () => void,
  ) {
    this.absPath = absPath
    this.streamIndex = streamIndex
    this.cacheFile = cacheFile
    this.tmpFile = tmpFile
    this.timeoutMs = timeoutMs
    this.onSettled = onSettled
  }

  start(): void {
    this.spawnFfmpeg()
  }

  /** 把已产出的内容回放给新客户端，之后继续接收实时输出。 */
  addReader(reader: PassThrough): void {
    // 客户端提前断开时不要因为写入已销毁的流而抛错
    reader.on('error', () => this.readers.delete(reader))
    if (this.settled) {
      if (this.bytes > 0) {
        for (const chunk of this.chunks) if (!reader.destroyed) reader.write(chunk)
        reader.end()
      } else {
        reader.destroy(new Error(this.stderr.slice(-300) || '字幕提取失败'))
      }
      return
    }
    for (const chunk of this.chunks) reader.write(chunk)
    this.readers.add(reader)
    reader.on('close', () => {
      this.readers.delete(reader)
      // 浏览器切换字幕会中断 <track> 请求：没人再要这份字幕时就不要继续占用慢速磁盘。
      if (!this.settled && this.readers.size === 0) this.cancel()
    })
  }

  cancel(): void {
    if (this.settled) return
    this.settled = true
    this.clearTimer()
    try {
      this.child?.kill('SIGKILL')
    } catch {}
    for (const reader of this.readers) reader.destroy()
    this.readers.clear()
    void fs.rm(this.tmpFile, { force: true }).catch(() => undefined)
    this.onSettled()
  }

  private spawnFfmpeg(): void {
    const ffmpeg = ffmpegPath()
    if (!ffmpeg) {
      this.fail('服务端未安装 ffmpeg，无法提取内挂字幕')
      return
    }
    const encoding = this.attemptIndex === 0 ? null : CHARSET_CANDIDATES[this.attemptIndex - 1]
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
    if (encoding) args.push('-sub_charenc', encoding)
    args.push(
      '-i', this.absPath,
      '-map', this.streamIndex === null ? '0:s:0' : `0:${this.streamIndex}`,
      '-f', 'webvtt', '-',
    )
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000)
    })
    child.on('error', (error: Error) => this.fail(error.message))
    child.on('close', (code: number | null) => this.onClose(code))
    this.timer = setTimeout(() => {
      this.timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {}
    }, this.timeoutMs)
    this.timer.unref?.()
  }

  private onData(chunk: Buffer): void {
    this.bytes += chunk.length
    if (this.bufferedBytes + chunk.length <= MAX_BUFFERED_BYTES) {
      this.chunks.push(chunk)
      this.bufferedBytes += chunk.length
    } else {
      this.overflow = true
    }
    for (const reader of this.readers) {
      if (!reader.destroyed) reader.write(chunk)
    }
  }

  private onClose(code: number | null): void {
    this.clearTimer()
    if (this.settled) return
    if (code === 0 && this.bytes > 0) {
      void this.finish()
      return
    }
    // 第一遍没有任何输出：可能只是字幕编码不是 UTF-8，换常见编码再试；有输出则不再重读整个文件。
    if (this.bytes === 0 && !this.timedOut && this.attemptIndex < CHARSET_CANDIDATES.length) {
      this.attemptIndex += 1
      this.stderr = ''
      this.spawnFfmpeg()
      return
    }
    this.fail(this.timedOut ? '字幕提取超时' : this.stderr.slice(-300) || `ffmpeg 退出码 ${code}`)
  }

  private async finish(): Promise<void> {
    this.settled = true
    const data = this.overflow ? null : Buffer.concat(this.chunks)
    if (data) {
      try {
        await fs.mkdir(path.dirname(this.cacheFile), { recursive: true })
        await fs.writeFile(this.tmpFile, data)
        await fs.rename(this.tmpFile, this.cacheFile)
      } catch {
        await fs.rm(this.tmpFile, { force: true }).catch(() => undefined)
      }
    }
    // 缓存写完再结束响应：紧随其后的第二次请求才能稳定命中，不会重复读整个视频。
    for (const reader of this.readers) reader.end()
    this.readers.clear()
    this.onSettled()
  }

  private fail(message: string): void {
    if (this.settled) return
    this.settled = true
    this.clearTimer()
    try {
      this.child?.kill('SIGKILL')
    } catch {}
    this.onSettled()
    const failure = new Error(message)
    for (const reader of this.readers) {
      // 已经流出部分 VTT 时安静收尾（浏览器会保留已显示的字幕），一个字节都没产出才把错误交给请求方。
      if (this.bytes > 0) reader.end()
      else reader.destroy(failure)
    }
    this.readers.clear()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

export function createSubtitleService({ dataDir, timeoutMs = DEFAULT_TIMEOUT_MS }: SubtitleServiceOptions): SubtitleService {
  const cacheDir = path.join(dataDir, 'subtitles')
  const inflight = new Map<string, Extraction>()
  const externalInflight = new Map<string, Promise<string>>()
  let closed = false

  const cacheFileFor = (key: string): string => path.join(cacheDir, `${key}.vtt`)
  const partFileFor = (key: string): string => path.join(cacheDir, `${key}.${process.pid}.part`)

  // 上次进程残留的 .part 文件没有意义，启动时顺手清掉。
  void fs.mkdir(cacheDir, { recursive: true })
    .then(async () => {
      for (const name of await fs.readdir(cacheDir)) {
        if (name.endsWith('.part')) await fs.rm(path.join(cacheDir, name), { force: true }).catch(() => undefined)
      }
    })
    .catch(() => undefined)

  async function externalVtt(absPath: string, extension: string): Promise<string> {
    const stat = await fs.stat(absPath)
    const key = cacheKey(absPath, stat, null)
    const cacheFile = cacheFileFor(key)
    const cached = await readCache(cacheFile)
    if (cached !== null) return cached
    const pending = externalInflight.get(key)
    if (pending) return pending
    const task = (async (): Promise<string> => {
      const conversion = hasFFmpeg() ? await subtitleToVtt(absPath, null) : null
      let text = conversion?.vtt ?? null
      if (!text) {
        const raw = await fs.readFile(absPath, 'utf8').catch(() => null)
        if (raw === null) throw new HttpError(415, '无法读取字幕')
        text = toWebVtt(raw, extension)
      }
      const data = text
      // 原子写缓存：避免并发请求读到写了一半的文件。
      try {
        await fs.mkdir(cacheDir, { recursive: true })
        const tmp = path.join(cacheDir, `${key}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`)
        await fs.writeFile(tmp, data)
        await fs.rename(tmp, cacheFile)
      } catch {
        // 缓存写失败不影响本次响应
      }
      return data
    })().finally(() => externalInflight.delete(key))
    externalInflight.set(key, task)
    return task
  }

  async function openEmbedded(absPath: string, streamIndex: number): Promise<SubtitleStream> {
    if (!hasFFmpeg()) throw new HttpError(500, '服务端未安装 ffmpeg，无法提取内挂字幕')
    const stat = await fs.stat(absPath)
    const key = cacheKey(absPath, stat, streamIndex)
    const cacheFile = cacheFileFor(key)
    const cached = await statCache(cacheFile)
    if (cached) {
      return { cached: true, length: cached.size, stream: fsSync.createReadStream(cacheFile) }
    }
    let extraction = inflight.get(key)
    if (!extraction) {
      const created = new Extraction(
        absPath, streamIndex, cacheFile, partFileFor(key), timeoutMs,
        () => inflight.delete(key),
      )
      inflight.set(key, created)
      extraction = created
      created.start()
    }
    const reader = new PassThrough()
    extraction.addReader(reader)
    return { cached: false, stream: reader }
  }

  // 字幕缓存都是小文件；设个上限，淘汰最久未使用的，避免长期积累。
  const pruneTimer: NodeJS.Timeout = setInterval(() => {
    void (async () => {
      const maxBytes = Math.max(16, Number(process.env.SUBTITLE_CACHE_MAX_MB) || 256) * 1024 * 1024
      let total = 0
      const entries: Array<{ full: string; size: number; mtime: number }> = []
      for (const name of await fs.readdir(cacheDir).catch((): string[] => [])) {
        if (!name.endsWith('.vtt')) continue
        const full = path.join(cacheDir, name)
        const stat = await fs.stat(full).catch(() => null)
        if (!stat?.isFile()) continue
        entries.push({ full, size: stat.size, mtime: stat.mtimeMs })
        total += stat.size
      }
      if (total <= maxBytes) return
      entries.sort((a, b) => a.mtime - b.mtime)
      for (const entry of entries) {
        if (total <= maxBytes * 0.8) break
        await fs.rm(entry.full, { force: true }).catch(() => undefined)
        total -= entry.size
      }
    })().catch(() => undefined)
  }, 10 * 60_000)
  pruneTimer.unref?.()

  return {
    openEmbedded,
    externalVtt,
    close(): void {
      if (closed) return
      closed = true
      clearInterval(pruneTimer)
      for (const extraction of inflight.values()) extraction.cancel()
      inflight.clear()
    },
  }
}
