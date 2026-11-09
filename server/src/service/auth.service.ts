import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AniShareDatabase } from '../model/database.ts'

/** 会话状态；enabled 为 false 时表示未配置访问密钥，任何请求都视为已登录。 */
export interface AuthSession {
  enabled: boolean
  authenticated: boolean
}

export interface AuthLoginResult {
  token: string | null
  session: AuthSession
}

export interface AuthService {
  readonly enabled: boolean
  readonly sessionMaxAge: number
  session(token?: string): AuthSession
  login(key: unknown, ip: string, previousToken?: string): AuthLoginResult
  logout(token?: string): AuthSession
}

export interface AuthServiceOptions {
  authSecret: string
  sessionDays?: number
}

/** 登录失败以 Error 形式跨层抛出，status/code/retryAfter 由 HTTP 层读取。 */
interface AuthFailure extends Error {
  status: number
  code: string
  retryAfter?: number
}

interface LoginAttempt {
  failures: number
  resetAt: number
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

const failure = (status: number, message: string, code: string, retryAfter?: number): AuthFailure =>
  Object.assign(new Error(message), { status, code, retryAfter })

export function createAuthService(database: AniShareDatabase, { authSecret, sessionDays = 30 }: AuthServiceOptions): AuthService {
  const enabled = Boolean(authSecret)
  const secretHash = hash(authSecret || '')
  const sessionMaxAge = Math.round(sessionDays * 86400)
  const attempts = new Map<string, LoginAttempt>()
  database.cleanSessions(Date.now(), secretHash)
  const authenticated = (token?: string): boolean => !enabled || Boolean(token && database.findSession(hash(token), secretHash, Date.now()))
  const session = (token?: string): AuthSession => ({ enabled, authenticated: authenticated(token) })
  return {
    enabled,
    sessionMaxAge,
    session,
    login(key: unknown, ip: string, previousToken?: string): AuthLoginResult {
      if (!enabled) return { token: null, session: session() }
      const now = Date.now()
      for (const [address, attempt] of attempts) if (attempt.resetAt <= now) attempts.delete(address)
      const attempt: LoginAttempt = attempts.get(ip) || { failures: 0, resetAt: now + 15 * 60 * 1000 }
      if (attempt.failures >= 10) throw failure(429, '尝试次数过多，请稍后再试', 'LOGIN_RATE_LIMITED', Math.ceil((attempt.resetAt - now) / 1000))
      if (typeof key !== 'string' || key.length > 4096 || !timingSafeEqual(Buffer.from(hash(key)), Buffer.from(secretHash))) {
        attempt.failures++
        if (attempts.size >= 10000 && !attempts.has(ip)) {
          const oldest = attempts.keys().next().value
          if (oldest !== undefined) attempts.delete(oldest)
        }
        attempts.set(ip, attempt)
        throw failure(401, '访问密钥不正确', 'INVALID_ACCESS_KEY')
      }
      attempts.delete(ip)
      if (previousToken) database.deleteSession(hash(previousToken))
      database.cleanSessions(now, secretHash)
      const token = randomBytes(32).toString('hex')
      database.createSession(hash(token), secretHash, now + sessionMaxAge * 1000)
      return { token, session: session(token) }
    },
    logout(token?: string): AuthSession {
      if (token) database.deleteSession(hash(token))
      return { enabled, authenticated: !enabled }
    },
  }
}
