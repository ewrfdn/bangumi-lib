import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '../..')

/** 极简 .env 加载（不覆盖已有环境变量） */
function loadDotEnv() {
  const file = process.env.ENV_FILE || path.join(PROJECT_ROOT, '.env')
  if (!fs.existsSync(file)) return
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}
loadDotEnv()

function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function resolveRoot() {
  const raw = process.env.BANGUMI_ROOT || process.env.MEDIA_ROOT || '~/bangumi'
  const abs = path.resolve(expandHome(raw))
  if (!fs.existsSync(abs)) {
    console.warn(`[config] 媒体根目录不存在：${abs}（请检查 BANGUMI_ROOT）`)
  }
  return abs
}

let cachedRoot = resolveRoot()

export const config = {
  get mediaRoot() {
    return cachedRoot
  },
  setMediaRoot(next) {
    const abs = path.resolve(expandHome(next))
    cachedRoot = abs
    process.env.BANGUMI_ROOT = abs
  },
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8088),
  ffmpeg: {
    ffmpegPath: process.env.FFMPEG_PATH || '',
    ffprobePath: process.env.FFPROBE_PATH || '',
    videoCodec: process.env.TRANSCODE_VIDEO_CODEC || '',
    preset: process.env.TRANSCODE_VIDEO_PRESET || '',
    bitrate: process.env.TRANSCODE_VIDEO_BITRATE || '',
    hwaccel: process.env.TRANSCODE_HWACCEL || '',
    maxBitrate: process.env.TRANSCODE_MAX_BITRATE || '',
    audioBitrate: process.env.TRANSCODE_AUDIO_BITRATE || '192k',
    tonemap: process.env.TRANSCODE_TONEMAP !== '0',
  },
  dataDir: path.join(PROJECT_ROOT, 'data'),
}
