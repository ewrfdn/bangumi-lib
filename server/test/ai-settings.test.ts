import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createDatabase } from '../src/model/database.ts'
import { createAiSettingsService } from '../src/service/ai-settings.service.ts'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-ai-settings-'))
after(() => fs.rm(temporary, { recursive: true, force: true }))
const envKey = 'env-secret-key-should-never-appear-in-sqlite'
const storedKey = 'stored-secret-key-should-never-appear-in-sqlite'
const settings = {
  dataDir: path.join(temporary, 'keys'), aiConfigKey: '',
  aiDefaults: { enabled: false, apiFormat: 'openai-completions', baseUrl: '', model: '', apiKey: envKey, maxTokens: 2048, timeoutMs: 30000 },
}
const usable = { enabled: true, apiFormat: 'openai-completions', baseUrl: 'https://provider.example/v1/', model: 'example-model', maxTokens: 1024, timeoutMs: 5000 }

test('AI settings encrypt keys, persist config across restarts, preserve blank keys and clear without env fallback', async () => {
  const filename = path.join(temporary, 'config.sqlite')
  let database = createDatabase(filename)
  let service = createAiSettingsService(database, settings)
  assert.equal(service.publicConfig().apiKeySource, 'environment')
  const saved = service.save({ ...usable, apiKey: storedKey })
  assert.equal(saved.baseUrl, 'https://provider.example/v1')
  assert.equal(saved.hasApiKey, true)
  assert.equal(saved.apiKeySource, 'stored')
  assert.ok(!JSON.stringify(saved).includes(storedKey))
  assert.ok(!JSON.stringify(database.getSetting('ai-config')).includes(storedKey))
  assert.equal(service.effective().apiKey, storedKey)
  service.save({ model: 'updated-model', apiKey: '   ' })
  assert.equal(service.effective().apiKey, storedKey)
  const localKey = await fs.readFile(path.join(settings.dataDir, 'ai-config.key'))
  assert.equal(localKey.length, 32)
  database.close()
  const bytes = await fs.readFile(filename)
  assert.ok(!bytes.includes(Buffer.from(storedKey)))
  assert.ok(!bytes.includes(Buffer.from(envKey)))
  database = createDatabase(filename)
  try {
    // Login secret rotation is independent from the persistent AI encryption key.
    service = createAiSettingsService(database, { ...settings, authSecret: 'rotated-login-secret', aiDefaults: { ...settings.aiDefaults, apiKey: 'changed-env-key' } })
    assert.equal(service.effective().apiKey, storedKey)
    assert.equal(service.publicConfig().model, 'updated-model')
    const cleared = service.save({ clearApiKey: true })
    assert.equal(cleared.hasApiKey, false)
    assert.equal(cleared.apiKeySource, 'none')
    assert.equal(service.effective().apiKey, '')
    assert.equal(createAiSettingsService(database, settings).effective().apiKey, '')
  } finally { database.close() }
})

test('draft tests use effective saved keys without saving and first save snapshots environment defaults', () => {
  const database = createDatabase(':memory:')
  try {
    const service = createAiSettingsService(database, { ...settings, aiConfigKey: randomBytes(32).toString('base64') })
    assert.equal(service.draft({ ...usable, enabled: false }).apiKey, envKey)
    assert.equal(database.getSetting('ai-config'), null)
    service.save({ ...usable, enabled: false })
    assert.equal(service.publicConfig().apiKeySource, 'stored')
    const before = database.getSetting('ai-config')
    assert.equal(service.draft({ model: 'draft-model' }).model, 'draft-model')
    assert.deepEqual(database.getSetting('ai-config'), before)
    assert.throws(() => service.effective(), (error) => error.code === 'AI_DISABLED')
    assert.equal(service.draft({ clearApiKey: true }).apiKey, '')
  } finally { database.close() }
})

test('AI config rejects unsafe URLs, malformed fields and ciphertext tampering without exposing secrets', () => {
  const database = createDatabase(':memory:')
  const aiConfigKey = randomBytes(32).toString('base64')
  try {
    const service = createAiSettingsService(database, { ...settings, aiConfigKey })
    for (const draft of [
      { ...usable, baseUrl: 'ftp://provider.example' }, { ...usable, baseUrl: 'https://user:secret@provider.example' },
      { ...usable, baseUrl: 'https://provider.example/?key=secret' }, { ...usable, baseUrl: 'https://provider.example/#secret' },
      { ...usable, model: '' }, { ...usable, maxTokens: 0 }, { ...usable, maxTokens: 1.5 }, { ...usable, timeoutMs: 999 },
      { ...usable, apiKey: storedKey + '\n' }, { ...usable, enabled: 'true' }, { ...usable, apiFormat: 'unknown' },
    ]) assert.throws(() => service.save(draft), (error) => error.status === 400 && !error.message.includes(storedKey))
    service.save({ ...usable, maxTokens: 65432 })
    assert.equal(service.effective().maxTokens, 65432)
    const unicodeKey = '密'.repeat(8192)
    service.save({ ...usable, apiKey: unicodeKey })
    assert.ok(service.effective().apiKey === unicodeKey)
    service.save({ ...usable, apiKey: storedKey })
    const row = database.getSetting('ai-config')
    const payload = JSON.parse(row.value)
    payload.encryptedApiKey.tag = randomBytes(16).toString('base64')
    database.setSetting('ai-config', JSON.stringify(payload))
    assert.throws(() => service.effective(), (error) => error.code === 'AI_CONFIG_DECRYPTION_FAILED' && !error.message.includes(storedKey))
    const invalidEncryptionKey = createAiSettingsService(database, { ...settings, aiConfigKey: 'not-a-valid-key' })
    assert.throws(() => invalidEncryptionKey.save({ apiKey: 'replacement' }), (error) => error.code === 'AI_CONFIG_KEY_UNAVAILABLE')
  } finally { database.close() }
})
