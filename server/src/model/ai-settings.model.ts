import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AiConfig, AppConfig, AppSettingsRow } from '../types.ts'

const SETTING_NAME = 'ai-config'

/** Stored AI config: the API key is kept encrypted next to it, never inside it. */
export type AiSettingsConfig = Omit<AiConfig, 'apiKey'>

/** AES-256-GCM envelope produced and consumed by the service cipher. */
export interface EncryptedApiKey {
  version: number
  iv: string
  tag: string
  ciphertext: string
}

export interface StoredAiSettings {
  config: AiSettingsConfig
  encryptedApiKey: EncryptedApiKey | null
  updatedAt: number
}

/** The app_settings storage this model needs. */
export interface AiSettingsDatabase {
  getSetting(name: string): AppSettingsRow | null
  setSetting(name: string, value: string, updatedAt?: number): unknown
}

/** The AppConfig fields this model needs. */
export type AiSettingsEnvironment = Pick<AppConfig, 'aiConfigKey' | 'dataDir'>

export interface AiSettingsModel {
  encryptionKey(): Buffer
  read(): StoredAiSettings | null
  write(config: AiSettingsConfig, encryptedApiKey: EncryptedApiKey | null): number
}

export function createAiSettingsModel(database: AiSettingsDatabase, settings: AiSettingsEnvironment): AiSettingsModel {
  let cachedKey: Buffer | undefined
  return {
    encryptionKey(): Buffer {
      if (cachedKey) return cachedKey
      try {
        if (settings.aiConfigKey) {
          const encoded = settings.aiConfigKey.trim()
          const key = Buffer.from(encoded, 'base64')
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || key.length !== 32 || key.toString('base64') !== encoded) throw new Error('invalid key')
          cachedKey = key
        } else {
          const keyPath = path.join(settings.dataDir, 'ai-config.key')
          fs.mkdirSync(settings.dataDir, { recursive: true })
          if (!fs.existsSync(keyPath)) {
            try { fs.writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            }
          }
          const key = fs.readFileSync(keyPath)
          if (key.length !== 32) throw new Error('invalid key file')
          cachedKey = key
        }
        return cachedKey
      } catch {
        throw Object.assign(new Error('AI 配置加密密钥不可用，请检查 AI_CONFIG_KEY 或数据目录中的 ai-config.key'), { status: 503, code: 'AI_CONFIG_KEY_UNAVAILABLE' })
      }
    },
    read(): StoredAiSettings | null {
      const row = database.getSetting(SETTING_NAME)
      if (!row) return null
      try {
        const stored = JSON.parse(row.value) as Omit<StoredAiSettings, 'updatedAt'>
        return { ...stored, updatedAt: row.updatedAt }
      } catch {
        throw Object.assign(new Error('已保存的 AI 配置无法读取，请重新保存配置'), { status: 503, code: 'AI_CONFIG_UNAVAILABLE' })
      }
    },
    write(config: AiSettingsConfig, encryptedApiKey: EncryptedApiKey | null): number {
      const updatedAt = Date.now()
      database.setSetting(SETTING_NAME, JSON.stringify({ config, encryptedApiKey }), updatedAt)
      return updatedAt
    },
  }
}
