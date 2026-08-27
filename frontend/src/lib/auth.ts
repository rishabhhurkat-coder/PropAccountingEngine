import type { PropSessionUser } from '../types'

const apiBase = import.meta.env.VITE_BACKEND_URL?.trim() || import.meta.env.BASE_URL.replace(/\/$/, '')
let token = localStorage.getItem('prop_trading_engine_token') ?? ''
let user = readUser()

function readUser(): PropSessionUser | null {
  try {
    const stored = localStorage.getItem('prop_trading_engine_user')
    return stored ? JSON.parse(stored) as PropSessionUser : null
  } catch {
    return null
  }
}

function notify() {
  window.dispatchEvent(new Event('prop-trading-auth-changed'))
}

export function hasSession() {
  return Boolean(token)
}

export function currentUser() {
  return user
}

export function isAdminUser(candidate = user) {
  return candidate?.user_class?.toLowerCase() === 'admin' || candidate?.user_type?.toLowerCase() === 'admin'
}

export async function signIn(username: string, password: string): Promise<void> {
  const response = await fetch(`${apiBase}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const payload = await response.json().catch(() => ({})) as { token?: string; user?: PropSessionUser; detail?: string }
  if (!response.ok || !payload.token) throw new Error(payload.detail ?? 'Unable to sign in.')
  token = payload.token
  user = payload.user ?? null
  localStorage.setItem('prop_trading_engine_token', token)
  if (user) localStorage.setItem('prop_trading_engine_user', JSON.stringify(user))
  notify()
}

export async function signOut(): Promise<void> {
  const activeToken = token
  token = ''
  user = null
  localStorage.removeItem('prop_trading_engine_token')
  localStorage.removeItem('prop_trading_engine_user')
  notify()
  if (activeToken) {
    await fetch(`${apiBase}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${activeToken}` } }).catch(() => undefined)
  }
}

export async function accessToken(): Promise<string | null> {
  return token || null
}
