import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, useEffect, useState } from 'react'

type LinkClassName = string | ((state: { isActive: boolean }) => string)

function getPathname() {
  return window.location.pathname || '/'
}

export function navigate(to: string, replace = false) {
  const url = new URL(to, window.location.origin)
  if (replace) window.history.replaceState({}, '', url.pathname + url.search + url.hash)
  else window.history.pushState({}, '', url.pathname + url.search + url.hash)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function usePathname() {
  const [pathname, setPathname] = useState(getPathname)

  useEffect(() => {
    const handlePopState = () => setPathname(getPathname())
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
