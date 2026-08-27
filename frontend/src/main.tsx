import React from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import './styles.css'
import './layout-overrides.css'
import './allocation.css'
import './allocation-overrides.css'
import './trade-book.css'
import './trade-book-overrides.css'
import './raw-trade-import-overrides.css'
import './strategy-report.css'
import './positions.css'
import './positions-allocation-match.css'
import './auth.css'
import './login.css'
import './user-management.css'
import { RawTxtData } from './pages/01_RawTxtData'
import { InstrumentAllocation } from './pages/InstrumentAllocation'
import { StrategyAllocation } from './pages/StrategyAllocation'
import { TradeBook } from './pages/TradeBook'
import { Strategy } from './pages/Strategy'
import { StrategyReport } from './pages/StrategyReport'
import { Positions } from './pages/Positions'
import { ActualPositions } from './pages/ActualPositions'
import { MataliaCharges } from './pages/MataliaCharges'
import { usePathname } from './lib/router'
import { AppLayout } from './layouts/AppLayout'
import { AuthGate } from './components/AuthGate'
import { ProductGuide } from './ProductGuide'
import { UserManagement } from './pages/UserManagement'

function WorkspaceApp({ pathname }: { pathname: string }) {
  if (pathname === '/raw-trade-import') return <AppLayout><RawTxtData /></AppLayout>
  if (pathname === '/strategy-allocation') return <AppLayout><StrategyAllocation /></AppLayout>
  if (pathname === '/instrument-allocation') return <InstrumentAllocation />
  if (pathname === '/trade-book') return <AppLayout><TradeBook /></AppLayout>
  if (pathname === '/positions') return <AppLayout><Positions /></AppLayout>
  if (pathname === '/actual-positions') return <AppLayout><ActualPositions /></AppLayout>
  if (pathname === '/strategies') return <AppLayout><Strategy /></AppLayout>
  if (pathname === '/strategy-report') return <AppLayout><StrategyReport /></AppLayout>
  if (pathname === '/matalia-reports') return <AppLayout><MataliaCharges /></AppLayout>
  if (pathname === '/user-management') return <AppLayout><UserManagement /></AppLayout>
  return null
}

function RouteTransition({ routeKey, children }: { routeKey: string; children: React.ReactNode }) {
  const prefersReducedMotion = useReducedMotion()
  const transition = prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: 'easeOut' as const }

  return <AnimatePresence mode="wait" initial={false}>
    <motion.div
      key={routeKey}
      className="route-transition"
      initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
      transition={transition}
    >
      {children}
    </motion.div>
  </AnimatePresence>
}

function App() {
  const pathname = usePathname()
  const routeKey = `${pathname}${window.location.search}${window.location.hash}`
  const page = pathname === '/product-guide'
    ? <ProductGuide />
    : <AuthGate pathname={pathname}><WorkspaceApp pathname={pathname} /></AuthGate>

  return <RouteTransition routeKey={routeKey}>{page}</RouteTransition>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
