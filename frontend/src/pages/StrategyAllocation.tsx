import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { Activity, AlertCircle, AlertTriangle, ArrowUpDown, BarChart3, CalendarDays, CheckCircle2, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, FileChartColumn, Filter, History, Loader2, LogOut, Plus, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, Trash2, Users, X } from 'lucide-react';
import { deleteTradeBookTrade, loadImportPipelineLog, loadStrategyAllocation, preloadStrategyAllocation, revalidateStrategyAllocationSnapshot, runImportPipeline, saveStrategySetup, uploadImportFiles, type PipelineLogResponse } from '../lib/api';
import type { StrategyAllocationRow, StrategyMasterRow, StrategySetupPayload } from '../lib/api';
import { navigate } from '../lib/router';
import { signOut } from '../lib/auth';
import { pipelineTimelineStage, WorkflowTimeline } from '../components/PipelineUI';
import Calendar from '../components/Calendar';

type Trade = {
  id: string;
  date: string;
  time: string;
  instrument: string;
  expiry: string;
  strike: string;
  tradeType: string;
  optionType: string;
  qty: string;
  avg: string;
  order: string;
  source: string;
  strategy: string;
  allocated: boolean;
  bucket: 'Open' | 'Unassigned';
  splitTradeId?: string;
};

type BucketFilter = 'all' | 'allocated' | 'unassigned';
type SortKey = 'date' | 'time' | 'instrument' | 'expiry' | 'strike' | 'tradeType' | 'optionType' | 'qty' | 'avg' | 'strategy';
type SortDirection = 'asc' | 'desc';
type TableFilters = {
  date: string;
  instrument: string;
  expiry: string;
  tradeType: string;
  optionType: string;
  strategy: string;
};

const groups = [
  ['PIPELINE', [['02 Merge Trades', FileChartColumn], ['03 Split Trades', SlidersHorizontal], ['04 Strategy Allocation', Users], ['05 Trade Book', ShieldCheck]]],
  ['TRADING', [['Positions', Activity], ['Strategies', Activity], ['Orders', SlidersHorizontal], ['Watchlist', Sparkles]]],
  ['REPORTS', [['Profit and Loss Report', FileChartColumn], ['Strategy Report', BarChart3], ['Activity Log', History]]],
  ['SYSTEM', [['Settings', Settings], ['Users', Users], ['System Health', ShieldCheck]]],
] as const;

type StrategySetupMode = 'create' | 'edit';
export type StrategySetupContext = {
  instrument?: string;
  expiry?: string;
  qty?: number;
};
export type StrategySetupInitialValues = {
  name?: string;
  instrument?: string;
  parentQty?: number;
  expiries?: string[];
  splitRequired?: boolean;
  splitMethod?: string;
  accounts?: Array<{ name: string; qty: number }>;
};
type StrategySetupItem = {
  mappingId: number;
  name: string;
  instrument: string;
  parentQty: number;
  expiries: string[];
  splitMethod: string;
  allocations: number[];
};

function normalizeSetupExpiry(value: string) {
  const compact = value.replace(/[-\s]/g, '').toUpperCase();
  const numericMatch = compact.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/);
  if (numericMatch) {
    const [, day, monthNumber, year] = numericMatch;
    const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(monthNumber) - 1];
    if (month) return `${day}${month}${year.length === 2 ? `20${year}` : year}`;
  }
  const match = compact.match(/^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/);
  if (!match) return compact;
  const [, day, month, year] = match;
  return `${day.padStart(2, '0')}${month}${year.length === 2 ? `20${year}` : year}`;
}

function formatSetupExpiry(value: string) {
  const compact = normalizeSetupExpiry(value);
  const match = compact.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return value;
  const [, day, month, year] = match;
  return `${day}-${month[0]}${month.slice(1).toLowerCase()}-${year.slice(-2)}`;
}

function isValidSetupExpiry(value: string) {
  const match = value.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return false;
  const [, dayText, monthText, yearText] = match;
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(monthText);
  if (month < 0) return false;
  const date = new Date(Date.UTC(Number(yearText), month, Number(dayText)));
  return date.getUTCFullYear() === Number(yearText) && date.getUTCMonth() === month && date.getUTCDate() === Number(dayText);
}

function setupItems(rows: StrategyMasterRow[]): StrategySetupItem[] {
  const grouped = new Map<number, StrategySetupItem>();
  rows.forEach((row) => {
    if (row.mappingId == null) return;
    const item = grouped.get(row.mappingId) ?? {
      mappingId: row.mappingId,
      name: row.strategyName,
      instrument: row.instrument,
      parentQty: row.parentQty ?? row.splitQty ?? 0,
      expiries: [],
      splitMethod: row.splitMethod || 'Quantity',
      allocations: [],
    };
    const expiry = normalizeSetupExpiry(row.expiry);
    if (expiry && !item.expiries.includes(expiry)) item.expiries.push(expiry);
    item.allocations.push(row.splitQty ?? row.parentQty ?? 0);
    grouped.set(row.mappingId, item);
  });
  return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function StrategySetupModal({
  mode,
  rows,
  context,
  initialValues,
  editMappingId,
  onClose,
  onSaved,
}: {
  mode: StrategySetupMode;
  rows: StrategyMasterRow[];
  context?: StrategySetupContext;
  initialValues?: StrategySetupInitialValues;
  editMappingId?: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const items = useMemo(() => setupItems(rows), [rows]);
  const [activeMode, setActiveMode] = useState<StrategySetupMode>(mode);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState(initialValues?.name ?? '');
  const [instrument, setInstrument] = useState(initialValues?.instrument || context?.instrument || 'NIFTY');
  const [parentQty, setParentQty] = useState(initialValues?.parentQty ? String(initialValues.parentQty) : context?.qty ? String(context.qty) : '');
  const [expiryInput, setExpiryInput] = useState('');
  const [expiries, setExpiries] = useState<string[]>(initialValues?.expiries?.map(normalizeSetupExpiry) ?? (context?.expiry ? [normalizeSetupExpiry(context.expiry)] : []));
  const [allExpiries, setAllExpiries] = useState(false);
  const [splitRequired, setSplitRequired] = useState(initialValues?.splitRequired ?? true);
  const [splitMethod, setSplitMethod] = useState(initialValues?.splitMethod || 'Quantity');
  const [accounts, setAccounts] = useState(initialValues?.accounts?.length ? initialValues.accounts : [{ name: 'H&L', qty: 0 }, { name: 'Richa', qty: 0 }]);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const knownExpiries = useMemo(() => Array.from(new Set(rows.map((row) => normalizeSetupExpiry(row.expiry)).filter(Boolean))), [rows]);
  const totalQty = Number(parentQty) || 0;
  const allocatedQty = accounts.reduce((sum, account) => sum + (Number(account.qty) || 0), 0);
  const pendingQty = Math.max(0, totalQty - allocatedQty);

  useEffect(() => {
    if (activeMode !== 'edit' || editMappingId == null) return;
    const item = items.find((candidate) => candidate.mappingId === editMappingId);
    if (item) loadItem(item);
  }, [activeMode, editMappingId, items]);

  function loadItem(item: StrategySetupItem) {
    setSelectedId(String(item.mappingId));
    setName(item.name);
    setInstrument(item.instrument || 'NIFTY');
    setParentQty(String(item.parentQty || ''));
    setExpiries(item.expiries);
    setAllExpiries(false);
    setSplitRequired(item.allocations.length > 1 || item.splitMethod !== 'None');
    setSplitMethod(item.splitMethod || 'Quantity');
    setAccounts(item.allocations.length > 1
      ? item.allocations.map((qty, index) => ({ name: index === 0 ? 'H&L' : index === 1 ? 'Richa' : `Account ${index + 1}`, qty }))
      : [{ name: 'H&L', qty: item.allocations[0] ?? item.parentQty }, { name: 'Richa', qty: 0 }]);
    setNotice('');
  }

  function resetCreate() {
    setActiveMode('create');
    setSelectedId('');
    setName('');
    setInstrument(context?.instrument || 'NIFTY');
    setParentQty(context?.qty ? String(context.qty) : '');
    setExpiryInput('');
    setExpiries(context?.expiry ? [normalizeSetupExpiry(context.expiry)] : []);
    setAllExpiries(false);
    setSplitRequired(true);
    setSplitMethod('Quantity');
    setAccounts([{ name: 'H&L', qty: 0 }, { name: 'Richa', qty: 0 }]);
    setNotice('');
  }

  function addExpiry() {
    const inputs = expiryInput.split(/[,;\s]+/).map((value) => value.trim()).filter(Boolean);
    const normalized = inputs.map(normalizeSetupExpiry);
    if (!normalized.length || normalized.some((expiry) => !isValidSetupExpiry(expiry))) {
      setNotice('Enter expiry as DDMMYY, DDMMYYYY, DDMMMYY or DDMMMYYYY. Multiple expiries can be comma-separated.');
      return;
    }
    setExpiries((current) => Array.from(new Set([...current, ...normalized])));
    setExpiryInput('');
    setNotice('');
  }

  function updateAccountPercentage(index: number, rawValue: string) {
    const percentage = Math.max(0, Math.min(100, Number(rawValue) || 0));
    const selectedQty = Math.round(totalQty * percentage / 100);
    const otherQty = totalQty - selectedQty;
    const nextAccounts = accounts.map((account, accountIndex) => ({
      ...account,
      qty: accountIndex === index ? selectedQty : otherQty,
    }));
    setAccounts(nextAccounts);
  }

  function updateAccountQuantity(index: number, rawValue: string) {
    const selectedQty = Math.max(0, Math.min(totalQty, Number(rawValue) || 0));
    const otherQty = totalQty - selectedQty;
    setAccounts((current) => current.map((account, accountIndex) => ({
      ...account,
      qty: accountIndex === index ? selectedQty : accountIndex === (index === 0 ? 1 : 0) ? otherQty : account.qty,
    })));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typedExpiries = expiryInput.split(/[,;\s]+/).map((value) => value.trim()).filter(Boolean).map(normalizeSetupExpiry);
    if (typedExpiries.some((expiry) => !isValidSetupExpiry(expiry))) {
      setNotice('Enter expiry as DDMMYY, DDMMYYYY, DDMMMYY or DDMMMYYYY.');
      return;
    }
    const selectedExpiries = allExpiries ? knownExpiries : Array.from(new Set([...expiries, ...typedExpiries]));
    if (!name.trim() || !selectedExpiries.length || !totalQty) {
      setNotice('Strategy name, expiry and quantity are required.');
      return;
    }
    if (splitRequired && Math.abs(allocatedQty - totalQty) > 1e-6) {
      setNotice('Account allocations must equal the strategy quantity.');
      return;
    }
    const payload: StrategySetupPayload = {
      mappingId: activeMode === 'edit' ? Number(selectedId) : null,
      originalStrategyName: activeMode === 'edit' ? items.find((item) => String(item.mappingId) === selectedId)?.name : undefined,
      strategyName: name.trim(),
      expiries: selectedExpiries,
      instrument,
      parentQty: totalQty,
      splitRequired,
      splitMethod,
      accounts: splitRequired ? accounts.map((account) => ({ name: account.name, qty: Number(account.qty) || 0 })) : [],
    };
    try {
      setSaving(true);
      const result = await saveStrategySetup(payload);
      setNotice(result.message);
      await onSaved();
      window.setTimeout(onClose, 250);
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : 'Unable to save strategy.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="strategy-setup-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="strategy-setup-modal" role="dialog" aria-modal="true" aria-labelledby="strategy-setup-title">
        <form onSubmit={submit}>
          <header className="strategy-setup-head">
            <div className="strategy-setup-brand"><ShieldCheck size={24} /></div>
            <div>
              <h2 id="strategy-setup-title">{activeMode === 'edit' ? 'Edit Strategy' : 'Create Strategy'}</h2>
            </div>
            <button type="button" className="strategy-setup-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
          </header>

          {activeMode === 'edit' && <div className="strategy-setup-edit-picker"><label>Saved strategy<select value={selectedId} onChange={(event) => { const item = items.find((candidate) => String(candidate.mappingId) === event.target.value); if (item) loadItem(item); }}><option value="">Select strategy</option>{items.map((item) => <option key={item.mappingId} value={item.mappingId}>{item.name} · {item.instrument}</option>)}</select></label><button type="button" onClick={resetCreate}>Create new</button></div>}

          <section className="strategy-setup-section">
            <div className="strategy-setup-section-title"><h3>Strategy Details</h3></div>
            <div className="strategy-setup-details-grid">
              <label>Strategy Name *<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter strategy name" required /></label>
              <div className="strategy-setup-field"><span>Expiry *</span>{context?.expiry ? <div className="strategy-setup-expiry strategy-setup-fixed-expiry"><span className="strategy-setup-chip">{formatSetupExpiry(context.expiry)}</span></div> : <div className="strategy-setup-expiry"><label className="strategy-setup-check"><input type="checkbox" checked={allExpiries} onChange={(event) => setAllExpiries(event.target.checked)} /> All Expiries</label><div className="strategy-setup-chip-row">{expiries.map((expiry) => <button type="button" key={expiry} className="strategy-setup-chip" onClick={() => setExpiries((current) => current.filter((item) => item !== expiry))}>{formatSetupExpiry(expiry)} ×</button>)}</div><div className="strategy-setup-add-expiry"><input value={expiryInput} onChange={(event) => setExpiryInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addExpiry(); } }} placeholder="" /><button type="button" onClick={addExpiry}>+ Add Expiry</button></div></div>}</div>
              <fieldset><legend>Instrument *</legend><div className="strategy-setup-radio-row">{['NIFTY', 'BANKNIFTY'].map((value) => <label key={value} className={`strategy-setup-radio ${instrument === value ? 'selected' : ''}`}><input type="radio" name="instrument" value={value} checked={instrument === value} onChange={(event) => setInstrument(event.target.value)} />{value}</label>)}</div></fieldset>
            </div>
          </section>

          <section className="strategy-setup-section strategy-setup-account-section">
            <div className="strategy-setup-section-title"><h3>Account Allocation</h3><span className="strategy-setup-pending">Pending {pendingQty} / {totalQty || 0}</span></div>
            <div className="strategy-setup-account-layout">
              <div className="strategy-setup-controls"><fieldset><legend>Split Required *</legend><div className="strategy-setup-toggle"><button type="button" className={splitRequired ? 'selected' : ''} onClick={() => setSplitRequired(true)}>Yes</button><button type="button" className={!splitRequired ? 'selected' : ''} onClick={() => setSplitRequired(false)}>No</button></div></fieldset><label>Strategy Quantity *<input type="number" min="1" value={parentQty} onChange={(event) => setParentQty(event.target.value)} placeholder="Enter quantity" required /></label><label>Method *<select value={splitMethod} onChange={(event) => setSplitMethod(event.target.value)}><option value="Quantity">Split by Quantity</option><option value="Percentage">Split by Percentage</option></select></label><fieldset><legend>Accounts *</legend><div className="strategy-setup-account-list">{accounts.map((account, index) => <label key={index}><input type="checkbox" checked={Number(account.qty) > 0} onChange={(event) => setAccounts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, qty: event.target.checked ? (totalQty ? Math.floor(totalQty / current.length) : 0) : 0 } : item))} />{account.name}</label>)}</div></fieldset></div>
              {splitRequired && <div className="strategy-setup-cards">{accounts.map((account, index) => { const percentage = totalQty ? Math.round((Number(account.qty) / totalQty) * 100) : 0; return <div className="strategy-setup-account-card" key={index}><div className="strategy-setup-card-head"><strong>{account.name}</strong><b>{percentage}%</b></div><label>{splitMethod === 'Percentage' ? 'Percentage' : 'Qty'}<input type="number" min="0" max={splitMethod === 'Percentage' ? 100 : totalQty || undefined} step={1} value={splitMethod === 'Percentage' ? (percentage || '') : (account.qty || '')} onChange={(event) => splitMethod === 'Percentage' ? updateAccountPercentage(index, event.target.value) : updateAccountQuantity(index, event.target.value)} /></label><div className="strategy-setup-progress"><span style={{ width: `${Math.min(100, percentage)}%` }} /></div><small>Qty: {Number(account.qty) || 0}</small></div>; })}</div>}
            </div>
          </section>

          {notice && <div className="strategy-setup-notice">{notice}</div>}
          <footer className="strategy-setup-footer"><button type="button" className="strategy-setup-cancel" onClick={onClose}>Cancel</button><button type="submit" className="strategy-setup-save" disabled={saving}>{saving ? 'Saving...' : activeMode === 'edit' ? 'Update Strategy' : 'Create Strategy'}</button></footer>
        </form>
      </section>
    </div>
  );
}

function Sidebar({ onStrategySetup }: { onStrategySetup: () => void }) {
  return (
    <aside className="alloc-sidebar">
      <div className="alloc-brand">
        <div className="alloc-brand-mark">M</div>
        <div className="alloc-brand-copy">
          <strong>Matalia SL</strong>
          <small>Trade Accounting OS</small>
        </div>
      </div>
      {groups.map(([title, items]) => (
        <div className="alloc-nav-section" key={title}>
          <div className="alloc-nav-label">{title}</div>
          {items.map(([label, Icon]) => (
            <button className={`alloc-nav-item ${label === '04 Strategy Allocation' ? 'active' : ''}`} key={label} onClick={label === 'Strategies' ? onStrategySetup : undefined}>
              <span className="alloc-nav-icon">
                <Icon size={16} />
              </span>
              {label}
            </button>
          ))}
        </div>
      ))}
      <div className="alloc-status">
        <button type="button" className="sidebar-logout" onClick={() => void signOut()}><LogOut size={13} /> Logout</button>
      </div>
    </aside>
  );
}

function Stat({ tone, icon, label, value, detail, onClick, active = false }: { tone: string; icon: ReactNode; label: string; value: string; detail?: string; onClick?: () => void; active?: boolean }) {
  const content = (
    <>
      <div className={`stat-icon ${tone}`}>{icon}</div>
      <div>
        <div className="stat-label">{label}</div>
        <strong className={tone === 'red' ? 'red-text' : tone === 'green' ? 'green-text' : ''}>{value}</strong>
        {detail && <small className={`${tone}-text`}>{detail}</small>}
      </div>
    </>
  );
  return onClick ? <button type="button" className={`alloc-stat alloc-stat-clickable${active ? ' active' : ''}`} onClick={onClick} aria-pressed={active}>{content}</button> : <div className="alloc-stat">{content}</div>;
}

function mapAllocationRows(rows: StrategyAllocationRow[]): Trade[] {
  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    time: row.time,
    instrument: row.scrip,
    expiry: row.expiry,
    strike: row.strike,
    tradeType: row.side,
    optionType: row.optType,
    qty: String(row.qty),
    avg: Number.isFinite(row.price) ? row.price.toFixed(2) : String(row.price),
    order: row.tradeId,
    source: row.source,
    strategy: row.strategy,
    allocated: row.bucket === 'Open',
    bucket: row.bucket,
    splitTradeId: row.splitTradeId,
  }));
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

function normalizeSearchValue(value: string) {
  return value.trim().toLowerCase().replace(/:/g, '.').replace(/\s+/g, ' ');
}

function normalizeNumericSearchValue(value: string) {
  const normalized = value.replace(/,/g, '').trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? String(number) : normalized;
}

function matchesNumericSearch(value: string, query: string) {
  const digits = normalizeNumericSearchValue(value).replace(/\D/g, '');
  const queryDigits = query.replace(/\D/g, '');
  if (!queryDigits) return false;

  // Match a typed numeric prefix (130 → 130 and 1300) or an in-order digit
  // sequence (770 → 57700) without letting text columns affect results.
  if (digits.startsWith(queryDigits)) return true;
  let queryIndex = 0;
  for (const digit of digits) {
    if (digit === queryDigits[queryIndex]) queryIndex += 1;
    if (queryIndex === queryDigits.length) return true;
  }
  return false;
}

const SORTABLE_HEADERS: Array<{ key: SortKey; label: string }> = [
  { key: 'date', label: 'Date' },
  { key: 'time', label: 'Time' },
  { key: 'instrument', label: 'Instrument' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'strike', label: 'Strike' },
  { key: 'tradeType', label: 'Trade' },
  { key: 'optionType', label: 'Option' },
  { key: 'qty', label: 'Qty' },
  { key: 'avg', label: 'Avg Price' },
  { key: 'strategy', label: 'Strategy' },
];

const STRATEGY_FAMILY_BADGES = [
  { match: 'BANKNIFTY FING', tone: 'purple', icon: FileChartColumn },
  { match: 'BANKNIFTY AVWAP', tone: 'green', icon: Activity },
  { match: 'NIFTY AVWAP', tone: 'blue', icon: BarChart3 },
  { match: 'NIFTY FING', tone: 'orange', icon: Sparkles },
  { match: 'ATM EMA INTRADAY', tone: 'cyan', icon: Activity },
  { match: 'NIFTY OPT BUY', tone: 'pink', icon: SlidersHorizontal },
  { match: 'NIFTY EXPIRY TRADES', tone: 'yellow', icon: History },
];

function strategyBadgePattern(strategy: string) {
  const normalized = strategy.replace(/\s+/g, ' ').trim().toUpperCase();
  const family = STRATEGY_FAMILY_BADGES.find(({ match }) => normalized.includes(match));
  return family || { tone: 'neutral', icon: BarChart3 };
}

function Table({ rows, onAllocate, onDelete, selectionMode, selectedIds, onToggle, onToggleAll, sortKey, sortDirection, onSort }: { rows: Trade[]; onAllocate: (row: Trade) => void; onDelete: (row: Trade) => void; selectionMode: boolean; selectedIds: Set<string>; onToggle: (row: Trade) => void; onToggleAll: (checked: boolean) => void; sortKey: SortKey; sortDirection: SortDirection; onSort: (key: SortKey) => void }) {
  const removableRows = rows.filter((row) => row.source === 'strategy_open');
  const selectedRemovableCount = removableRows.filter((row) => selectedIds.has(row.id)).length;
  return (
    <div className="alloc-table-wrap">
      <table className={`alloc-table${selectionMode ? ' selection-mode' : ''}`}>
        <thead>
          <tr>
            {selectionMode && <th className="alloc-select-column"><input type="checkbox" checked={removableRows.length > 0 && selectedRemovableCount === removableRows.length} onChange={(event) => onToggleAll(event.target.checked)} aria-label="Select all trades for removal" /></th>}
            {SORTABLE_HEADERS.map(({ key, label }) => (
              <th key={key} aria-sort={sortKey === key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="table-sort-button" onClick={() => onSort(key)} title={`Sort ${label}`}>
                  {label}<ArrowUpDown size={12} className={sortKey === key ? 'active' : ''} />
                </button>
              </th>
            ))}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {selectionMode && <td className="alloc-select-column"><input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => onToggle(row)} disabled={row.source !== 'strategy_open'} aria-label={`Select trade ${row.order} for removal`} /></td>}
              <td className="alloc-date-cell">{formatDisplayDate(row.date)}</td>
              <td>{formatDisplayTime(row.time)}</td>
              <td className="instrument">{row.instrument}</td>
              <td>{row.expiry}</td>
              <td>{row.strike}</td>
              <td>
                <span className={`alloc-trade-badge ${row.tradeType.toLowerCase()}`}>{row.tradeType}</span>
              </td>
              <td>
                <span className={`alloc-option-badge ${row.optionType.toLowerCase()}`}>{row.optionType}</span>
              </td>
              <td>{row.qty}</td>
              <td>{row.avg}</td>
              <td className="strategy-cell">
                {(() => {
                  const strategy = row.strategy || '—';
                  const pattern = strategyBadgePattern(strategy);
                  const Icon = pattern.icon;
                  return (
                    <button className={`strategy-cell-button strategy-color-badge ${pattern.tone}`} type="button" onClick={() => onAllocate(row)} aria-label={`Allocate ${strategy} for trade ${row.order}`} title="Allocate trade">
                      <Icon size={14} aria-hidden="true" />
                      <span>{strategy}</span>
                    </button>
                  );
                })()}
              </td>
              <td>
                <button className="alloc-delete-button" type="button" onClick={() => onDelete(row)} disabled={row.source !== 'strategy_open'} aria-label={`Remove trade ${row.order}`} title={row.source === 'strategy_open' ? 'Remove trade' : 'This trade has not been allocated yet'}>
                  <Trash2 size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatVerificationTime(value: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).replace(':', '.').toUpperCase();
}

export function ThemeSelect({ label, value, options, onChange, groupKey, activeKey, onToggle }: { label: string; value: string; options: string[]; onChange: (value: string) => void; groupKey?: string; activeKey?: string | null; onToggle?: (key: string | null) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const controlled = groupKey !== undefined && activeKey !== undefined && onToggle !== undefined;
  const isOpen = controlled ? activeKey === groupKey : open;

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        if (controlled) onToggle?.(null);
        else setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [controlled, onToggle]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (controlled) onToggle?.(null);
        else setOpen(false);
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [controlled, onToggle]);

  const displayValue = value || 'All';
  return <div className="theme-select" ref={rootRef}>
    <button type="button" className={`theme-select-trigger${isOpen ? ' open' : ''}`} onClick={() => { if (controlled) onToggle?.(isOpen ? null : groupKey!); else setOpen((current) => !current); }} aria-label={label} aria-haspopup="listbox" aria-expanded={isOpen}>
      <span>{displayValue}</span>
      <ChevronDown size={14} />
    </button>
    {isOpen && <div className="theme-select-menu" role="listbox" aria-label={`${label} options`}>
      {options.map((option) => <button type="button" role="option" aria-selected={option === value} className={`theme-select-option${option === value ? ' selected' : ''}`} key={option || 'all'} onClick={() => { onChange(option); if (controlled) onToggle?.(null); else setOpen(false); }}>
        <span>{option || 'All'}</span>
        {option === value && <CheckCircle2 size={13} />}
      </button>)}
    </div>}
  </div>;
}

const EMPTY_TABLE_FILTERS: TableFilters = { date: '', instrument: '', expiry: '', tradeType: '', optionType: '', strategy: '' };

const DATE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeTypedDate(value: string) {
  const input = value.trim().replace(/[/.]/g, '-').replace(/\s+/g, '-');
  if (!input) return '';
  let day = 0;
  let month = 0;
  let year = 0;
  let match = input.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = input.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2}|\d{4})$/);
    if (!match) return '';
    day = Number(match[1]);
    month = DATE_MONTHS.findIndex((name) => name.toLowerCase() === match![2].slice(0, 3).toLowerCase()) + 1;
    year = Number(match[3]);
    if (year < 100) year += 2000;
  }
  if (!month || !day || !year) return '';
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return '';
  return formatDisplayDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

function dateFilterVariants(value: string) {
  const display = formatDisplayDate(value);
  const [day, month] = display.split('-');
  const monthNumber = DATE_MONTHS.indexOf(month) + 1;
  const monthToken = monthNumber > 0 ? String(monthNumber).padStart(2, '0') : month;
  // Keep partial matching focused on the day/month. Including the ISO year
  // here would make typing "20" match every 2026 date.
  return [display, `${day}-${month}`, `${day}-${monthToken}`, `${day}/${monthToken}`];
}

function matchesTableFilter(row: Trade, filters: TableFilters, omit?: keyof TableFilters) {
  const normalizedDate = normalizeTypedDate(filters.date) || filters.date;
  const matchesDate = !filters.date || omit === 'date' || dateFilterVariants(row.date).some((value) => normalizeSearchValue(value).includes(normalizeSearchValue(normalizedDate)));
  const matchesInstrument = !filters.instrument || omit === 'instrument' || row.instrument === filters.instrument;
  const matchesExpiry = !filters.expiry || omit === 'expiry' || normalizeSearchValue(row.expiry).includes(normalizeSearchValue(filters.expiry));
  const matchesTrade = !filters.tradeType || omit === 'tradeType' || row.tradeType === filters.tradeType;
  const matchesOption = !filters.optionType || omit === 'optionType' || row.optionType === filters.optionType;
  const matchesStrategy = !filters.strategy || omit === 'strategy' || normalizeSearchValue(row.strategy).includes(normalizeSearchValue(filters.strategy));
  return matchesDate && matchesInstrument && matchesExpiry && matchesTrade && matchesOption && matchesStrategy;
}

function Section({ title, rows, onAllocate, onDelete, onDeleteMany }: { title: string; rows: Trade[]; onAllocate: (row: Trade) => void; onDelete: (row: Trade) => void; onDeleteMany: (rows: Trade[]) => void }) {
  const [query, setQuery] = useState(() => window.sessionStorage.getItem('strategy-allocation-search') ?? '');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [showFilters, setShowFilters] = useState(false);
  const [showDateSuggestions, setShowDateSuggestions] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<TableFilters>(() => {
    try {
      const saved = window.sessionStorage.getItem('strategy-allocation-filters');
      return saved ? { ...EMPTY_TABLE_FILTERS, ...JSON.parse(saved) as Partial<TableFilters> } : EMPTY_TABLE_FILTERS;
    } catch {
      return EMPTY_TABLE_FILTERS;
    }
  });

  const filterOptions = useMemo(() => ({
    dates: Array.from(new Set(rows.filter((row) => matchesTableFilter(row, filters, 'date')).map((row) => formatDisplayDate(row.date)).filter(Boolean))).sort(),
    instruments: Array.from(new Set(rows.filter((row) => matchesTableFilter(row, filters, 'instrument')).map((row) => row.instrument).filter(Boolean))).sort(),
    expiries: Array.from(new Set(rows.filter((row) => matchesTableFilter(row, filters, 'expiry')).map((row) => row.expiry).filter(Boolean))).sort(),
    tradeTypes: Array.from(new Set(rows.filter((row) => matchesTableFilter(row, filters, 'tradeType')).map((row) => row.tradeType).filter(Boolean))).sort(),
    optionTypes: Array.from(new Set(rows.filter((row) => matchesTableFilter(row, filters, 'optionType')).map((row) => row.optionType).filter(Boolean))).sort(),
    strategies: Array.from(new Set(rows.filter((row) => matchesTableFilter(row, filters, 'strategy')).map((row) => row.strategy).filter(Boolean))).sort(),
  }), [filters, rows]);

  function updateFilter(key: keyof TableFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function updateDateFilter(value: string) {
    updateFilter('date', normalizeTypedDate(value) || value);
    setShowDateSuggestions(true);
  }

  const dateSuggestions = useMemo(() => {
    const query = normalizeSearchValue(filters.date);
    return filterOptions.dates.filter((value) => !query || dateFilterVariants(value).some((variant) => normalizeSearchValue(variant).includes(query))).slice(0, 8);
  }, [filterOptions.dates, filters.date]);

  function sortValue(row: Trade, key: SortKey) {
    if (key === 'date') return Date.parse(row.date) || row.date.localeCompare('');
    if (key === 'time') return formatDisplayTime(row.time);
    if (key === 'strike' || key === 'qty' || key === 'avg') return Number(String(row[key]).replace(/,/g, '')) || 0;
    return String(row[key] ?? '').toLowerCase();
  }

  const filtered = useMemo(() => {
    const normalizedQuery = normalizeSearchValue(query);
    let filteredRows = rows;

    filteredRows = filteredRows.filter((row) => matchesTableFilter(row, filters));

    if (!normalizedQuery) {
      return [...filteredRows].sort((a, b) => {
        const left = sortValue(a, sortKey);
        const right = sortValue(b, sortKey);
        const comparison = left < right ? -1 : left > right ? 1 : 0;
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }

    const numericQuery = normalizeNumericSearchValue(normalizedQuery);
    const isNumericQuery = /^\d+(?:\.\d+)?$/.test(normalizedQuery.replace(/,/g, ''));

    if (isNumericQuery) {
      filteredRows = filteredRows.filter((row) =>
        [row.strike, row.qty, row.avg].some((field) => matchesNumericSearch(String(field), numericQuery)),
      );
    } else {
      filteredRows = filteredRows.filter((row) => {
      const exactFields = [
        formatDisplayDate(row.date),
        row.instrument,
        row.expiry,
        row.tradeType,
        row.optionType,
        formatDisplayTime(row.time),
        row.strategy,
      ];

      if (exactFields.some((field) => normalizeSearchValue(field) === normalizedQuery)) return true;

      const searchableText = normalizeSearchValue([
        formatDisplayDate(row.date),
        formatDisplayTime(row.time),
        row.instrument,
        row.expiry,
        row.strike,
        row.tradeType,
        row.optionType,
        row.qty,
        row.avg,
        row.strategy,
        row.order,
        row.source,
      ].join(' '));
      return normalizedQuery.split(' ').every((token) => searchableText.includes(token));
      });
    }
    return [...filteredRows].sort((a, b) => {
      const left = sortValue(a, sortKey);
      const right = sortValue(b, sortKey);
      const comparison = left < right ? -1 : left > right ? 1 : 0;
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filters, query, rows, sortDirection, sortKey]);

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, (safePage - 1) * pageSize + pageSize);
  const selectedRows = rows.filter((row) => selectedIds.has(row.id) && row.source === 'strategy_open');

  useEffect(() => {
    setPage(1);
  }, [rows]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    const validIds = new Set(rows.filter((row) => row.source === 'strategy_open').map((row) => row.id));
    setSelectedIds((current) => new Set(Array.from(current).filter((id) => validIds.has(id))));
  }, [rows]);

  useEffect(() => {
    setPage(1);
  }, [filters, pageSize, query, sortDirection, sortKey]);

  useEffect(() => {
    window.sessionStorage.setItem('strategy-allocation-search', query);
  }, [query]);

  useEffect(() => {
    window.sessionStorage.setItem('strategy-allocation-filters', JSON.stringify(filters));
  }, [filters]);

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  function onSort(key: SortKey) {
    if (sortKey === key) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  }

  function toggleSelected(row: Trade) {
    if (row.source !== 'strategy_open') return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(pageRows.filter((row) => row.source === 'strategy_open').map((row) => row.id)) : new Set());
  }

  function toggleSelectionMode() {
    setSelectionMode((current) => {
      if (current) setSelectedIds(new Set());
      return !current;
    });
  }

  return (
    <section className="alloc-card">
      <div className="alloc-card-head">
        <div>
          <h2>{title}</h2>
          <p>{totalCount} record{totalCount === 1 ? '' : 's'}</p>
        </div>
        <div className="table-tools">
          <label className="table-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search trades..." />
            {query && <button type="button" className="table-search-clear-button" onMouseDown={(event) => event.preventDefault()} onClick={() => setQuery('')} aria-label="Clear search" title="Clear search"><X size={14} /></button>}
          </label>
          {selectedRows.length > 0 && <button type="button" className="table-bulk-remove" onClick={() => { onDeleteMany(selectedRows); setSelectedIds(new Set()); }}><Trash2 size={14} /> Remove selected ({selectedRows.length})</button>}
          <button type="button" className={`table-select-button${selectionMode ? ' active' : ''}`} onClick={toggleSelectionMode} aria-pressed={selectionMode} aria-label={selectionMode ? 'Exit trade removal selection mode' : 'Select trades for removal'} title={selectionMode ? 'Exit selection mode' : 'Select trades for removal'}>
            <CheckSquare size={16} />
          </button>
          <button type="button" className={`table-filter-button${showFilters || activeFilterCount ? ' active' : ''}`} onClick={() => setShowFilters((current) => !current)}>
            <Filter size={14} /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </button>
        </div>
      </div>
      {showFilters && <div className="table-filter-panel">
        <label className="table-filter-date">Date<div className="table-filter-date-controls"><Calendar value={filters.date ? parseCalendarDisplayDate(filters.date) : ''} onChange={(value) => { updateFilter('date', value ? formatDisplayDate(value) : ''); setShowDateSuggestions(false); }} placeholder="Any date" allowClear allowedDates={filterOptions.dates.map(parseCalendarDisplayDate)} /><input value={filters.date} onChange={(event) => updateDateFilter(event.target.value)} onFocus={() => setShowDateSuggestions(true)} onBlur={() => window.setTimeout(() => setShowDateSuggestions(false), 120)} placeholder="Type date" aria-label="Type date" aria-autocomplete="list" aria-expanded={showDateSuggestions && dateSuggestions.length > 0} />{showDateSuggestions && dateSuggestions.length > 0 && <div className="table-filter-date-suggestions" role="listbox">{dateSuggestions.map((value) => <button type="button" role="option" key={value} onMouseDown={(event) => { event.preventDefault(); updateFilter('date', value); setShowDateSuggestions(false); }}>{value}</button>)}</div>}</div></label>
        <div className="table-filter-field"><span>Instrument</span><ThemeSelect label="Instrument" value={filters.instrument} options={['', ...filterOptions.instruments]} onChange={(value) => updateFilter('instrument', value)} /></div>
        <div className="table-filter-field"><span>Expiry</span><ThemeSelect label="Expiry" value={filters.expiry} options={['', ...filterOptions.expiries]} onChange={(value) => updateFilter('expiry', value)} /></div>
        <div className="table-filter-field"><span>Trade</span><ThemeSelect label="Trade" value={filters.tradeType} options={['', ...filterOptions.tradeTypes]} onChange={(value) => updateFilter('tradeType', value)} /></div>
        <div className="table-filter-field"><span>Option</span><ThemeSelect label="Option" value={filters.optionType} options={['', ...filterOptions.optionTypes]} onChange={(value) => updateFilter('optionType', value)} /></div>
        <div className="table-filter-field"><span>Strategy</span><ThemeSelect label="Strategy" value={filters.strategy} options={['', ...filterOptions.strategies]} onChange={(value) => updateFilter('strategy', value)} /></div>
        <button type="button" className="table-filter-clear" onClick={() => setFilters(EMPTY_TABLE_FILTERS)} aria-label="Clear filters" title="Clear filters"><X size={14} /></button>
      </div>}
      <Table rows={pageRows} onAllocate={onAllocate} onDelete={onDelete} selectionMode={selectionMode} selectedIds={selectedIds} onToggle={toggleSelected} onToggleAll={toggleAll} sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} />
      <div className="table-footer">
        <span>
          Showing {(safePage - 1) * pageSize + (pageRows.length ? 1 : 0)} to {(safePage - 1) * pageSize + pageRows.length} of {totalCount} trades
        </span>
        <div className="pagination">
          <button disabled={safePage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            <ChevronLeft size={15} />
          </button>
          <button className="current">{safePage}</button>
          <button disabled={safePage === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
            <ChevronRight size={15} />
          </button>
          <label className="page-size">
            <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
              <option value={10}>10 / page</option>
              <option value={15}>15 / page</option>
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
            </select>
            <ChevronDown size={14} />
          </label>
        </div>
      </div>
    </section>
  );
}

export function StrategyAllocation() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(() => {
    const queryDate = new URLSearchParams(window.location.search).get('date');
    return queryDate ? formatDisplayDate(queryDate) : 'All Dates';
  });
  const [notice, setNotice] = useState('');
  const [removeConfirmRows, setRemoveConfirmRows] = useState<Trade[]>([]);
  const [deletingTrade, setDeletingTrade] = useState(false);
  // Render the page shell immediately; allocation data arrives in the background.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<Trade[]>([]);
  const [strategyMasterRows, setStrategyMasterRows] = useState<StrategyMasterRow[]>([]);
  const [strategySetupOpen, setStrategySetupOpen] = useState(false);
  const [pipelineLog, setPipelineLog] = useState<PipelineLogResponse | null>(null);
  const [showProcessLog, setShowProcessLog] = useState(false);
  const [showTradeDataPlan, setShowTradeDataPlan] = useState(false);
  const [showPipelineCard, setShowPipelineCard] = useState(false);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState('');
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>('all');
  const [syncStatus, setSyncStatus] = useState<'checking' | 'verified' | 'mismatch' | 'idle'>('checking');
  const [syncCheckedAt, setSyncCheckedAt] = useState('');
  const [counts, setCounts] = useState({
    'Open Trades': 0,
    'Unassigned Trades': 0,
    'Allocated Trades': 0,
    Strategies: 0,
  });

  function countsAreVerified(data: Awaited<ReturnType<typeof loadStrategyAllocation>>) {
    return data.verification?.counts_match
      ?? ((data.rows?.length ?? 0) === ((data.counts?.['Open Trades'] ?? 0) + (data.counts?.['Unassigned Trades'] ?? 0)));
  }

  useEffect(() => {
    let cancelled = false;

    let allocationArrived = false;

    // Start with the cached/normal request. The callback renders allocation
    // rows as soon as the primary request completes; master/version metadata
    // remains in the same preload but is not allowed to delay the table.
    preloadStrategyAllocation(false, (allocation) => {
        allocationArrived = true;
        if (cancelled) return;
        setRows(mapAllocationRows(allocation.rows ?? []));
        setCounts(allocation.counts);
        setSyncStatus(countsAreVerified(allocation) ? 'verified' : 'mismatch');
        setSyncCheckedAt(allocation.verification?.checked_at ?? '');
        setLoading(false);
      })
      .then(({ allocation, master }) => {
        if (cancelled) return;
        setStrategyMasterRows(master.rows ?? []);
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        // A secondary preload failure must not erase rows that are already
        // visible. Only show an error when the primary request failed too.
        if (allocationArrived) return;
        setError(loadError instanceof Error ? loadError.message : 'Unable to load allocation data');
        setRows([]);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (!active || refreshing) return;
      refreshing = true;
      setSyncStatus('checking');
      revalidateStrategyAllocationSnapshot().then(({ allocation, master }) => {
        if (!active) return;
        setRows(mapAllocationRows(allocation.rows ?? []));
        setCounts(allocation.counts);
        setStrategyMasterRows(master.rows ?? []);
        setSyncStatus(countsAreVerified(allocation) ? 'verified' : 'mismatch');
        setSyncCheckedAt(allocation.verification?.checked_at ?? '');
      }).catch(() => undefined).finally(() => { refreshing = false; });
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  function applyAllocationData(data: Awaited<ReturnType<typeof loadStrategyAllocation>>, master: StrategyMasterRow[]) {
    setRows(mapAllocationRows(data.rows ?? []));
    setCounts(data.counts);
    setStrategyMasterRows(master);
    setSyncStatus(countsAreVerified(data) ? 'verified' : 'mismatch');
    setSyncCheckedAt(data.verification?.checked_at ?? '');
  }

  async function refreshAllocationWithVerification() {
    let latest: Awaited<ReturnType<typeof loadStrategyAllocation>> | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await preloadStrategyAllocation(true);
      const allocationData = snapshot.allocation;
      latest = allocationData;
      applyAllocationData(allocationData, snapshot.master.rows ?? []);
      if (allocationData.verification?.counts_match) return allocationData;
      if (attempt < 4) await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    return latest;
  }

  useEffect(() => {
    let active = true;
    let refreshingLog = false;
    const refreshLog = async () => {
      if (refreshingLog) return;
      refreshingLog = true;
      try {
        const data = await loadImportPipelineLog();
        if (active) setPipelineLog(data);
      } catch {
        if (active) setPipelineLog(null);
      } finally {
        refreshingLog = false;
      }
    };
    refreshLog().catch(() => undefined);
    const timer = window.setInterval(refreshLog, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function startImportPipeline() {
    setShowPipelineCard(true);
    setPipelineLoading(true);
    setPipelineError('');
    setPipelineLog(null);
    try {
      const result = await runImportPipeline();
      if (result.success) {
        const allocationData = await refreshAllocationWithVerification();
        if (allocationData?.verification?.counts_match) {
          setPipelineError('');
          action(`Success — ${result.message ?? 'Pipeline completed successfully'}. Supabase data is updated and counts are verified.`);
        } else {
          setPipelineError('Pipeline completed, but the Supabase counts are still syncing. The page will keep checking in the background.');
          action('Pipeline completed. Supabase count verification is still pending.');
        }
      } else {
        const failureMessage = result.error || result.message || `Pipeline failed${result.failed_step ? ` at ${result.failed_step}` : ''}`;
        setPipelineError(failureMessage);
        action(failureMessage);
      }
    } catch (runError: unknown) {
      const message = runError instanceof Error ? runError.message : 'Pipeline failed';
      setPipelineError(message);
      action(message);
    } finally {
      setPipelineLoading(false);
    }
  }

  function openTradeFilePicker() {
    if (pipelineBusy) return;
    const input = inputRef.current;
    if (!input) return;
    try {
      const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
      if (pickerInput.showPicker) pickerInput.showPicker();
      else input.click();
    } catch {
      input.click();
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!selected.length) return;
    setShowPipelineCard(true);
    setPipelineLoading(true);
    setPipelineError('Uploading selected file(s)…');
    setPipelineLog(null);
    try {
      await uploadImportFiles(selected);
      await startImportPipeline();
    } catch (fileError: unknown) {
      const message = fileError instanceof Error ? fileError.message : 'Unable to select TXT file';
      setPipelineLoading(false);
      setPipelineError(message);
      action(message);
    }
  }


  const dateOptions = useMemo(
    () => ['All Dates', ...Array.from(new Set(rows.map((row) => formatDisplayDate(row.date)).filter(Boolean))).sort()],
    [rows],
  );

  const visibleTrades = useMemo(() => rows.filter((row) => date === 'All Dates' || formatDisplayDate(row.date) === date), [date, rows]);

  const combinedVisible = useMemo(() => visibleTrades.filter((row) => row.bucket === 'Open' || row.bucket === 'Unassigned'), [visibleTrades]);
  const bucketVisible = useMemo(() => combinedVisible.filter((row) => bucketFilter === 'all' || (bucketFilter === 'allocated' ? row.bucket === 'Open' : row.bucket === 'Unassigned')), [bucketFilter, combinedVisible]);
  const syncTimeLabel = formatVerificationTime(syncCheckedAt);
  const pipelineBusy = pipelineLoading || Boolean(pipelineLog?.running);
  const failedPipelineFiles = pipelineLog?.failed_files?.length
    ? pipelineLog.failed_files
    : (pipelineLog?.files ?? []).filter((file) => file.status === 'failed');
  const pipelineFailureReason = pipelineError || pipelineLog?.error || pipelineLog?.message || 'The import could not be completed.';

  function action(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2600);
  }

  async function deleteAllocatedTrade(row: Trade) {
    setRemoveConfirmRows([row]);
  }

  async function confirmRemoveAllocatedTrades() {
    if (!removeConfirmRows.length) return;
    setDeletingTrade(true);
    try {
      const failures: string[] = [];
      let removedCount = 0;
      for (const row of removeConfirmRows) {
        try {
          await deleteTradeBookTrade(row.order);
          removedCount += 1;
        } catch (removeError: unknown) {
          failures.push(`${row.order}: ${removeError instanceof Error ? removeError.message : 'Unknown error'}`);
        }
      }
      const { allocation: allocationData, master: masterData } = await preloadStrategyAllocation(true);
      setRows(mapAllocationRows(allocationData.rows ?? []));
      setCounts(allocationData.counts);
      setStrategyMasterRows(masterData.rows ?? []);
      action(failures.length ? `${removedCount} removed. Failed: ${failures.join(' · ')}` : `${removedCount} trade${removedCount === 1 ? '' : 's'} removed.`);
    } catch (deleteError: unknown) {
      action(deleteError instanceof Error ? deleteError.message : 'Unable to remove trade');
    } finally {
      setDeletingTrade(false);
      setRemoveConfirmRows([]);
    }
  }

  return (
    <div className={`alloc-shell ${deletingTrade ? 'delete-in-progress' : ''}`}>
      <Sidebar onStrategySetup={() => setStrategySetupOpen(true)} />
      <main className="alloc-main">
        <header className="alloc-header">
          <div>
            <div className="alloc-eyebrow">PIPELINE / 04</div>
            <h1>04 Strategy Allocation</h1>
            <p>Allocate strategy to open trades and track performance</p>
          </div>
          <input ref={inputRef} className="trade-file-input" type="file" accept=".txt,text/plain" multiple onChange={handleImportFile} />
          <div className="alloc-header-actions">
            <div className={`supabase-sync-status ${syncStatus}`} role="status" title={`Supabase count verification: ${syncStatus}`}>
              {syncStatus === 'checking' ? <RefreshCw className="spin" size={13} /> : syncStatus === 'verified' ? <CheckCircle2 size={13} /> : syncStatus === 'mismatch' ? <AlertCircle size={13} /> : <RefreshCw size={13} />}
              <span>{syncStatus === 'checking' ? 'Checking Supabase…' : syncStatus === 'verified' ? `Verified · ${syncTimeLabel}` : syncStatus === 'mismatch' ? 'Count mismatch — retrying' : 'Not verified'}</span>
            </div>
            <button className="allocation-page-refresh" type="button" onClick={() => window.location.reload()} aria-label="Refresh Strategy Allocation page" title="Refresh page">
              <RefreshCw size={15} />
            </button>
            <button className="btn primary strategy-trades-button" type="button" onClick={openTradeFilePicker} disabled={pipelineBusy} aria-label="Add new OrderBook Data" title={pipelineBusy ? 'An import is already running' : 'Choose TXT trade files to import'}>
              {pipelineLoading ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}
              <span>Trades</span>
            </button>
            <button
              className="trade-data-danger-button"
              type="button"
              onClick={() => setShowTradeDataPlan(true)}
              aria-label="Delete Trade Data plan"
              title="Delete Trade Data — planned"
            >
              <AlertTriangle size={17} />
            </button>
            <Calendar className="strategy-allocation-calendar" label="Trade Date" value={date === 'All Dates' ? '' : parseCalendarDisplayDate(date)} placeholder="All Dates" allowClear allowedDates={dateOptions.slice(1).map(parseCalendarDisplayDate)} onChange={(value) => setDate(value ? formatDisplayDate(value) : 'All Dates')} />
            <button className="smart-btn" onClick={() => action('Smart allocation suggestions are ready')}>
              <Sparkles size={16} />
              Smart Allocation
            </button>
          </div>
        </header>

        {showPipelineCard && (
          <div className="pipeline-card-modal-backdrop" role="presentation" onClick={() => { if (!pipelineBusy) setShowPipelineCard(false); }}>
            <section className="pipeline-card-modal" role="dialog" aria-modal="true" aria-labelledby="strategy-pipeline-card-title" onClick={(event) => event.stopPropagation()}>
              <h2 id="strategy-pipeline-card-title">Pipeline Progress</h2>
              <WorkflowTimeline
                stage={pipelineTimelineStage(pipelineLog?.stage, pipelineLog?.running || pipelineLoading)}
                status={pipelineError || pipelineLog?.stage === 'error' ? 'error' : pipelineLog?.running || pipelineLoading ? 'running' : pipelineLog?.stage === 'ready' ? 'success' : pipelineLog?.stage === 'files' ? 'files' : 'idle'}
                message={pipelineError || pipelineLog?.message}
                actions={
                  <button
                    className={`pipeline-monitor strategy-pipeline-monitor strategy-python-view ${pipelineLog?.running ? 'running' : 'idle'}`}
                    type="button"
                    onClick={() => setShowProcessLog(true)}
                    aria-label="View Python backend process log"
                    title="View Python backend log"
                  >
                    <span className="pipeline-monitor-icon"><span className="python-view-glyph">λ</span></span>
                  </button>
                }
                onSelectFile={openTradeFilePicker}
              />
              {(pipelineLog?.stage === 'error' || pipelineError) && <div className="pipeline-failure-summary" role="alert">
                <strong>Why the import failed</strong>
                <p>{pipelineFailureReason}</p>
                {failedPipelineFiles.length > 0 ? <ul>{failedPipelineFiles.map((file) => <li key={`${file.name}-${file.date}`}><b>{file.name}</b><span>Date: {file.date || 'not found'}</span><span>{file.reason || 'File could not be processed.'}</span></li>)}</ul> : <small>No file-level details were returned. Open the process log for the exact backend output.</small>}
              </div>}
              <button className="pipeline-card-ok" type="button" disabled={pipelineBusy} onClick={() => setShowPipelineCard(false)}>{pipelineBusy ? 'Importing…' : 'Close'}</button>
            </section>
          </div>
        )}

        {showTradeDataPlan && (
          <div className="trade-data-plan-backdrop" role="presentation" onClick={() => setShowTradeDataPlan(false)}>
            <section
              className="trade-data-plan-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="trade-data-plan-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="trade-data-plan-icon"><AlertTriangle size={21} /></div>
              <h2 id="trade-data-plan-title">Delete Trade Data</h2>
              <p className="trade-data-plan-status">Planned — not implemented</p>
              <p className="trade-data-plan-purpose">
                Purpose: permanently remove trade data from all related Supabase tables.
              </p>
              <div className="trade-data-plan-section">
                <strong>Planned implementation</strong>
                <ol>
                  <li>Confirm the exact date range and trades.</li>
                  <li>Remove related allocations, positions, splits, and merges in the correct order.</li>
                  <li>Remove the original trade records from all related tables.</li>
                  <li>Verify the tables, counters, and cached views after removal.</li>
                </ol>
              </div>
              <div className="trade-data-plan-note">
                No deletion will happen from this button yet.
              </div>
              <button type="button" className="trade-data-plan-close" onClick={() => setShowTradeDataPlan(false)}>
                Close
              </button>
            </section>
          </div>
        )}

        {loading && (
          <div className="alloc-notice">
            Loading live allocation data...
          </div>
        )}

        {error && (
          <div className="alloc-notice">
            {error}
            <button onClick={() => window.location.reload()}>
              <X size={14} />
            </button>
          </div>
        )}

        {notice && (
          <div className="alloc-notice">
            {notice}
            <button onClick={() => setNotice('')}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className="alloc-stats">
          <Stat tone="blue" icon={<Users size={21} />} label="Open Trades" value={String(counts['Open Trades'])} />
          <Stat tone="red" icon={<SlidersHorizontal size={21} />} label="Unassigned Trades" value={String(counts['Unassigned Trades'])} onClick={() => setBucketFilter((current) => current === 'unassigned' ? 'all' : 'unassigned')} active={bucketFilter === 'unassigned'} />
          <Stat tone="green" icon={<Users size={21} />} label="Allocated Trades" value={String(counts['Allocated Trades'])} onClick={() => setBucketFilter((current) => current === 'allocated' ? 'all' : 'allocated')} active={bucketFilter === 'allocated'} />
          <Stat tone="green" icon={<ShieldCheck size={21} />} label="Strategies" value={String(counts.Strategies)} />
        </div>

        <Section
          title={`${bucketFilter === 'allocated' ? 'Allocated Trades' : bucketFilter === 'unassigned' ? 'Unassigned Trades' : 'Open Trades + Unassigned Trades'} (${bucketVisible.length})`}
          rows={bucketVisible}
          onAllocate={(row) => navigate(`/instrument-allocation?instrument=${encodeURIComponent(row.instrument)}&expiry=${encodeURIComponent(row.expiry)}&strike=${encodeURIComponent(row.strike)}&option=${encodeURIComponent(row.optionType)}&allocationStatus=${encodeURIComponent(row.strategy && row.strategy !== 'Unassigned' ? 'Allocated' : 'Unassigned')}${date === 'All Dates' ? '' : `&date=${encodeURIComponent(parseCalendarDisplayDate(date))}`}`)}
          onDelete={deleteAllocatedTrade}
          onDeleteMany={setRemoveConfirmRows}
        />
      </main>
      {showProcessLog && (
        <div className="pipeline-log-modal-backdrop strategy-pipeline-modal-backdrop" role="presentation" onClick={() => setShowProcessLog(false)}>
          <section className={`pipeline-log-panel strategy-pipeline-log-modal ${pipelineLog?.running ? 'running' : 'idle'}`} role="dialog" aria-modal="true" aria-labelledby="strategy-process-monitor-title" onClick={(event) => event.stopPropagation()}>
            <div className="pipeline-log-head">
              <div>
                <div className="section-eyebrow">PYTHON BACKEND</div>
                <h2 id="strategy-process-monitor-title">Process Monitor</h2>
              </div>
              <button className="pipeline-log-close" type="button" onClick={() => setShowProcessLog(false)} aria-label="Close process monitor">×</button>
              <div className={`pipeline-log-status ${pipelineLog?.running ? 'running' : pipelineLog?.stage === 'error' || pipelineError ? 'error' : 'idle'}`}>
                {pipelineLog?.running ? <Activity size={14} /> : pipelineLog?.stage === 'error' || pipelineError ? <X size={14} /> : <Activity size={14} />}
                {pipelineLog?.running ? 'Live output' : pipelineLog?.stage === 'error' || pipelineError ? 'Failed' : 'Latest snapshot'}
              </div>
            </div>
            <div className="pipeline-log-meta">
              <span>Stage: {pipelineLog?.stage ?? 'idle'}</span>
              <span>Last run: {pipelineLog?.last_run_at ? new Date(pipelineLog.last_run_at).toLocaleString() : 'Not run yet'}</span>
              <span>{pipelineLog?.log_path ? pipelineLog.log_path.split(/[\\/]/).slice(-2).join('/') : 'Other Logs/Runtime/import_pipeline.log'}</span>
            </div>
            <div className="pipeline-log-stream" role="log" aria-live="polite">
              {(pipelineLog?.log ?? []).slice(-14).map((line, index) => <div className="pipeline-log-line" key={`${index}-${line}`}>{line}</div>)}
              {!pipelineLog?.log?.length && <div className="pipeline-log-empty">No log lines yet. Run the pipeline to capture backend output here.</div>}
            </div>
          </section>
        </div>
      )}
      {strategySetupOpen && <StrategySetupModal mode="create" rows={strategyMasterRows} onClose={() => setStrategySetupOpen(false)} onSaved={async () => {
        const { allocation: allocationData, master: masterData } = await preloadStrategyAllocation(true);
        setRows(mapAllocationRows(allocationData.rows ?? []));
        setCounts(allocationData.counts);
        setStrategyMasterRows(masterData.rows ?? []);
      }} />}
      {removeConfirmRows.length > 0 && (
        <div className="allocation-delete-modal-backdrop" role="presentation">
          <section className="allocation-delete-modal" role="dialog" aria-modal="true" aria-labelledby="allocation-delete-title">
            {deletingTrade ? (
              <>
                <div className="allocation-delete-spinner" aria-hidden="true" />
                <h2 id="allocation-delete-title">Removing allocation…</h2>
                <p>Please wait while the trade and related records are removed.</p>
              </>
            ) : (
              <>
                <div className="allocation-delete-icon"><Trash2 size={20} /></div>
                <h2 id="allocation-delete-title">Remove {removeConfirmRows.length === 1 ? 'allocated trade?' : `${removeConfirmRows.length} allocated trades?`}</h2>
                <p>{removeConfirmRows.length === 1 ? `Remove trade ${removeConfirmRows[0].order} and all related allocation, split, and merge records?` : 'Remove all selected trades and their related allocation, split, and merge records?'}</p>
                <div className="allocation-delete-actions">
                  <button type="button" className="allocation-delete-cancel" onClick={() => setRemoveConfirmRows([])}>Cancel</button>
                  <button type="button" className="allocation-delete-confirm" onClick={confirmRemoveAllocatedTrades}>Remove</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
