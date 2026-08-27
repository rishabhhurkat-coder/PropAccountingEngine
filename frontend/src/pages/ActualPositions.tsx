import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowUpRight, Check, CircleDollarSign, Download, Edit3, Loader2, Minus, Plus, RefreshCw, Save, Trash2, Wifi, X } from 'lucide-react';
import {
  addActualPositionsBulk,
  deleteActualPosition,
  importActualPositions,
  loadActualPositions,
  loadActualPositionStrategyQuotes,
  loadCachedActualPositions,
  loadZerodhaLivePrices,
  startZerodhaLivePrices,
  updateActualPosition,
  type ActualPositionCreatePayload,
  type ActualPositionStrategyQuoteRow,
} from '../lib/api';
import type { TradeBookRecord } from '../lib/tradeBook';
import { StrategyBadge } from '../components/StrategyBadge';

const STRATEGIES = ['Nifty FING', 'Nifty AVWAP', 'Banknifty FING', 'Banknifty AVWAP', 'ATM EMA Intraday', 'Nifty Opt Buy'];
const GROUPED_STRATEGIES = new Set(['Nifty FING', 'Nifty AVWAP', 'Banknifty FING', 'Banknifty AVWAP']);
const MAIN_STRATEGY_ORDER = ['ATM EMA Intraday', 'Banknifty AVWAP', 'Banknifty FING', 'Nifty AVWAP', 'Nifty FING', 'Nifty Opt Buy'];

type WizardStep = 'strategy' | 'details' | 'review';
type WizardRow = Omit<ActualPositionStrategyQuoteRow, 'strike' | 'qty' | 'entryPrice'> & { strike: string; qty: number | string; entryPrice: number | string | null; livePrice?: number | null };
type WizardState = {
  strategy: string;
  instrument: string;
  side: 'BUY' | 'SELL';
  option: '' | 'CE' | 'PE';
  expiry: string;
  expiryChoices: Array<{ value: string; label: string; dte: string }>;
  date: string;
  time: string;
  underlyingPrice: string;
  atm: number | null;
  strikeChoices: number[];
  rows: WizardRow[];
  quoteError: string;
};
type DisplayPosition = TradeBookRecord & { cmp: number };

function money(value: number) {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnl(row: TradeBookRecord, cmp: number) {
  const direction = row.side === 'BUY' ? 1 : -1;
  return (cmp - row.price) * row.qty * direction;
}

function nowParts() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}` };
}

function emptyWizard(): WizardState {
  const now = nowParts();
  return { strategy: '', instrument: '', side: 'BUY', option: '', expiry: '', expiryChoices: [], date: now.date, time: now.time, underlyingPrice: '', atm: null, strikeChoices: [], rows: [], quoteError: '' };
}

function isGrouped(strategy: string) { return GROUPED_STRATEGIES.has(strategy); }

function mainStrategyName(strategy: string, persistedMainStrategy?: string) {
  const candidate = persistedMainStrategy?.trim() || strategy;
  const normalized = candidate.replace(/\s+/g, ' ').trim().replace(/^R\s+/, '').toUpperCase();
  if (normalized.startsWith('BANKNIFTY AVWAP')) return 'Banknifty AVWAP';
  if (normalized.startsWith('BANKNIFTY FING')) return 'Banknifty FING';
  if (normalized.startsWith('NIFTY AVWAP')) return 'Nifty AVWAP';
  if (normalized.startsWith('NIFTY FING')) return 'Nifty FING';
  if (normalized.startsWith('ATM EMA INTRADAY')) return 'ATM EMA Intraday';
  if (normalized.startsWith('NIFTY OPT BUY')) return 'Nifty Opt Buy';
  return candidate.trim() || 'Other';
}

function strategySort(a: string, b: string) {
  const aIndex = MAIN_STRATEGY_ORDER.indexOf(a);
  const bIndex = MAIN_STRATEGY_ORDER.indexOf(b);
  if (aIndex !== -1 || bIndex !== -1) return (aIndex === -1 ? MAIN_STRATEGY_ORDER.length : aIndex) - (bIndex === -1 ? MAIN_STRATEGY_ORDER.length : bIndex);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function groupMetrics(rows: DisplayPosition[]) {
  return rows.reduce((summary, row) => {
    const absoluteQty = Math.abs(row.qty);
    summary.qty += row.side === 'BUY' ? row.qty : -row.qty;
    summary.mtm += pnl(row, row.cmp);
    summary.priceTotal += row.price * absoluteQty;
    summary.quantityTotal += absoluteQty;
    return summary;
  }, { qty: 0, mtm: 0, priceTotal: 0, quantityTotal: 0 });
}

function editDate(value: string) {
  const match = value.trim().match(/^(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{2,4})/);
  if (!match) return value;
  const months: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${months[match[2].toLowerCase()] || '01'}-${String(match[1]).padStart(2, '0')}`;
}

export function ActualPositions() {
  const cachedSnapshot = loadCachedActualPositions();
  const [rows, setRows] = useState<TradeBookRecord[]>(cachedSnapshot?.rows || []);
  const [imported, setImported] = useState(cachedSnapshot?.imported || false);
  const [needsReimport, setNeedsReimport] = useState(Boolean(cachedSnapshot?.needs_reimport));
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(!cachedSnapshot);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [feedConnected, setFeedConnected] = useState(false);
  const [feedError, setFeedError] = useState('');
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('strategy');
  const [wizard, setWizard] = useState<WizardState>(emptyWizard);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [savingWizard, setSavingWizard] = useState(false);
  const [editing, setEditing] = useState<(ActualPositionCreatePayload & { id: string }) | null>(null);
  const [editingSaving, setEditingSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [editError, setEditError] = useState('');
  const [strategyFilter, setStrategyFilter] = useState('ALL');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedOptionGroups, setCollapsedOptionGroups] = useState<Set<string>>(new Set());
  const lastReconnectAt = useRef(0);

  async function startLive(rowsToUse: TradeBookRecord[]) {
    if (!rowsToUse.length) return;
    const live = await startZerodhaLivePrices(rowsToUse.map((row) => ({ id: row.id, scrip: row.scrip, expiry: row.expiry, strike: row.strike, optType: row.optType })));
    setLivePrices(live.prices || {});
    setFeedConnected(live.connected);
    setFeedError(live.last_error || (!live.success ? live.message || 'Zerodha live-price startup failed.' : live.mapped === 0 ? 'No live Zerodha instrument mapping was found.' : ''));
    if (Object.keys(live.prices || {}).length) setLastUpdated(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }

  async function refresh() {
    setLoading(rows.length === 0); setError('');
    try {
      const response = await loadActualPositions();
      setRows(response.rows); setImported(response.imported); setNeedsReimport(Boolean(response.needs_reimport)); await startLive(response.rows);
    } catch (loadError: unknown) {
      if (rows.length) setMessage('Showing the last cached Actual Positions while Supabase reconnects.');
      else setError(loadError instanceof Error ? loadError.message : 'Unable to load Actual Positions');
    } finally { setLoading(false); }
  }

  useEffect(() => { refresh().catch(() => undefined); }, []);

  useEffect(() => {
    if (!rows.length) return undefined;
    const positionPayload = rows.map((row) => ({ id: row.id, scrip: row.scrip, expiry: row.expiry, strike: row.strike, optType: row.optType }));
    const timer = window.setInterval(() => {
      loadZerodhaLivePrices().then((response) => {
        setLivePrices(response.prices || {}); setFeedConnected(response.connected); setFeedError(response.last_error || (!response.success ? response.message || 'Zerodha live-price request failed.' : ''));
        if (Object.keys(response.prices || {}).length) setLastUpdated(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        if (!response.connected && Date.now() - lastReconnectAt.current >= 5000) {
          lastReconnectAt.current = Date.now();
          startZerodhaLivePrices(positionPayload).then((retry) => { setLivePrices(retry.prices || {}); setFeedConnected(retry.connected); setFeedError(retry.last_error || (!retry.success ? retry.message || 'Zerodha reconnect failed.' : '')); }).catch(() => setFeedConnected(false));
        }
      }).catch((pollError: unknown) => { setFeedConnected(false); setFeedError(pollError instanceof Error ? pollError.message : 'Live CMP request failed'); });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [rows]);

  async function importOnce() {
    setImporting(true); setError(''); setMessage('Importing positions from the next four active expiry dates…');
    try { const response = await importActualPositions(); setRows(response.rows); setImported(true); setNeedsReimport(false); setMessage(response.message || `Imported ${response.imported_count || 0} position(s).`); await startLive(response.rows); }
    catch (importError: unknown) { setMessage(''); setError(importError instanceof Error ? importError.message : 'Unable to import Actual Positions'); }
    finally { setImporting(false); }
  }

  function openWizard() { setWizard(emptyWizard()); setWizardStep('strategy'); setShowWizard(true); setError(''); }

  function strikeStepForInstrument(instrument: string) { return instrument.toUpperCase().includes('BANKNIFTY') ? 100 : 50; }

  function normalizeStrike(value: string, instrument: string) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return value;
    const step = strikeStepForInstrument(instrument);
    return String(Math.round(numeric / step) * step);
  }

  async function loadWizardQuotes(next: WizardState) {
    if (!next.strategy || !next.expiry || !next.option) return;
    setQuoteLoading(true); setWizard((current) => ({ ...current, quoteError: '' }));
    try {
      const response = await loadActualPositionStrategyQuotes({ strategy: next.strategy, expiry: next.expiry, option: next.option, side: next.side, underlyingPrice: next.underlyingPrice ? Number(next.underlyingPrice) : null });
      setWizard((current) => ({ ...current, rows: response.rows, strikeChoices: response.strike_choices || current.strikeChoices, underlyingPrice: response.underlying_price == null ? current.underlyingPrice : String(response.underlying_price), atm: response.atm ?? current.atm, quoteError: response.quote_error || '' }));
    } catch (quoteError: unknown) { setWizard((current) => ({ ...current, rows: [], quoteError: quoteError instanceof Error ? quoteError.message : 'Unable to load the strategy options.' })); }
    finally { setQuoteLoading(false); }
  }

  async function chooseStrategy(strategy: string) {
    setQuoteLoading(true); setWizard((current) => ({ ...current, strategy, rows: [], quoteError: '' }));
    try {
      const response = await loadActualPositionStrategyQuotes({ strategy });
      const side = response.side || (strategy === 'Nifty Opt Buy' ? 'BUY' : 'SELL');
      const option: WizardState['option'] = strategy === 'Nifty Opt Buy' ? (side === 'BUY' ? 'CE' : 'PE') : '';
      const firstExpiry = response.expiry_choices[0];
      const defaultExpiry = strategy === 'ATM EMA Intraday' && firstExpiry && Number(firstExpiry.dte) < 2 ? response.expiry_choices[1] || firstExpiry : firstExpiry;
      const nextWizard = { ...wizard, strategy, instrument: response.instrument, side, option, expiryChoices: response.expiry_choices, expiry: defaultExpiry?.value || '', underlyingPrice: response.underlying_price == null ? '' : String(response.underlying_price), atm: response.atm ?? null, strikeChoices: response.strike_choices || [], rows: [], quoteError: '' };
      setWizard(nextWizard);
      if (option && nextWizard.expiry) await loadWizardQuotes(nextWizard);
      setWizardStep('details');
    } catch (quoteError: unknown) { setWizard((current) => ({ ...current, quoteError: quoteError instanceof Error ? quoteError.message : 'Unable to load this strategy.' })); }
    finally { setQuoteLoading(false); }
  }

  function changeWizard(partial: Partial<WizardState>) { setWizard((current) => ({ ...current, ...partial })); }

  async function selectOption(option: 'CE' | 'PE') { const next = { ...wizard, option }; changeWizard({ option, rows: [] }); await loadWizardQuotes(next); }
  async function selectSide(side: 'BUY' | 'SELL') { const option: 'CE' | 'PE' = side === 'BUY' ? 'CE' : 'PE'; const next = { ...wizard, side, option }; changeWizard({ side, option, rows: [] }); await loadWizardQuotes(next); }
  async function selectExpiry(expiry: string) { const next = { ...wizard, expiry }; changeWizard({ expiry, rows: [] }); await loadWizardQuotes(next); }
  async function refreshWizardRowQuote(index: number, rawStrike: string) {
    const strike = normalizeStrike(rawStrike, wizard.instrument);
    setWizard((current) => ({ ...current, rows: current.rows.map((row, rowIndex) => rowIndex === index ? { ...row, strike } : row), quoteError: '' }));
    if (!wizard.expiry || !wizard.option || !strike) return;
    setQuoteLoading(true);
    try {
      const response = await loadActualPositionStrategyQuotes({ strategy: wizard.strategy, expiry: wizard.expiry, option: wizard.option, side: wizard.side, strike: Number(strike), strategyName: wizard.rows[index]?.strategyName });
      const quote = response.rows[0];
      setWizard((current) => ({
        ...current,
        rows: current.rows.map((row, rowIndex) => rowIndex === index ? {
          ...row,
          strike,
          livePrice: quote?.livePrice ?? null,
          entryPrice: quote?.entryPrice ?? row.entryPrice,
        } : row),
        quoteError: response.quote_error || '',
      }));
    } catch (quoteError: unknown) {
      setWizard((current) => ({ ...current, quoteError: quoteError instanceof Error ? quoteError.message : 'Unable to refresh the Zerodha premium for this strike.' }));
    } finally { setQuoteLoading(false); }
  }

  function updateWizardRow(index: number, field: 'strike' | 'qty' | 'entryPrice', value: string) { setWizard((current) => ({ ...current, rows: current.rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row) })); }

  const wizardCanReview = Boolean(wizard.rows.length > 0 && wizard.rows.every((row) => Number(row.strike) > 0 && Number(row.qty) > 0 && Number(row.entryPrice) >= 0) && wizard.date && wizard.time && wizard.expiry);

  async function saveWizard() {
    if (!wizardCanReview) return;
    setSavingWizard(true); setError('');
    const payload: ActualPositionCreatePayload[] = wizard.rows.map((row) => ({ strategyName: row.strategyName, date: wizard.date, time: wizard.time, instrument: wizard.instrument, expiry: wizard.expiry, strike: Number(row.strike), option: row.option, qty: Number(row.qty), entryPrice: Number(row.entryPrice), side: wizard.side }));
    try { const response = await addActualPositionsBulk(payload); setRows(response.rows); setImported(response.imported); setNeedsReimport(Boolean(response.needs_reimport)); setShowWizard(false); setMessage(response.message || `Saved ${payload.length} Actual Position(s).`); await startLive(response.rows).catch(() => undefined); }
    catch (saveError: unknown) { setWizard((current) => ({ ...current, quoteError: saveError instanceof Error ? saveError.message : 'Unable to save Actual Positions.' })); }
    finally { setSavingWizard(false); }
  }

  function beginEdit(row: TradeBookRecord) {
    setEditError('');
    setEditing({ id: row.id, strategyName: row.strategy, date: editDate(row.date), time: row.time.slice(0, 5), instrument: row.scrip, expiry: editDate(row.expiry), strike: Number(row.strike), option: row.optType, qty: row.qty, entryPrice: row.price, side: row.side });
  }

  async function saveEdit() {
    if (!editing) return;
    setEditingSaving(true); setEditError('');
    try { const response = await updateActualPosition(editing.id, editing); setRows(response.rows); setEditing(null); setMessage(response.message || 'Actual Position updated.'); await startLive(response.rows).catch(() => undefined); }
    catch (saveError: unknown) { setEditError(saveError instanceof Error ? saveError.message : 'Unable to update Actual Position'); }
    finally { setEditingSaving(false); }
  }

  async function removePosition(row: TradeBookRecord) {
    if (!window.confirm(`Delete ${row.strategy} ${row.scrip} ${row.strike}${row.optType}?`)) return;
    setDeletingId(row.id); setError('');
    try { const response = await deleteActualPosition(row.id); setRows(response.rows); setMessage(response.message || 'Actual Position deleted.'); }
    catch (deleteError: unknown) { setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete Actual Position'); }
    finally { setDeletingId(''); }
  }

  const positions = useMemo<DisplayPosition[]>(() => rows.map((row) => ({ ...row, cmp: livePrices[row.id] ?? row.cmp ?? row.price })), [livePrices, rows]);
  const strategyOptions = useMemo(() => Array.from(new Set(positions.map((row) => mainStrategyName(row.strategy, row.mainStrategy))).values()).sort(strategySort), [positions]);
  const visiblePositions = useMemo(() => positions.filter((row) => strategyFilter === 'ALL' || mainStrategyName(row.strategy, row.mainStrategy) === strategyFilter), [positions, strategyFilter]);
  const groupedPositions = useMemo(() => {
    const groups = new Map<string, DisplayPosition[]>();
    visiblePositions.forEach((row) => {
      const mainStrategy = mainStrategyName(row.strategy, row.mainStrategy);
      const existing = groups.get(mainStrategy) || [];
      existing.push(row);
      groups.set(mainStrategy, existing);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => strategySort(a, b)).map(([name, groupRows]) => ({
      name,
      rows: groupRows.sort((a, b) => a.strategy.localeCompare(b.strategy, undefined, { numeric: true, sensitivity: 'base' }) || a.date.localeCompare(b.date) || a.time.localeCompare(b.time)),
      optionGroups: Array.from(new Set(groupRows.map((row) => row.optType.toUpperCase()))).sort().map((option) => ({ option, rows: groupRows.filter((row) => row.optType.toUpperCase() === option) })),
    }));
  }, [visiblePositions]);
  const totals = useMemo(() => visiblePositions.reduce((summary, row) => { summary.qty += row.side === 'BUY' ? row.qty : -row.qty; summary.value += row.price * row.qty; summary.pnl += pnl(row, row.cmp); return summary; }, { qty: 0, value: 0, pnl: 0 }), [visiblePositions]);

  function positionsTable(tableRows: DisplayPosition[]) {
    return <div className="positions-table-wrap"><table className="positions-table"><thead><tr><th>Date</th><th>Time</th><th>Trade</th><th>Instrument</th><th>Expiry</th><th>Strike</th><th>Option</th><th>Qty</th><th>Price</th><th>CMP</th><th>Live P&amp;L</th><th>Strategy</th><th>Actions</th></tr></thead><tbody>{tableRows.map((row) => { const rowPnl = pnl(row, row.cmp); return <tr key={row.id}><td>{row.date}</td><td>{row.time}</td><td><span className={`positions-trade-badge ${row.side.toLowerCase()}`}>{row.side}</span></td><td className="positions-instrument">{row.scrip}</td><td>{row.expiry}</td><td>{row.strike}</td><td><span className={`positions-option ${row.optType.toLowerCase()}`}>{row.optType}</span></td><td>{row.qty.toLocaleString('en-IN')}</td><td>{money(row.price)}</td><td className="positions-cmp">{money(row.cmp)}</td><td className={rowPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>{money(rowPnl)}</td><td><StrategyBadge value={row.strategy} className="positions-strategy" /></td><td><div className="position-row-actions"><button type="button" aria-label="Edit position" title="Edit position" onClick={() => beginEdit(row)}><Edit3 size={13} /></button><button type="button" aria-label="Delete position" title="Delete position" disabled={deletingId === row.id} onClick={() => removePosition(row)}><Trash2 size={13} /></button></div></td></tr>; })}</tbody></table></div>;
  }

  return <div className="positions-page"><main className="positions-main">
    <header className="positions-header"><div><h1>Actual Positions</h1></div><div className="positions-header-actions">
      <span className={`positions-feed-status ${feedConnected ? 'connected' : feedError ? 'error' : 'ready'}`} title={feedError || 'Live CMP status'}><Wifi size={14} /> {feedConnected ? 'Live feed connected' : feedError ? 'Live CMP issue' : 'Live CMP ready'}</span>
      <button className="positions-refresh" type="button" onClick={openWizard} disabled={savingWizard}><Plus size={15} /> Add Position</button>
      <button className="positions-refresh" type="button" onClick={importOnce} disabled={importing || loading}><Download size={15} className={importing ? 'spin' : ''} /> {importing ? 'Importing…' : needsReimport ? 'Re-import Active Positions' : imported ? 'Re-import & Overwrite' : 'Import Active Positions'}</button>
      <button className="positions-refresh" type="button" onClick={refresh} disabled={loading || importing}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh</button>
    </div></header>

    {!imported && !loading && <div className="positions-message" role="status">Import will include all positions from the next four expiry dates on or after today. After import, maintain the position rows manually. Zerodha CMP will continue updating automatically.</div>}
    {needsReimport && !loading && <div className="positions-message" role="status">The previous snapshot used the old import scope. Re-import to replace it with positions from the next four active expiry dates.</div>}
    {message && <div className="positions-message" role="status">{message}</div>}{feedError && <div className="positions-message error" role="status">Live CMP update issue: {feedError}</div>}{error && <div className="positions-message error" role="alert">{error}<button type="button" onClick={refresh}>Retry</button></div>}

    {editing && <section className="positions-card actual-position-form-card"><div className="positions-card-head"><div><h2>Edit Position</h2><p>Update the saved Actual Position row.</p></div><button className="positions-icon-button" type="button" onClick={() => setEditing(null)} aria-label="Close"><X size={17} /></button></div><div className="actual-position-form"><label>Strategy Name<input value={editing.strategyName} onChange={(event) => setEditing({ ...editing, strategyName: event.target.value })} /></label><label>Date<input type="date" value={editing.date} onChange={(event) => setEditing({ ...editing, date: event.target.value })} /></label><label>Time<input type="time" value={editing.time} onChange={(event) => setEditing({ ...editing, time: event.target.value })} /></label><label>Instrument<input value={editing.instrument} onChange={(event) => setEditing({ ...editing, instrument: event.target.value.toUpperCase() })} /></label><label>Expiry<input type="date" value={editing.expiry} onChange={(event) => setEditing({ ...editing, expiry: event.target.value })} /></label><label>Strike<input type="number" min="1" step={strikeStepForInstrument(editing.instrument)} value={editing.strike} onChange={(event) => setEditing({ ...editing, strike: Number(event.target.value) })} onBlur={() => setEditing({ ...editing, strike: Number(normalizeStrike(String(editing.strike), editing.instrument)) })} /></label><label>Option<select value={editing.option} onChange={(event) => setEditing({ ...editing, option: event.target.value })}><option value="CE">CE</option><option value="PE">PE</option></select></label><label>Quantity<input type="number" min="1" value={editing.qty} onChange={(event) => setEditing({ ...editing, qty: Number(event.target.value) })} /></label><label>Entry Price<input type="number" min="0" step="0.01" value={editing.entryPrice} onChange={(event) => setEditing({ ...editing, entryPrice: Number(event.target.value) })} /></label><label>Trade Side<select value={editing.side} onChange={(event) => setEditing({ ...editing, side: event.target.value as 'BUY' | 'SELL' })}><option value="BUY">BUY</option><option value="SELL">SELL</option></select></label>{editError && <div className="actual-position-form-error" role="alert">{editError}</div>}<div className="actual-position-form-actions"><button type="button" className="positions-refresh" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="positions-refresh actual-position-save" disabled={editingSaving} onClick={saveEdit}><Save size={15} className={editingSaving ? 'spin' : ''} /> {editingSaving ? 'Saving…' : 'Save Changes'}</button></div></div></section>}

    {showWizard && <div className="actual-position-modal-backdrop" role="presentation"><section className="positions-card actual-position-wizard-card" role="dialog" aria-modal="true" aria-label="Add Actual Position"><div className="positions-card-head wizard-head"><div><span className="wizard-eyebrow">ACTUAL POSITIONS</span><h2>{wizardStep === 'strategy' ? 'Add Position' : wizardStep === 'details' ? wizard.strategy : 'Review Position'}</h2><p>{wizardStep === 'strategy' ? 'Select the main strategy to begin.' : wizardStep === 'details' ? 'Complete the strategy-specific details.' : 'Check the entries before saving them together.'}</p></div><button className="positions-icon-button" type="button" onClick={() => setShowWizard(false)} aria-label="Close"><X size={21} /></button></div><div className="wizard-body">
      {wizardStep === 'strategy' && <div className="wizard-strategy-grid">{STRATEGIES.map((strategy) => <button type="button" className="wizard-strategy-option" key={strategy} onClick={() => chooseStrategy(strategy)} disabled={quoteLoading}><span>{strategy}</span><small>{strategy === 'Nifty Opt Buy' || strategy === 'ATM EMA Intraday' ? 'NIFTY · one position' : `${strategy.includes('Banknifty') ? 'BANKNIFTY' : 'NIFTY'} · grouped positions`}</small></button>)}</div>}

      {wizardStep === 'details' && <><div className="wizard-toolbar"><button type="button" className="wizard-back-button" onClick={() => setWizardStep('strategy')}><ArrowLeft size={14} /> Change strategy</button>{quoteLoading && <span className="wizard-loading"><Loader2 size={14} className="spin" /> Loading Zerodha data…</span>}</div><div className="wizard-fields">
        <label>Instrument<input value={wizard.instrument} readOnly /></label><label>Expiry<select value={wizard.expiry} onChange={(event) => selectExpiry(event.target.value)}>{wizard.expiryChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label} ({choice.dte} DTE)</option>)}</select></label><label>Date<input type="date" value={wizard.date} onChange={(event) => changeWizard({ date: event.target.value })} /></label><label>Time<input type="time" value={wizard.time} onChange={(event) => changeWizard({ time: event.target.value })} /></label>
        {isGrouped(wizard.strategy) && <label>Index Price<input type="number" step="0.01" value={wizard.underlyingPrice} onChange={(event) => changeWizard({ underlyingPrice: event.target.value })} onBlur={() => wizard.option && loadWizardQuotes({ ...wizard, underlyingPrice: wizard.underlyingPrice })} /></label>}{isGrouped(wizard.strategy) && <label>Calculated ATM<input value={wizard.atm ?? 'Select price'} readOnly /></label>}
      </div><div className="wizard-choice-row"><span className="wizard-label">{wizard.strategy === 'Nifty Opt Buy' ? 'Trade' : 'Option'}</span>{wizard.strategy === 'Nifty Opt Buy' ? (['BUY', 'SELL'] as const).map((side) => <button type="button" key={side} className={`wizard-choice ${wizard.side === side ? 'selected' : ''}`} onClick={() => selectSide(side)}>{side}<small>{side === 'BUY' ? 'CE' : 'PE'}</small></button>) : (['CE', 'PE'] as const).map((option) => <button type="button" key={option} className={`wizard-choice ${wizard.option === option ? 'selected' : ''}`} onClick={() => selectOption(option)}>{option}</button>)}</div><div className="wizard-side-note">Trade: <strong>{wizard.strategy === 'Nifty Opt Buy' ? wizard.side : 'SELL'}</strong>{wizard.strategy !== 'Nifty Opt Buy' && ' · locked'}{wizard.strategy === 'Nifty Opt Buy' && ` · Option ${wizard.option || 'auto-selects'}`}</div>
        {wizard.quoteError && <div className="actual-position-form-error" role="alert">{wizard.quoteError} Manual Entry Price is allowed.</div>}{wizard.rows.length > 0 && <div className="wizard-rows"><div className="wizard-row wizard-row-head"><span>Strategy</span><span>Strike</span><span>Option</span><span>Qty</span><span>Live Premium</span><span>Entry Price</span></div>{wizard.rows.map((row, index) => { const choices = wizard.strikeChoices.length ? wizard.strikeChoices : row.strike ? [Number(row.strike)] : []; return <div className="wizard-row" key={`${row.strategyName}-${index}`}><strong>{row.strategyName}</strong><select className="wizard-strike-select" value={row.strike} onChange={(event) => refreshWizardRowQuote(index, event.target.value)} disabled={!choices.length || quoteLoading}><option value="">Select strike</option>{choices.map((strike) => <option key={strike} value={strike}>{strike}</option>)}</select><span className="wizard-pill">{row.option}</span><input type="number" min="1" step="1" value={row.qty} onChange={(event) => updateWizardRow(index, 'qty', event.target.value)} /><span>{row.livePrice == null ? 'Manual' : money(row.livePrice)}</span><input type="number" min="0" step="0.01" value={row.entryPrice ?? ''} onChange={(event) => updateWizardRow(index, 'entryPrice', event.target.value)} placeholder="Entry price" /></div>; })}</div>}
        <div className="wizard-actions"><button type="button" className="positions-refresh" onClick={() => setShowWizard(false)}>Cancel</button><button type="button" className="positions-refresh actual-position-save" disabled={!wizardCanReview || quoteLoading} onClick={() => setWizardStep('review')}><Check size={15} /> Review &amp; Confirm</button></div></>}

      {wizardStep === 'review' && <div className="wizard-review"><div className="wizard-review-meta"><span>{wizard.strategy}</span><span>{wizard.instrument}</span><span>{wizard.expiry}</span><span>{wizard.side} {wizard.option}</span><span>{wizard.date} {wizard.time}</span></div>{wizard.rows.map((row) => <div className="wizard-review-row" key={row.strategyName}><strong>{row.strategyName}</strong><span>{row.option} {row.strike}</span><span>Qty {row.qty}</span><span>Entry {money(Number(row.entryPrice))}</span></div>)}<div className="wizard-actions"><button type="button" className="positions-refresh" onClick={() => setWizardStep('details')}><ArrowLeft size={14} /> Edit</button><button type="button" className="positions-refresh actual-position-save" disabled={savingWizard} onClick={saveWizard}><Save size={15} className={savingWizard ? 'spin' : ''} /> {savingWizard ? 'Saving…' : 'Confirm & Save'}</button></div></div>}
    </div></section></div>}

    <section className="positions-summary" aria-label="Position summary"><div className="positions-stat"><div className="positions-stat-icon blue"><Activity size={19} /></div><div><span>Actual Positions</span><strong>{positions.length}</strong><small>Manual snapshot</small></div></div><div className="positions-stat"><div className="positions-stat-icon violet"><CircleDollarSign size={19} /></div><div><span>Net Quantity</span><strong>{totals.qty.toLocaleString('en-IN')}</strong><small>Across actual trades</small></div></div><div className="positions-stat"><div className="positions-stat-icon orange"><CircleDollarSign size={19} /></div><div><span>Position Value</span><strong>{money(totals.value)}</strong><small>At average price</small></div></div><div className={`positions-stat ${totals.pnl >= 0 ? 'positive' : 'negative'}`}><div className="positions-stat-icon green"><ArrowUpRight size={19} /></div><div><span>Live P&amp;L</span><strong>{money(totals.pnl)}</strong><small>Based on CMP</small></div></div></section>

    <section className="positions-filter-card"><div><h2>Strategy-wise view</h2><p>Trades are grouped by main strategy and sorted by strategy name.</p></div><label>Filter strategy<select value={strategyFilter} onChange={(event) => setStrategyFilter(event.target.value)}><option value="ALL">All Strategies</option>{strategyOptions.map((strategy) => <option key={strategy} value={strategy}>{strategy}</option>)}</select></label></section>
    {loading && <section className="positions-card"><div className="positions-empty">Loading Actual Positions…</div></section>}
    {!loading && !visiblePositions.length && <section className="positions-card"><div className="positions-empty">{positions.length && strategyFilter !== 'ALL' ? 'No positions match this strategy filter.' : imported ? 'No actual positions available.' : 'Import positions or use Add Position to create the Actual Positions snapshot.'}</div></section>}
    {!loading && groupedPositions.map((group) => { const metrics = groupMetrics(group.rows); const expanded = !collapsedGroups.has(group.name); return <section className="positions-card positions-strategy-group" key={group.name}><div className="positions-card-head positions-strategy-group-head"><div className="positions-strategy-heading"><button type="button" className="positions-group-toggle" onClick={() => setCollapsedGroups((current) => { const next = new Set(current); if (next.has(group.name)) next.delete(group.name); else next.add(group.name); return next; })} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.name}`} title={`${expanded ? 'Collapse' : 'Expand'} ${group.name}`}>{expanded ? <Minus size={18} /> : <Plus size={18} />}</button><div className="positions-main-strategy"><StrategyBadge value={group.name} className="positions-main-strategy-badge" /></div></div><div className="positions-group-head-right"><div className="positions-group-metrics"><div><span>Trades</span><strong>{group.rows.length}</strong></div><div><span>Qty</span><strong className={metrics.qty >= 0 ? 'qty-positive' : 'qty-negative'}>{metrics.qty.toLocaleString('en-IN')}</strong></div><div><span>Live MTM</span><strong className={metrics.mtm >= 0 ? 'pnl-positive' : 'pnl-negative'}>{money(metrics.mtm)}</strong></div><div><span>Average Price</span><strong>{money(metrics.quantityTotal ? metrics.priceTotal / metrics.quantityTotal : 0)}</strong></div></div></div></div>{expanded && group.optionGroups.map((optionGroup) => { const optionMetrics = groupMetrics(optionGroup.rows); const optionKey = `${group.name}-${optionGroup.option}`; const optionExpanded = !collapsedOptionGroups.has(optionKey); return <section className="positions-option-group" key={optionKey}><div className="positions-option-group-head"><div className="positions-option-heading"><button type="button" className="positions-option-group-toggle" onClick={() => setCollapsedOptionGroups((current) => { const next = new Set(current); if (next.has(optionKey)) next.delete(optionKey); else next.add(optionKey); return next; })} aria-label={`${optionExpanded ? 'Collapse' : 'Expand'} ${optionGroup.option} trades`} title={`${optionExpanded ? 'Collapse' : 'Expand'} ${optionGroup.option} trades`}>{optionExpanded ? <Minus size={15} /> : <Plus size={15} />}</button><span className={`positions-option positions-option-group-pill ${optionGroup.option.toLowerCase()}`}>{optionGroup.option}</span><strong>{optionGroup.option} Trades</strong></div><div className="positions-group-metrics"><div><span>Trades</span><strong>{optionGroup.rows.length}</strong></div><div><span>Qty</span><strong className={optionMetrics.qty >= 0 ? 'qty-positive' : 'qty-negative'}>{optionMetrics.qty.toLocaleString('en-IN')}</strong></div><div><span>Live MTM</span><strong className={optionMetrics.mtm >= 0 ? 'pnl-positive' : 'pnl-negative'}>{money(optionMetrics.mtm)}</strong></div><div><span>Average Price</span><strong>{money(optionMetrics.quantityTotal ? optionMetrics.priceTotal / optionMetrics.quantityTotal : 0)}</strong></div></div></div>{optionExpanded && positionsTable(optionGroup.rows)}</section>})}</section>; })}
  </main></div>;
}
