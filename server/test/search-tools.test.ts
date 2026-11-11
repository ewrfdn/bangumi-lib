import test from 'node:test'
import assert from 'node:assert/strict'
import { createSearchTools } from '../src/agent/tools/search.tools.ts'
import { ChatAgent } from '../src/agent/agents/chat.agent.ts'
import { BangumiAgent } from '../src/agent/agents/bangumi.agent.ts'

const QUERY = '间谍过家家 第三季 播出时间'

function makeItem(index, overrides = {}) {
  return {
    title: `结果 ${index}`,
    url: `https://example.com/${index}`,
    snippet: `摘要 ${index}`,
    summary: `较长的摘要 ${index}`,
    content: `<p>正文 ${index}</p>`,
    siteName: 'Example',
    date: '2026-01-02T03:04:05Z',
    authority: 3,
    score: 2.1,
    ...overrides,
  }
}

function makeSearch({ items = [makeItem(1), makeItem(2)], error = null } = {}) {
  return {
    async search(query, options = {}) {
      if (error) throw error
      return {
        query,
        count: items.length,
        results: options.needContent ? items : items.map((item) => ({ ...item, content: '' })),
      }
    },
    async fetchPage(url) {
      if (error) throw error
      return { url, title: '抓取标题', content: '# 正文\n' + '内容'.repeat(5000) }
    },
    async test() { return { ok: true, provider: 'deepseek', latencyMs: 1, query, count: 1, sample: [] } },
  }
}

function toolOf(tools, name) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `应存在工具 ${name}`)
  return tool
}

test('web_search validates parameters, clips long fields and honors content flag', async () => {
  const longSummary = '长'.repeat(3000)
  const items = [makeItem(1, { summary: longSummary }), makeItem(2)]
  const tools = createSearchTools({ search: makeSearch({ items }) })
  const search = toolOf(tools, 'web_search')

  const result = await search.execute('call-1', { query: `  ${QUERY}  `, count: 2 })
  const details = result.details
  assert.equal(details.query, QUERY, 'query 应被 trim')
  assert.equal(details.results.length, 2)
  assert.ok(details.results[0].summary.length <= 701, '摘要应被裁剪')
  assert.ok(details.results[0].summary.endsWith('…'))
  assert.equal('content' in details.results[0], false, '默认不返回正文')
  assert.equal(details.results[0].url, 'https://example.com/1')
  assert.equal(details.results[0].authority, 3)

  const withContent = await search.execute('call-2', { query: QUERY, content: true })
  assert.equal('content' in withContent.details.results[0], true)
  assert.ok(withContent.details.results[0].content.length <= 1201)
})

test('web_search keeps the total tool payload within budget and drops trailing results', async () => {
  const items = Array.from({ length: 10 }, (_, index) => makeItem(index, {
    summary: '摘'.repeat(700), snippet: '片'.repeat(300), content: '文'.repeat(1200),
  }))
  const result = await toolOf(createSearchTools({ search: makeSearch({ items }) }), 'web_search')
    .execute('call', { query: QUERY, count: 10, content: true })
  assert.ok(JSON.stringify(result.details).length <= 6600, '整体工具结果应受预算限制')
  assert.ok(result.details.results.length < 10)
  assert.equal(result.details.truncated, true)
})

test('web_search rejects invalid query and count before calling the API', async () => {
  const calls = []
  const search = makeSearch()
  const original = search.search
  search.search = (query, options) => { calls.push({ query, options }); return original(query, options) }
  const webSearch = toolOf(createSearchTools({ search }), 'web_search')
  const cases = [
    [{}, '搜索关键词不能为空'],
    [{ query: '   ' }, '搜索关键词不能为空'],
    [{ query: 'a'.repeat(129) }, '最多 128'],
    [{ query: QUERY, count: 0 }, '1 到 10'],
    [{ query: QUERY, count: 11 }, '1 到 10'],
    [{ query: QUERY, count: 1.5 }, '1 到 10'],
    [{ query: QUERY, count: '3' }, '1 到 10'],
  ]
  for (const [params, message] of cases) {
    await assert.rejects(webSearch.execute('call', params), (error) => {
      assert.equal(error.status, 400)
      assert.ok(String(error.message).includes(message), `错误信息应包含：${message}`)
      return true
    })
  }
  assert.equal(calls.length, 0, '参数非法时不应发起搜索请求')
})

test('web_fetch clips markdown content and validates the URL', async () => {
  const fetchTool = toolOf(createSearchTools({ search: makeSearch() }), 'web_fetch')
  const result = await fetchTool.execute('call', { url: 'https://example.com/page' })
  assert.equal(result.details.url, 'https://example.com/page')
  assert.equal(result.details.title, '抓取标题')
  assert.ok(result.details.content.length <= 8001)
  assert.equal(result.details.truncated, true)
  for (const url of ['', '   ', 'x'.repeat(9000)]) {
    await assert.rejects(fetchTool.execute('call', { url }), (error) => error.status === 400)
  }
})

test('search API failures propagate to the agent as tool errors', async () => {
  const failure = Object.assign(new Error('DeepSeek 搜索密钥无效或没有 Search / Fetch API 权限，请检查 API Key'), {
    status: 400, code: 'SEARCH_AUTH_FAILED',
  })
  const tools = createSearchTools({ search: makeSearch({ error: failure }) })
  await assert.rejects(toolOf(tools, 'web_search').execute('call', { query: QUERY }), (error) => error.code === 'SEARCH_AUTH_FAILED')
  await assert.rejects(toolOf(tools, 'web_fetch').execute('call', { url: 'https://example.com' }), (error) => error.code === 'SEARCH_AUTH_FAILED')
})

test('ChatAgent exposes web tools only while search is enabled and keyed', () => {
  const services = {}
  const models = {}
  const settings = { libraries: [], defaultLibraryId: 'bangumi' }
  const search = makeSearch()

  const unusable = new ChatAgent({ services, models, settings, search, searchSettings: { usable: () => false } })
  const disabledNames = unusable.tools({ messages: [] }).map((tool) => tool.name)
  assert.ok(!disabledNames.includes('web_search'))
  assert.ok(!disabledNames.includes('web_fetch'))

  const enabled = new ChatAgent({ services, models, settings, search, searchSettings: { usable: () => true } })
  const enabledNames = enabled.tools({ messages: [] }).map((tool) => tool.name)
  assert.ok(enabledNames.includes('web_search'))
  assert.ok(enabledNames.includes('web_fetch'))
  assert.ok(enabledNames.includes('search_media'), '联网工具不能挤掉原有工具')

  const noSearch = new ChatAgent({ services, models, settings })
  const plainNames = noSearch.tools({ messages: [] }).map((tool) => tool.name)
  assert.ok(!plainNames.includes('web_search'))
  assert.equal(plainNames.length, disabledNames.length)
})

test('BangumiAgent exposes web tools only when the search key is usable', () => {
  const context = {
    library: { id: 'bangumi', name: '番剧库', root: process.cwd() },
    folder: { relPath: 'Show', name: 'Show', depth: 1 },
    entries: { total: 0, truncated: false, items: [] },
    binding: null,
  }
  const deps = { services: {}, models: {}, mediaSync: {}, search: makeSearch() }

  const gated = new BangumiAgent({ ...deps, searchSettings: { usable: () => false } })
  const gatedNames = gated.tools(context).map((tool) => tool.name)
  assert.ok(gatedNames.includes('search_bangumi'), '原有扫描工具必须保留')
  assert.ok(!gatedNames.includes('web_search'))
  assert.ok(!gatedNames.includes('web_fetch'))

  const available = new BangumiAgent({ ...deps, searchSettings: { usable: () => true } })
  const names = available.tools(context).map((tool) => tool.name)
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('web_fetch'))
  assert.ok(names.includes('search_bangumi'))
  assert.ok(names.includes('report'), '原有扫描工具必须保留')
})

test('BangumiAgent prompt carries ancestor binding info for subfolders', () => {
  const agent = new BangumiAgent({ services: {}, models: {}, mediaSync: {} })
  const prompt = agent.userPrompt({
    library: { id: 'bangumi', name: '番剧库', root: process.cwd() },
    folder: { relPath: '作品/特典', name: '特典', depth: 2 },
    entries: { total: 1, truncated: false, items: [{ name: 'PV01.mkv', kind: 'file', ext: 'mkv' }] },
    binding: null,
    ancestors: [{
      path: '作品', localMediaId: 7, mediaId: 5, title: '某作品', season: 1,
      episodeCount: 12, dataSource: 'bangumi', dataSourceUrl: 'https://bgm.tv/subject/400602',
    }],
  })
  assert.match(prompt, /"ancestors"/)
  assert.match(prompt, /"path": "作品"/)
  assert.match(prompt, /"title": "某作品"/)
  assert.match(prompt, /"episodeCount": 12/)
  assert.match(prompt, /"path": "作品\/特典"/, '当前目录路径也在提示里')
})

test('BangumiAgent prompt omits empty ancestors field content', () => {
  const agent = new BangumiAgent({ services: {}, models: {}, mediaSync: {} })
  const prompt = agent.userPrompt({
    library: { id: 'bangumi', name: '番剧库', root: process.cwd() },
    folder: { relPath: '作品/第一季', name: '第一季', depth: 2 },
    entries: { total: 1, truncated: false, items: [{ name: '01.mkv', kind: 'file', ext: 'mkv' }] },
    binding: null,
  })
  assert.match(prompt, /"ancestors": \[\]/)
})
