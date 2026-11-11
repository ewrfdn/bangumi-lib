import { createSecretSettingsStore } from './encrypted-settings.model.ts'
import type { EncryptedSecret, SecretSettingsDatabase, StoredSecretSettings } from './encrypted-settings.model.ts'
import type { AppConfig, SearchConfig } from '../types.ts'

/**
 * 联网搜索配置在 app_settings 里的独立条目（相当于新增一种密钥 type）。
 * 与 ai-config 共用持久化加密密钥，但通过不同的 AAD 隔离，两种密钥不能互换解密。
 */
const SETTING_NAME = 'ai-search'

export type SearchSettingsConfig = SearchConfig

export type EncryptedSearchApiKey = EncryptedSecret

export interface StoredSearchSettings extends StoredSecretSettings<SearchSettingsConfig> {}

export type SearchSettingsDatabase = SecretSettingsDatabase

export type SearchSettingsEnvironment = Pick<AppConfig, 'aiConfigKey' | 'dataDir'>

export interface SearchSettingsModel {
  encryptionKey(): Buffer
  read(): StoredSearchSettings | null
  write(config: SearchSettingsConfig, encryptedApiKey: EncryptedSearchApiKey | null): number
}

export function createSearchSettingsModel(database: SearchSettingsDatabase, settings: SearchSettingsEnvironment): SearchSettingsModel {
  return createSecretSettingsStore<SearchSettingsConfig>({
    database,
    settings,
    settingName: SETTING_NAME,
    keyErrorCode: 'SEARCH_CONFIG_KEY_UNAVAILABLE',
    keyErrorMessage: '联网搜索配置的加密密钥不可用，请检查 AI_CONFIG_KEY 或数据目录中的 ai-config.key',
    readErrorCode: 'SEARCH_CONFIG_UNAVAILABLE',
    readErrorMessage: '已保存的联网搜索配置无法读取，请重新保存配置',
  })
}
