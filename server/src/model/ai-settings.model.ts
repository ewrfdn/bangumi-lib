import { createSecretSettingsStore } from './encrypted-settings.model.ts'
import type { EncryptedSecret, SecretSettingsDatabase, SecretSettingsEnvironment, StoredSecretSettings } from './encrypted-settings.model.ts'
import type { AiConfig, AppConfig } from '../types.ts'

const SETTING_NAME = 'ai-config'

/** Stored AI config: the API key is kept encrypted next to it, never inside it. */
export type AiSettingsConfig = Omit<AiConfig, 'apiKey'>

/** AES-256-GCM envelope produced and consumed by the service cipher. */
export type EncryptedApiKey = EncryptedSecret

export interface StoredAiSettings extends StoredSecretSettings<AiSettingsConfig> {}

/** The app_settings storage this model needs. */
export type AiSettingsDatabase = SecretSettingsDatabase

/** The AppConfig fields this model needs. */
export type AiSettingsEnvironment = Pick<AppConfig, 'aiConfigKey' | 'dataDir'> & SecretSettingsEnvironment

export interface AiSettingsModel {
  encryptionKey(): Buffer
  read(): StoredAiSettings | null
  write(config: AiSettingsConfig, encryptedApiKey: EncryptedApiKey | null): number
}

export function createAiSettingsModel(database: AiSettingsDatabase, settings: AiSettingsEnvironment): AiSettingsModel {
  return createSecretSettingsStore<AiSettingsConfig>({
    database,
    settings,
    settingName: SETTING_NAME,
    keyErrorCode: 'AI_CONFIG_KEY_UNAVAILABLE',
    keyErrorMessage: 'AI 配置加密密钥不可用，请检查 AI_CONFIG_KEY 或数据目录中的 ai-config.key',
    readErrorCode: 'AI_CONFIG_UNAVAILABLE',
    readErrorMessage: '已保存的 AI 配置无法读取，请重新保存配置',
  })
}
