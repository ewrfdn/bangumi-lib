import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-subtitle-'))
const libraryRoot = path.join(temporary, 'library')
await fs.mkdir(path.join(libraryRoot, 'Show'), { recursive: true })

process.env.ENV_FILE = path.join(temporary, 'missing.env')
process.env.DATA_DIR = path.join(temporary, 'data')
process.env.BANGUMI_LIBRARY = libraryRoot
delete process.env.MOVIE_LIBRARY

const { createApp } = await import('../src/app.ts')
const { ffmpegPath } = await import('../src/service/ffmpeg.service.ts')
const run = promisify(execFile)
after(() => fs.rm(temporary, { recursive: true, force: true }))

/** 生成一个带内挂文本字幕的小视频；没有 ffmpeg 的机器跳过这些用例。 */
async function makeEmbeddedVideo(): Promise<boolean> {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) return false
  const srt = path.join(temporary, 'cues.srt')
  await fs.writeFile(srt, [
    '1', '00:00:01,000 --> 00:00:02,000', '第一条字幕', '',
    '2', '00:00:03,000 --> 00:00:04,000', '第二条字幕', '',
  ].join('\n'))
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:size=160x120:rate=1:duration=5',
    '-i', srt,
    '-map', '0:v', '-map', '1:s',
    '-c:v', 'mpeg4', '-c:s', 'srt',
    '-y', path.join(libraryRoot, 'Show', '01.mkv'),
  ], { timeout: 60_000 })
  return true
}

async function makeApp() {
  const app = await createApp({ dbPath: ':memory:', logger: false, authSecret: '' })
  await app.ready()
  return app
}

const query = (virtualPath: string, extra: Record<string, string | number> = {}): string =>
  new URLSearchParams({ path: virtualPath, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString()

test('embedded subtitles are converted progressively and cached per file version', async () => {
  if (!(await makeEmbeddedVideo())) return
  const app = await makeApp()
  try {
    const info = await app.inject(`/api/video?${query('/Show/01.mkv')}`)
    assert.equal(info.statusCode, 200)
    const stream = info.json().streams.find((entry: { text: boolean }) => entry.text)
    assert.ok(stream, '视频应探测到内挂文本字幕')

    const first = await app.inject(`/api/stream-subtitle?${query('/Show/01.mkv', { index: stream.index })}`)
    assert.equal(first.statusCode, 200)
    assert.match(first.headers['content-type'] as string, /^text\/vtt/)
    assert.equal(first.headers['x-subtitle-cache'], 'miss')
    assert.match(first.body, /^WEBVTT/)
    assert.match(first.body, /第一条字幕/)
    assert.match(first.body, /第二条字幕/)

    // 第一次提取完成后落盘；第二次请求直接命中缓存，不再读整个视频。
    const cacheDir = path.join(temporary, 'data', 'subtitles')
    const files = (await fs.readdir(cacheDir)).filter((name) => name.endsWith('.vtt'))
    assert.equal(files.length, 1)

    const second = await app.inject(`/api/stream-subtitle?${query('/Show/01.mkv', { index: stream.index })}`)
    assert.equal(second.statusCode, 200)
    assert.equal(second.headers['x-subtitle-cache'], 'hit')
    assert.equal(second.headers['content-length'], String(Buffer.byteLength(second.body)))
    assert.equal(second.body, first.body)
  } finally {
    await app.close()
  }
})

test('invalid embedded subtitle indexes are rejected without extracting', async () => {
  const app = await makeApp()
  try {
    const negative = await app.inject(`/api/stream-subtitle?${query('/Show/01.mkv', { index: -1 })}`)
    assert.equal(negative.statusCode, 400)
    const missingIndex = await app.inject(`/api/stream-subtitle?${query('/Show/01.mkv')}`)
    assert.equal(missingIndex.statusCode, 400)
  } finally {
    await app.close()
  }
})

test('external subtitle files are converted to WebVTT and cached', async () => {
  const app = await makeApp()
  try {
    const file = path.join(libraryRoot, 'Show', '01.srt')
    await fs.writeFile(file, '1\n00:00:01,000 --> 00:00:02,000\n外挂字幕\n')
    const first = await app.inject(`/api/subtitle?${query('/Show/01.srt')}`)
    assert.equal(first.statusCode, 200)
    assert.match(first.headers['content-type'] as string, /^text\/vtt/)
    assert.match(first.body, /外挂字幕/)
    assert.match(first.body, /^WEBVTT/)

    const second = await app.inject(`/api/subtitle?${query('/Show/01.srt')}`)
    assert.equal(second.statusCode, 200)
    assert.equal(second.body, first.body)
  } finally {
    await app.close()
  }
})
