import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AppSettingsRow } from '../types.ts'

/**
 * AES-256-GCM envelope used for every encrypted secret in `app_settings`.
 * The JSON shape is kept byte-for-byte compatible with the original ai-config row,
 * so existing databases keep working after the shared store refactor.
 */
export interface EncryptedSecret {
  version: number
  iv: string
  tag: string
  ciphertext: string
}

/** One encrypted settings row: public config + encrypted secret + timestamp. */
export interface StoredSecretSettings<T> {
  config: T
  encryptedApiKey: EncryptedSecret | null
  updatedAt: number
}

/** The app_settings storage every secret settings model needs. */
export interface SecretSettingsDatabase {
  getSetting(name: string): AppSettingsRow | null
  setSetting(name: string, value: string, updatedAt?: number): unknown
}

/** The AppConfig fields needed to derive the persistent encryption key. */
export interface SecretSettingsEnvironment {
  aiConfigKey: string
  dataDir: string
}

export interface SecretSettingsStore<T> {
  encryptionKey(): Buffer
  read(): StoredSecretSettings<T> | null
  write(config: T, encryptedApiKey: EncryptedSecret | null): number
}

export interface SecretSettingsOptions<T> {
  database: SecretSettingsDatabase
  settings: SecretSettingsEnvironment
  /** app_settings.name used for this kind of secret (one "type" per settings row). */
  settingName: string
  keyErrorCode: string
  keyErrorMessage: string
  readErrorCode: string
  readErrorMessage: string
}

/**
 * Generic encrypted settings row, addressed by `app_settings.name`.
 * Keys are derived once from AI_CONFIG_KEY or DATA_DIR/ai-config.key and cached per store.
 * Each store keeps its own ciphertext under its own name, so adding a new secret type
 * (e.g. the DeepSeek search key) needs no schema migration.
 */
export function createSecretSettingsStore<T>({
  database, settings, settingName, keyErrorCode, keyErrorMessage, readErrorCode, readErrorMessage,
}: SecretSettingsOptions<T>): SecretSettingsStore<T> {
  let cachedKey: Buffer | undefined
  const unavailable = (code: string, message: string): Error => Object.assign(new Error(message), { status: 503, code })
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
        throw unavailable(keyErrorCode, keyErrorMessage)
      }
    },
    read(): StoredSecretSettings<T> | null {
      const row = database.getSetting(settingName)
      if (!row) return null
      try {
        const stored = JSON.parse(row.value) as Omit<StoredSecretSettings<T>, 'updatedAt'>
        return { ...stored, updatedAt: row.updatedAt }
      } catch {
        throw unavailable(readErrorCode, readErrorMessage)
      }
    },
    write(config: T, encryptedApiKey: EncryptedSecret | null): number {
      const updatedAt = Date.now()
      database.setSetting(settingName, JSON.stringify({ config, encryptedApiKey }), updatedAt)
      return updatedAt
    },
  }
}
