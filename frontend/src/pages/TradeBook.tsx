import { useEffect, useMemo, useState } from 'react';
import { TradeBookFilters } from '../components/TradeBookFilters';
import { TradeBookHeader } from '../components/TradeBookHeader';
import { TradeBookPagination } from '../components/TradeBookPagination';
import { TradeBookTable, TradeSortKey } from '../components/TradeBookTable';
import { TradeBookTabs } from '../components/TradeBookTabs';
import { deleteTradeBookTrade, loadTradeBook, updateOpenTradeCmps } from '../lib/api';
import { TradeBookRecord, TradeBookTab } from '../lib/tradeBook';

type FilterState = {
  date: string;
  expiry: string;
  scrip: string;
  strategy: string;
  tradeType: string;
  search: string;
};

const DEFAULT_FILTERS: FilterState = {
  date: 'Loading trade date...',
  expiry: 'All Expiry',
  scrip: 'All Scrips',
  strategy: 'All Strategies',
  tradeType: 'All',
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
  const tradeType = filters.tradeType.toLowerCase();

  return (
    tabMatch &&
    (filters.date === 'Loading trade date...' || row.date === filters.date) &&
    (filters.expiry === 'All Expiry' || row.expiry === filters.expiry) &&
    (filters.scrip === 'All Scrips' || row.scrip === filters.scrip) &&
    (filters.strategy === 'All Strategies' || row.strategy === filters.strategy) &&
    (tradeType === 'all' || row.side.toLowerCase() === tradeType) &&
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
  const [activeTab, setActiveTab] = useState<TradeBookTab>('All Trades');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<TradeBookRecord[]>([]);
  const [loadedView, setLoadedView] = useState<TradeBookTab | null>(null);
  const [counts, setCounts] = useState<Record<TradeBookTab, number>>(DEFAULT_COUNTS);
  const [sortKey, setSortKey] = useState<TradeSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [savingCmp, setSavingCmp] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;

    setStatusMessage('Loading live trade book data from Supabase...');
    setLoadError('');
    setLoadedView(null);
    setRows([]);

    loadTradeBook(activeTab)
      .then((response) => {
        if (cancelled) return;
        setRows(response.rows);
        setLoadedView(response.view);
        setCounts(response.counts);
        setFilters((current) => ({
          ...current,
          date: response.rows[0]?.date ?? current.date,
        }));
        setStatusMessage('');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Unable to load trade book data';
        setRows([]);
        setLoadedView(null);
        setCounts(DEFAULT_COUNTS);
        setLoadError(message);
        setStatusMessage('');
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, refreshNonce]);

  const filterOptions = useMemo(() => {
    return {
      expiries: uniqueOptions(rows, (row) => row.expiry, 'All Expiry'),
      scrips: uniqueOptions(rows, (row) => row.scrip, 'All Scrips'),
      strategies: uniqueOptions(rows, (row) => row.strategy, 'All Strategies'),
    };
  }, [rows]);

  const matchingRows = useMemo(() => {
    if (loadedView !== activeTab) return [];

    return rows
      .filter((row) => matchesFilters(row, activeTab, filters))
      .sort((left, right) => (sortKey ? (sortDirection === 'asc' ? 1 : -1) * compareRecords(left, right, sortKey) : 0));
  }, [activeTab, filters, loadedView, rows, sortDirection, sortKey]);

  const virtualTotal =
    filters.date !== 'Loading trade date...' ||
    filters.search ||
    filters.expiry !== 'All Expiry' ||
    filters.scrip !== 'All Scrips' ||
    filters.strategy !== 'All Strategies' ||
    filters.tradeType !== 'All'
      ? matchingRows.length
      : counts[activeTab];

  const pageCount = Math.max(1, Math.ceil(virtualTotal / pageSize));
  const pageRows = matchingRows.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    setOpenMenu(null);
  }, [activeTab]);

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

  async function deleteTrade(tradeId: string) {
    if (!window.confirm(`Delete trade ${tradeId} and all related merge/split records?`)) return;

    try {
      const response = await deleteTradeBookTrade(tradeId);
      setFeedback(response.message);
      refreshTradeBook();
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : 'Unable to delete trade');
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

  return (
    <div className="reference-shell">
      <main className="reference-main">
        <TradeBookHeader onRefresh={refreshTradeBook} />
        <TradeBookFilters values={filters} options={filterOptions} onChange={updateFilter} />
        {statusMessage && (
          <div className="reference-feedback" role="status">
            {statusMessage}
          </div>
        )}
        {loadError && (
          <div className="reference-feedback" role="alert">
            {loadError}
            <button onClick={refreshTradeBook}>Retry</button>
          </div>
        )}
        {feedback && (
          <div className="reference-feedback" role="status">
            {feedback}
            <button onClick={() => setFeedback('')}>×</button>
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
            <div className="reference-table-actions">
              {activeTab === 'Open Trades' && (
                <button className="reference-cmp-button" onClick={saveOpenTradeCmps} disabled={savingCmp || loadedView !== activeTab} title="Fetch current CMP and save it to Open Trades">
                  {savingCmp ? 'Saving CMP…' : 'Fetch & Save CMP'}
                </button>
              )}
              <button className="reference-export-button" onClick={exportRows}>
                ↓ &nbsp; Export
              </button>
              <button className="reference-add-button" onClick={() => setFeedback('Manual trade entry is ready to be connected')}>
                ⊕ &nbsp; Add Manual Trade
              </button>
            </div>
          </div>
          <TradeBookTable key={`${activeTab}-${loadedView ?? 'loading'}`} rows={pageRows} sortKey={sortKey} sortDirection={sortDirection} onSort={sortBy} openMenu={openMenu} onOpenMenu={setOpenMenu} onDelete={deleteTrade} showStatus showPlAmt={activeTab !== 'All Trades'} showCmp={activeTab === 'Open Trades'} />
          <TradeBookPagination page={page} pageCount={pageCount} totalCount={virtualTotal} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={updatePageSize} />
        </section>
      </main>
    </div>
  );
}
