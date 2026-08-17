import React from 'react'
import { createRoot } from 'react-dom/client'
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
import { RawTxtData } from './pages/01_RawTxtData'
import { InstrumentAllocation } from './pages/InstrumentAllocation'
import { StrategyAllocation } from './pages/StrategyAllocation'
import { TradeBook } from './pages/TradeBook'
import { Strategy } from './pages/Strategy'
import { StrategyReport } from './pages/StrategyReport'
import { Positions } from './pages/Positions'
import { MataliaCharges } from './pages/MataliaCharges'
import { navigate, usePathname } from './lib/router'
import { AppLayout } from './layouts/AppLayout'

function Redirect({ to }: { to: string }) {
  React.useEffect(() => { navigate(to, true) }, [to])
  return null
}

function App() {
  const pathname = usePathname()
  if (pathname === '/') return <Redirect to="/raw-trade-import" />
  if (pathname === '/raw-trade-import') return <AppLayout><RawTxtData /></AppLayout>
  if (pathname === '/strategy-allocation') return <AppLayout><StrategyAllocation /></AppLayout>
  if (pathname === '/instrument-allocation') return <InstrumentAllocation />
  if (pathname === '/trade-book') return <AppLayout><TradeBook /></AppLayout>
  if (pathname === '/positions') return <AppLayout><Positions /></AppLayout>
  if (pathname === '/strategies') return <AppLayout><Strategy /></AppLayout>
  if (pathname === '/strategy-report') return <AppLayout><StrategyReport /></AppLayout>
  if (pathname === '/matalia-reports') return <AppLayout><MataliaCharges /></AppLayout>
  return <Redirect to="/raw-trade-import" />
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
