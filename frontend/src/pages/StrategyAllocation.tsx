import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { Activity, BarChart3, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, FileChartColumn, History, Loader2, Play, Search, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, Trash2, Users, UserRound, X } from 'lucide-react';
import { deleteTradeBookTrade, loadImportPipelineLog, loadStrategyAllocation, loadStrategyMaster, runImportPipeline, saveStrategySetup, uploadImportFile, type PipelineLogResponse } from '../lib/api';
import type { StrategyAllocationRow, StrategyMasterRow, StrategySetupPayload } from '../lib/api';
import { navigate } from '../lib/router';
import { WorkflowTimeline } from '../components/PipelineUI';
import Calendar from '../components/Calendar';
import type { Stage } from '../types';

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
};

const groups = [
  ['PIPELINE', [['02 Merge Trades', FileChartColumn], ['03 Split Trades', SlidersHorizontal], ['04 Strategy Allocation', Users], ['05 Trade Book', ShieldCheck]]],
  ['TRADING', [['Positions', Activity], ['Strategies', Activity], ['Orders', SlidersHorizontal], ['Watchlist', Sparkles]]],
  ['REPORTS', [['Profit and Loss Report', FileChartColumn], ['Strategy Report', BarChart3], ['Activity Log', History]]],
  ['HIDDEN', [['01 Raw Trade Import', UserRound]]],
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
        <span className="status-dot">●</span>
        <strong>System Status</strong>
        <small>All systems operational</small>
        <small>Last sync: live</small>
        <hr />
        <button>View Logs</button>
      </div>
    </aside>
  );
}

function Stat({ tone, icon, label, value, detail }: { tone: string; icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="alloc-stat">
      <div className={`stat-icon ${tone}`}>{icon}</div>
      <div>
        <div className="stat-label">{label}</div>
        <strong className={tone === 'red' ? 'red-text' : tone === 'green' ? 'green-text' : ''}>{value}</strong>
        {detail && <small className={`${tone}-text`}>{detail}</small>}
      </div>
    </div>
  );
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

function Table({ rows, onAllocate, onDelete }: { rows: Trade[]; onAllocate: (row: Trade) => void; onDelete: (row: Trade) => void }) {
  return (
    <div className="alloc-table-wrap">
      <table className="alloc-table">
        <thead>
          <tr>
            {['Date', 'Time', 'Instrument', 'Expiry', 'Strike', 'Trade', 'Option', 'Qty', 'Avg Price', 'Strategy', 'Allocation', 'Actions'].map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatDisplayDate(row.date)}</td>
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
              <td>{row.strategy || '—'}</td>
              <td>
                <button className="allocate-btn" onClick={() => onAllocate(row)}>
                  Allocate
                </button>
              </td>
              <td>
                <button className="alloc-delete-button" type="button" onClick={() => onDelete(row)} disabled={row.source !== 'strategy_open'} aria-label={`Delete trade ${row.order}`} title={row.source === 'strategy_open' ? 'Delete trade' : 'This trade has not been allocated yet'}>
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

function Section({ title, rows, onAllocate, onDelete }: { title: string; rows: Trade[]; onAllocate: (row: Trade) => void; onDelete: (row: Trade) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const filtered = useMemo(() => {
    const normalizedQuery = normalizeSearchValue(query);
    if (!normalizedQuery) return rows;

    const numericQuery = normalizeNumericSearchValue(normalizedQuery);
    const isNumericQuery = /^\d+(?:\.\d+)?$/.test(normalizedQuery.replace(/,/g, ''));

    if (isNumericQuery) {
      return rows.filter((row) =>
        [row.strike, row.qty, row.avg].some((field) => matchesNumericSearch(String(field), numericQuery)),
      );
    }

    return rows.filter((row) => {
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
  }, [query, rows]);

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, (safePage - 1) * pageSize + pageSize);

  useEffect(() => {
    setPage(1);
  }, [rows]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setPage(1);
  }, [pageSize, query]);

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
          </label>
        </div>
      </div>
      <Table rows={pageRows} onAllocate={onAllocate} onDelete={onDelete} />
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
  const [date, setDate] = useState('All Dates');
  const [instrument, setInstrument] = useState('All Instruments');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<Trade[]>([]);
  const [strategyMasterRows, setStrategyMasterRows] = useState<StrategyMasterRow[]>([]);
  const [strategySetupOpen, setStrategySetupOpen] = useState(false);
  const [pipelineLog, setPipelineLog] = useState<PipelineLogResponse | null>(null);
  const [showProcessLog, setShowProcessLog] = useState(false);
  const [showPipelineCard, setShowPipelineCard] = useState(false);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [counts, setCounts] = useState({
    'Open Trades': 0,
    'Unassigned Trades': 0,
    'Allocated Trades': 0,
    Strategies: 0,
  });

  useEffect(() => {
    let cancelled = false;

    Promise.all([loadStrategyAllocation(), loadStrategyMaster()])
      .then(([data, master]) => {
        if (cancelled) return;
        const mapped = mapAllocationRows(data.rows ?? []);
        setRows(mapped);
        setStrategyMasterRows(master.rows ?? []);
        setCounts(data.counts);
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
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
    const refreshLog = async () => {
      try {
        const data = await loadImportPipelineLog();
        if (active) setPipelineLog(data);
      } catch {
        if (active) setPipelineLog(null);
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
    try {
      await runImportPipeline();
    } catch (runError: unknown) {
      action(runError instanceof Error ? runError.message : 'Pipeline failed');
    } finally {
      setPipelineLoading(false);
    }
  }

  function selectFileAndRun() {
    if (!pipelineLoading) inputRef.current?.click();
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (!selected) return;
    try {
      await uploadImportFile(selected);
      await startImportPipeline();
    } catch (fileError: unknown) {
      action(fileError instanceof Error ? fileError.message : 'Unable to select TXT file');
    }
  }


  const dateOptions = useMemo(
    () => ['All Dates', ...Array.from(new Set(rows.map((row) => formatDisplayDate(row.date)).filter(Boolean))).sort()],
    [rows],
  );

  const visibleTrades = useMemo(() => rows.filter((row) => {
    const instrumentMatches = instrument === 'All Instruments' || row.instrument === instrument;
    const dateMatches = date === 'All Dates' || formatDisplayDate(row.date) === date;
    return instrumentMatches && dateMatches;
  }), [date, instrument, rows]);

  const combinedVisible = useMemo(() => visibleTrades.filter((row) => row.bucket === 'Open' || row.bucket === 'Unassigned'), [visibleTrades]);
  const instruments = useMemo(() => ['All Instruments', ...Array.from(new Set(rows.map((row) => row.instrument))).sort()], [rows]);

  function action(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2600);
  }

  async function deleteAllocatedTrade(row: Trade) {
    if (!window.confirm(`Delete trade ${row.order} and all related allocation, split, and merge records?`)) return;

    try {
      const result = await deleteTradeBookTrade(row.order);
      const [allocationData, masterData] = await Promise.all([loadStrategyAllocation(), loadStrategyMaster()]);
      setRows(mapAllocationRows(allocationData.rows ?? []));
      setCounts(allocationData.counts);
      setStrategyMasterRows(masterData.rows ?? []);
      action(result.message);
    } catch (deleteError: unknown) {
      action(deleteError instanceof Error ? deleteError.message : 'Unable to delete trade');
    }
  }

  return (
    <div className="alloc-shell">
      <Sidebar onStrategySetup={() => setStrategySetupOpen(true)} />
      <main className="alloc-main">
        <header className="alloc-header">
          <div>
            <div className="alloc-eyebrow">PIPELINE / 04</div>
            <h1>04 Strategy Allocation</h1>
            <p>Allocate strategy to open trades and track performance</p>
          </div>
          <input ref={inputRef} type="file" accept=".txt,text/plain" hidden onChange={handleImportFile} />
          <div className="alloc-header-actions">
            <button className="btn primary strategy-run-button" type="button" onClick={selectFileAndRun} disabled={pipelineLoading} aria-label="Select TXT file and run import pipeline" title="Select TXT file and run import pipeline">
              {pipelineLoading ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            </button>
            <Calendar className="strategy-allocation-calendar" label="Trade Date" value={date === 'All Dates' ? '' : parseCalendarDisplayDate(date)} placeholder="All Dates" allowClear allowedDates={dateOptions.slice(1).map(parseCalendarDisplayDate)} onChange={(value) => setDate(value ? formatDisplayDate(value) : 'All Dates')} />
            <label className="alloc-select">
              <select value={instrument} onChange={(event) => setInstrument(event.target.value)}>
                {instruments.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <ChevronDown size={15} />
            </label>
            <button className="smart-btn" onClick={() => action('Smart allocation suggestions are ready')}>
              <Sparkles size={16} />
              Smart Allocation
            </button>
          </div>
        </header>

        {showPipelineCard && (
          <div className="pipeline-card-modal-backdrop" role="presentation" onClick={() => setShowPipelineCard(false)}>
            <section className="pipeline-card-modal" role="dialog" aria-modal="true" aria-labelledby="strategy-pipeline-card-title" onClick={(event) => event.stopPropagation()}>
              <h2 id="strategy-pipeline-card-title">Pipeline Progress</h2>
              <WorkflowTimeline
                stage={(pipelineLog?.running ? 'convert' : 'ready') as Stage}
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
                onSelectFile={selectFileAndRun}
              />
              <button className="pipeline-card-ok" type="button" onClick={() => setShowPipelineCard(false)}>OK</button>
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
          <Stat tone="red" icon={<SlidersHorizontal size={21} />} label="Unassigned Trades" value={String(counts['Unassigned Trades'])} />
          <Stat tone="green" icon={<Users size={21} />} label="Allocated Trades" value={String(counts['Allocated Trades'])} />
          <Stat tone="green" icon={<ShieldCheck size={21} />} label="Strategies" value={String(counts.Strategies)} />
        </div>

        <Section
          title={`Open Trades + Unassigned Trades (${combinedVisible.length})`}
          rows={combinedVisible}
          onAllocate={(row) => navigate(`/instrument-allocation?instrument=${encodeURIComponent(row.instrument)}&expiry=${encodeURIComponent(row.expiry)}&strike=${encodeURIComponent(row.strike)}&option=${encodeURIComponent(row.optionType)}&allocationStatus=${encodeURIComponent(row.strategy && row.strategy !== 'Unassigned' ? 'Allocated' : 'Unassigned')}`)}
          onDelete={deleteAllocatedTrade}
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
              <div className={`pipeline-log-status ${pipelineLog?.running ? 'running' : 'idle'}`}>
                <Activity size={14} />
                {pipelineLog?.running ? 'Live output' : 'Latest snapshot'}
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
        const [allocationData, masterData] = await Promise.all([loadStrategyAllocation(), loadStrategyMaster()]);
        setRows(mapAllocationRows(allocationData.rows ?? []));
        setCounts(allocationData.counts);
        setStrategyMasterRows(masterData.rows ?? []);
      }} />}
    </div>
  );
}
