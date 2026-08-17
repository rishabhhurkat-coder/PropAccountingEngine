import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowUpRight, CircleDollarSign, RefreshCw, Wifi } from 'lucide-react';
import { loadTradeBook, loadZerodhaLivePrices, startZerodhaLivePrices, updateOpenTradeCmps } from '../lib/api';
import type { TradeBookRecord } from '../lib/tradeBook';

function money(value: number) {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnl(row: TradeBookRecord, cmp: number) {
  const direction = row.side === 'BUY' ? 1 : -1;
  return (cmp - row.price) * row.qty * direction;
}

export function Positions() {
  const [rows, setRows] = useState<TradeBookRecord[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [savingCmp, setSavingCmp] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [feedConnected, setFeedConnected] = useState(false);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const response = await loadTradeBook('Open Trades');
      setRows(response.rows);
      const live = await startZerodhaLivePrices(response.rows.map((row) => ({ id: row.id, scrip: row.scrip, expiry: row.expiry, strike: row.strike, optType: row.optType })));
      setLivePrices(live.prices);
      setFeedConnected(live.connected);
      setLastUpdated(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load open positions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!rows.length) return undefined;
    const timer = window.setInterval(() => {
      loadZerodhaLivePrices().then((response) => {
        setLivePrices(response.prices);
        setFeedConnected(response.connected);
      }).catch(() => setFeedConnected(false));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [rows.length]);

  async function saveCmp() {
    setSavingCmp(true);
    setError('');
    setMessage('Fetching current CMP from Zerodha and saving to Open Trades…');
    try {
      const response = await updateOpenTradeCmps();
      setMessage(response.message || `Updated CMP for ${response.updated} open trade(s).`);
      await refresh();
    } catch (saveError: unknown) {
      setMessage('');
      setError(saveError instanceof Error ? saveError.message : 'Unable to update CMP');
    } finally {
      setSavingCmp(false);
    }
  }

  const positions = useMemo(() => rows.map((row) => ({
    ...row,
    cmp: livePrices[row.id] ?? row.cmp ?? row.price,
  })), [livePrices, rows]);

  const totals = useMemo(() => positions.reduce((summary, row) => {
    const rowPnl = pnl(row, row.cmp);
    summary.qty += row.side === 'BUY' ? row.qty : -row.qty;
    summary.value += row.price * row.qty;
    summary.pnl += rowPnl;
    return summary;
  }, { qty: 0, value: 0, pnl: 0 }), [positions]);

  return (
    <div className="positions-page">
      <main className="positions-main">
        <header className="positions-header">
          <div>
            <h1>Positions</h1>
          </div>
          <div className="positions-header-actions">
            <span className={`positions-feed-status ${feedConnected ? 'connected' : 'ready'}`}><Wifi size={14} /> {feedConnected ? 'Live feed connected' : 'Live CMP ready'}</span>
            <button className="positions-refresh" type="button" onClick={saveCmp} disabled={savingCmp || loading} title="Fetch current CMP and save it to Open Trades"><RefreshCw size={15} className={savingCmp ? 'spin' : ''} /> {savingCmp ? 'Saving CMP…' : 'Fetch & Save CMP'}</button>
            <button className="positions-refresh" type="button" onClick={refresh} disabled={loading || savingCmp} title="Reload open positions"><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh</button>
          </div>
        </header>

        {message && <div className="positions-message" role="status">{message}</div>}
        {error && <div className="positions-message error" role="alert">{error}<button type="button" onClick={refresh}>Retry</button></div>}

        <section className="positions-summary" aria-label="Position summary">
          <div className="positions-stat"><div className="positions-stat-icon blue"><Activity size={19} /></div><div><span>Open Positions</span><strong>{positions.length}</strong><small>Currently running</small></div></div>
          <div className="positions-stat"><div className="positions-stat-icon violet"><CircleDollarSign size={19} /></div><div><span>Net Quantity</span><strong>{totals.qty.toLocaleString('en-IN')}</strong><small>Across open trades</small></div></div>
          <div className="positions-stat"><div className="positions-stat-icon orange"><CircleDollarSign size={19} /></div><div><span>Position Value</span><strong>{money(totals.value)}</strong><small>At average price</small></div></div>
          <div className={`positions-stat ${totals.pnl >= 0 ? 'positive' : 'negative'}`}><div className="positions-stat-icon green"><ArrowUpRight size={19} /></div><div><span>Live P&amp;L</span><strong>{money(totals.pnl)}</strong><small>Based on CMP</small></div></div>
        </section>

        <section className="positions-card">
          <div className="positions-card-head"><div><h2>Open Positions</h2><p>{positions.length} live position{positions.length === 1 ? '' : 's'}</p></div><span className="positions-updated">Updated {lastUpdated || '—'}</span></div>
          <div className="positions-table-wrap">
            <table className="positions-table">
              <thead><tr><th>Date</th><th>Time</th><th>Trade</th><th>Instrument</th><th>Expiry</th><th>Strike</th><th>Option</th><th>Qty</th><th>Price</th><th>CMP</th><th>Live P&amp;L</th><th>Strategy</th></tr></thead>
              <tbody>
                {positions.map((row) => {
                  const rowPnl = pnl(row, row.cmp);
                  return <tr key={row.id}><td>{row.date}</td><td>{row.time}</td><td><span className={`positions-trade-badge ${row.side.toLowerCase()}`}>{row.side}</span></td><td className="positions-instrument">{row.scrip}</td><td>{row.expiry}</td><td>{row.strike}</td><td><span className={`positions-option ${row.optType.toLowerCase()}`}>{row.optType}</span></td><td>{row.qty.toLocaleString('en-IN')}</td><td>{money(row.price)}</td><td className="positions-cmp">{money(row.cmp)}</td><td className={rowPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>{money(rowPnl)}</td><td><span className="positions-strategy">{row.strategy}</span></td></tr>;
                })}
                {!loading && !positions.length && <tr><td colSpan={12} className="positions-empty">No open positions right now.</td></tr>}
                {loading && <tr><td colSpan={12} className="positions-empty">Loading open positions…</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
