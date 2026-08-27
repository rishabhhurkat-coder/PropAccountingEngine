import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'

export function TradeBookHeader({ syncStatus, syncTimeLabel, countMismatch, actualAllTrades, expectedAllTrades }: { syncStatus: 'checking' | 'verified' | 'mismatch' | 'idle'; syncTimeLabel: string; countMismatch: boolean; actualAllTrades: number; expectedAllTrades: number }) {
  const verified = syncStatus === 'verified';
  const mismatch = syncStatus === 'mismatch';
  const countState = syncStatus === 'checking' || syncStatus === 'idle' ? 'checking' : countMismatch ? 'mismatch' : 'good';
  return (
    <header className="reference-trade-header">
      <div><h1>Trade Book</h1></div>
      <div className="reference-header-actions">
        <div className={`reference-sync-card ${verified ? 'verified' : mismatch ? 'mismatch' : syncStatus === 'checking' ? 'checking' : ''}`} role="status" title="Trade Book Supabase verification">
          {verified ? <CheckCircle2 size={14} /> : mismatch ? <AlertCircle size={14} /> : <Loader2 className={syncStatus === 'checking' ? 'spin' : ''} size={14} />}
          <span>{verified ? `Verified · ${syncTimeLabel}` : mismatch ? 'Count mismatch — retrying' : syncStatus === 'checking' ? 'Checking data…' : 'Not verified'}</span>
        </div>
        <div className={`reference-count-alert ${countState}`} role={countState === 'mismatch' ? 'alert' : 'status'} title="All Trades count compared with Closed Trades × 2 + Open Trades">
          {countState === 'good' ? <CheckCircle2 size={14} /> : countState === 'mismatch' ? <AlertCircle size={14} /> : <Loader2 className="spin" size={14} />}
          <span>{countState === 'good' ? 'All Good' : countState === 'mismatch' ? `Count Alert · All ${actualAllTrades} / Expected ${expectedAllTrades}` : 'Checking counts…'}</span>
        </div>
      </div>
    </header>
  )
}
