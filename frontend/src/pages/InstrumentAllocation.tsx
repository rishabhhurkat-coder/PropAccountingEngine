import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, CircleCheckBig, GitMerge, Scissors, Search, ShieldCheck, Users, X } from 'lucide-react';
import {
  confirmStrategyAllocations,
  loadStrategyAllocation,
  loadStrategyMaster,
  mergeInstrumentTrades,
  splitInstrumentTrade,
  type StrategyAllocationConfirmationRow,
  type StrategyAllocationRow,
  type StrategyMasterRow,
} from '../lib/api';
import { navigate } from '../lib/router';
import { StrategySetupModal } from './StrategyAllocation';
import Calendar from '../components/Calendar';

type AllocationContext = {
  instrument: string;
  expiry: string;
  strike: string;
  option: string;
  allocationStatus: string;
};

type SuggestionFilters = {
  qty: string;
  date: string;
  time: string;
};

type BlockGroup = {
  key: string;
  rows: StrategyAllocationRow[];
};

type SuggestionRow = {
  id: string;
  tradeDateTime: string;
  side: string;
  qtyPrice: string;
  strategyLabel: string;
  strategyName: string;
  sourceRow: StrategyAllocationRow;
};

function initialSplitQuantities(quantity: number, parts: number) {
  const base = Math.floor(quantity / parts);
  return Array.from({ length: parts }, (_, index) => index === parts - 1 ? quantity - base * (parts - 1) : base).map(String);
}

function SplitTradeModal({ row, onClose, onSaved }: { row: StrategyAllocationRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [parts, setParts] = useState(2);
  const [quantities, setQuantities] = useState(() => initialSplitQuantities(row.qty, 2));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const totalEntered = quantities.reduce((sum, quantity) => sum + (Number(quantity) || 0), 0);
  const remaining = row.qty - totalEntered;
  const valid = quantities.length === parts && quantities.every((quantity) => Number.isFinite(Number(quantity)) && Number(quantity) > 0) && Math.abs(remaining) < 0.0001;

  function changeParts(value: number) {
    setParts(value);
    setQuantities(initialSplitQuantities(row.qty, value));
    setError('');
  }

  async function saveSplit() {
    if (!valid) return;
    if (row.source !== '01RawTxtData') {
      setError('Only an unprocessed RawTxtData trade can start the direct Split workflow.');
      return;
    }
    try {
      setSaving(true);
      const result = await splitInstrumentTrade({
        rawTradeId: row.id,
        originalQty: row.qty,
        quantities: quantities.map(Number),
      });
      await onSaved();
      onClose();
      if (!result.success) setError(result.message || 'Unable to save split.');
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save split.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="split-trade-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="split-trade-modal" role="dialog" aria-modal="true" aria-labelledby="split-trade-title">
        <header className="split-trade-head">
          <h2 id="split-trade-title">Split Trade by Quantity</h2>
          <button type="button" className="split-trade-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="split-trade-info">Total Quantity to split: <strong>{formatQty(row.qty)}</strong></div>
        <label className="split-trade-field">Number of Parts<select value={parts} onChange={(event) => changeParts(Number(event.target.value))}>{[2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} Parts</option>)}</select></label>
        <div className="split-trade-label">Enter Quantity for each part</div>
        <div className="split-trade-quantities">{quantities.map((quantity, index) => <label key={index}>Part {index + 1} Quantity<input type="number" min="0" value={quantity} onChange={(event) => setQuantities((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /></label>)}</div>
        <div className={`split-trade-summary ${valid ? 'valid' : ''}`}><span>Total Entered: <strong>{formatQty(totalEntered)}</strong></span><span>/</span><span>Remaining: <strong>{formatQty(remaining)}</strong></span></div>
        <div className="split-trade-note">The original trade will be replaced by the split quantities.</div>
        {error && <div className="split-trade-error">{error}</div>}
        <footer className="split-trade-footer"><button type="button" className="split-trade-cancel" onClick={onClose}>Cancel</button><button type="button" className="split-trade-save" disabled={!valid || saving} onClick={() => void saveSplit()}>{saving ? 'Saving...' : 'Save Split'}</button></footer>
      </section>
    </div>
  );
}

function MergeTradesModal({ row, eligibleRows, onClose, onSaved }: { row: StrategyAllocationRow; eligibleRows: StrategyAllocationRow[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const trades = eligibleRows;
  const [selectedIds, setSelectedIds] = useState<string[]>([row.id]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedTrades = trades.filter((trade) => selectedIds.includes(trade.id));
  const totalQty = selectedTrades.reduce((sum, trade) => sum + trade.qty, 0);
  const wap = totalQty ? selectedTrades.reduce((sum, trade) => sum + trade.qty * trade.price, 0) / totalQty : 0;
  const selectedTimes = selectedTrades.map((trade) => trade.time).sort();
  const canMerge = selectedTrades.length >= 2 && !saving;
  const allSelected = trades.length > 0 && selectedIds.length === trades.length;

  function toggleTrade(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function mergeSelected() {
    if (!canMerge) return;
    try {
      setSaving(true);
      const result = await mergeInstrumentTrades({ rawTradeIds: selectedIds });
      await onSaved();
      onClose();
      if (!result.success) setError(result.message || 'Unable to merge trades.');
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to merge trades.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="merge-trades-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="merge-trades-modal" role="dialog" aria-modal="true" aria-labelledby="merge-trades-title">
        <header className="merge-trades-head">
          <div><h2 id="merge-trades-title">Merge Trades</h2><p>Select the trades you want to merge. Merged quantity and WAP will be calculated.</p></div>
          <button type="button" className="merge-trades-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <section className="merge-trades-context"><h3>Instrument Details</h3><div className="merge-trades-context-grid"><span>Underlying<strong>{row.scrip}</strong></span><span>Expiry<strong>{row.expiry}</strong></span><span>Strike<strong>{row.strike}</strong></span><span>Option<strong>{row.optType}</strong></span><span>Trade Type<strong>{row.side}</strong></span><span>Account<strong>{row.account || '—'}</strong></span></div></section>
        <section className="merge-trades-available"><div className="merge-trades-section-head"><div><h3>Available Trades</h3><p>{`${trades.length} matching trade${trades.length === 1 ? '' : 's'}`}</p></div><label><input type="checkbox" checked={allSelected} onChange={() => setSelectedIds(allSelected ? [] : trades.map((trade) => trade.id))} disabled={!trades.length} /> Select all</label></div>
          <div className="merge-trades-list"><div className="merge-trades-row merge-trades-row-head"><span /><span>Date</span><span>Time</span><span>Side</span><span>Qty</span><span>Price</span></div>{trades.map((trade) => <label className="merge-trades-row" key={trade.id}><input type="checkbox" checked={selectedIds.includes(trade.id)} onChange={() => toggleTrade(trade.id)} /><span>{formatDisplayDate(trade.date)}</span><span>{formatDisplayTime(trade.time)}</span><span>{trade.side}</span><strong>{formatQty(trade.qty)}</strong><span>{formatPrice(trade.price)}</span></label>)}{!trades.length && <div className="merge-trades-empty">No eligible matching trades found.</div>}</div>
        </section>
        {error && <div className="merge-trades-error">{error}</div>}
        <footer className="merge-trades-footer"><button type="button" className="merge-trades-cancel" onClick={onClose}>Cancel</button><button type="button" className="merge-trades-save" disabled={!canMerge} onClick={() => void mergeSelected()}>{saving ? 'Merging...' : 'Merge Selected'}</button></footer>
      </section>
    </div>
  );
}

function readContext(): AllocationContext | null {
  const params = new URLSearchParams(window.location.search);
  const instrument = params.get('instrument') ?? '';
  const expiry = params.get('expiry') ?? '';
  const strike = params.get('strike') ?? '';
  const option = params.get('option') ?? '';
  const allocationStatus = params.get('allocationStatus') ?? 'Unassigned';
  if (!instrument || !expiry || !strike || !option) return null;
  return { instrument, expiry, strike, option, allocationStatus };
}

function formatDisplayDate(value: string) {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed
      .toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: '2-digit',
      })
      .replace(/ /g, '-');
  }

  const match = value.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return `${day.padStart(2, '0')}-${month}-${year.slice(-2)}`;
  }

  return value;
}

function parseCalendarDisplayDate(value: string) {
  const match = value.match(/^(\d{2})-([A-Za-z]{3})-(\d{2})$/);
  if (!match) return value;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2]);
  return month < 0 ? value : `20${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]}`;
}

function formatDisplayTime(value: string) {
  const match = value.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!match) return value.replace(/:/g, '.');
  return `${match[1].padStart(2, '0')}.${match[2]}`;
}

function formatPrice(value: number) {
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMoney(value: number) {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatPrice(value)}`;
}

function formatQty(value: number) {
  return value.toLocaleString('en-IN');
}

function badgeTone(value: string) {
  return value.toUpperCase() === 'BUY' ? 'buy' : 'sell';
}

function optionTone(value: string) {
  return value.toLowerCase();
}

function normalizeCompactExpiry(value: string) {
  const compact = value.replace(/[-\s]/g, '').toUpperCase();
  const match = compact.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (!match) return compact;
  const [, day, month, year] = match;
  return `${day.padStart(2, '0')}${month}${year}`;
}

function normalizeStrategyExpiry(value: string) {
  const compact = value.replace(/[-\s]/g, '').toUpperCase();
  const match = compact.match(/^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/);
  if (!match) return compact;
  const [, day, month, year] = match;
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${day.padStart(2, '0')}${month}${fullYear}`;
}

function formatStrategyExpiry(value: string) {
  const compact = normalizeStrategyExpiry(value);
  const match = compact.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return value;
  const [, day, month, year] = match;
  return `${day}-${month.slice(0, 1)}${month.slice(1).toLowerCase()}-${year}`;
}

function formatTitleExpiry(value: string) {
  const compact = normalizeStrategyExpiry(value);
  const match = compact.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return value;
  const [, day, month, year] = match;
  return `${day}-${month.slice(0, 1)}${month.slice(1).toLowerCase()}-${year.slice(-2)}`;
}

function normalizeMatchValue(value: string) {
  return value.trim().toUpperCase();
}

function findStrategySuggestions(row: StrategyAllocationRow, strategyMasterRows: StrategyMasterRow[]) {
  const expiry = normalizeStrategyExpiry(row.expiry);
  const candidates = strategyMasterRows.filter(
    (strategy) =>
      strategy.active &&
      normalizeMatchValue(strategy.instrument) === normalizeMatchValue(row.scrip) &&
      normalizeStrategyExpiry(strategy.expiry) === expiry &&
      (strategy.parentQty === row.qty || strategy.splitQty === row.qty),
  );
  const uniqueStrategies = new Map<string, StrategyMasterRow>();
  candidates.forEach((candidate) => {
    const key = candidate.strategyName.trim().toLowerCase();
    if (key && !uniqueStrategies.has(key)) uniqueStrategies.set(key, candidate);
  });
  return Array.from(uniqueStrategies.values());
}

function groupBlocks(rows: StrategyAllocationRow[]): BlockGroup[] {
  const map = new Map<string, StrategyAllocationRow[]>();
  rows.forEach((row) => {
    const key = row.strategy && row.strategy.trim() ? row.strategy : 'Unassigned';
    const existing = map.get(key);
    if (existing) existing.push(row);
    else map.set(key, [row]);
  });
  return Array.from(map.entries()).map(([key, groupedRows]) => ({ key, rows: groupedRows }));
}

function SummaryCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="inst-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function ActionButton({
  tone,
  icon,
  ariaLabel,
  onClick,
}: {
  tone: 'secondary' | 'primary';
  icon: ReactNode;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button className={`inst-action-btn ${tone}`} onClick={onClick} type="button" aria-label={ariaLabel}>
      {icon}
    </button>
  );
}

export function InstrumentAllocation() {
  const context = useMemo(readContext, []);
  const [rows, setRows] = useState<StrategyAllocationRow[]>([]);
  const [strategyMasterRows, setStrategyMasterRows] = useState<StrategyMasterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [suggestionFilters, setSuggestionFilters] = useState<SuggestionFilters>({ qty: 'All Qty', date: 'All Dates', time: 'All Times' });
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>([]);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [splitRow, setSplitRow] = useState<StrategyAllocationRow | null>(null);
  const [mergeRow, setMergeRow] = useState<StrategyAllocationRow | null>(null);
  const [strategySetupRow, setStrategySetupRow] = useState<StrategyAllocationRow | null>(null);

  async function reloadAllocationData(cancelledCheck?: () => boolean) {
    const [allocationData, masterData] = await Promise.all([loadStrategyAllocation(), loadStrategyMaster()]);
    if (cancelledCheck?.()) return;
    setRows(allocationData.rows ?? []);
    setStrategyMasterRows(masterData.rows ?? []);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;

    reloadAllocationData(() => cancelled).catch((loadError: unknown) => {
      if (cancelled) return;
      setError(loadError instanceof Error ? loadError.message : 'Unable to load instrument allocation data');
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const matchingRows = useMemo(() => {
    if (!context) return [];
    return rows.filter(
      (row) =>
        normalizeMatchValue(row.scrip) === normalizeMatchValue(context.instrument) &&
        normalizeStrategyExpiry(row.expiry) === normalizeStrategyExpiry(context.expiry) &&
        normalizeMatchValue(row.strike) === normalizeMatchValue(context.strike) &&
        normalizeMatchValue(row.optType) === normalizeMatchValue(context.option),
    );
  }, [context, rows]);

  const mergeEligibleRows = useMemo(() => {
    if (!mergeRow) return [];
    return matchingRows.filter((candidate) =>
      candidate.source === '01RawTxtData' &&
      candidate.date === mergeRow.date &&
      candidate.side === mergeRow.side &&
      (candidate.account || '') === (mergeRow.account || ''),
    );
  }, [matchingRows, mergeRow]);

  const visibleRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return matchingRows.filter((row) => {
      const matchesSearch =
        !normalizedSearch ||
        [row.date, formatDisplayTime(row.time), row.side, row.optType, String(row.qty), String(row.price), row.strategy]
          .join(' ')
          .toLowerCase()
          .includes(normalizedSearch);
      const matchesQty = suggestionFilters.qty === 'All Qty' || String(row.qty) === suggestionFilters.qty;
      const matchesDate = suggestionFilters.date === 'All Dates' || formatDisplayDate(row.date) === suggestionFilters.date;
      const matchesTime = suggestionFilters.time === 'All Times' || formatDisplayTime(row.time) === suggestionFilters.time;
      return matchesSearch && matchesQty && matchesDate && matchesTime;
    });
  }, [matchingRows, search, suggestionFilters.date, suggestionFilters.qty, suggestionFilters.time]);

  const suggestionRows = useMemo<SuggestionRow[]>(() => {
    return visibleRows.flatMap((row) => {
      return findStrategySuggestions(row, strategyMasterRows).map((suggested) => ({
        id: `${row.id}-${suggested.mappingId ?? suggested.strategyName}`,
        tradeDateTime: `${formatDisplayDate(row.date)} ${formatDisplayTime(row.time)}`,
        side: row.side.toUpperCase(),
        qtyPrice: `${formatQty(row.qty)} @ ${formatPrice(row.price)}`,
        strategyLabel: `${row.scrip} ${formatStrategyExpiry(suggested.expiry)} - ${suggested.strategyName}`,
        strategyName: suggested.strategyName,
        sourceRow: row,
      }));
    });
  }, [strategyMasterRows, visibleRows]);

  const summary = useMemo(() => {
    const totalTrades = matchingRows.length;
    const totalBuys = matchingRows.filter((row) => row.side === 'BUY').reduce((sum, row) => sum + row.qty, 0);
    const totalSells = matchingRows.filter((row) => row.side === 'SELL').reduce((sum, row) => sum + row.qty, 0);
    const grossQuantity = totalBuys + totalSells;
    const netQuantity = totalBuys - totalSells;
    const avgPrice = grossQuantity ? matchingRows.reduce((sum, row) => sum + row.price * row.qty, 0) / grossQuantity : 0;
    const grossPnl = matchingRows.reduce((sum, row) => sum + row.mtm, 0);
    return { totalTrades, totalBuys, totalSells, grossQuantity, netQuantity, avgPrice, grossPnl };
  }, [matchingRows]);

  const suggestionOptions = useMemo(() => {
    const qty = Array.from(new Set(matchingRows.map((row) => String(row.qty)))).sort((a, b) => Number(a) - Number(b));
    const dateOptions = Array.from(new Set(matchingRows.map((row) => formatDisplayDate(row.date)))).sort();
    const timeOptions = Array.from(new Set(matchingRows.map((row) => formatDisplayTime(row.time)))).sort();
    return {
      qty: ['All Qty', ...qty],
      date: ['All Dates', ...dateOptions],
      time: ['All Times', ...timeOptions],
    };
  }, [matchingRows]);

  const blocks = useMemo(() => groupBlocks(matchingRows), [matchingRows]);

  useEffect(() => {
    setSelectedSuggestionIds([]);
    setSelectedBlockIds([]);
  }, [context?.instrument, context?.expiry, context?.strike, context?.option]);

  useEffect(() => {
    const shell = document.querySelector('.app-shell');
    shell?.classList.add('inst-no-sidebar');
    return () => {
      shell?.classList.remove('inst-no-sidebar');
    };
  }, []);

  useEffect(() => {
    setSelectedSuggestionIds((current) => current.filter((id) => suggestionRows.some((row) => row.id === id)));
  }, [suggestionRows]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2500);
  }

  function updateFilter<K extends keyof SuggestionFilters>(key: K, value: SuggestionFilters[K]) {
    setSuggestionFilters((current) => ({ ...current, [key]: value }));
  }

  function toggleSuggestionSelection(id: string) {
    setSelectedSuggestionIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function toggleBlockSelection(id: string) {
    setSelectedBlockIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function selectVisibleSuggestions() {
    setSelectedSuggestionIds(suggestionRows.map((row) => row.id));
    flash('Visible batch split suggestions selected');
  }

  async function confirmSelectedSuggestions() {
    const selected = suggestionRows.filter((row) => selectedSuggestionIds.includes(row.id));
    if (!selected.length) {
      flash('Select at least one suggestion first');
      return;
    }

    try {
      const payload: StrategyAllocationConfirmationRow[] = selected.map((row) => ({
        tradeId: row.sourceRow.tradeId,
        source: row.sourceRow.source,
        sourceId: row.sourceRow.id,
        instrument: row.sourceRow.scrip,
        expiry: row.sourceRow.expiry,
        strike: row.sourceRow.strike,
        option: row.sourceRow.optType,
        side: row.sourceRow.side,
        qty: row.sourceRow.qty,
        price: row.sourceRow.price,
        strategyName: row.strategyName,
      }));

      const result = await confirmStrategyAllocations(payload);
      await reloadAllocationData();
      setSelectedSuggestionIds([]);
      const processed = result.processed_count ?? result.updated_rows ?? payload.length;
      const skipped = result.skipped_count ?? 0;
      const errors = result.errors?.length ? ` Errors: ${result.errors.join(' | ')}` : '';
      flash(
        result.message ??
          `${processed} trade${processed === 1 ? '' : 's'} processed successfully. Skipped: ${skipped}.${errors}`,
      );
    } catch (confirmError: unknown) {
      flash(confirmError instanceof Error ? confirmError.message : 'Unable to confirm selected suggestions');
    }
  }

  async function confirmAllVisibleSuggestions() {
    if (!suggestionRows.length) {
      flash('No visible suggestions to confirm');
      return;
    }

    try {
      const payload: StrategyAllocationConfirmationRow[] = suggestionRows.map((row) => ({
        tradeId: row.sourceRow.tradeId,
        source: row.sourceRow.source,
        sourceId: row.sourceRow.id,
        instrument: row.sourceRow.scrip,
        expiry: row.sourceRow.expiry,
        strike: row.sourceRow.strike,
        option: row.sourceRow.optType,
        side: row.sourceRow.side,
        qty: row.sourceRow.qty,
        price: row.sourceRow.price,
        strategyName: row.strategyName,
      }));

      const result = await confirmStrategyAllocations(payload);
      await reloadAllocationData();
      setSelectedSuggestionIds([]);
      const processed = result.processed_count ?? result.updated_rows ?? payload.length;
      const skipped = result.skipped_count ?? 0;
      const errors = result.errors?.length ? ` Errors: ${result.errors.join(' | ')}` : '';
      flash(
        result.message ??
          `${processed} trade${processed === 1 ? '' : 's'} processed successfully. Skipped: ${skipped}.${errors}`,
      );
    } catch (confirmError: unknown) {
      flash(confirmError instanceof Error ? confirmError.message : 'Unable to confirm all visible suggestions');
    }
  }

  function closeAllVisibleBlocks() {
    flash(`${blocks.length} visible block${blocks.length === 1 ? '' : 's'} queued for close`);
  }

  if (!context) {
    return (
      <main className="alloc-main inst-page">
        <style>{`
          .app-shell.inst-no-sidebar .alloc-sidebar{display:none !important;}
          .app-shell.inst-no-sidebar .app-page{flex:1;min-width:0;width:100%;}
          .app-shell.inst-no-sidebar{width:100%;}
        `}</style>
        <div className="alloc-notice">Missing instrument context. Open this page from Strategy Allocation.</div>
      </main>
    );
  }

  return (
    <main className="alloc-main inst-page">
      <style>{`
        .app-shell.inst-no-sidebar .alloc-sidebar{display:none !important;}
        .app-shell.inst-no-sidebar .app-page{flex:1;min-width:0;width:100%;}
        .app-shell.inst-no-sidebar{width:100%;}
        .inst-page{width:100%;gap:12px;}
        .inst-top-row{display:grid;grid-template-columns:minmax(0,51fr) minmax(0,49fr);gap:14px;align-items:stretch;}
        .inst-top-row > section{min-width:0;height:100%;align-self:stretch;display:flex;flex-direction:column;}
        .inst-table-card,.inst-suggestions-card{min-width:0;}
        .inst-table-card,.inst-suggestions-card{height:100%;}
        .inst-table-card .alloc-card-head,.inst-suggestions-card .alloc-card-head{padding-bottom:10px;}
        .inst-table-card .inst-table-wrap{padding-bottom:8px;}
        .inst-table-card .inst-table{min-width:0;width:100%;table-layout:fixed;font-size:12.5px;}
        .inst-table-card .inst-table th,.inst-table-card .inst-table td{padding-left:8px;padding-right:8px;}
        .inst-table-card .inst-table th{height:53px;font-size:11.25px;}
        .inst-table-card .inst-table td{height:63px;}
        .inst-table-card .inst-action-btn{height:35px;padding:0 11px;font-size:12.5px;}
        .inst-table-card .inst-strategy-action{display:flex;align-items:center;justify-content:center;}
        .inst-table-card .table-search{width:180px;font-size:12.5px;}
        .inst-table-card .table-search,
        .inst-table-card .table-search input,
        .inst-table-card .table-search input::placeholder,
        .inst-table-card .table-search svg{
          color:#155eef;
        }
        .inst-table-card .table-search input{font-size:12.5px;}
        .inst-table-card .alloc-card-head h2{
          color:#155eef;
          font-size:18.75px;
        }
        .inst-suggestions-card .alloc-card-head h2{
          color:#111827;
          font-size:15px;
        }
        .inst-table-card .alloc-card-head p,
        .inst-suggestions-card .alloc-card-head p{
          color:#111827;
          font-size:11.2px;
        }
        .inst-suggestions-card .inst-mini-table-wrap{padding-bottom:8px;}
        .inst-suggestions-card .inst-mini-table{min-width:0;width:100%;table-layout:fixed;font-size:12.5px;}
        .inst-suggestions-card .inst-mini-table th,.inst-suggestions-card .inst-mini-table td{padding-left:8px;padding-right:8px;}
        .inst-suggestions-card .inst-mini-table th{font-size:11.25px;height:42px;color:#111827;}
        .inst-suggestions-card .inst-mini-table td{height:56px;padding-top:4px;padding-bottom:4px;}
        .inst-suggestions-card .inst-mini-table tbody tr{cursor:pointer;transition:background-color 0.15s ease, box-shadow 0.15s ease;}
        .inst-suggestions-card .inst-mini-table tbody tr.is-selected{background:transparent;}
        .inst-suggestions-card .inst-mini-table tbody td{vertical-align:middle;}
        .inst-suggestions-card .inst-suggestion-row{display:grid;grid-template-columns:18px 128px 58px 130px 1fr;align-items:center;gap:12px;width:100%;min-height:42px;padding:10px 12px;border:1px solid #d6e1f4;border-radius:6px;background:#fff;box-sizing:border-box;}
        .inst-suggestions-card .inst-mini-table tbody tr.is-selected .inst-suggestion-row{border-color:#2d69d8;box-shadow:0 0 0 1px #2d69d8 inset;background:#f7fbff;}
        .inst-suggestions-card .inst-suggestion-row input[type='checkbox']{width:16px;height:16px;flex:0 0 auto;margin:0;}
        .inst-suggestions-card .inst-suggestion-row .inst-suggestion-datetime,
        .inst-suggestions-card .inst-suggestion-row .inst-suggestion-qty,
        .inst-suggestions-card .inst-suggestion-row .inst-suggestion-strategy{display:block;min-width:0;color:#111827;font-size:12.75px;font-weight:500;line-height:1.35;text-align:left;letter-spacing:0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .inst-suggestions-card .inst-suggestion-row .inst-suggestion-side{display:inline-flex;justify-content:center;align-items:center;min-width:0;white-space:nowrap;}
        .inst-suggestions-card .inst-suggestion-row .inst-suggestion-qty{font-variant-numeric:tabular-nums;}
        .inst-suggestions-card .inst-suggestion-row .inst-suggestion-strategy{font-weight:600;}
        .inst-suggestions-card .inst-filter-field{min-width:0;flex:1;font-size:12.5px;color:#111827;}
        .inst-suggestions-card .inst-filter-field span,.inst-suggestions-card .inst-filter-field select{font-size:11.25px;color:#111827;}
        .inst-suggestions-card .inst-header-actions button,
        .inst-suggestions-card .inst-select-visible{
          font-size:12.5px;
          height:34px;
          background:#155eef;
          border-color:#155eef;
          color:#fff;
        }
        .inst-suggestions-card .inst-header-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
        .inst-back-btn{
          background:#155eef;
          border-color:#155eef;
          color:#fff;
        }
        .inst-back-btn:hover{
          background:#134fd0;
        }
        .inst-page-header .inst-breadcrumbs,
        .inst-page-header .inst-breadcrumbs strong{
          color:#111827;
        }
        .inst-summary-card span{
          color:#155eef;
          font-size:14.06px;
        }
        .inst-summary-card strong{
          font-size:22.5px;
          color:#111827;
        }
      `}</style>
      <header className="inst-page-header">
        <div className="inst-page-header-left">
          <button className="inst-back-btn" type="button" onClick={() => navigate('/strategy-allocation')}>
            <ArrowLeft size={16} />
            Back
          </button>
          <div className="inst-breadcrumbs">
            <span>Strategy Allocation</span>
            <span>›</span>
            <strong>Instrument Allocation</strong>
          </div>
        </div>
      </header>

      {loading && <div className="alloc-notice">Loading instrument allocation data...</div>}
      {error && <div className="alloc-notice">{error}</div>}
      {notice && (
        <div className="alloc-notice">
          {notice}
          <button onClick={() => setNotice('')} type="button">
            <ShieldCheck size={14} />
          </button>
        </div>
      )}

      <section className="inst-identity-card">
        <div className="inst-identity-top">
          <div>
            <div className="inst-identity-title">{`${context.instrument} ${formatTitleExpiry(context.expiry)} ${context.strike} ${context.option}`}</div>
          </div>
        </div>
      </section>

      <section className="inst-summary-grid">
        <SummaryCard label="Total Trades" value={String(summary.totalTrades)} />
        <SummaryCard label="Total Buys" value={formatQty(summary.totalBuys)} />
        <SummaryCard label="Total Sells" value={formatQty(summary.totalSells)} />
        <SummaryCard label="Gross Quantity" value={formatQty(summary.grossQuantity)} />
        <SummaryCard label="Net Quantity" value={formatQty(summary.netQuantity)} />
        <SummaryCard label="Avg Price" value={formatPrice(summary.avgPrice)} />
        <SummaryCard label="Gross P&L" value={formatMoney(summary.grossPnl)} />
      </section>

      <div className="inst-top-row">
        <section className="alloc-card inst-section-card inst-table-card">
          <div className="alloc-card-head">
            <div>
              <h2>All Trades for this Instrument</h2>
              <p>{matchingRows.length} records</p>
            </div>
            <div className="table-tools">
              <label className="table-search inst-search">
                <Search size={15} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search trades..." />
              </label>
            </div>
          </div>
          <div className="inst-table-wrap">
            <table className="inst-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Type</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Merge</th>
                  <th>Split</th>
                  <th>Strategy</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDisplayDate(row.date)}</td>
                    <td>{formatDisplayTime(row.time)}</td>
                    <td>
                      <span className={`inst-side-badge ${badgeTone(row.side)}`}>{row.side}</span>
                    </td>
                    <td>
                      <span className={`alloc-option-badge ${optionTone(row.optType)}`}>{row.optType}</span>
                    </td>
                    <td>{formatQty(row.qty)}</td>
                    <td>{formatPrice(row.price)}</td>
                    <td>
                      <ActionButton tone="secondary" icon={<GitMerge size={14} />} ariaLabel={`Merge trade ${row.tradeId}`} onClick={() => setMergeRow(row)} />
                    </td>
                    <td>
                      <ActionButton tone="secondary" icon={<Scissors size={14} />} ariaLabel={`Split trade ${row.tradeId}`} onClick={() => setSplitRow(row)} />
                    </td>
                    <td>
                      <div className="inst-strategy-action">
                        <ActionButton tone="primary" icon={<Users size={16} />} ariaLabel={`Open Strategy Setup for ${row.tradeId}`} onClick={() => setStrategySetupRow(row)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="alloc-card inst-workflow-card inst-suggestions-card">
          <div className="alloc-card-head inst-subcard-head">
            <div>
              <h2>Batch Split Suggestions</h2>
              <p>{visibleRows.length} records</p>
            </div>
            <div className="inst-header-actions">
              <button className="allocate-btn inst-mini-btn" type="button" onClick={confirmSelectedSuggestions}>Confirm Selected</button>
              <button className="allocate-btn inst-mini-btn" type="button" onClick={confirmAllVisibleSuggestions}>Confirm All Visible</button>
            </div>
          </div>
          <div className="inst-filter-row">
            <label className="inst-filter-field">
              <span>Qty filter</span>
              <select value={suggestionFilters.qty} onChange={(event) => updateFilter('qty', event.target.value)}>
                {suggestionOptions.qty.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <Calendar className="inst-date-calendar" label="Date filter" value={suggestionFilters.date === 'All Dates' ? '' : parseCalendarDisplayDate(suggestionFilters.date)} placeholder="All Dates" allowClear allowedDates={suggestionOptions.date.slice(1).map(parseCalendarDisplayDate)} onChange={(value) => updateFilter('date', value ? formatDisplayDate(value) : 'All Dates')} />
            <label className="inst-filter-field">
              <span>Time filter</span>
              <select value={suggestionFilters.time} onChange={(event) => updateFilter('time', event.target.value)}>
                {suggestionOptions.time.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button className="allocate-btn inst-select-visible" type="button" onClick={selectVisibleSuggestions}>
              Select Visible
            </button>
          </div>
          <div className="inst-mini-table-wrap">
            <table className="inst-mini-table">
              <thead>
                <tr>
                  <th>STRATEGY</th>
                </tr>
              </thead>
              <tbody>
                {suggestionRows.map((row) => (
                  <tr
                    key={`suggestion-${row.id}`}
                    className={selectedSuggestionIds.includes(row.id) ? 'is-selected' : ''}
                    onClick={() => toggleSuggestionSelection(row.id)}
                  >
                    <td>
                      <label className="inst-suggestion-row">
                        <input
                          type="checkbox"
                          checked={selectedSuggestionIds.includes(row.id)}
                          onChange={() => toggleSuggestionSelection(row.id)}
                          onClick={(event) => event.stopPropagation()}
                        />
                        <span className="inst-suggestion-datetime">{row.tradeDateTime}</span>
                        <span className="inst-suggestion-side">
                          <span className={`inst-side-badge ${badgeTone(row.side)}`}>{row.side}</span>
                        </span>
                        <span className="inst-suggestion-qty">{row.qtyPrice}</span>
                        <span className="inst-suggestion-strategy">{row.strategyLabel}</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {strategySetupRow && <StrategySetupModal
        key={strategySetupRow.id}
        mode="create"
        rows={strategyMasterRows}
        context={{ instrument: strategySetupRow.scrip, expiry: strategySetupRow.expiry, qty: strategySetupRow.qty }}
        onClose={() => setStrategySetupRow(null)}
        onSaved={async () => { await reloadAllocationData(); }}
      />}
      {splitRow && <SplitTradeModal row={splitRow} onClose={() => setSplitRow(null)} onSaved={async () => { await reloadAllocationData(); }} />}
      {mergeRow && <MergeTradesModal row={mergeRow} eligibleRows={mergeEligibleRows} onClose={() => setMergeRow(null)} onSaved={async () => { await reloadAllocationData(); }} />}
    </main>
  );
}
