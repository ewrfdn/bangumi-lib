import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyVideos, isSpecialVideo, parseEpisodeNumber } from '../src/service/video-classification.ts'

test('episode numbers are parsed from common release names', () => {
  assert.equal(parseEpisodeNumber('Bocchi the Rock - 01 [1080p].mkv'), 1)
  assert.equal(parseEpisodeNumber('Show S02E11.mkv'), 11)
  assert.equal(parseEpisodeNumber('Show 第3话.mkv'), 3)
  assert.equal(parseEpisodeNumber('Show - 11.5 [1080p].mp4'), 11.5)
  assert.equal(parseEpisodeNumber('Season 2 - 04.mkv'), 4)
  assert.equal(parseEpisodeNumber('Show 1080p.mkv'), null)
  assert.equal(parseEpisodeNumber('Show 720p.mkv'), null)
})

test('special directories and names are detected without matching SPY-style titles', () => {
  assert.equal(isSpecialVideo('特典/Show - Character PV 01.mkv'), true)
  assert.equal(isSpecialVideo('Show - NCOP.mkv'), true)
  assert.equal(isSpecialVideo('Show - 01.mkv'), false)
  assert.equal(isSpecialVideo('SPY×FAMILY - 01.mkv'), false)
  assert.equal(isSpecialVideo('Love Live! - 01.mkv'), false)
  assert.equal(isSpecialVideo('SP/Show - 01.mkv'), true)
})

test('Bangumi episode count splits main episodes from specials', () => {
  const files = [
    ...Array.from({ length: 12 }, (_, index) => ({ mediaPath: `Show - ${index + 1} [1080p].mkv` })),
    { mediaPath: 'Show - 11.5 [1080p].mp4' },
    ...['Character PV 01', 'Lyric Video 01', 'Menu01', 'NCOP'].map((name) => ({ mediaPath: `特典/Show - 特典 - ${name}.mkv` })),
  ]
  const result = classifyVideos(files, { episodeCount: 12 })
  const main = [...result.values()].filter((item) => item.videoType === 'main')
  const extra = [...result.values()].filter((item) => item.videoType === 'extra')
  assert.equal(main.length, 12)
  assert.deepEqual(main.map((item) => item.videoIndex).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.equal(extra.length, 5)
  assert.ok(extra.every((item) => item.videoIndex > 12))
  assert.equal(result.get('Show - 11.5 [1080p].mp4').videoType, 'extra')
})

test('without an episode count only explicit specials are extras', () => {
  const result = classifyVideos([
    { mediaPath: 'Movie.mkv' },
    { mediaPath: '特典/NCOP.mkv' },
    { mediaPath: 'Show - 01.mkv' },
  ], { episodeCount: null })
  assert.equal(result.get('Movie.mkv').videoType, 'main')
  assert.equal(result.get('Show - 01.mkv').videoType, 'main')
  assert.equal(result.get('特典/NCOP.mkv').videoType, 'extra')
})

test('unnumbered non-special files fall back to the first N main episodes', () => {
  const result = classifyVideos([
    { mediaPath: 'Show/01 - 序章.mkv' },
    { mediaPath: 'Show/02 - 第二话.mkv' },
    { mediaPath: 'Show/03 - 第三话.mkv' },
    { mediaPath: 'Show/特典/花絮.mkv' },
  ], { episodeCount: 3 })
  assert.deepEqual([...result.values()].filter((item) => item.videoType === 'main').map((item) => item.videoIndex), [1, 2, 3])
  assert.equal(result.get('Show/特典/花絮.mkv').videoType, 'extra')
})

test('a lone movie with a year in its name is still a main video', () => {
  const result = classifyVideos([{ mediaPath: 'Movie 999.mkv' }], { episodeCount: 1 })
  assert.equal(result.get('Movie 999.mkv').videoType, 'main')
  assert.equal(result.get('Movie 999.mkv').videoIndex, 1)
})

test('a folder starting at episode 13 is treated as a continuation when it fits the declared count', () => {
  const files = Array.from({ length: 12 }, (_, index) => ({ mediaPath: `Show - ${index + 13}.mkv` }))
  const result = classifyVideos(files, { episodeCount: 12 })
  const main = [...result.values()].filter((item) => item.videoType === 'main')
  assert.equal(main.length, 12)
  assert.deepEqual(main.map((item) => item.videoIndex).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
})
