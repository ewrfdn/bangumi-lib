import { reactive } from 'vue'
import { api } from './api'

export const auth = reactive({ enabled: false, authenticated: false, checked: false, error: '' })
let pendingSession

function updateSession(session) {
  auth.enabled = session.enabled
  auth.authenticated = session.authenticated
  auth.checked = true
  auth.error = ''
  return session
}

export function checkSession(force = false) {
  if (auth.checked && !force) return Promise.resolve(auth)
  if (!pendingSession) {
    pendingSession = api.authSession().then(updateSession).catch((error) => {
      auth.error = error.message || '暂时无法连接番剧库'
      throw error
    }).finally(() => { pendingSession = null })
  }
  return pendingSession
}

export async function login(key) {
  return updateSession(await api.login(key))
}

export async function logout() {
  const session = await api.logout()
  updateSession(session)
}

export function loginDestination(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login')
    ? value
    : '/'
}
