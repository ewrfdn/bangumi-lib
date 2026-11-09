import { spawn, execFile } from 'node:child_process'
import type { ChildProcess, ExecFileException } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { config, PROJECT_ROOT } from '../config.ts'

/** `run()` / `spawnCollect()` 统一返回的子进程输出。 */
interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** 一个视频编码方案（探测结果与缓存共用）。 */
export interface EncoderPipeline {
  encoder: string
  /** 需要 VAAPI 设备与 hwupload 滤镜链 */
  vaapi?: boolean
  /** 纯软件编码，无需在该源上验证 GPU 解码 */
  software?: boolean
  /** 编码器可用性探测时需要预先追加的参数 */
  probeArgs?: string[]
}

/** ffprobe `-of json` 的原始输出结构（动态 JSON 边界：除 index/codec_type 外多数字段可缺失）。 */
interface FfprobeStream {
  /** ffprobe 对每条流都会输出序号 */
  index: number
  codec_type: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  bit_rate?: string | number
  pix_fmt?: string
  channels?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  color_transfer?: string
  color_primaries?: string
  disposition?: { attached_pic?: number }
  tags?: { language?: string; title?: string }
}

interface FfprobeFormat {
  duration?: string | number
  size?: string | number
  bit_rate?: string | number
  format_name?: string
}

interface FfprobeJson {
  streams?: FfprobeStream[]
  format?: FfprobeFormat
}

/** 归一化后的视频流信息。 */
export interface MediaProbeVideo {
  codec: string
  profile: string
  width: number
  height: number
  pixFmt: string
  fps: number
  bitrate: number
  hdr: boolean
  colorTransfer: string
  colorPrimaries: string
  browserPlayable: boolean
  hevc: boolean
}

export interface MediaProbeAudio {
  index: number
  codec: string
  channels: number
  language: string
  title: string
  default: boolean
}

export interface MediaProbeSubtitle {
  index: number
  codec: string
  language: string
  title: string
  text: boolean
}

/** `probe()` 归一化后的媒体信息。 */
export interface MediaProbe {
  format: string
  duration: number
  size: number
  bitrate: number
  video: MediaProbeVideo | null
  audio: MediaProbeAudio[]
  subtitles: MediaProbeSubtitle[]
}

/** 字幕转换成功：带 vtt，error 不存在。 */
export interface SubtitleVttResult {
  vtt: string
  error?: undefined
}

/** 字幕转换失败：带 error，vtt 不存在。 */
export interface SubtitleFailureResult {
  error: string
  vtt?: undefined
}

export type SubtitleConvertResult = SubtitleVttResult | SubtitleFailureResult

/** 转码参数生成成功：带 args/encoder，error 不存在。 */
export interface TranscodeArgsResult {
  args: string[]
  encoder: string
  error?: undefined
}

/** 转码参数生成失败：带 error，args/encoder 不存在。 */
export interface TranscodeFailureResult {
  error: string
  args?: undefined
  encoder?: undefined
}

export type TranscodeBuildResult = TranscodeArgsResult | TranscodeFailureResult

/** `buildTranscodeArgs()` 需要的探测信息最小视图（`MediaProbe` 与 hls 模块的 `ProbeInfo` 都满足）。 */
export interface TranscodeProbeInfo {
  bitrate?: number
  video?: {
    bitrate?: number
    fps?: number
    hdr?: boolean
    colorTransfer?: string
  } | null
  audio?: Array<{ index?: number }>
}

/** `buildTranscodeArgs()` 的可选参数。 */
export interface TranscodeOptions {
  startTime?: number
  segmentSeconds?: number
  forceSoftware?: boolean
}

/** `capabilities()` 返回的 ffmpeg 能力快照。 */
export interface FfmpegCapabilities {
  ffmpeg: string | null
  ffprobe: string | null
  hwaccels: string[]
  encoders: string[]
  transcode: EncoderPipeline | null
  probeLatencyMs: number | null
}

interface ProbeCacheEntry {
  at: number
  value: MediaProbe | null
}

interface FfmpegState {
  ffmpeg: string | null
  ffprobe: string | null
  hwList: string[] | null
  encoders: Set<string> | null
  probeCache: Map<string, ProbeCacheEntry>
  probeDelayMs: number | null
  pipeline: EncoderPipeline | null
  encoderOk: Map<string, boolean>
}

const isWin = process.platform === 'win32'
const exe = (name: string): string => (isWin ? `${name}.exe` : name)

/** 候选路径：env > 项目 tools/ > PATH */
function candidates(name: string, envPath: string): string[] {
  const list: string[] = []
  if (envPath) list.push(envPath)
  list.push(path.join(PROJECT_ROOT, 'tools', 'ffmpeg', 'bin', exe(name)))
  list.push(path.join(PROJECT_ROOT, 'tools', name, exe(name)))
  list.push(path.join(os.homedir(), '.local', 'bin', exe(name)))
  list.push(`/usr/local/bin/${name}`)
  list.push(`/opt/homebrew/bin/${name}`)
  list.push(`/usr/bin/${name}`)
  return list
}

function whichSync(name: string): string | null {
  const paths = (process.env.PATH || '').split(path.delimiter)
  for (const p of paths) {
    const full = path.join(p, exe(name))
    try {
      fs.accessSync(full, fs.constants.X_OK)
      return full
    } catch {}
  }
  return null
}

function findBinary(name: string, envPath: string): string | null {
  for (const c of candidates(name, envPath)) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {}
  }
  return whichSync(name)
}

const state: FfmpegState = {
  ffmpeg: findBinary('ffmpeg', config.ffmpeg.ffmpegPath),
  ffprobe: findBinary('ffprobe', config.ffmpeg.ffprobePath),
  hwList: null,
  encoders: null,
  probeCache: new Map<string, ProbeCacheEntry>(),
  probeDelayMs: null,
  pipeline: null, // { encoder, vaapi?, software? }
  encoderOk: new Map<string, boolean>(),
}

export function ffmpegPath(): string | null {
  return state.ffmpeg
}
export function ffprobePath(): string | null {
  return state.ffprobe
}
export const hasFFmpeg = (): boolean => Boolean(state.ffmpeg)
export const hasFFprobe = (): boolean => Boolean(state.ffprobe)

function run(cmd: string, args: string[], timeout = 15000): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err: ExecFileException | null, stdout: string, stderr: string) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

async function listEncoders(): Promise<Set<string>> {
  if (state.encoders) return state.encoders
  if (!state.ffmpeg) return new Set()
  const { stdout, stderr } = await run(state.ffmpeg, ['-hide_banner', '-encoders'])
  const text = stdout + stderr
  const set = new Set<string>()
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[VAS][A-Z.]{5}\s+(\S+)/)
    if (m) set.add(m[1])
  }
  state.encoders = set
  return set
}

async function listHwaccels(): Promise<string[]> {
  if (state.hwList) return state.hwList
  if (!state.ffmpeg) return []
  const { stdout, stderr } = await run(state.ffmpeg, ['-hide_banner', '-hwaccels'])
  const list: string[] = (stdout + stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('Hardware acceleration methods') && !l.startsWith('ffmpeg version') && !l.includes('configuration'))
  state.hwList = list
  return list
}

/**
 * 探测某个硬件编码器是否真的可用（设备就绪），结果缓存。
 * 用 testsrc 编 1 帧，成功才算数。
 */
async function encoderWorks(encoder: string, extraArgs: string[] = []): Promise<boolean> {
  if (state.encoderOk.has(encoder)) return state.encoderOk.get(encoder) ?? false
  const ffmpeg = state.ffmpeg
  if (!ffmpeg) return false
  // 用真实视频帧测试（lavfi 的 testsrc 是 wrapped_avframe，会误判硬件编码可用）
  const r = await run(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error',
      ...extraArgs,
      '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=25:duration=0.2',
      ...(encoder.endsWith('_vaapi') ? ['-vf', 'format=nv12,hwupload'] : []),
      '-c:v', encoder, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
    ],
    20000,
  )
  state.encoderOk.set(encoder, r.ok)
  return r.ok
}

/** 用真实来源画面验证：硬件编码器从该文件解码再编码是否可行（GPU 被占用时会失败） */
const sourceOk = new Map<string, boolean>()
async function pipelineWorksOnSource(pipeline: EncoderPipeline | null, absPath: string): Promise<boolean> {
  if (!pipeline || pipeline.software) return true
  const key = `${pipeline.encoder}|${absPath}`
  if (sourceOk.has(key)) {
    if (sourceOk.get(key)) return true
    // 失败后 60 秒内不再重试（GPU 可能正被其他任务占用）
    return false
  }
  const ffmpeg = state.ffmpeg
  const args = ['-hide_banner', '-loglevel', 'error']
  if (/nvenc$/.test(pipeline.encoder)) args.push('-hwaccel', 'cuda')
  if (pipeline.vaapi) args.push('-vaapi_device', process.env.VAAPI_DEVICE || '/dev/dri/renderD128')
  args.push('-ss', '5', '-i', absPath, '-t', '1', '-map', '0:v:0')
  if (pipeline.vaapi) args.push('-vf', 'format=nv12,hwupload')
  args.push('-c:v', pipeline.encoder, '-pix_fmt', 'yuv420p', '-f', 'null', '-')
  // 能走到这里说明 pipeline 非空、ffmpeg 必然已就绪；保留 ffmpeg 为空时 execFile 抛错的原有行为
  const r = await run(ffmpeg as string, args, 20000)
  sourceOk.set(key, r.ok)
  if (!r.ok) setTimeout(() => sourceOk.delete(key), 60_000)
  return r.ok
}

/**
 * 选择转码编码方案。TRANSCODE_VIDEO_CODEC 可强制指定。
 * 优先级：Apple VT → NVENC → VAAPI → QSV → H.264 软件编码(DT_RPATH) → libx265 → AV1
 */
async function pickPipeline(): Promise<EncoderPipeline | null> {
  if (state.pipeline) return state.pipeline
  const encoders = await listEncoders()
  const has = (n: string): boolean => encoders.has(n)
  const vaapiDevice = process.env.VAAPI_DEVICE || '/dev/dri/renderD128'
  const vaapiArgs = ['-vaapi_device', vaapiDevice]

  const plan: EncoderPipeline[] = [
    { encoder: 'h264_videotoolbox' },
    { encoder: 'h264_nvenc' },
    { encoder: 'h264_vaapi', vaapi: true, probeArgs: vaapiArgs },
    { encoder: 'h264_qsv' },
    { encoder: 'libx264', software: true },
    { encoder: 'libx265', software: true },
    { encoder: 'hevc_vaapi', vaapi: true, probeArgs: vaapiArgs },
  ]
  if (config.ffmpeg.videoCodec) plan.unshift({ encoder: config.ffmpeg.videoCodec })
  for (const p of plan) {
    if (!has(p.encoder)) continue
    if (await encoderWorks(p.encoder, p.probeArgs || [])) {
      state.pipeline = p
      return p
    }
  }
  return null
}

/** 探测媒体信息（带内存缓存 + 慢速存储自适应） */
export async function probe(absPath: string): Promise<MediaProbe | null> {
  const cached = state.probeCache.get(absPath)
  if (cached && Date.now() - cached.at < 1000 * 60 * 30) return cached.value
  const ffprobe = state.ffprobe
  if (!ffprobe) return null
  const t0 = Date.now()
  const { ok, stdout } = await run(
    ffprobe,
    [
      '-v', 'error',
      '-show_entries',
      'format=duration,size,bit_rate,format_name:stream=index,codec_type,codec_name,profile,width,height,bit_rate,pix_fmt,channels,tags:stream_tags=language,title,BPS-eng,DURATION',
      '-of', 'json',
      absPath,
    ],
    120000,
  )
  const elapsed = Date.now() - t0
  if (!ok) {
    // 探测失败也缓存一会儿，避免反复卡顿
    state.probeCache.set(absPath, { at: Date.now(), value: null })
    return null
  }
  let raw: FfprobeJson = {}
  try {
    // JSON.parse 返回 any：ffprobe 输出属于外部动态 JSON 边界，此处断言为上面声明的结构
    raw = JSON.parse(stdout) as FfprobeJson
  } catch {}
  const value = normalizeProbe(raw)
  state.probeCache.set(absPath, { at: Date.now(), value })
  if (state.probeDelayMs === null) state.probeDelayMs = elapsed
  else state.probeDelayMs = Math.min(state.probeDelayMs, elapsed)
  return value
}

function normalizeProbe(raw: FfprobeJson): MediaProbe {
  const streams = raw.streams || []
  const fmt = raw.format || {}
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic))
  const audioStreams = streams.filter((s) => s.codec_type === 'audio')
  const subStreams = streams.filter((s) => s.codec_type === 'subtitle')
  const fps = parseFps(video?.avg_frame_rate || video?.r_frame_rate)
  const duration = Number(fmt.duration) || 0
  const codec = video?.codec_name || ''
  const pixFmt = video?.pix_fmt || ''
  const isHdr =
    /smpte2084|arib-std-b67/i.test(video?.color_transfer || '') ||
    /yuv420p10|yuv420p12|p010/i.test(pixFmt)
  return {
    format: fmt.format_name || '',
    duration,
    size: Number(fmt.size) || 0,
    bitrate: Number(fmt.bit_rate) || Number(video?.bit_rate) || 0,
    video: video
      ? {
          codec,
          profile: video.profile || '',
          width: video.width || 0,
          height: video.height || 0,
          pixFmt,
          fps,
          bitrate: Number(video.bit_rate) || 0,
          hdr: isHdr,
          colorTransfer: video?.color_transfer || '',
          colorPrimaries: video?.color_primaries || '',
          // 浏览器原生（MSE）可解码的编码
          browserPlayable: ['h264', 'vp8', 'vp9', 'av1'].includes(codec),
          hevc: codec === 'hevc' || codec === 'h265',
        }
      : null,
    audio: audioStreams.map((s, i) => ({
      index: s.index,
      codec: s.codec_name || '',
      channels: s.channels || 0,
      language: s.tags?.language || '',
      title: s.tags?.title || '',
      default: i === 0,
    })),
    subtitles: subStreams.map((s) => ({
      index: s.index,
      codec: s.codec_name || '',
      language: s.tags?.language || '',
      title: s.tags?.title || '',
      text: ['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text'].includes(s.codec_name || ''),
    })),
  }
}

function parseFps(rate: string | undefined): number {
  if (!rate || typeof rate !== 'string') return 0
  const [a, b] = rate.split('/').map(Number)
  if (!b) return a || 0
  return Math.round((a / b) * 100) / 100
}

/**
 * 抽取文本字幕并转 WebVTT
 * @param absPath 视频或 .ass/.srt 文件
 * @param streamIndex 内挂字幕流序号；null 表示普通字幕文件（0:s:0）
 */
export async function subtitleToVtt(absPath: string, streamIndex: number | null = null): Promise<SubtitleConvertResult> {
  const ffmpeg = state.ffmpeg
  if (!ffmpeg) return { error: '服务端未安装 ffmpeg，无法转换字幕' }
  const map = streamIndex === null ? '0:s:0' : `0:${streamIndex}`
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  const run = async (extra: string[]): Promise<RunResult> => {
    const args = [...base, ...extra, '-i', absPath, '-map', map, '-f', 'webvtt', '-']
    try {
      return await spawnCollect(ffmpeg, args, 180000)
    } catch (err) {
      // spawnCollect 只会抛出进程启动错误（Error）；非 Error 时保持原有的 String(err) 兜底
      const message = err instanceof Error ? err.message : err
      return { ok: false, stdout: '', stderr: String(message || err) }
    }
  }
  let r = await run([])
  // 非 UTF-8 的字幕（GBK/BIG5 等）：尝试常见编码重新解码
  if (!r.ok || !r.stdout.trim()) {
    for (const enc of ['gb18030', 'big5', 'shift_jis', 'euc-kr']) {
      const r2 = await run(['-sub_charenc', enc])
      if (r2.ok && r2.stdout.trim()) {
        r = r2
        break
      }
    }
  }
  if (!r.ok || !r.stdout.trim()) return { error: r.stderr.slice(0, 500) || '字幕转换失败' }
  const out = r.stdout.replace(/^\uFEFF/, '')
  return { vtt: out.startsWith('WEBVTT') ? out : 'WEBVTT\n\n' + out }
}

function spawnCollect(cmd: string, args: string[], timeout: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (c: number | null) => {
      clearTimeout(timer)
      resolve({ ok: c === 0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/**
 * 实时转码参数：任何浏览器放不了的编码 → H.264 (MPEG-TS → MSE)
 *  - 优先硬件编码（videotoolbox / nvenc / vaapi / qsv），否则 libx264 veryfast
 *  - 关键帧间隔固定 1s，方便前端卡顿时重置（hls.js 回退）
 */
export async function buildTranscodeArgs(
  absPath: string,
  probeInfo: TranscodeProbeInfo | null,
  { startTime = 0, segmentSeconds = 1, forceSoftware = false }: TranscodeOptions = {},
): Promise<TranscodeBuildResult> {
  if (!state.ffmpeg) return { error: '服务端没有可用的 ffmpeg' }
  let picked: EncoderPipeline | null = await pickPipeline()
  const encoders: Set<string> = picked ? await listEncoders() : new Set<string>()
  // 硬件编码在该源上不可用（GPU 被占用 / 驱动问题）→ 本文件改用软件编码
  if (picked && !forceSoftware && !(await pipelineWorksOnSource(picked, absPath))) {
    state.pipeline = null
    state.encoderOk.set(picked.encoder, false)
    picked = await pickPipeline()
  }
  // software=true：强制软解 + 软编（兜底，兼容性最好）
  // 兜底链为 libx264 → libx265 → 当前方案；当前方案为空时保留原有的 undefined（原逻辑如此）
  const pipe: EncoderPipeline | null = forceSoftware
    ? { encoder: encoders.has('libx264') ? 'libx264' : encoders.has('libx265') ? 'libx265' : (picked?.encoder as string), software: true }
    : picked
  if (!pipe) return { error: 'ffmpeg 缺少可用的 H.264 编码器' }
  const target = pipe.encoder
  const srcBitrate = probeInfo?.video?.bitrate || probeInfo?.bitrate || 0
  const bitrate = config.ffmpeg.bitrate || (srcBitrate > 0 ? `${Math.max(800, Math.round(srcBitrate / 1000))}k` : '8M')
  const maxrate = config.ffmpeg.maxBitrate || bitrate
  const software = !['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_vaapi', 'hevc_vaapi', 'h264_qsv', 'hevc_qsv', 'h264_videotoolbox', 'hevc_videotoolbox'].includes(target)
  const capRate = (() => {
    const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(bitrate)
    if (!m) return maxrate
    const n = Number(m[1]) * (/[kK]/.test(m[2]) ? 1 : /[mM]/.test(m[2]) ? 1000 : 1 / 1000)
    const v = Math.min(Math.max(n * 1.6, 4000), 16000)
    return `${Math.round(v)}k`
  })()

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].includes(target)) {
    // 用 GPU 解码（HEVC Main10 / AV1 都支持），CPU 只负责封装
    args.push('-hwaccel', 'cuda')
  }
  // 关键：-ss 放在 -i 之前 = 输入侧快速定位（按索引跳到最近关键帧，不解码前面的内容）。
  // 即使从 0 开始也带上，避免走「精确 seek」路径而按 1x 实时解码。
  args.push('-ss', String(Math.max(0, Number(startTime) || 0)))
  args.push('-noaccurate_seek')
  args.push('-i', absPath)

  // 关键帧间隔与切片长度一致，切片才能严格按 keyint 切
  const keyint = Math.max(2, Math.round(segmentSeconds * (probeInfo?.video?.fps || 24)))
  const codecArgTable: Record<string, string[]> = {
    libx264: [
      '-preset', config.ffmpeg.preset || 'veryfast',
      '-profile:v', 'high',
      '-x264-params',
      [
        'scenecut=0',
        `keyint=${keyint}`,
        `min-keyint=${keyint}`,
        'bframes=0',
        config.ffmpeg.rcLookahead ? `rc-lookahead=${config.ffmpeg.rcLookahead}:lookahead-threads=1` : '',
      ]
        .filter(Boolean)
        .join(':'),
      ...(config.ffmpeg.threads ? ['-threads', String(config.ffmpeg.threads)] : []),
      '-b:v', bitrate, '-maxrate', maxrate, '-bufsize', '4M',
    ],
    libx265: ['-preset', config.ffmpeg.preset || 'ultrafast', '-x265-params', 'log-level=error', '-b:v', bitrate],
    libsvtav1: ['-preset', '10', '-b:v', bitrate],
    h264_videotoolbox: ['-b:v', bitrate, '-allow_sw', '1', '-realtime', '1'],
    hevc_videotoolbox: ['-b:v', bitrate, '-allow_sw', '1', '-tag:v', 'hvc1'],
    // NVENC：VBR + CQ，画质优先档（p5=hq），带空间自适应量化
    h264_nvenc: ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', bitrate, '-maxrate', capRate, '-spatial-aq', '1'],
    hevc_nvenc: ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '25', '-b:v', bitrate, '-maxrate', capRate, '-tag:v', 'hvc1'],
    h264_vaapi: ['-b:v', bitrate],
    hevc_vaapi: ['-b:v', bitrate],
    h264_qsv: ['-preset', 'fast', '-b:v', bitrate],
    hevc_qsv: ['-preset', 'fast', '-b:v', bitrate],
  }
  const codecArgs: string[] = codecArgTable[target] || ['-b:v', bitrate]

  const videoFilters: string[] = []
  const nvdec = ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].includes(target)
  if (pipe.vaapi) videoFilters.push('format=nv12', 'hwupload')
  // HDR → SDR（默认开启；TRANSCODE_TONEMAP=0 可关闭）。需源带颜色元数据，否则 zscale 会报错
  const tonemap = config.ffmpeg.tonemap
  if (probeInfo?.video?.hdr && tonemap && probeInfo.video.colorTransfer) {
    videoFilters.unshift('zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:r=tv')
  }

  const audioIndex = probeInfo?.audio?.[0]?.index ?? -1
  const finalArgs = [
    ...args,
    ...(pipe.vaapi ? ['-vaapi_device', process.env.VAAPI_DEVICE || '/dev/dri/renderD128'] : []),
    '-map', '0:v:0',
    ...(audioIndex >= 0 ? ['-map', `0:${audioIndex}`] : ['-map', '0:a:0?']),
    ...(videoFilters.length ? ['-vf', videoFilters.join(',')] : []),
    '-c:v', target,
    ...codecArgs,
    // 软件编码统一输出 8bit yuv420p；硬件编码有 cuda/vaapi 格式链，交给滤镜处理
    ...(software || nvdec ? ['-pix_fmt', 'yuv420p'] : []),
    '-g', String(keyint),
    '-c:a', 'aac',
    '-b:a', config.ffmpeg.audioBitrate,
    '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0',
    // 调整封装队列（内存受限时可调小）
    '-max_muxing_queue_size', String(Number(process.env.TRANSCODE_MUX_QUEUE || 4096)),
    '-f', 'mpegts',
    '-',
  ]
  return { args: finalArgs, encoder: target }
}

export async function capabilities(): Promise<FfmpegCapabilities> {
  const encoders = await listEncoders()
  const hw = await listHwaccels()
  const pipeline = state.ffmpeg ? await pickPipeline() : null
  return {
    ffmpeg: state.ffmpeg,
    ffprobe: state.ffprobe,
    hwaccels: await listHwaccels(),
    encoders: [...encoders].filter((e) =>
      /hevc|h265|x265|x264|264|av1|svt|videotoolbox|nvenc|vaapi|qsv|vpx/.test(e),
    ),
    transcode: pipeline,
    probeLatencyMs: state.probeDelayMs,
  }
}
