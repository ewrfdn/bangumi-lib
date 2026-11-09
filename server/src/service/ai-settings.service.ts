import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { createAiSettingsModel } from '../model/ai-settings.model.ts'
import type { AiSettingsConfig, EncryptedApiKey, StoredAiSettings } from '../model/ai-settings.model.ts'
import type { AniShareDatabase } from '../model/database.ts'
import type { AiConfig, AppConfig } from '../types.ts'

const formats = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
const defaults = { enabled: false, apiFormat: 'openai-completions', baseUrl: '', model: '', maxTokens: 2048, timeoutMs: 30000 }

/** 对外公开的配置：密钥只以是否存在的标记出现，绝不回传明文。 */
export type AiPublicConfig = Omit<AiConfig, 'apiKey'> & {
  hasApiKey: boolean
  apiKeySource: 'stored' | 'none' | 'environment'
  updatedAt?: number
}

export interface AiSettingsService {
  publicConfig(): AiPublicConfig
  save(draft: unknown): AiPublicConfig
  draft(draft?: unknown): AiConfig
  effective(): AiConfig
}

/** 服务只需要这几项配置；便于测试注入最小依赖。 */
export type AiSettingsSource = Pick<AppConfig, 'aiConfigKey' | 'dataDir' | 'aiDefaults'>

interface AiSettingsState {
  config: AiSettingsConfig
  stored: StoredAiSettings | null
  encryptedApiKey: EncryptedApiKey | null
}

interface PreparedAiConfig {
  state: AiSettingsState
  config: AiSettingsConfig
  clear: boolean
  replacement: string
}

interface ValidateOptions {
  requireConfigured?: boolean
  allowIncomplete?: boolean
}

interface KeyCipher {
  encrypt(secret: string): EncryptedApiKey
  decrypt(encrypted: EncryptedApiKey | null | undefined): string
}

const fail = (status: number, message: string, code = 'AI_CONFIG_INVALID') => Object.assign(new Error(message), { status, code })
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

function validate(input: Record<string, unknown>, { requireConfigured = false, allowIncomplete = false }: ValidateOptions = {}): AiSettingsConfig {
  if (typeof input.enabled !== 'boolean') throw fail(400, 'enabled 必须为布尔值')
  if (typeof input.apiFormat !== 'string' || !formats.has(input.apiFormat)) throw fail(400, '请选择支持的 API 格式')
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048 || /[\r\n]/.test(input.baseUrl)) throw fail(400, 'API 地址无效')
  let baseUrl = input.baseUrl.trim()
  if (baseUrl) {
    let parsed: URL
    try { parsed = new URL(baseUrl) } catch { throw fail(400, 'API 地址必须是有效的 HTTP 或 HTTPS 地址') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || baseUrl.includes('?') || baseUrl.includes('#')) {
      throw fail(400, 'API 地址只支持 HTTP/HTTPS，且不能包含账号、查询参数或片段')
    }
    baseUrl = parsed.toString().replace(/\/+$/, '')
  }
  if (typeof input.model !== 'string' || input.model.length > 200 || /[\r\n]/.test(input.model)) throw fail(400, '模型名称无效，最多 200 个字符')
  const model = input.model.trim()
  if (!allowIncomplete && (input.enabled || requireConfigured) && (!baseUrl || !model)) throw fail(400, '请先配置 API 地址和模型名称', 'AI_NOT_CONFIGURED')
  if (typeof input.maxTokens !== 'number' || !Number.isInteger(input.maxTokens) || input.maxTokens < 1) throw fail(400, 'maxTokens 必须是大于 0 的整数')
  if (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 120000) throw fail(400, 'timeoutMs 必须为 1000 至 120000 的整数')
  return { enabled: input.enabled, apiFormat: input.apiFormat, baseUrl, model, maxTokens: input.maxTokens, timeoutMs: input.timeoutMs }
}

function createKeyCipher(loadKey: () => Buffer): KeyCipher {
  return {
    encrypt(secret: string): EncryptedApiKey {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', loadKey(), iv)
      cipher.setAAD(Buffer.from('anishare:ai-config:v1'))
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
      return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    },
    decrypt(encrypted: EncryptedApiKey | null | undefined): string {
      if (!encrypted) return ''
      const key = loadKey()
      try {
        if (encrypted.version !== 1) throw new Error('invalid version')
        const iv = Buffer.from(encrypted.iv, 'base64')
        const tag = Buffer.from(encrypted.tag, 'base64')
        if (iv.length !== 12 || tag.length !== 16 || typeof encrypted.ciphertext !== 'string' || encrypted.ciphertext.length > 32768) throw new Error('invalid envelope')
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(Buffer.from('anishare:ai-config:v1'))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8')
      } catch {
        throw fail(503, 'AI 配置解密失败，请检查 AI_CONFIG_KEY 或数据目录中的 ai-config.key', 'AI_CONFIG_DECRYPTION_FAILED')
      }
    },
  }
}

export function createAiSettingsService(database: AniShareDatabase, settings: AiSettingsSource): AiSettingsService {
  const storage = createAiSettingsModel(database, settings)
  const cipher = createKeyCipher(() => storage.encryptionKey())
  const initial: AiConfig = { ...defaults, ...settings.aiDefaults }
  const current = (): AiSettingsState => {
    const stored = storage.read()
    const config = validate(stored ? stored.config : { ...initial }, { allowIncomplete: true })
    return { config, stored, encryptedApiKey: stored?.encryptedApiKey || null }
  }
  const keyOf = (state: AiSettingsState): string => state.stored ? cipher.decrypt(state.encryptedApiKey) : initial.apiKey || ''
  const publicOf = (state: AiSettingsState): AiPublicConfig => ({
    ...state.config,
    hasApiKey: state.stored ? Boolean(state.encryptedApiKey) : Boolean(initial.apiKey),
    apiKeySource: state.stored ? state.encryptedApiKey ? 'stored' : 'none' : initial.apiKey ? 'environment' : 'none',
    ...(state.stored ? { updatedAt: state.stored.updatedAt } : {}),
  })
  const prepare = (input: unknown, requireConfigured: boolean): PreparedAiConfig => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'AI 配置必须是对象')
    // 动态 JSON：字段逐个校验后才进入配置，这里显式收窄为键值表。
    const draft = input as Record<string, unknown>
    const state = current()
    const combined: Record<string, unknown> = { ...state.config }
    for (const field of Object.keys(defaults)) if (own(draft, field)) combined[field] = draft[field]
    if (own(draft, 'clearApiKey') && typeof draft.clearApiKey !== 'boolean') throw fail(400, 'clearApiKey 必须为布尔值')
    if (own(draft, 'apiKey') && (typeof draft.apiKey !== 'string' || draft.apiKey.length > 8192 || /[\r\n]/.test(draft.apiKey))) throw fail(400, 'API Key 无效，最多 8192 个字符且不能包含换行')
    const replacement = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : ''
    return { state, config: validate(combined, { requireConfigured }), clear: draft.clearApiKey === true, replacement }
  }
  return {
    publicConfig: (): AiPublicConfig => publicOf(current()),
    save(draft: unknown): AiPublicConfig {
      const prepared = prepare(draft, false)
      let encrypted = prepared.state.encryptedApiKey
      if (prepared.clear) encrypted = null
      else if (prepared.replacement) encrypted = cipher.encrypt(prepared.replacement)
      else if (!prepared.state.stored && initial.apiKey) encrypted = cipher.encrypt(initial.apiKey)
      storage.write(prepared.config, encrypted)
      return publicOf(current())
    },
    draft(draft: unknown = {}): AiConfig {
      const prepared = prepare(draft, true)
      const apiKey = prepared.clear ? '' : prepared.replacement || keyOf(prepared.state)
      return { ...prepared.config, apiKey }
    },
    effective(): AiConfig {
      const state = current()
      if (!state.config.enabled) throw fail(409, 'AI Agent 尚未启用，请先在后台管理「模型服务」中开启', 'AI_DISABLED')
      return { ...validate(state.config, { requireConfigured: true }), apiKey: keyOf(state) }
    },
  }
}
