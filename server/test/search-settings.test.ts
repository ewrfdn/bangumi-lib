import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createDatabase } from '../src/model/database.ts'
import { createSearchSettingsService } from '../src/service/search-settings.service.ts'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-search-settings-'))
after(() => fs.rm(temporary, { recursive: true, force: true }))
const envKey = 'deepseek-env-key-should-never-appear-in-sqlite'
const storedKey = 'deepseek-stored-key-should-never-appear-in-sqlite'
const modelKey = 'model-api-key-used-for-reuse-mode'
const baseSettings = {
  dataDir: path.join(temporary, 'keys'),
  aiConfigKey: '',
  deepseekSearchKey: envKey,
  searchDefaults: { enabled: false, baseUrl: 'https://api.deepseek.com', count: 8, needContent: true, timeoutMs: 15000, reuseModelKey: false },
}
const usable = { enabled: true, baseUrl: 'https://api.deepseek.com', count: 5, needContent: false, timeoutMs: 8000, reuseModelKey: false }
const stubAi = (key) => ({ apiKey: () => key })

test('search settings encrypt the DeepSeek key in their own app_settings row and survive restarts', async () => {
  const filename = path.join(temporary, 'search-config.sqlite')
  let database = createDatabase(filename)
  let service = createSearchSettingsService({ database, settings: baseSettings, aiSettings: stubAi('') })
  const initial = service.publicConfig()
  assert.equal(initial.enabled, false)
  assert.equal(initial.baseUrl, 'https://api.deepseek.com')
  assert.equal(initial.hasApiKey, true)
  assert.equal(initial.apiKeySource, 'environment')
  assert.equal(initial.count, 8)
  assert.equal(initial.needContent, true)
  assert.equal(service.enabled(), false)
  assert.equal(service.usable(), false, '未启用时不应注册联网工具')

  const saved = service.save({ ...usable, apiKey: storedKey })
  assert.equal(saved.enabled, true)
  assert.equal(saved.hasApiKey, true)
  assert.equal(saved.apiKeySource, 'stored')
  assert.ok(!JSON.stringify(saved).includes(storedKey))
  assert.equal(service.effective().apiKey, storedKey)
  assert.equal(service.enabled(), true)
  assert.equal(service.usable(), true, '启用且有密钥时才注册工具')
  const row = database.getSetting('ai-search')
  assert.ok(row, '搜索配置应写入独立的 app_settings 行')
  assert.equal(database.getSetting('ai-config'), null, '搜索配置不能复用 ai-config 行')
  assert.ok(!JSON.stringify(row).includes(storedKey))
  assert.equal(service.save({ model: 'ignored' }).count, 5)

  database.close()
  const bytes = await fs.readFile(filename)
  assert.ok(!bytes.includes(Buffer.from(storedKey)))
  assert.ok(!bytes.includes(Buffer.from(envKey)))
  database = createDatabase(filename)
  try {
    service = createSearchSettingsService({ database, settings: baseSettings, aiSettings: stubAi('') })
    assert.equal(service.effective().apiKey, storedKey)
    assert.equal(service.publicConfig().baseUrl, 'https://api.deepseek.com')
    const cleared = service.save({ clearApiKey: true })
    assert.equal(cleared.hasApiKey, false)
    assert.equal(cleared.apiKeySource, 'none')
    assert.equal(service.usable(), false, '没有密钥时即使启用也不注册工具')
    assert.throws(() => service.effective(), (error) => error.code === 'SEARCH_NOT_CONFIGURED')
    assert.equal(service.publicConfig().enabled, true)
  } finally { database.close() }
})

test('search settings reuse the model key or fall back to the environment key', () => {
  const database = createDatabase(':memory:')
  try {
    const service = createSearchSettingsService({ database, settings: baseSettings, aiSettings: stubAi(modelKey) })
    // 首次保存会把环境变量兜底密钥加密落库，之后以库为准。
    assert.equal(service.draft({ ...usable, enabled: false }).apiKey, envKey)
    service.save({ ...usable, enabled: false })
    assert.equal(service.publicConfig().apiKeySource, 'stored')

    service.save({ ...usable, reuseModelKey: true, apiKey: storedKey })
    const reused = service.effective()
    assert.equal(reused.reuseModelKey, true)
    assert.equal(reused.apiKey, modelKey, '勾选复用时优先使用模型密钥')
    assert.equal(service.usable(), true, '复用模型密钥时，模型有密钥即可注册工具')

    const emptyModel = createSearchSettingsService({
      database, settings: { ...baseSettings, deepseekSearchKey: '' }, aiSettings: stubAi(''),
    })
    assert.equal(emptyModel.usable(), false, '复用模型密钥但模型无密钥时不应注册工具')
    assert.throws(() => emptyModel.effective(), (error) => error.code === 'SEARCH_NOT_CONFIGURED')
    assert.throws(() => emptyModel.draft({ ...usable, reuseModelKey: true }), (error) => error.code === 'SEARCH_NOT_CONFIGURED')
  } finally { database.close() }
})

test('search config rejects unsafe URLs and malformed fields without exposing secrets', () => {
  const database = createDatabase(':memory:')
  try {
    const service = createSearchSettingsService({ database, settings: baseSettings, aiSettings: stubAi('') })
    const invalidDrafts = [
      { ...usable, baseUrl: 'ftp://api.deepseek.com' },
      { ...usable, baseUrl: 'https://user:pass@api.deepseek.com' },
      { ...usable, baseUrl: 'https://api.deepseek.com/?key=secret' },
      { ...usable, baseUrl: 'https://api.deepseek.com/#secret' },
      { ...usable, baseUrl: 'http://[invalid' },
      { ...usable, count: 0 }, { ...usable, count: 51 }, { ...usable, count: 1.5 },
      { ...usable, timeoutMs: 999 }, { ...usable, timeoutMs: 120001 }, { ...usable, timeoutMs: 1.5 },
      { ...usable, enabled: 'true' }, { ...usable, reuseModelKey: 'false' }, { ...usable, needContent: 1 },
      { ...usable, apiKey: storedKey + '\n' }, { ...usable, apiKey: 42 },
      'not-an-object', [],
    ]
    for (const draft of invalidDrafts) {
      assert.throws(() => service.save(draft), (error) => error.status === 400 && !String(error.message).includes(storedKey))
    }
    // Key 字段错误信息不能回显密钥内容。
    assert.throws(() => service.save({ apiKey: `${storedKey}\n` }), (error) => !String(error.message).includes(storedKey))

    service.save({ ...usable, apiKey: storedKey })
    const payload = JSON.parse(database.getSetting('ai-search').value)
    payload.encryptedApiKey.tag = randomBytes(16).toString('base64')
    database.setSetting('ai-search', JSON.stringify(payload))
    assert.throws(() => service.effective(), (error) => error.code === 'SEARCH_CONFIG_DECRYPTION_FAILED' && !String(error.message).includes(storedKey))

    database.setSetting('ai-search', '{invalid json')
    assert.throws(() => service.publicConfig(), (error) => error.code === 'SEARCH_CONFIG_UNAVAILABLE')
    assert.equal(service.enabled(), false, '配置损坏时按未启用处理，避免 WS ready 崩溃')
  } finally { database.close() }

  const emptyDatabase = createDatabase(':memory:')
  try {
    const wrongKey = createSearchSettingsService({
      database: emptyDatabase, settings: { ...baseSettings, aiConfigKey: 'not-a-valid-key' }, aiSettings: stubAi(''),
    })
    assert.throws(() => wrongKey.save({ apiKey: 'replacement' }), (error) => error.code === 'SEARCH_CONFIG_KEY_UNAVAILABLE')
  } finally { emptyDatabase.close() }
})
