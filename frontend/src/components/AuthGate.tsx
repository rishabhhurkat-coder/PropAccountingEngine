import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { ArrowRight, BarChart3, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { hasSession, signIn } from '../lib/auth'
import { preloadWorkspaceData } from '../lib/api'
import { navigate } from '../lib/router'
import { LoginSiteHeader } from './LoginSiteHeader'

export function AuthGate({ children, pathname }: { children: ReactNode; pathname: string }) {
  const [authenticated, setAuthenticated] = useState(hasSession)

  useEffect(() => {
    const refresh = () => {
      const nextAuthenticated = hasSession()
      setAuthenticated(nextAuthenticated)
      if (nextAuthenticated && pathname === '/') navigate('/strategy-allocation', true)
      if (!nextAuthenticated && pathname !== '/') navigate('/', true)
    }

    // Keep login and the authenticated workspace on separate canonical URLs.
    refresh()
    window.addEventListener('prop-trading-auth-changed', refresh)
    return () => window.removeEventListener('prop-trading-auth-changed', refresh)
  }, [pathname])

  if (!authenticated) return <SignIn onSuccess={() => { setAuthenticated(true); navigate('/strategy-allocation', true) }} />
  if (pathname === '/') return null
  return <>{children}</>
}

function SignIn({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await signIn(username, password)
      // Warm the shared workspace snapshot while the route changes so the
      // first tab is ready immediately after authentication.
      preloadWorkspaceData()
      onSuccess()
    } catch {
      setError('We could not sign you in. Check your username and password.')
    } finally {
      setSubmitting(false)
    }
  }

  return <><LoginSiteHeader /><main className={`login-shell${submitting ? ' is-submitting' : ''}`} aria-busy={submitting}>
    <div className="login-background-orb login-background-orb-blue" />
    <div className="login-background-orb login-background-orb-purple" />
    <div className="login-grid-lines" />
    <div className="login-digital-display" aria-hidden="true"><span /><span /><span /></div>
    <div className="login-stage">
      <section className="login-card">
        <div className="login-intro">
          <p className="login-kicker"><span /> PROP TRADING ENGINE</p>
          <h1>Welcome back.</h1>
          <p className="login-subtitle">Sign in to manage your shared trading workspace securely.</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>Username<span className="login-input-wrap"><UserRound size={17} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Enter your username" required /></span></label>
          <label>Password<span className="login-input-wrap"><LockKeyhole size={17} /><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required /><button className="password-toggle" type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
          <div className="login-options"><span><ShieldCheck size={14} /> Secure connection</span><span>Need help? Contact your administrator.</span></div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button login-button" disabled={submitting}><span>{submitting ? 'Signing in...' : 'Sign in'}</span></button>
          <a className="login-more-info" href={`${import.meta.env.BASE_URL}product-guide`}>More about this product <ArrowRight size={15} /></a>
        </form>
        <p className="login-footer-note"><span /> H&amp;L Software · Shared trading workspace</p>
      </section>
      <aside className="login-showcase" aria-label="Prop trading engine overview">
        <h2>Every trade, position and decision in one place.</h2>
        <p className="showcase-copy">A clearer way to track trade accounting, allocations, positions and strategy reports in one shared workspace.</p>
        <div className="login-showcase-stack"><article className="ui-card login-showcase-card login-showcase-card-main"><div className="showcase-card-heading"><span className="showcase-icon blue"><BarChart3 size={18} /></span><span><small>PROP TRADING ENGINE</small><strong>Workspace ready</strong></span><em><i />Live</em></div><div className="showcase-detail-grid"><span><small>LEDGER SYNC</small><strong>Ready</strong></span><span><small>ALLOCATIONS</small><strong>Live</strong></span><span><small>RISK VIEW</small><strong>Clear</strong></span></div><div className="showcase-metrics"><span><b>12</b> active positions</span><span><b>P&amp;L</b> strategy reporting</span></div></article></div>
      </aside>
    </div>
  </main></>
}
