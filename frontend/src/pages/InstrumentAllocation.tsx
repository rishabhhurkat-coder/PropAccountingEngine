import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, BarChart3, Check, ChevronDown, CircleCheckBig, CircleMinus, Filter, GitMerge, IndianRupee, Layers3, Package, Plus, Scissors, Search, ShieldCheck, ShoppingCart, TrendingUp, Users, X } from 'lucide-react';
import {
  confirmStrategyAllocations,
  loadConfirmationProgress,
  applyConfirmedStrategyAllocations,
  getStrategyAllocationSnapshot,
  preloadStrategyAllocation,
  revalidateStrategyAllocationSnapshot,
  mergeInstrumentTrades,
  splitInstrumentTrade,
  type StrategyAllocationConfirmationRow,
  type StrategyAllocationRow,
  type StrategyAllocationResponse,
  type StrategyMasterRow,
  type ConfirmationProgressResponse,
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
  date: string;
};

type SuggestionFilters = {
  qty: string;
  date: string;
  time: string;
};

const ALL_QTY_FILTER = 'Quantity';
const ALL_TIME_FILTER = 'Time';

type BlockGroup = {
  key: string;
  rows: StrategyAllocationRow[];
};

type SuggestionRow = {
  id: string;
  tradeDateTime: string;
  side: string;
  qtyPrice: string;
  strategyName: string;
  sourceRow: StrategyAllocationRow;
};

type SuggestionGroup = {
  key: string;
  tradeDateTime: string;
  side: string;
  qtyPrice: string;
  instrument: string;
  expiry: string;
  rows: SuggestionRow[];
};

type ConfirmationItemStatus = 'waiting' | 'processing' | 'completed' | 'skipped' | 'failed';

type ConfirmationProcessStep = {
  key: string;
  label: string;
  status: ConfirmationItemStatus;
  detail: string;
  durationMs?: number | null;
};

type ConfirmationItem = {
  id: string;
  label: string;
  status: ConfirmationItemStatus;
  detail: string;
  steps: ConfirmationProcessStep[];
};

type ConfirmationStage = 'preparing' | 'loading' | 'processing' | 'finalizing' | 'refreshing' | 'completed' | 'failed';

const CONFIRMATION_PROCESS_STEPS: Array<{ key: string; label: string }> = [
  { key: 'source', label: 'Read source trade' },
  { key: 'merge', label: 'Prepare MergeTrades record' },
  { key: 'split', label: 'Prepare SplitTrades record' },
  { key: 'strategy', label: 'Assign Strategy Allocation' },
  { key: 'matching', label: 'Match Entry / Exit' },
  { key: 'recalculate', label: 'Recalculate positions' },
  { key: 'queued', label: 'Queue changes for save' },
];

// Older API responses identified a split child only in the display id
// (`split:<SplitTrades.id>`). Keep that lineage when building the allocation
// request so selecting 260 cannot accidentally allocate its 520 sibling.
function resolveSplitTradeId(row: StrategyAllocationRow) {
  const explicitId = String(row.splitTradeId ?? '').trim();
  if (explicitId) return explicitId;
  const displayId = String(row.id ?? '').trim();
  return displayId.startsWith('split:') ? displayId.slice('split:'.length) : undefined;
}

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

  function changeQuantity(index: number, rawValue: string) {
    // For the common two-part split, always make the other part the exact
    // remainder. This keeps the total balanced while the user edits either
    // field and avoids forcing them to calculate it manually.
    if (parts === 2) {
      const entered = rawValue === '' ? 0 : Math.max(0, Number(rawValue) || 0);
      setQuantities(index === 0
        ? [rawValue, String(Math.max(0, row.qty - entered))]
        : [String(Math.max(0, row.qty - entered)), rawValue]);
      return;
    }

    setQuantities((current) => {
      const next = current.map((quantity, quantityIndex) => quantityIndex === index ? rawValue : quantity);
      const remainderIndex = index === next.length - 1 ? 0 : next.length - 1;
      const enteredElsewhere = next.reduce((sum, quantity, quantityIndex) => quantityIndex === remainderIndex ? sum : sum + (Number(quantity) || 0), 0);
      next[remainderIndex] = String(Math.max(0, row.qty - enteredElsewhere));
      return next;
    });
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
        rawTradeId: row.sourceId || row.id,
        splitTradeId: resolveSplitTradeId(row),
        originalQty: row.qty,
        quantities: quantities.map(Number),
      });
      if (!result.success) {
        setError(result.message || 'Unable to save split.');
        return;
      }
      await onSaved();
      onClose();
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
        <div className="split-trade-quantities">{quantities.map((quantity, index) => <label key={index}>Part {index + 1} Quantity<input type="number" min="0" value={quantity} onChange={(event) => changeQuantity(index, event.target.value)} /></label>)}</div>
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
  const date = params.get('date') ?? '';
  if (!instrument || !expiry || !strike || !option) return null;
  return { instrument, expiry, strike, option, allocationStatus, date };
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

function matchesAllocationContext(row: StrategyAllocationRow, context: AllocationContext) {
  return normalizeMatchValue(row.scrip) === normalizeMatchValue(context.instrument) &&
    normalizeStrategyExpiry(row.expiry) === normalizeStrategyExpiry(context.expiry) &&
    normalizeMatchValue(row.strike) === normalizeMatchValue(context.strike) &&
    normalizeMatchValue(row.optType) === normalizeMatchValue(context.option) &&
    (!context.date || parseCalendarDisplayDate(formatDisplayDate(row.date)) === context.date);
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

function buildSuggestionRows(rows: StrategyAllocationRow[], strategyMasterRows: StrategyMasterRow[]): SuggestionRow[] {
  return rows
    .filter((row) => !row.strategy || row.strategy.trim().toLowerCase() === 'unassigned')
    .flatMap((row) => findStrategySuggestions(row, strategyMasterRows).map((suggested) => ({
      // Include the full trade fingerprint. Numeric raw/split IDs can be
      // reused after a refresh, which would otherwise let an old selection
      // point at a different instrument with the same ID.
      id: [
        row.id,
        row.source,
        row.sourceId ?? '',
        row.splitTradeId ?? '',
        row.date,
        row.time,
        row.side,
        row.scrip,
        row.expiry,
        row.strike,
        row.optType,
        row.qty,
        row.price,
        suggested.mappingId ?? suggested.strategyName,
      ].join('|'),
      tradeDateTime: `${formatDisplayDate(row.date)} ${formatDisplayTime(row.time)}`,
      side: row.side.toUpperCase(),
      qtyPrice: `${formatQty(row.qty)} @ ${formatPrice(row.price)}`,
      strategyName: suggested.strategyName,
      sourceRow: row,
    })));
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

function SummaryCard({ label, value, note, icon, tone }: { label: string; value: string; note?: string; icon: ReactNode; tone: string }) {
  return (
    <div className="inst-summary-card">
      <div className={`inst-summary-icon ${tone}`}>{icon}</div>
      <div className="inst-summary-copy"><span>{label}</span><strong>{value}</strong></div>
      {note && <small>{note}</small>}
    </div>
  );
}

function confirmationStatusIcon(status: ConfirmationItemStatus) {
  if (status === 'completed') return <CircleCheckBig size={17} aria-hidden="true" />;
  if (status === 'failed') return <AlertTriangle size={17} aria-hidden="true" />;
  if (status === 'skipped') return <CircleMinus size={17} aria-hidden="true" />;
  if (status === 'processing') return <span className="inst-progress-spinner" aria-hidden="true" />;
  return <span className="inst-progress-dot" aria-hidden="true" />;
}

function StyledFilterSelect({ value, options, onChange, ariaLabel }: { value: string; options: string[]; onChange: (value: string) => void; ariaLabel: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  return (
    <div className="inst-filter-select" ref={rootRef}>
      <button
        type="button"
        className={`inst-filter-select-trigger ${open ? 'is-open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{value}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="inst-filter-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option === value}
              className={`inst-filter-select-option ${option === value ? 'is-selected' : ''}`}
              key={option}
              onClick={() => { onChange(option); setOpen(false); }}
            >
              <span>{option}</span>
              {option === value && <Check size={14} strokeWidth={3} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  tone,
  icon,
  ariaLabel,
  onClick,
  disabled = false,
  title,
}: {
  tone: 'secondary' | 'primary';
  icon: ReactNode;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button className={`inst-action-btn ${tone}`} onClick={onClick} type="button" aria-label={ariaLabel} disabled={disabled} title={title}>
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
  const [confirming, setConfirming] = useState(false);
  const [confirmingCount, setConfirmingCount] = useState(0);
  const [confirmPhase, setConfirmPhase] = useState<'saving' | 'refreshing'>('saving');
  const [confirmationItems, setConfirmationItems] = useState<ConfirmationItem[]>([]);
  const [confirmationStage, setConfirmationStage] = useState<ConfirmationStage>('preparing');
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [confirmationStartedAt, setConfirmationStartedAt] = useState<number | null>(null);
  const [confirmationElapsedMs, setConfirmationElapsedMs] = useState(0);
  const confirmingRef = useRef(false);
  const [search, setSearch] = useState('');
  const [suggestionFilters, setSuggestionFilters] = useState<SuggestionFilters>({ qty: ALL_QTY_FILTER, date: context?.date ? formatDisplayDate(context.date) : 'All Dates', time: ALL_TIME_FILTER });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>([]);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [splitRow, setSplitRow] = useState<StrategyAllocationRow | null>(null);
  const [mergeRow, setMergeRow] = useState<StrategyAllocationRow | null>(null);
  const [strategySetupRow, setStrategySetupRow] = useState<StrategyAllocationRow | null>(null);

  async function reloadAllocationData(cancelledCheck?: () => boolean) {
    const { allocation: allocationData, master: masterData } = await preloadStrategyAllocation(true);
    if (cancelledCheck?.()) return;
    setRows(allocationData.rows ?? []);
    setStrategyMasterRows(masterData.rows ?? []);
    setLoading(false);
    return allocationData;
  }

  useEffect(() => {
    let cancelled = false;

    const cachedSnapshot = getStrategyAllocationSnapshot();

    if (cachedSnapshot) {
      setRows(cachedSnapshot.allocation.rows ?? []);
      setStrategyMasterRows(cachedSnapshot.master.rows ?? []);
      setLoading(false);
    }

    // Reuse the preloaded snapshot immediately, then verify only the small
    // version metadata. A full reload happens only when a version changed or
    // this page was opened directly without a preload.
    setLoading(false);
    (cachedSnapshot ? revalidateStrategyAllocationSnapshot() : preloadStrategyAllocation(false))
      .then(({ allocation, master }) => {
        if (cancelled) return;
        setRows(allocation.rows ?? []);
        setStrategyMasterRows(master.rows ?? []);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Unable to load instrument allocation data');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matchingRows = useMemo(() => {
    if (!context) return [];
    return rows.filter((row) => matchesAllocationContext(row, context));
  }, [context, rows]);

  const mergeEligibleRows = useMemo(() => {
    if (!mergeRow) return [];
    return matchingRows.filter((candidate) =>
      candidate.source === '01RawTxtData' &&
      !candidate.splitTradeId &&
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
      const matchesQty = suggestionFilters.qty === ALL_QTY_FILTER || String(row.qty) === suggestionFilters.qty;
      const matchesDate = suggestionFilters.date === 'All Dates' || formatDisplayDate(row.date) === suggestionFilters.date;
      const matchesTime = suggestionFilters.time === ALL_TIME_FILTER || formatDisplayTime(row.time) === suggestionFilters.time;
      return matchesSearch && matchesQty && matchesDate && matchesTime;
    });
  }, [matchingRows, search, suggestionFilters.date, suggestionFilters.qty, suggestionFilters.time]);

  const unassignedVisibleRows = useMemo(
    () => visibleRows.filter((row) => !row.strategy || row.strategy.trim().toLowerCase() === 'unassigned'),
    [visibleRows],
  );

  const suggestionRows = useMemo<SuggestionRow[]>(() => {
    return buildSuggestionRows(unassignedVisibleRows, strategyMasterRows);
  }, [strategyMasterRows, unassignedVisibleRows]);

  const suggestionGroups = useMemo<SuggestionGroup[]>(() => {
    const groups = new Map<string, SuggestionGroup>();
    suggestionRows.forEach((row) => {
      const key = row.sourceRow.id;
      const existing = groups.get(key);
      if (existing) {
        existing.rows.push(row);
        return;
      }
      groups.set(key, {
        key,
        tradeDateTime: row.tradeDateTime,
        side: row.side,
        qtyPrice: row.qtyPrice,
        instrument: row.sourceRow.scrip,
        expiry: formatStrategyExpiry(row.sourceRow.expiry),
        rows: [row],
      });
    });
    return Array.from(groups.values());
  }, [suggestionRows]);

  const selectedSuggestionGroups = useMemo(
    () => suggestionGroups.map((group) => ({
      group,
      selectedRows: group.rows.filter((row) => selectedSuggestionIds.includes(row.id)),
    })),
    [selectedSuggestionIds, suggestionGroups],
  );
  const selectedSuggestionCount = selectedSuggestionIds.filter((id) => suggestionRows.some((row) => row.id === id)).length;

  const candidateCountMatchesTradeCount =
    unassignedVisibleRows.length > 0 &&
    suggestionGroups.length === unassignedVisibleRows.length &&
    suggestionRows.length === unassignedVisibleRows.length;
  const selectedGroups = selectedSuggestionGroups.filter(({ selectedRows }) => selectedRows.length > 0);
  const hasValidSelectedStrategySelection =
    selectedGroups.length > 0 && selectedGroups.every(({ selectedRows }) => selectedRows.length === 1);
  const canConfirmAllVisible = suggestionRows.length > 0 && candidateCountMatchesTradeCount;

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
      qty: [ALL_QTY_FILTER, ...qty],
      date: ['All Dates', ...dateOptions],
      time: [ALL_TIME_FILTER, ...timeOptions],
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

  useEffect(() => {
    if (confirmationStartedAt === null) return undefined;
    const updateElapsed = () => setConfirmationElapsedMs(Date.now() - confirmationStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 100);
    return () => window.clearInterval(timer);
  }, [confirmationStartedAt]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2500);
  }

  function returnToStrategyAllocationIfComplete(data: StrategyAllocationResponse | undefined) {
    if (!context || !data) return;
    const hasUnallocatedMatches = (data.rows ?? []).some((row) => matchesAllocationContext(row, context) && (!row.strategy || row.strategy.trim() === 'Unassigned'));
    if (!hasUnallocatedMatches) {
      navigate(`/strategy-allocation${context.date ? `?date=${encodeURIComponent(context.date)}` : ''}`);
    }
  }

  function updateFilter<K extends keyof SuggestionFilters>(key: K, value: SuggestionFilters[K]) {
    setSuggestionFilters((current) => ({ ...current, [key]: value }));
  }

  function validateConfirmationPayload(payload: StrategyAllocationConfirmationRow[]) {
    const seen = new Set<string>();
    payload.forEach((row) => {
      const key = `${row.source}:${row.sourceId}:${row.splitTradeId ?? ''}`;
      if (seen.has(key)) {
        throw new Error('Select exactly one strategy for each trade before confirming');
      }
      seen.add(key);
    });
    return payload;
  }

  function buildConfirmationPayload(sourceRows: SuggestionRow[]) {
    return validateConfirmationPayload(sourceRows.map((row) => ({
      tradeId: row.sourceRow.tradeId,
      source: row.sourceRow.source,
      sourceId: row.sourceRow.sourceId || row.sourceRow.id,
      splitTradeId: resolveSplitTradeId(row.sourceRow),
      instrument: row.sourceRow.scrip,
      expiry: row.sourceRow.expiry,
      strike: row.sourceRow.strike,
      option: row.sourceRow.optType,
      side: row.sourceRow.side,
      qty: row.sourceRow.qty,
      price: row.sourceRow.price,
      strategyName: row.strategyName,
    })));
  }

  async function loadFreshSuggestionRows() {
    const { allocation: allocationData, master: masterData } = await preloadStrategyAllocation(true);
    const freshRows = allocationData.rows ?? [];
    const freshMasterRows = masterData.rows ?? [];
    setRows(freshRows);
    setStrategyMasterRows(freshMasterRows);

    const normalizedSearch = search.trim().toLowerCase();
    const freshVisibleRows = freshRows.filter((row) => {
      if (!context || !matchesAllocationContext(row, context)) return false;
      const matchesSearch =
        !normalizedSearch ||
        [row.date, formatDisplayTime(row.time), row.side, row.optType, String(row.qty), String(row.price), row.strategy]
          .join(' ')
          .toLowerCase()
          .includes(normalizedSearch);
      const matchesQty = suggestionFilters.qty === ALL_QTY_FILTER || String(row.qty) === suggestionFilters.qty;
      const matchesDate = suggestionFilters.date === 'All Dates' || formatDisplayDate(row.date) === suggestionFilters.date;
      const matchesTime = suggestionFilters.time === ALL_TIME_FILTER || formatDisplayTime(row.time) === suggestionFilters.time;
      return matchesSearch && matchesQty && matchesDate && matchesTime;
    });

    return buildSuggestionRows(freshVisibleRows, freshMasterRows);
  }

  function buildConfirmationItems(sourceRows: SuggestionRow[]): ConfirmationItem[] {
    return sourceRows.map((row) => ({
      id: row.id,
      label: `${row.tradeDateTime} · ${row.side} ${row.qtyPrice} · ${row.strategyName}`,
      status: 'waiting',
      detail: 'Waiting to start',
      steps: CONFIRMATION_PROCESS_STEPS.map((step) => ({
        ...step,
        status: 'waiting' as ConfirmationItemStatus,
        detail: 'Waiting to start',
        durationMs: null,
      })),
    }));
  }

  function applyConfirmationProgress(progress: ConfirmationProgressResponse) {
    setConfirmationStage(progress.stage);
    setConfirmationMessage(progress.message);
    setConfirmationItems((current) => current.map((item, index) => {
      const status = progress.row_statuses[index] ?? item.status;
      const processSteps = progress.trade_processes?.[index];
      const detail = status === 'processing'
        ? (progress.current_process?.trade_index === index
          ? progress.current_process.detail
          : 'Processing now')
        : status === 'completed'
          ? 'Completed successfully'
          : status === 'skipped'
            ? 'Skipped'
            : status === 'failed'
              ? (progress.error || 'Failed')
              : 'Waiting to start';
      return {
        ...item,
        status,
        detail,
        steps: processSteps?.map((step) => ({
          key: step.key,
          label: step.label,
          status: step.status,
          detail: step.detail,
          durationMs: step.duration_ms ?? null,
        })) ?? item.steps,
      };
    }));
  }

  function formatElapsed(milliseconds: number) {
    return `${(milliseconds / 1000).toFixed(1)} sec`;
  }

  function formatStepElapsed(milliseconds?: number | null) {
    if (milliseconds === null || milliseconds === undefined) return '—';
    return `${(milliseconds / 1000).toFixed(milliseconds < 1000 ? 2 : 1)} sec`;
  }

  async function confirmSuggestions(payload: StrategyAllocationConfirmationRow[], errorMessage: string, sourceRows: SuggestionRow[]) {
    if (confirmingRef.current || !payload.length) return;
    confirmingRef.current = true;
    setConfirming(true);
    setConfirmingCount(payload.length);
    setConfirmPhase('saving');
    setConfirmationItems(buildConfirmationItems(sourceRows));
    setConfirmationStage('preparing');
    setConfirmationMessage('Preparing confirmation');
    const startedAt = Date.now();
    setConfirmationStartedAt(startedAt);
    setConfirmationElapsedMs(0);

    const progressId = globalThis.crypto?.randomUUID?.() ?? `confirmation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let confirmationRequestFinished = false;
    const pollProgress = async () => {
      for (let attempt = 0; attempt < 180; attempt += 1) {
        try {
          const progress = await loadConfirmationProgress(progressId);
          applyConfirmationProgress(progress);
          if (progress.status !== 'running') return;
        } catch {
          // The POST creates the progress record just after it starts. Keep
          // polling through the short initial 404 race instead of stopping
          // before the first trade has been reported.
          if (confirmationRequestFinished) return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
    };
    const confirmationRequest = confirmStrategyAllocations(payload, progressId)
      .finally(() => { confirmationRequestFinished = true; });
    const progressPromise = pollProgress();

    try {
      const result = await confirmationRequest;
      await progressPromise;
      const processed = result.processed_count ?? result.updated_rows ?? payload.length;
      const skipped = result.skipped_count ?? 0;
      const errors = result.errors?.length ? ` Errors: ${result.errors.join(' | ')}` : '';
      const fullyProcessed = processed === payload.length && skipped === 0 && !result.errors?.length;

      setSelectedSuggestionIds([]);
      flash(
        result.message ??
          `${processed} trade${processed === 1 ? '' : 's'} processed successfully. Skipped: ${skipped}.${errors}`,
      );

      if (fullyProcessed) {
        setConfirmationStage('completed');
        setConfirmationMessage('All selected trades completed');
        const patchedData = applyConfirmedStrategyAllocations(payload);
        if (processed > 0) returnToStrategyAllocationIfComplete(patchedData);
        return;
      }

      setConfirmPhase('refreshing');
      setConfirmationStage('refreshing');
      setConfirmationMessage('Refreshing allocation data');
      const refreshedSnapshot = await revalidateStrategyAllocationSnapshot();
      setRows(refreshedSnapshot.allocation.rows ?? []);
      setStrategyMasterRows(refreshedSnapshot.master.rows ?? []);
      if (processed > 0) returnToStrategyAllocationIfComplete(refreshedSnapshot.allocation);
    } catch (confirmError: unknown) {
      const failureMessage = confirmError instanceof Error ? confirmError.message : errorMessage;
      const requiresRefresh = /needs a refresh|allocation_not_preassigned|raw_trade_mismatch|split_trade_mismatch/i.test(failureMessage);
      setConfirmationStage('failed');
      setConfirmationMessage(requiresRefresh ? 'The allocation list was out of date. Refreshing the selection.' : failureMessage);
      setConfirmationItems((current) => current.map((item) => item.status === 'processing' ? { ...item, status: 'failed', detail: 'Failed' } : item));
      if (requiresRefresh) {
        setSelectedSuggestionIds([]);
        try {
          const refreshedSnapshot = await preloadStrategyAllocation(true);
          setRows(refreshedSnapshot.allocation.rows ?? []);
          setStrategyMasterRows(refreshedSnapshot.master.rows ?? []);
          flash('The allocation list was refreshed. Please select the trades again.');
        } catch {
          flash('The allocation list changed. Please refresh the page and select the trades again.');
        }
      } else {
        flash(failureMessage);
      }
    } finally {
      setConfirmationElapsedMs(Date.now() - startedAt);
      setConfirmationStartedAt(null);
      confirmingRef.current = false;
      setConfirming(false);
      setConfirmingCount(0);
      setConfirmPhase('saving');
    }
  }

  function toggleSuggestionSelection(id: string) {
    setSelectedSuggestionIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function toggleBlockSelection(id: string) {
    setSelectedBlockIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function confirmSelectedSuggestions() {
    let freshSuggestionRows: SuggestionRow[];
    try {
      freshSuggestionRows = await loadFreshSuggestionRows();
    } catch (loadError: unknown) {
      flash(loadError instanceof Error ? `Unable to refresh suggestions: ${loadError.message}` : 'Unable to refresh suggestions');
      return;
    }
    const selected = freshSuggestionRows.filter((row) => selectedSuggestionIds.includes(row.id));
    if (selected.length !== selectedSuggestionIds.length) {
      setSelectedSuggestionIds(selected.map((row) => row.id));
      flash('The suggestions changed. The list was refreshed; please select the trade again.');
      return;
    }
    const selectedGroups = Array.from(new Set(selected.map((row) => row.sourceRow.id)))
      .map((sourceId) => selected.filter((row) => row.sourceRow.id === sourceId));
    if (!selectedGroups.length || selectedGroups.some((group) => group.length !== 1)) {
      flash('Select exactly one strategy for each selected trade before confirming');
      return;
    }

    await confirmSuggestions(buildConfirmationPayload(selected), 'Unable to confirm selected suggestions', selected);
  }

  async function confirmAllVisibleSuggestions() {
    let freshSuggestionRows: SuggestionRow[];
    try {
      freshSuggestionRows = await loadFreshSuggestionRows();
    } catch (loadError: unknown) {
      flash(loadError instanceof Error ? `Unable to refresh suggestions: ${loadError.message}` : 'Unable to refresh suggestions');
      return;
    }
    const freshGroups = Array.from(new Set(freshSuggestionRows.map((row) => row.sourceRow.id)))
      .map((sourceId) => freshSuggestionRows.filter((row) => row.sourceRow.id === sourceId));
    if (!freshSuggestionRows.length || freshGroups.length !== freshSuggestionRows.length || freshGroups.some((group) => group.length !== 1)) {
      flash('The suggestions changed. The list was refreshed; review the strategies before confirming.');
      return;
    }

    await confirmSuggestions(buildConfirmationPayload(freshSuggestionRows), 'Unable to confirm all visible suggestions', freshSuggestionRows);
  }

  async function confirmFromSingleButton() {
    if (selectedSuggestionCount > 0) {
      await confirmSelectedSuggestions();
      return;
    }
    if (!canConfirmAllVisible) {
      flash('Select exactly one strategy for each trade before confirming');
      return;
    }
    await confirmAllVisibleSuggestions();
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
        .inst-top-row{display:grid;grid-template-columns:minmax(0,75fr) minmax(0,25fr);gap:14px;align-items:stretch;}
        .inst-top-row > section{min-width:0;height:100%;align-self:stretch;display:flex;flex-direction:column;}
        .inst-table-card,.inst-suggestions-card{min-width:0;}
        .inst-table-card,.inst-suggestions-card{height:100%;}
        .inst-table-card .alloc-card-head,.inst-suggestions-card .alloc-card-head{padding-bottom:10px;}
        .inst-table-card .inst-table-wrap{padding-bottom:8px;}
        .inst-table-card .inst-table{min-width:0;width:100%;max-width:100%;table-layout:fixed;font-size:12.5px;}
        .inst-table-card .inst-table th,.inst-table-card .inst-table td{box-sizing:border-box;padding-left:8px;padding-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .inst-table-card .inst-table th{white-space:nowrap;}
        .inst-table-card .inst-strategy-cell{min-width:0;text-align:left;}
        .inst-table-card .inst-strategy-value{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .inst-table-card .inst-unassigned-label{display:inline-flex;align-items:center;gap:5px;color:#c98512;font-weight:800;}
        .inst-table-card .inst-unassigned-label svg{color:#e29a1b;flex:0 0 auto;}
        .inst-table-card .inst-actions-cell{text-align:center;}
        .inst-table-card .inst-table th{height:53px;font-size:11.25px;color:#000;}
        .inst-table-card .inst-table td{height:63px;}
        .inst-table-card .inst-action-btn{height:35px;padding:0 11px;font-size:12.5px;}
        .inst-table-card .inst-strategy-action{display:flex;align-items:center;justify-content:flex-start;gap:8px;min-width:0;}
        .inst-table-card .inst-allocated-strategy{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#111827;font-size:11px;font-weight:600;}
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
        .inst-suggestions-card .inst-mini-table-wrap{padding:0 8px 12px;}
        .inst-suggestions-card{position:relative;overflow:visible;z-index:20;}
        .inst-suggestions-card .inst-filter-popover{position:absolute;top:58px;left:10px;right:10px;z-index:50;padding:10px;border:1px solid #c9d9f1;border-radius:11px;background:#fff;box-shadow:0 14px 30px rgba(25,62,123,.16);}
        .inst-suggestions-card .inst-filter-row{display:flex;flex-wrap:nowrap;align-items:flex-end;gap:10px;width:100%;padding:0 8px 14px;box-sizing:border-box;}
        .inst-suggestions-card .inst-filter-popover .inst-filter-row{padding:0;}
        .inst-suggestions-card .inst-filter-row > *{min-width:0;flex:1 1 0;}
        .inst-suggestions-card .inst-filter-field,
        .inst-suggestions-card .inst-date-filter{display:flex;flex-direction:column;gap:0;min-width:0;flex:1 1 0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;color:#667695;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}
        .inst-suggestions-card .inst-filter-select-trigger,
        .inst-suggestions-card .inst-date-filter .matalia-calendar-trigger{width:100%;height:38px;box-sizing:border-box;border:1px solid #d6e1f4;border-radius:10px;background:linear-gradient(180deg,#fff 0%,#f9fbff 100%);box-shadow:0 2px 5px rgba(25,62,123,.06);color:#172e58;font-size:12px;font-weight:700;letter-spacing:0;text-transform:none;outline:none;}
        .inst-suggestions-card .inst-filter-select{position:relative;width:100%;}
        .inst-suggestions-card .inst-filter-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 11px 0 12px;cursor:pointer;font-family:inherit;text-align:left;}
        .inst-suggestions-card .inst-filter-select-trigger span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .inst-suggestions-card .inst-filter-select-trigger svg{color:#155eef;transition:transform .18s ease;}
        .inst-suggestions-card .inst-filter-select-trigger.is-open svg{transform:rotate(180deg);}
        .inst-suggestions-card .inst-filter-select-trigger:focus,
        .inst-suggestions-card .inst-date-filter .matalia-calendar-trigger:focus,
        .inst-suggestions-card .inst-date-filter .matalia-calendar-trigger:hover{border-color:#7ea6ed;box-shadow:0 0 0 3px rgba(45,105,216,.1);}
        .inst-suggestions-card .inst-filter-select-trigger:hover,
        .inst-suggestions-card .inst-filter-select-trigger.is-open{border-color:#7ea6ed;box-shadow:0 0 0 3px rgba(45,105,216,.1);}
        .inst-suggestions-card .inst-filter-select-menu{position:absolute;top:calc(100% + 7px);left:0;right:0;z-index:80;padding:5px;border:1px solid #c9d9f1;border-radius:11px;background:#fff;box-shadow:0 14px 30px rgba(25,62,123,.16);}
        .inst-suggestions-card .inst-filter-select-option{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;height:32px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:#28426d;font-family:inherit;font-size:11.5px;font-weight:700;text-align:left;cursor:pointer;}
        .inst-suggestions-card .inst-filter-select-option:hover{background:#edf4ff;color:#155eef;}
        .inst-suggestions-card .inst-filter-select-option.is-selected{background:#155eef;color:#fff;}
        .inst-suggestions-card .inst-filter-select-option.is-selected svg{color:#fff;}
        .inst-suggestions-card .inst-date-filter .matalia-calendar{width:100%;}
        .inst-suggestions-card .inst-date-filter .matalia-calendar{position:relative;z-index:100;}
        .inst-suggestions-card .inst-date-filter .matalia-calendar-label{display:none;}
        .inst-suggestions-card .inst-date-filter .matalia-calendar-trigger{padding:0 11px;}
        .inst-suggestions-card .inst-date-filter .matalia-calendar-trigger strong{font-size:12px;}
        .inst-suggestions-card .inst-header-actions button{
          font-size:12.5px;
          height:34px;
          background:#155eef;
          border-color:#155eef;
          color:#fff;
        }
        .inst-suggestions-card .inst-header-actions .inst-filter-toggle{width:34px;padding:0;display:grid;place-items:center;}
        .inst-suggestions-card .inst-header-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
        .inst-confirm-progress{display:flex;flex-direction:column;gap:9px;padding:11px 13px;border:1px solid #d6e2f5;border-radius:10px;background:#f8fbff;color:#6d7d98;}
        .inst-confirm-progress-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}
        .inst-confirm-progress-copy{display:flex;flex-direction:column;gap:2px;min-width:0;}
        .inst-confirm-progress-copy strong{color:#173567;font-size:12px;}
        .inst-confirm-progress-copy span{overflow:hidden;color:#7183a0;font-size:10px;text-overflow:ellipsis;white-space:nowrap;}
        .inst-confirm-progress-count{display:flex;flex-direction:column;align-items:flex-end;gap:1px;color:#155eef;font-size:11px;font-weight:900;text-align:right;white-space:nowrap;}
        .inst-confirm-progress-time{color:#60728f;font-size:10px;font-weight:800;}
        .inst-confirm-progress-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px;margin:0;padding:0;list-style:none;}
        .inst-confirm-progress-item{display:flex;flex-direction:column;align-items:stretch;gap:5px;min-width:0;padding:7px 8px;border:1px solid #dfe8f5;border-radius:8px;background:#fff;color:#6d7d98;}
        .inst-confirm-progress-item-head{display:flex;align-items:center;gap:9px;min-width:0;}
        .inst-confirm-progress-item-head > div{display:flex;flex-direction:column;gap:2px;min-width:0;}
        .inst-confirm-progress-item strong{overflow:hidden;color:#28426d;font-size:10px;text-overflow:ellipsis;white-space:nowrap;}
        .inst-confirm-progress-item span{font-size:9px;}
        .inst-confirm-progress-item.is-processing{border-color:#7ea6ed;background:#fff;color:#155eef;}
        .inst-confirm-progress-item.is-processing strong{color:#155eef;}
        .inst-confirm-progress-item.is-completed{border-color:#a8dec4;color:#19734a;}
        .inst-confirm-progress-item.is-completed strong{color:#16643f;}
        .inst-confirm-progress-item.is-skipped,.inst-confirm-progress-item.is-failed{border-color:#f0c8c8;color:#a33d3d;}
        .inst-confirm-progress-item.is-skipped strong,.inst-confirm-progress-item.is-failed strong{color:#8e3030;}
        .inst-confirm-process-list{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(96px,1fr);grid-template-columns:none;gap:4px;margin:2px 0 0;padding:0;list-style:none;overflow-x:auto;}
        .inst-confirm-process-step{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:5px;min-width:0;min-height:32px;padding:6px 7px;border:1px solid #e6edf7;border-radius:6px;background:#fbfdff;color:#8392a9;font-size:9px;line-height:1.2;text-align:left;}
        .inst-confirm-process-step > div{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:6px;min-width:0;width:100%;}
        .inst-confirm-process-step strong{display:block;max-width:100%;overflow:hidden;color:inherit;font-size:9px;font-weight:800;text-overflow:ellipsis;white-space:nowrap;}
        .inst-confirm-process-duration{display:inline;margin-left:5px;color:#667892;font-size:8px;font-weight:700;white-space:nowrap;}
        .inst-confirm-process-step > div > span{display:none;}
        .inst-confirm-process-step.is-processing{color:#155eef;}
        .inst-confirm-process-step.is-completed{color:#19734a;}
        .inst-confirm-process-step.is-failed,.inst-confirm-process-step.is-skipped{color:#a33d3d;}
        .inst-confirm-process-step .inst-progress-spinner{width:10px;height:10px;border-width:1.5px;margin-top:1px;}
        .inst-confirm-process-step .inst-progress-dot{width:6px;height:6px;margin:3px 2px 0 2px;}
        .inst-progress-spinner{display:block;width:15px;height:15px;border:2px solid #bfd2f7;border-top-color:#155eef;border-radius:50%;animation:inst-progress-spin .75s linear infinite;flex:none;}
        .inst-progress-dot{display:block;width:9px;height:9px;margin:3px;border-radius:50%;background:#b7c6dc;flex:none;}
        @keyframes inst-progress-spin{to{transform:rotate(360deg)}}
        @media (max-width: 900px){.inst-confirm-process-list{grid-auto-columns:96px;}}
        .inst-suggestions-card .inst-suggestion-list{display:flex;flex-direction:column;gap:10px;}
        .inst-suggestions-card .inst-suggestion-group{padding:12px;border:1px solid #d6e1f4;border-radius:10px;background:linear-gradient(180deg,#fff 0%,#fbfdff 100%);box-shadow:0 2px 7px rgba(25,62,123,.05);}
        .inst-suggestions-card .inst-suggestion-group-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px 10px;border-bottom:1px solid #e7edf7;}
        .inst-suggestions-card .inst-suggestion-trade-meta{display:flex;align-items:center;gap:10px;width:100%;min-width:0;flex-wrap:wrap;}
        .inst-suggestions-card .inst-suggestion-datetime,
        .inst-suggestions-card .inst-suggestion-qty,
        .inst-suggestions-card .inst-suggestion-contract{color:#172e58;font-size:12px;font-weight:800;white-space:nowrap;}
        .inst-suggestions-card .inst-suggestion-qty{font-variant-numeric:tabular-nums;}
        .inst-suggestions-card .inst-suggestion-contract{margin-left:auto;color:#536783;font-size:11.5px;font-weight:700;text-align:right;}
        .inst-suggestions-card .inst-strategy-options{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding-top:10px;}
        .inst-suggestions-card .inst-strategy-option{display:grid;grid-template-columns:16px 25px minmax(0,1fr);align-items:center;gap:8px;min-width:0;padding:8px 10px;border:1px solid #d6e1f4;border-radius:9px;background:#fff;color:#24416f;cursor:pointer;transition:border-color .15s ease, box-shadow .15s ease, background-color .15s ease, transform .15s ease;}
        .inst-suggestions-card .inst-strategy-options.strategy-count-1 .inst-strategy-option{width:fit-content;max-width:100%;grid-template-columns:16px 25px minmax(0,max-content);}
        .inst-suggestions-card .inst-strategy-option:hover{border-color:#8bade8;background:#f7fbff;transform:translateY(-1px);}
        .inst-suggestions-card .inst-strategy-option.is-selected{border-color:#2d69d8;background:#eef5ff;box-shadow:0 0 0 2px rgba(45,105,216,.12);color:#155eef;}
        .inst-suggestions-card .inst-strategy-option input[type='checkbox']{width:16px;height:16px;margin:0;accent-color:#155eef;}
        .inst-suggestions-card .inst-strategy-option-icon{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:#edf3ff;color:#356fda;}
        .inst-suggestions-card .inst-strategy-option.is-selected .inst-strategy-option-icon{background:#155eef;color:#fff;}
        .inst-suggestions-card .inst-strategy-option-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:900;}
        .inst-suggestions-card .inst-add-strategy-tile{display:flex;align-items:center;gap:12px;min-height:78px;padding:14px;border:1px dashed #9eb9eb;border-radius:10px;background:linear-gradient(135deg,#f7faff 0%,#eef5ff 100%);}
        .inst-suggestions-card .inst-add-strategy-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#155eef;color:#fff;box-shadow:0 5px 12px rgba(21,94,239,.2);flex:0 0 auto;}
        .inst-suggestions-card .inst-add-strategy-copy{display:flex;flex-direction:column;gap:4px;min-width:0;}
        .inst-suggestions-card .inst-add-strategy-copy strong{color:#173567;font-size:12.5px;font-weight:900;}
        .inst-suggestions-card .inst-add-strategy-copy span{color:#6b7d9b;font-size:10.5px;line-height:1.35;}
        .inst-suggestions-card .inst-add-strategy-button{margin-left:auto;height:34px;padding:0 13px;border:1px solid #155eef;border-radius:8px;background:#155eef;color:#fff;font-size:11.5px;font-weight:800;cursor:pointer;white-space:nowrap;}
        .inst-suggestions-card .inst-add-strategy-button:hover{background:#134fd0;border-color:#134fd0;}
        @media (max-width: 900px){
          .inst-suggestions-card .inst-filter-row{flex-wrap:wrap;}
          .inst-suggestions-card .inst-filter-row > *{flex:1 1 calc(50% - 10px);}
          .inst-suggestions-card .inst-suggestion-group-head{align-items:flex-start;flex-direction:column;gap:6px;}
          .inst-suggestions-card .inst-suggestion-contract{margin-left:0;}
          .inst-suggestions-card .inst-strategy-options{align-items:stretch;}
          .inst-suggestions-card .inst-add-strategy-tile{align-items:flex-start;flex-wrap:wrap;}
          .inst-suggestions-card .inst-add-strategy-button{margin-left:46px;}
        }
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
          <button className="inst-back-btn" type="button" onClick={() => navigate(`/strategy-allocation${context.date ? `?date=${encodeURIComponent(context.date)}` : ''}`)} aria-label="Back to Strategy Allocation" title="Back to Strategy Allocation">
            <ArrowLeft size={24} />
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
      {confirming && (
        <div className="alloc-notice alloc-confirming" role="status" aria-live="polite">
          <span className="alloc-confirming-spinner" aria-hidden="true" />
          {confirmPhase === 'saving'
            ? `Confirming ${confirmingCount} suggestion${confirmingCount === 1 ? '' : 's'}...`
            : 'Refreshing allocation data...'}
        </div>
      )}
      {confirmationItems.length > 0 && (
        <section className={`inst-confirm-progress is-${confirmationStage}`} role="status" aria-live="polite">
          <div className="inst-confirm-progress-head">
            <div className="inst-confirm-progress-copy">
              <strong>{confirmationStage === 'completed' ? 'Confirmation completed' : confirmationStage === 'failed' ? 'Confirmation stopped' : 'Confirmation progress'}</strong>
              <span>{confirmationMessage || 'Preparing confirmation'}</span>
            </div>
            <span className="inst-confirm-progress-count">
              {confirmationItems.filter((item) => item.status === 'completed').length}/{confirmationItems.length} completed
              <span className="inst-confirm-progress-time">Time: {formatElapsed(confirmationElapsedMs)}</span>
            </span>
          </div>
          <ol className="inst-confirm-progress-list">
            {confirmationItems.map((item, index) => (
              <li className={`inst-confirm-progress-item is-${item.status}`} key={item.id}>
                <div className="inst-confirm-progress-item-head">
                  {confirmationStatusIcon(item.status)}
                  <div>
                    <strong>{index + 1}. {item.label}</strong>
                    <span>{item.detail}</span>
                  </div>
                </div>
                <ol className="inst-confirm-process-list" aria-label={`Detailed process for trade ${index + 1}`}>
                  {item.steps.map((step) => (
                    <li className={`inst-confirm-process-step is-${step.status}`} key={step.key}>
                      {confirmationStatusIcon(step.status)}
                      <div>
                        <strong>{step.label}<span className="inst-confirm-process-duration">{formatStepElapsed(step.durationMs)}</span></strong>
                        <span>{step.detail}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </section>
      )}
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
        <SummaryCard label="Total Trades" value={String(summary.totalTrades)} icon={<BarChart3 size={25} />} tone="blue" />
        <SummaryCard label="Total Buys" value={formatQty(summary.totalBuys)} icon={<ShoppingCart size={25} />} tone="green" />
        <SummaryCard label="Total Sells" value={formatQty(summary.totalSells)} icon={<ShoppingCart size={25} />} tone="red" />
        <SummaryCard label="Gross Quantity" value={formatQty(summary.grossQuantity)} icon={<Package size={25} />} tone="purple" />
        <SummaryCard label="Net Quantity" value={formatQty(summary.netQuantity)} icon={<CircleMinus size={25} />} tone="orange" />
        <SummaryCard label="Avg Price" value={formatPrice(summary.avgPrice)} icon={<IndianRupee size={25} />} tone="blue" />
        <SummaryCard label="Gross P&L" value={formatMoney(summary.grossPnl)} icon={<TrendingUp size={25} />} tone="green" />
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
              <colgroup>
                <col style={{ width: '11%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '12%' }} />
              </colgroup>
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
                  <th>Actions</th>
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
                      <ActionButton
                        tone="secondary"
                        icon={<Scissors size={14} />}
                        ariaLabel={`Split trade ${row.tradeId}`}
                        disabled={row.source !== '01RawTxtData' || (!!row.splitTradeId && row.strategy.trim().toLowerCase() !== 'unassigned')}
                        title={row.source !== '01RawTxtData' || (!!row.splitTradeId && row.strategy.trim().toLowerCase() !== 'unassigned')
                          ? 'This trade is already allocated.'
                          : 'Split this trade by quantity'}
                        onClick={() => setSplitRow(row)}
                      />
                    </td>
                    <td className="inst-strategy-cell">
                      <span className="inst-strategy-value" title={row.strategy || 'Unassigned'}>
                        {row.strategy && row.strategy.trim().toLowerCase() !== 'unassigned' ? row.strategy : <span className="inst-unassigned-label"><AlertTriangle size={13} />Unassigned</span>}
                      </span>
                    </td>
                    <td className="inst-actions-cell">
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
              <p>{suggestionRows.length} records</p>
            </div>
            <div className="inst-header-actions">
              <button
                className="allocate-btn inst-mini-btn inst-filter-toggle"
                type="button"
                onClick={() => setFiltersOpen((open) => !open)}
                aria-label="Toggle suggestion filters"
                aria-expanded={filtersOpen}
                title="Filters"
              >
                <Filter size={15} />
              </button>
              <button
                className="allocate-btn inst-mini-btn"
                type="button"
                onClick={confirmFromSingleButton}
                disabled={confirming || !suggestionRows.length || (selectedSuggestionCount === 0 && !canConfirmAllVisible)}
                title={selectedSuggestionCount > 0 && !hasValidSelectedStrategySelection ? 'Select exactly one strategy for each selected trade' : selectedSuggestionCount === 0 && !canConfirmAllVisible ? 'Select exactly one strategy for each trade' : undefined}
              >
                {confirming
                  ? `Confirming ${confirmingCount}...`
                  : selectedSuggestionCount > 0
                    ? `Confirm Selected (${selectedSuggestionCount})`
                    : canConfirmAllVisible
                      ? `Confirm All (${unassignedVisibleRows.length})`
                      : 'Select Strategies'}
              </button>
            </div>
          </div>
          {filtersOpen && <div className="inst-filter-popover">
            <div className="inst-filter-row">
              <label className="inst-filter-field">
                <StyledFilterSelect ariaLabel="Quantity filter" value={suggestionFilters.qty} options={suggestionOptions.qty} onChange={(value) => updateFilter('qty', value)} />
              </label>
              <div className="inst-date-filter">
                <Calendar className="inst-date-calendar" label="" value={suggestionFilters.date === 'All Dates' ? '' : parseCalendarDisplayDate(suggestionFilters.date)} placeholder="All Dates" allowClear allowedDates={suggestionOptions.date.slice(1).map(parseCalendarDisplayDate)} onChange={(value) => updateFilter('date', value ? formatDisplayDate(value) : 'All Dates')} />
              </div>
              <label className="inst-filter-field">
                <StyledFilterSelect ariaLabel="Time filter" value={suggestionFilters.time} options={suggestionOptions.time} onChange={(value) => updateFilter('time', value)} />
              </label>
            </div>
          </div>}
          <div className="inst-mini-table-wrap">
            <div className="inst-suggestion-list" role="list" aria-label="Batch split suggestions">
              {suggestionGroups.length > 0 ? suggestionGroups.map((group) => (
                <article className="inst-suggestion-group" key={`suggestion-group-${group.key}`} role="listitem">
                  <div className="inst-suggestion-group-head">
                    <div className="inst-suggestion-trade-meta">
                      <span className="inst-suggestion-datetime">{group.tradeDateTime}</span>
                      <span className="inst-suggestion-side">
                        <span className={`inst-side-badge ${badgeTone(group.side)}`}>{group.side}</span>
                      </span>
                      <span className="inst-suggestion-qty">{group.qtyPrice}</span>
                      <span className="inst-suggestion-contract">{group.instrument} · {group.expiry}</span>
                    </div>
                  </div>
                  <div className={`inst-strategy-options strategy-count-${Math.min(group.rows.length, 4)}`}>
                    {group.rows.map((row) => {
                      const selected = selectedSuggestionIds.includes(row.id);
                      return (
                        <div
                          className={`inst-strategy-option ${selected ? 'is-selected' : ''}`}
                          key={`suggestion-option-${row.id}`}
                          title={row.strategyName}
                          role="button"
                          tabIndex={0}
                          aria-pressed={selected}
                          onClick={() => toggleSuggestionSelection(row.id)}
                          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSuggestionSelection(row.id); } }}
                        >
                          <input type="checkbox" checked={selected} onChange={() => toggleSuggestionSelection(row.id)} onClick={(event) => event.stopPropagation()} aria-label={`Select ${row.strategyName}`} />
                          <span className="inst-strategy-option-icon"><Layers3 size={14} /></span>
                          <span className="inst-strategy-option-name">{row.strategyName}</span>
                        </div>
                      );
                    })}
                  </div>
                </article>
              )) : unassignedVisibleRows.length > 0 ? (
                <div className="inst-add-strategy-tile" role="listitem">
                  <span className="inst-add-strategy-icon"><Plus size={19} /></span>
                  <div className="inst-add-strategy-copy">
                    <strong>Add Strategy</strong>
                    <span>No matching strategy suggestion is available for this trade.</span>
                  </div>
                  <button type="button" className="inst-add-strategy-button" onClick={() => setStrategySetupRow(unassignedVisibleRows[0])}>
                    Add Strategy
                  </button>
                </div>
              ) : null}
            </div>
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
