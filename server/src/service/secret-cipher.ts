import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import type { EncryptedSecret } from '../model/encrypted-settings.model.ts'

/** Symmetric cipher contract shared by the AI config and the search config services. */
export interface SecretCipher {
  encrypt(secret: string): EncryptedSecret
  decrypt(encrypted: EncryptedSecret | null | undefined): string
}

export interface SecretCipherOptions {
  /** AES-GCM additional authenticated data; keeps different secret types apart. */
  aad: string
  decryptErrorMessage: string
  decryptErrorCode: string
}

/**
 * AES-256-GCM envelope cipher. The key loader is lazy and may throw a 503-style
 * error; callers surface that error unchanged so configuration problems stay visible.
 */
export function createSecretCipher(loadKey: () => Buffer, { aad, decryptErrorMessage, decryptErrorCode }: SecretCipherOptions): SecretCipher {
  const failDecrypt = (): Error => Object.assign(new Error(decryptErrorMessage), { status: 503, code: decryptErrorCode })
  return {
    encrypt(secret: string): EncryptedSecret {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', loadKey(), iv)
      cipher.setAAD(Buffer.from(aad))
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
      return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    },
    decrypt(encrypted: EncryptedSecret | null | undefined): string {
      if (!encrypted) return ''
      const key = loadKey()
      try {
        if (encrypted.version !== 1) throw new Error('invalid version')
        const iv = Buffer.from(encrypted.iv, 'base64')
        const tag = Buffer.from(encrypted.tag, 'base64')
        if (iv.length !== 12 || tag.length !== 16 || typeof encrypted.ciphertext !== 'string' || encrypted.ciphertext.length > 32768) throw new Error('invalid envelope')
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(Buffer.from(aad))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8')
      } catch {
        throw failDecrypt()
      }
    },
  }
}
