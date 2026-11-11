import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from '../types.ts'
import type { AuthService } from '../service/auth.service.ts'

/** 会话 Cookie 名与格式；WebSocket 网关（agent-chat.controller）握手时复用同一套规则。 */
export const SESSION_COOKIE = 'anishare_session'
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/

/** 从原始 Cookie 头里取合法的会话 token；格式不对或不存在时返回空串。 */
export function sessionToken(cookieHeader: string | undefined): string {
  const value = (cookieHeader || '').split(';').find((part: string) => part.trim().startsWith(`${SESSION_COOKIE}=`))
  const token = value?.trim().slice(SESSION_COOKIE.length + 1) || ''
  return SESSION_TOKEN_PATTERN.test(token) ? token : ''
}

const publicPaths: ReadonlySet<string> = new Set(['/api/auth/session', '/api/auth/login', '/api/auth/logout'])
const pathnameOf = (req: FastifyRequest): string => new URL(req.url, 'http://localhost').pathname
const cookieToken = (req: FastifyRequest): string => sessionToken(req.headers.cookie)

/** Request bodies are dynamic JSON; only the fields this controller reads are described. */
interface LoginRoute {
  Body: { key?: unknown } | null
}

/** Dependencies injected by the composition root (see app.ts / routes.ts). */
export interface AuthControllerDependencies {
  readonly authService: AuthService
  readonly settings: AppConfig
}

export function registerAuthController(app: FastifyInstance, { authService, settings }: AuthControllerDependencies): void {
  const setCookie = (req: FastifyRequest, reply: FastifyReply, token: string, age: number): void => {
    const secure = settings.secureCookies || req.protocol === 'https' ? '; Secure' : ''
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`)
  }
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const pathname = pathnameOf(req)
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin
      let originUrl: URL | null
      try { originUrl = origin ? new URL(origin) : null } catch { originUrl = null }
      const explicitlyAllowed = Boolean(originUrl && settings.frontendOrigins?.includes(originUrl.origin))
      if (!explicitlyAllowed && (req.headers['sec-fetch-site'] === 'cross-site' || (origin && originUrl?.host !== req.headers.host))) {
        return reply.code(403).send({ error: '不允许跨站请求' })
      }
    }
    if (authService.enabled && !publicPaths.has(pathname) && !authService.session(cookieToken(req)).authenticated) {
      return reply.code(401).header('Cache-Control', 'no-store').send({ error: '请先输入访问密钥登录' })
    }
  })
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (!pathnameOf(req).startsWith('/api/')) return payload
    if (authService.enabled) {
      reply.header('Cache-Control', String(reply.getHeader('cache-control') || 'no-store').replace(/\bpublic\b/g, 'private'))
      const vary = String(reply.getHeader('vary') || '').split(',').map((value: string) => value.trim()).filter(Boolean)
      reply.header('Vary', [...new Set([...vary, 'Cookie'])].join(', '))
    }
    return payload
  })
  app.get('/api/auth/session', async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    reply.header('Cache-Control', 'no-store')
    return authService.session(cookieToken(req))
  })
  app.post<LoginRoute>('/api/auth/login', async (req: FastifyRequest<LoginRoute>, reply: FastifyReply): Promise<unknown> => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { token, session } = authService.login(req.body?.key, req.ip, cookieToken(req))
      if (token) setCookie(req, reply, token, authService.sessionMaxAge)
      return session
    } catch (error) {
      // Login failures carry an optional retry hint; read it structurally.
      const retryAfter = (error as { retryAfter?: number }).retryAfter
      if (retryAfter) reply.header('Retry-After', String(retryAfter))
      throw error
    }
  })
  app.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const session = authService.logout(cookieToken(req))
    setCookie(req, reply, '', 0)
    reply.header('Cache-Control', 'no-store')
    return session
  })
}
