import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMediaScanTools, searchKeywordVariants } from '../src/agent/tools/media-scan.tools.ts'

const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-search-keyword-'))
after(() => fs.rm(libraryRoot, { recursive: true, force: true }))

function toolsWith(searchImpl) {
  return createMediaScanTools({
    library: { id: 'bangumi', name: '番剧库', root: libraryRoot },
    services: { metadata: { search: searchImpl } },
    models: {},
    mediaSync: {},
  })
}

function item(sourceId = '400602') {
  return { sourceId, title: '条目', originalTitle: '原名', airedOn: '2023-10-01', platform: 'TV', mediaType: 'anime' }
}

test('searchKeywordVariants normalizes tildes, release tags and subtitle titles', () => {
  const zombie = '僵尸100~在变成僵尸之前想做的100件事~'
  const variants = searchKeywordVariants(zombie)
  assert.equal(variants[0], zombie)
  assert.ok(variants.includes('僵尸100～在变成僵尸之前想做的100件事～'), '应尝试全角波浪号')
  assert.ok(variants.includes('僵尸100'), '应尝试主标题')
  assert.ok(variants.length <= 4)

  const fullWidth = searchKeywordVariants('僵尸100～在变成僵尸之前想做的100件事～')
  assert.ok(fullWidth.includes('僵尸100'))

  const release = searchKeywordVariants('[Sakurato] Spy x Family S3 [HEVC-10bit 1080p AAC][CHS&CHT]')
  assert.ok(release.includes('Spy x Family S3'), `实际：${JSON.stringify(release)}`)

  assert.deepEqual(searchKeywordVariants('我们无法一起学习'), ['我们无法一起学习'], '正常标题不应产生额外请求')
  assert.deepEqual(searchKeywordVariants('   '), [])
})

test('search_bangumi retries simplified keywords when the raw folder name returns nothing', async () => {
  const calls = []
  const tools = toolsWith(async (body) => {
    calls.push(body.keyword)
    return body.keyword === '僵尸100' ? { total: 1, items: [item()] } : { total: 0, items: [] }
  })
  const tool = tools.find((entry) => entry.name === 'search_bangumi')
  const result = await tool.execute('call-1', { keyword: '僵尸100~在变成僵尸之前想做的100件事~' }, new AbortController().signal)
  assert.equal(result.details.items.length, 1)
  assert.equal(result.details.items[0].sourceId, '400602')
  assert.deepEqual(result.details.triedKeywords, ['僵尸100~在变成僵尸之前想做的100件事~', '僵尸100～在变成僵尸之前想做的100件事～', '僵尸100'])
  assert.equal(calls.length, 3, '只在空结果时继续尝试，命中后停止')
})

test('search_bangumi stops after the first hit and returns triedKeywords', async () => {
  const calls = []
  const tools = toolsWith(async (body) => {
    calls.push(body.keyword)
    return { total: 1, items: [item(body.keyword === '我们无法一起学习' ? '123' : '456')] }
  })
  const tool = tools.find((entry) => entry.name === 'search_bangumi')
  const result = await tool.execute('call-1', { keyword: '我们无法一起学习' }, new AbortController().signal)
  assert.equal(calls.length, 1)
  assert.deepEqual(result.details.triedKeywords, ['我们无法一起学习'])
  assert.equal(result.details.items[0].sourceId, '123')
})

test('search_bangumi tries at most three variants and never hides network errors', async () => {
  const calls = []
  const emptyTools = toolsWith(async (body) => {
    calls.push(body.keyword)
    return { total: 0, items: [] }
  })
  const searchTool = emptyTools.find((entry) => entry.name === 'search_bangumi')
  const empty = await searchTool.execute('call-1', { keyword: '[Sub] Show [1080p]' }, new AbortController().signal)
  assert.equal(empty.details.items.length, 0)
  assert.ok(calls.length <= 3, `最多尝试 3 次，实际 ${calls.length}`)
  assert.deepEqual(empty.details.triedKeywords, calls)

  const failure = Object.assign(new Error('无法连接数据源'), { code: 'NETWORK_ERROR', status: 502 })
  const failing = toolsWith(async () => { throw failure })
  await assert.rejects(
    failing.find((entry) => entry.name === 'search_bangumi').execute('call-1', { keyword: '我们无法一起学习' }, new AbortController().signal),
    (error) => error.code === 'NETWORK_ERROR',
  )
})
