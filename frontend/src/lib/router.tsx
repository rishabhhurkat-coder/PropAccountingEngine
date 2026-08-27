import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, useEffect, useState } from 'react'

type LinkClassName = string | ((state: { isActive: boolean }) => string)

const HOME_ROUTE = '/strategy-allocation'
const FALLBACK_ROUTE = '/raw-trade-import'
const PUBLIC_ROUTES = new Set(['/product-guide'])
const APP_ROUTES = new Set([
  HOME_ROUTE,
  FALLBACK_ROUTE,
  '/instrument-allocation',
  '/trade-book',
  '/positions',
  '/actual-positions',
  '/strategies',
  '/strategy-report',
  '/matalia-reports',
  '/user-management',
])

function getBasePath() {
  return import.meta.env.BASE_URL.replace(/\/$/, '')
}

function getPathname() {
  const base = getBasePath()
  const pathname = window.location.pathname || '/'
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) return pathname.slice(base.length) || '/'
  return pathname
}

function getAppUrl(to: string) {
  const base = getBasePath()
  const path = to.startsWith('/') ? to : `/${to}`
  const url = new URL(`${base}${path}`, window.location.origin)
  return url.pathname + url.search + url.hash
}

function getHistoryState(route: string) {
  const currentState = window.history.state
  return {
    ...(currentState && typeof currentState === 'object' ? currentState : {}),
    __hnlPropTradingEngine: true,
    route,
  }
}

function normalizeRoute(pathname: string) {
  // Keep the app root as the login entry. AuthGate decides whether it should
  // remain there or replace it with the authenticated workspace Home route.
  if (pathname === '/' || pathname === '') return '/'
  if (PUBLIC_ROUTES.has(pathname) || APP_ROUTES.has(pathname)) return pathname
  return FALLBACK_ROUTE
}

function replaceWithNormalizedRoute(pathname: string) {
  const route = normalizeRoute(pathname)
  if (route === pathname) return route
  window.history.replaceState(getHistoryState(route), '', getAppUrl(route))
  return route
}

// Leave the first app entry at the login route. After authentication, AuthGate
// replaces it with the workspace Home route so browser Back follows:
// app page → app home → landing page.
replaceWithNormalizedRoute(getPathname())

export function navigate(to: string, replace = false) {
  const nextUrl = getAppUrl(to)
  const currentUrl = window.location.pathname + window.location.search + window.location.hash
  if (nextUrl === currentUrl) return

  const route = nextUrl.slice(getBasePath().length) || '/'
  const nextState = getHistoryState(route)
  if (replace) window.history.replaceState(nextState, '', nextUrl)
  else window.history.pushState(nextState, '', nextUrl)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function usePathname() {
  const [pathname, setPathname] = useState(() => replaceWithNormalizedRoute(getPathname()))

  useEffect(() => {
    const handlePopState = () => setPathname(replaceWithNormalizedRoute(getPathname()))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return pathname
}

export function NavLink(
  { to, end = false, replace = false, className, children, onClick, ...props }:
  { to: string; end?: boolean; replace?: boolean; className?: LinkClassName; children: ReactNode; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children' | 'onClick'>,
) {
  const pathname = usePathname()
  const isActive = end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)
  const resolvedClassName = typeof className === 'function' ? className({ isActive }) : [className, isActive ? 'active' : ''].filter(Boolean).join(' ')

  return <a
    {...props}
    href={to}
    className={resolvedClassName}
    onClick={(event) => {
      onClick?.(event)
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
      event.preventDefault()
      navigate(to, replace)
    }}
  >
    {children}
  </a>
}
