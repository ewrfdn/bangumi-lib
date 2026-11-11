import { createSearchSettingsModel } from '../model/search-settings.model.ts'
import type { EncryptedSearchApiKey, SearchSettingsConfig, StoredSearchSettings } from '../model/search-settings.model.ts'
import type { AniShareDatabase } from '../model/database.ts'
import type { AppConfig, SearchConfig } from '../types.ts'
import { createSecretCipher } from './secret-cipher.ts'
import type { AiSettingsService } from './ai-settings.service.ts'

/** 联网搜索默认值：DeepSeek 官方 Search / Fetch API。 */
const defaults: SearchConfig = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com',
  count: 8,
  needContent: true,
  timeoutMs: 15000,
  reuseModelKey: false,
}

/** 对外公开的搜索配置：密钥只以是否存在的标记出现，绝不回传明文。 */
export type SearchPublicConfig = SearchConfig & {
  hasApiKey: boolean
  apiKeySource: 'stored' | 'environment' | 'none'
  updatedAt?: number
}

/** 真正发起请求时使用：已解析出明文 API Key 的配置。 */
export interface SearchRuntimeConfig extends SearchConfig {
  apiKey: string
}

export interface SearchSettingsService {
  publicConfig(): SearchPublicConfig
  save(draft: unknown): SearchPublicConfig
  /** 用「已保存配置 + 传入草稿」解析出可直接请求的配置（用于连接测试）。 */
  draft(draft?: unknown): SearchRuntimeConfig
  effective(): SearchRuntimeConfig
  /** 是否启用并且能解析到可用密钥；供 Agent 决定是否注册联网搜索工具。 */
  usable(): boolean
  /** 是否启用；供 Agent 决定是否注册联网搜索工具。配置损坏时按未启用处理。 */
  enabled(): boolean
}

/** 服务只需要这几项环境配置；便于测试注入最小依赖。 */
export type SearchSettingsSource = Pick<AppConfig, 'aiConfigKey' | 'dataDir' | 'deepseekSearchKey' | 'searchDefaults'>

export interface SearchSettingsDependencies {
  database: AniShareDatabase
  settings: SearchSettingsSource
  /** 只读取当前模型密钥，供「复用模型服务密钥」使用。 */
  aiSettings: Pick<AiSettingsService, 'apiKey'>
}

interface SearchSettingsState {
  config: SearchSettingsConfig
  stored: StoredSearchSettings | null
  encryptedApiKey: EncryptedSearchApiKey | null
}

interface PreparedSearchConfig {
  state: SearchSettingsState
  config: SearchSettingsConfig
  clear: boolean
  replacement: string
}

interface ValidateOptions {
  requireConfigured?: boolean
  allowIncomplete?: boolean
}

const fail = (status: number, message: string, code = 'SEARCH_CONFIG_INVALID') => Object.assign(new Error(message), { status, code })
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

function validate(input: Record<string, unknown>, { requireConfigured = false, allowIncomplete = false }: ValidateOptions = {}): SearchSettingsConfig {
  if (typeof input.enabled !== 'boolean') throw fail(400, 'enabled 必须为布尔值')
  if (typeof input.reuseModelKey !== 'boolean') throw fail(400, 'reuseModelKey 必须为布尔值')
  if (typeof input.needContent !== 'boolean') throw fail(400, 'needContent 必须为布尔值')
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048 || /[\r\n]/.test(input.baseUrl)) throw fail(400, '搜索 API 地址无效')
  let baseUrl = input.baseUrl.trim()
  if (baseUrl) {
    let parsed: URL
    try { parsed = new URL(baseUrl) } catch { throw fail(400, '搜索 API 地址必须是有效的 HTTP 或 HTTPS 地址') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || baseUrl.includes('?') || baseUrl.includes('#')) {
      throw fail(400, '搜索 API 地址只支持 HTTP/HTTPS，且不能包含账号、查询参数或片段')
    }
    baseUrl = parsed.toString().replace(/\/+$/, '')
  }
  if (!allowIncomplete && (input.enabled || requireConfigured) && !baseUrl) throw fail(400, '请先配置搜索 API 地址', 'SEARCH_NOT_CONFIGURED')
  if (typeof input.count !== 'number' || !Number.isInteger(input.count) || input.count < 1 || input.count > 50) {
    throw fail(400, '返回条数必须是 1 到 50 的整数')
  }
  if (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 120000) {
    throw fail(400, 'timeoutMs 必须为 1000 至 120000 的整数')
  }
  return {
    enabled: input.enabled,
    baseUrl,
    count: input.count,
    needContent: input.needContent,
    timeoutMs: input.timeoutMs,
    reuseModelKey: input.reuseModelKey,
  }
}

function createKeyCipher(loadKey: () => Buffer) {
  return createSecretCipher(loadKey, {
    aad: 'anishare:ai-search:v1',
    decryptErrorMessage: '联网搜索配置解密失败，请检查 AI_CONFIG_KEY 或数据目录中的 ai-config.key',
    decryptErrorCode: 'SEARCH_CONFIG_DECRYPTION_FAILED',
  })
}

export function createSearchSettingsService({ database, settings, aiSettings }: SearchSettingsDependencies): SearchSettingsService {
  const storage = createSearchSettingsModel(database, settings)
  const cipher = createKeyCipher(() => storage.encryptionKey())
  const initial: SearchConfig = { ...defaults, ...settings.searchDefaults }
  const initialKey = typeof settings.deepseekSearchKey === 'string' ? settings.deepseekSearchKey.trim() : ''
  const current = (): SearchSettingsState => {
    const stored = storage.read()
    const config = validate(stored ? { ...stored.config } : { ...initial }, { allowIncomplete: true })
    return { config, stored, encryptedApiKey: stored?.encryptedApiKey || null }
  }
  const storedKeyOf = (state: SearchSettingsState): string => (state.stored ? cipher.decrypt(state.encryptedApiKey) : initialKey)
  /** 复用模型密钥时优先读模型配置；读取失败（如模型密钥解密错误）按空密钥处理，由上层给出明确提示。 */
  const modelKeyOf = (): string => {
    try { return aiSettings.apiKey() } catch { return '' }
  }
  const resolveKey = (config: SearchSettingsConfig, state: SearchSettingsState, { replacement = '', clear = false }: { replacement?: string; clear?: boolean } = {}): string => {
    // 显式勾选「复用模型密钥」时只认模型密钥：模型没配密钥时给出明确错误，
    // 避免悄悄回退到旧的独立密钥、用错账号或计费主体。
    if (config.reuseModelKey) return modelKeyOf()
    if (clear) return ''
    return replacement || storedKeyOf(state)
  }
  const publicOf = (state: SearchSettingsState): SearchPublicConfig => ({
    ...state.config,
    hasApiKey: state.stored ? Boolean(state.encryptedApiKey) : Boolean(initialKey),
    apiKeySource: state.stored ? state.encryptedApiKey ? 'stored' : 'none' : initialKey ? 'environment' : 'none',
    ...(state.stored ? { updatedAt: state.stored.updatedAt } : {}),
  })
  const prepare = (input: unknown, requireConfigured: boolean): PreparedSearchConfig => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '联网搜索配置必须是对象')
    const draft = input as Record<string, unknown>
    const state = current()
    const combined: Record<string, unknown> = { ...state.config }
    for (const field of Object.keys(defaults)) if (own(draft, field)) combined[field] = draft[field]
    if (own(draft, 'clearApiKey') && typeof draft.clearApiKey !== 'boolean') throw fail(400, 'clearApiKey 必须为布尔值')
    if (own(draft, 'apiKey') && (typeof draft.apiKey !== 'string' || draft.apiKey.length > 8192 || /[\r\n]/.test(draft.apiKey))) {
      throw fail(400, 'DeepSeek API Key 无效，最多 8192 个字符且不能包含换行')
    }
    const replacement = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : ''
    return { state, config: validate(combined, { requireConfigured }), clear: draft.clearApiKey === true, replacement }
  }
  const runtimeOf = (config: SearchSettingsConfig, state: SearchSettingsState, key: string): SearchRuntimeConfig => {
    if (!key) {
      throw fail(409, '联网搜索尚未配置 DeepSeek API Key，请在后台管理「模型服务 → 联网搜索」中填写，或勾选复用模型密钥', 'SEARCH_NOT_CONFIGURED')
    }
    return { ...config, apiKey: key }
  }
  return {
    publicConfig: (): SearchPublicConfig => publicOf(current()),
    save(draft: unknown): SearchPublicConfig {
      const prepared = prepare(draft, false)
      let encrypted = prepared.state.encryptedApiKey
      if (prepared.clear) encrypted = null
      else if (prepared.replacement) encrypted = cipher.encrypt(prepared.replacement)
      else if (!prepared.state.stored && initialKey) encrypted = cipher.encrypt(initialKey)
      storage.write(prepared.config, encrypted)
      return publicOf(current())
    },
    draft(draft: unknown = {}): SearchRuntimeConfig {
      const prepared = prepare(draft, true)
      return runtimeOf(prepared.config, prepared.state, resolveKey(prepared.config, prepared.state, prepared))
    },
    effective(): SearchRuntimeConfig {
      const state = current()
      if (!state.config.enabled) {
        throw fail(409, '联网搜索尚未启用，请先在后台管理「模型服务」中开启', 'SEARCH_DISABLED')
      }
      return runtimeOf(state.config, state, resolveKey(state.config, state))
    },
    enabled(): boolean {
      try { return current().config.enabled } catch { return false }
    },
    usable(): boolean {
      // 「启用」只代表用户意向；没有配置可用的 API Key 时不注册工具，
      // 避免模型看到 web_search 却每次调用都失败。
      try {
        const state = current()
        if (!state.config.enabled) return false
        return Boolean(resolveKey(state.config, state))
      } catch { return false }
    },
  }
}
