import { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Download, Trash2 } from 'lucide-react';
import { TradeBookFilterControls, TradeBookFilterPanel, TradeBookFilterValues } from '../components/TradeBookFilters';
import { TradeBookHeader } from '../components/TradeBookHeader';
import { TradeBookPagination } from '../components/TradeBookPagination';
import { TradeBookTable, TradeSortKey } from '../components/TradeBookTable';
import { TradeBookTabs } from '../components/TradeBookTabs';
import { deleteTradeBookTrade, loadTradeBook, updateOpenTradeCmps } from '../lib/api';
import { TradeBookRecord, TradeBookTab } from '../lib/tradeBook';

type FilterState = TradeBookFilterValues;

const DEFAULT_FILTERS: FilterState = {
  date: '',
  expiry: 'All Expiry',
  scrip: 'All Scrips',
  strategy: 'All Strategies',
  tradeType: 'All',
  optionType: '',
  search: '',
};

const DEFAULT_COUNTS: Record<TradeBookTab, number> = {
  'All Trades': 0,
  'Open Trades': 0,
  'Closed Trades': 0,
};

function compareRecords(a: TradeBookRecord, b: TradeBookRecord, key: TradeSortKey) {
  const left = a[key];
  const right = b[key];
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function uniqueOptions(rows: TradeBookRecord[], selector: (row: TradeBookRecord) => string, allLabel: string) {
  const values = Array.from(new Set(rows.map(selector).filter(Boolean))).sort((left, right) => left.localeCompare(right));
  return [allLabel, ...values];
}

function normalizeText(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function matchesFilters(row: TradeBookRecord, activeTab: TradeBookTab, filters: FilterState) {
  const tabMatch =
    activeTab === 'All Trades' ||
    (activeTab === 'Open Trades' && row.status.toUpperCase() === 'OPEN') ||
    (activeTab === 'Closed Trades' && row.status.toUpperCase() === 'CLOSED');
  const query = normalizeText(filters.search);
  const tradeType = normalizeText(filters.tradeType);
  const same = (left: unknown, right: unknown) => normalizeText(left) === normalizeText(right);

  return (
    tabMatch &&
    (!filters.date || same(row.date, filters.date)) &&
    (filters.expiry === 'All Expiry' || same(row.expiry, filters.expiry)) &&
    (filters.scrip === 'All Scrips' || same(row.scrip, filters.scrip)) &&
    (filters.strategy === 'All Strategies' || same(row.strategy, filters.strategy)) &&
    (tradeType === 'all' || same(row.side, filters.tradeType)) &&
    (!filters.optionType || same(row.optType, filters.optionType)) &&
    (!query ||
      [
        row.date,
        row.time,
        row.tradeId,
        row.side,
        row.scrip,
        row.expiry,
        row.strike,
        row.optType,
        row.qty,
        row.price,
        row.mtm,
        row.strategy,
        row.status,
      ]
        .map(normalizeText)
        .some((field) => field.includes(query)))
  );
}

export function TradeBook() {
  const [activeTab, setActiveTab] = useState<TradeBookTab>('Open Trades');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<TradeBookRecord[]>([]);
  const [loadedView, setLoadedView] = useState<TradeBookTab | null>(null);
  const [counts, setCounts] = useState<Record<TradeBookTab, number>>(DEFAULT_COUNTS);
  const [sortKey, setSortKey] = useState<TradeSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedTradeIds, setSelectedTradeIds] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [loadError, setLoadError] = useState('');
  const [deleteConfirmTrade, setDeleteConfirmTrade] = useState<string | null>(null);
  const [deletingTrade, setDeletingTrade] = useState(false);
  const [savingCmp, setSavingCmp] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'checking' | 'verified' | 'mismatch' | 'idle'>('checking');
  const [syncCheckedAt, setSyncCheckedAt] = useState('');
  useEffect(() => {
    let cancelled = false;

    setSyncStatus('checking');
    setSyncCheckedAt('');
    setLoadError('');

    loadTradeBook(activeTab)
      .then((response) => {
        if (cancelled) return;
        setRows(response.rows);
        setLoadedView(response.view);
        setCounts(response.counts);
        const countsMatch = response.verification?.counts_match ?? response.rows.length === response.counts[response.view];
        setSyncStatus(countsMatch ? 'verified' : 'mismatch');
        setSyncCheckedAt(response.verification?.checked_at ?? new Date().toISOString());
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Unable to load trade book data';
        setRows([]);
        setLoadedView(null);
        setCounts(DEFAULT_COUNTS);
        setLoadError(message);
        setSyncStatus('idle');
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, refreshNonce]);

  const filterOptions = useMemo(() => {
    const rowsForFilter = (field: keyof FilterState) => rows.filter((row) => matchesFilters(row, activeTab, { ...filters, [field]: DEFAULT_FILTERS[field] }));
    return {
      dates: uniqueOptions(rowsForFilter('date'), (row) => row.date, 'All Dates'),
      expiries: uniqueOptions(rowsForFilter('expiry'), (row) => row.expiry, 'All Expiry'),
      scrips: uniqueOptions(rowsForFilter('scrip'), (row) => row.scrip, 'All Scrips'),
      strategies: uniqueOptions(rowsForFilter('strategy'), (row) => row.strategy, 'All Strategies'),
      optionTypes: uniqueOptions(rowsForFilter('optionType'), (row) => row.optType, 'All Options'),
    };
  }, [activeTab, filters, rows]);

  const matchingRows = useMemo(() => {
    if (loadedView !== activeTab) return [];

    return rows
      .filter((row) => matchesFilters(row, activeTab, filters))
      .sort((left, right) => (sortKey ? (sortDirection === 'asc' ? 1 : -1) * compareRecords(left, right, sortKey) : 0));
  }, [activeTab, filters, loadedView, rows, sortDirection, sortKey]);

  const virtualTotal =
    filters.date ||
    filters.search ||
    filters.expiry !== 'All Expiry' ||
    filters.scrip !== 'All Scrips' ||
    filters.strategy !== 'All Strategies' ||
    filters.tradeType !== 'All' ||
    filters.optionType
      ? matchingRows.length
      : counts[activeTab];

  const pageCount = Math.max(1, Math.ceil(virtualTotal / pageSize));
  const pageRows = matchingRows.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    setOpenMenu(null);
    setSelectedTradeIds(new Set());
    setSelectionMode(false);
  }, [activeTab]);

  function toggleSelectionMode() {
    setSelectionMode((current) => {
      if (current) setSelectedTradeIds(new Set());
      return !current;
    });
  }

  function toggleTradeSelection(tradeId: string) {
    setSelectedTradeIds((current) => {
      const next = new Set(current);
      if (next.has(tradeId)) next.delete(tradeId);
      else next.add(tradeId);
      return next;
    });
  }

  function toggleAllTradeSelection(tradeIds: string[], checked: boolean) {
    setSelectedTradeIds((current) => {
      const next = new Set(current);
      tradeIds.forEach((tradeId) => (checked ? next.add(tradeId) : next.delete(tradeId)));
      return next;
    });
  }

  function updateFilter(key: keyof FilterState, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  function updatePageSize(nextPageSize: number) {
    setPageSize(nextPageSize);
    setPage(1);
  }

  function sortBy(key: TradeSortKey) {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortKey(key);
    setSortDirection('asc');
  }

  function refreshTradeBook() {
    setRefreshNonce((current) => current + 1);
  }

  async function saveOpenTradeCmps() {
    setSavingCmp(true);
    setLoadError('');
    try {
      const response = await updateOpenTradeCmps();
      setFeedback(response.message || `Updated CMP for ${response.updated} open trade(s).`);
      refreshTradeBook();
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : 'Unable to update CMP');
    } finally {
      setSavingCmp(false);
    }
  }

  async function confirmDeleteTrade() {
    if (!deleteConfirmTrade || deletingTrade) return;
    setDeletingTrade(true);
    setLoadError('');
    try {
      const response = await deleteTradeBookTrade(deleteConfirmTrade);
      setFeedback(response.message);
      refreshTradeBook();
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : 'Unable to delete trade');
    } finally {
      setDeletingTrade(false);
      setDeleteConfirmTrade(null);
    }
  }

  function exportRows() {
    const csv = [
      'Date,Time,Trade ID,Side,Scrip,Expiry,Strike,Opt Type,Qty,Price,MTM,Strategy,Status',
      ...matchingRows.map((row) =>
        [row.date, row.time, row.tradeId, row.side, row.scrip, row.expiry, row.strike, row.optType, row.qty, row.price.toFixed(2), row.mtm.toFixed(2), row.strategy, row.status].join(','),
      ),
    ].join('\n');

    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = 'trade-book.csv';
    link.click();
    URL.revokeObjectURL(link.href);
    setFeedback('Trade book exported');
  }

  const syncTimeLabel = useMemo(() => {
    if (!syncCheckedAt) return '—';
    const parsed = new Date(syncCheckedAt);
    if (Number.isNaN(parsed.getTime())) return syncCheckedAt;
    return parsed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).replace(':', '.').toUpperCase();
  }, [syncCheckedAt]);
  // All Trades is no longer loaded or displayed, so there is no combined
  // dataset to compare against the Open/Closed counts.
  const expectedAllTradesCount = 0;
  const countMismatch = false;

  return (
    <div className="reference-shell">
      <main className="reference-main">
        <TradeBookHeader syncStatus={syncStatus} syncTimeLabel={syncTimeLabel} countMismatch={countMismatch} actualAllTrades={counts['All Trades']} expectedAllTrades={expectedAllTradesCount} />
        {loadError && (
          <div className="alloc-notice trade-book-error" role="alert">
            {loadError}
            <button onClick={refreshTradeBook}>Retry</button>
          </div>
        )}
        <section className="reference-trade-card">
          <div className="reference-trade-card-head">
            <TradeBookTabs
              activeTab={activeTab}
              counts={counts}
              onChange={(tab) => {
                setActiveTab(tab);
                setPage(1);
              }}
            />
            <div className="trade-book-header-tools">
              <TradeBookFilterControls values={filters} showFilters={showFilters} activeFilterCount={Object.entries(filters).filter(([key, value]) => key !== 'search' && Boolean(value) && !['All Expiry', 'All Scrips', 'All Strategies', 'All'].includes(value)).length} onToggleFilters={() => setShowFilters((current) => !current)} onChange={updateFilter} />
              <button type="button" className={`trade-book-selection-toggle${selectionMode ? ' active' : ''}`} onClick={toggleSelectionMode} aria-pressed={selectionMode} aria-label={selectionMode ? 'Hide trade selection' : 'Enable multiple trade selection'} title={selectionMode ? 'Hide trade selection' : 'Select multiple trades'}>
                <CheckSquare size={15} />
              </button>
              <div className="reference-table-actions">
                {activeTab === 'Open Trades' && (
                  <button className="reference-cmp-button" onClick={saveOpenTradeCmps} disabled={savingCmp || loadedView !== activeTab} title="Fetch current CMP and save it to Open Trades">
                    {savingCmp ? 'Saving CMP…' : 'Fetch & Save CMP'}
                  </button>
                )}
                <button className="reference-export-button" onClick={exportRows} aria-label="Export trade book as CSV" title="Export CSV">
                  <Download size={14} /> <span>CSV</span>
                </button>
                <button className="reference-add-button" onClick={() => setFeedback('Manual trade entry is ready to be connected')}>
                  ⊕ &nbsp; Add Manual Trade
                </button>
              </div>
            </div>
          </div>
          {showFilters && <TradeBookFilterPanel values={filters} options={filterOptions} onChange={updateFilter} onClear={() => setFilters(DEFAULT_FILTERS)} />}
          {feedback && (
            <div className="alloc-notice trade-book-action-notice" role="status">
              {feedback}
              <button onClick={() => setFeedback('')}>×</button>
            </div>
          )}
          <TradeBookTable key={`${activeTab}-${loadedView ?? 'loading'}`} rows={pageRows} sortKey={sortKey} sortDirection={sortDirection} onSort={sortBy} openMenu={openMenu} onOpenMenu={setOpenMenu} onDelete={setDeleteConfirmTrade} showStatus={false} showPlAmt showCmp={activeTab === 'Open Trades'} closedView={activeTab === 'Closed Trades'} openView={activeTab === 'Open Trades'} showTradeId={false} selectionMode={selectionMode} selectedTradeIds={selectedTradeIds} onToggleTrade={toggleTradeSelection} onToggleAll={toggleAllTradeSelection} />
          <TradeBookPagination page={page} pageCount={pageCount} totalCount={virtualTotal} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={updatePageSize} />
        </section>
        {deleteConfirmTrade && (
          <div className="allocation-delete-modal-backdrop" role="presentation">
            <section className="allocation-delete-modal" role="dialog" aria-modal="true" aria-labelledby="trade-book-delete-title">
              {deletingTrade ? (
                <>
                  <div className="allocation-delete-spinner" aria-hidden="true" />
                  <h2 id="trade-book-delete-title">Deleting trade…</h2>
                  <p>Please wait while the trade and related records are removed.</p>
                </>
              ) : (
                <>
                  <div className="allocation-delete-icon"><Trash2 size={20} /></div>
                  <h2 id="trade-book-delete-title">Delete trade?</h2>
                  <p>Delete trade {deleteConfirmTrade} and all related merge, split, and allocation records?</p>
                  <div className="allocation-delete-actions">
                    <button type="button" className="allocation-delete-cancel" onClick={() => setDeleteConfirmTrade(null)}>Cancel</button>
                    <button type="button" className="allocation-delete-confirm" onClick={confirmDeleteTrade}>Delete</button>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
