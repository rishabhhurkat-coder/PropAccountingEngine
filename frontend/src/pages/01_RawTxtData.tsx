import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, Check, Loader2, Play, Search, Terminal } from 'lucide-react';
import {
  loadImportPipelineLog,
  loadImportFiles,
  loadRawTxtData,
  proceedToMerge,
  runImportPipeline,
  uploadImportFiles,
  type PipelineLogResponse,
} from '../lib/api';
import { ImportedFile, RawTrade, Stage } from '../types';
import { ImportFileCard, pipelineTimelineStage, PrimaryButton, SectionHeader, StickyActionBar, WorkflowTimeline } from '../components/PipelineUI';
import { RawTradesTable } from '../components/RawTradesTable';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const filesSeed: ImportedFile[] = [];

function formatDateText(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day}-${MONTHS[Number(month) - 1]}-${year.slice(-2)}`;
  }

  const normalized = raw.replace(/\./g, '/').replace(/\s+/g, '');
  const slashMatch = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, '0');
    const month = Number(slashMatch[2]);
    const year = slashMatch[3].length === 2 ? slashMatch[3] : slashMatch[3].slice(-2);
    return `${day}-${MONTHS[month - 1]}-${year}`;
  }

  const compactMatch = normalized.match(/^(\d{1,2})([A-Za-z]{3})(\d{2,4})$/);
  if (compactMatch) {
    const day = compactMatch[1].padStart(2, '0');
    const month = compactMatch[2].slice(0, 1).toUpperCase() + compactMatch[2].slice(1).toLowerCase();
    const year = compactMatch[3].length === 2 ? compactMatch[3] : compactMatch[3].slice(-2);
    return `${day}-${month}-${year}`;
  }

  return raw;
}

function normalizeSearchText(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function formatPrice(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const numeric = Number(raw.replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric.toFixed(2) : raw;
}

function normalizeTradeSide(value: unknown) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'Buy';
  if (raw === 'sell' || raw === 's' || raw === 'short' || raw.startsWith('sell')) return 'Sell';
  if (raw === 'buy' || raw === 'b' || raw === 'long' || raw.startsWith('buy')) return 'Buy';
  return raw.includes('sell') ? 'Sell' : 'Buy';
}

function formatLogTime(value: string | null | undefined) {
  if (!value) return 'Not run yet';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function mapCsvRows(rows: Record<string, unknown>[]): RawTrade[] {
  return rows.map((row, index) => ({
    id: String(row.id ?? row.InstrumentId ?? index + 1),
    date: formatDateText(row.trade_date ?? row.Date ?? row.TradeDate ?? ''),
    time: String(row.trade_minute ?? row.Time ?? ''),
    client: String(row.account ?? row.Account ?? ''),
    side: normalizeTradeSide(row.trade_type ?? row.Trade ?? row.Side ?? row.BuySell ?? row.TradeType),
    instrument: String(row.scrip ?? row.Scrip ?? ''),
    expiry: formatDateText(row.expiry ?? row.Expiry ?? ''),
    strike: String(row.strike ?? row.Strike ?? ''),
    option: String(row.option_type ?? row.Options ?? row.Option ?? row.OptionType ?? 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE',
    quantity: Number(row.quantity ?? row.Quantity ?? 0),
    price: formatPrice(row.average_price ?? row.Price ?? ''),
    order: String(row.instrument_id ?? row.InstrumentId ?? index + 1),
    source: '01RawTxtData',
    mergeTradeId: row.merge_trade_id == null || row.merge_trade_id === '' ? null : (row.merge_trade_id as string | number),
  }));
}

function hasMergeTradeId(value: RawTrade['mergeTradeId']) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return false;
  return Number.isFinite(typeof value === 'number' ? value : Number(value));
}

export function RawTxtData() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState(filesSeed);
  const [trades, setTrades] = useState<RawTrade[]>([]);
  const [stage, setStage] = useState<Stage>('idle');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [pipelineLog, setPipelineLog] = useState<PipelineLogResponse | null>(null);
  const [showProcessLog, setShowProcessLog] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [allocationFilter, setAllocationFilter] = useState<'all' | 'allocated' | 'unallocated'>('all');
  const refreshingRef = useRef(false);

  async function refreshPipelineLog() {
    const data = await loadImportPipelineLog();
    setPipelineLog(data);
    setStage(pipelineTimelineStage(data.stage, data.running));
  }

  async function refreshRawTxtData() {
    const data = await loadRawTxtData();
    if (!data.success) throw new Error(data.message ?? 'Unable to load matalia."01RawTxtData"');
    setTrades(mapCsvRows(data.rows));
  }

  async function refreshDataWithRetry() {
    let refreshed = { rowCount: 0, fileCount: 0 };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const [tradeData, fileData] = await Promise.all([loadRawTxtData(), loadImportFiles()]);
        if (!tradeData.success) throw new Error(tradeData.message ?? 'Unable to load raw trades');
        setTrades(mapCsvRows(tradeData.rows));
        setFiles(fileData.files ?? []);
        refreshed = { rowCount: tradeData.rows.length, fileCount: fileData.files?.length ?? 0 };
        if (attempt < 4) await new Promise((resolve) => window.setTimeout(resolve, 500));
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    }
    return refreshed;
  }

  useEffect(() => {
    refreshDataWithRetry().catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      refreshDataWithRetry().catch(() => undefined).finally(() => { refreshingRef.current = false; });
    }, 5000);
    return () => window.clearInterval(timer);
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

  const filteredTrades = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    return trades.filter(
      (trade) =>
        (!normalizedQuery ||
          [
            trade.date,
            trade.time,
            trade.client,
            trade.side,
            trade.instrument,
            trade.expiry,
            trade.strike,
            trade.option,
            trade.quantity,
            trade.price,
            trade.order,
            trade.source,
          ].some((field) => normalizeSearchText(field).includes(normalizedQuery))) &&
        (allocationFilter === 'all' || (allocationFilter === 'allocated' ? hasMergeTradeId(trade.mergeTradeId) : !hasMergeTradeId(trade.mergeTradeId))),
    );
  }, [trades, query, allocationFilter]);

  const totalCount = filteredTrades.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStartIndex = totalCount === 0 ? 0 : (safePage - 1) * pageSize;
  const pageTrades = filteredTrades.slice(pageStartIndex, pageStartIndex + pageSize);

  useEffect(() => {
    if (page !== safePage) {
      setPage(safePage);
    }
  }, [page, safePage]);

  useEffect(() => {
    setPage(1);
  }, [query, pageSize, allocationFilter]);

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!selected.length) return;
    try {
      const response = await uploadImportFiles(selected);
      setFiles(response.files);
      setStage('files');
      setNotice(response.message ?? `${selected.length} TXT file(s) uploaded. Click Run Import Pipeline to process them.`);
    } catch (error) {
      setStage('error');
      setNotice(error instanceof Error ? error.message : 'Unable to select TXT file');
    }
  }

  async function runImport() {
    setShowProcessLog(true);
    setLoading(true);
    setStage('convert');
    try {
      const result = await runImportPipeline();
      await refreshPipelineLog().catch(() => undefined);
      if (result.success) {
        const refreshed = await refreshDataWithRetry();
        setStage('ready');
        const fileLabel = `${refreshed.fileCount} file${refreshed.fileCount === 1 ? '' : 's'} processed`;
        const rowLabel = `${refreshed.rowCount.toLocaleString()} row${refreshed.rowCount === 1 ? '' : 's'} loaded`;
        setNotice(`Success — ${result.message ?? 'Pipeline completed successfully'}. ${fileLabel}; ${rowLabel}. Supabase data is updated.`);
      } else {
        setStage('error');
        setNotice(result.message ?? `Pipeline failed${result.failed_step ? ` at ${result.failed_step}` : ''}`);
      }
    } catch (error) {
      setStage('error');
      setNotice(error instanceof Error ? error.message : 'Pipeline failed');
    } finally {
      await refreshPipelineLog().catch(() => undefined);
      setLoading(false);
      setShowProcessLog(false);
    }
  }

  async function proceed() {
    setLoading(true);
    try {
      await proceedToMerge();
      setNotice('Ready for merge');
    } finally {
      setLoading(false);
    }
  }

  const pipelineLogLines = pipelineLog?.log ?? [];
  const pipelineLogTail = pipelineLogLines.slice(-14);

  return (
    <div className="workspace-shell raw-trade-import-page">
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <div className="eyebrow">TRADE ACCOUNTING WORKSPACE</div>
            <h1>Raw Trade Import</h1>
            <p>Import your broker TXT files and verify them before processing.</p>
          </div>
          <input ref={inputRef} type="file" accept=".txt,text/plain" multiple hidden onChange={pick} />
          <div className="workspace-actions">
            <button
              type="button"
              className={`pipeline-monitor ${pipelineLog?.running ? 'running' : 'idle'}`}
              onClick={() => setShowProcessLog((current) => !current)}
              aria-pressed={showProcessLog}
              aria-label={pipelineLog?.running ? 'View running Python backend process log' : 'View Python backend process log'}
              title={pipelineLog?.running ? 'Python backend is running — view log' : 'View Python backend log'}
            >
              <span className="pipeline-monitor-icon">
                {pipelineLog?.running ? <Activity size={20} /> : <Terminal size={20} />}
              </span>
            </button>
            <PrimaryButton compact ariaLabel="Run Import Pipeline" onClick={runImport} disabled={loading || !files.length} icon={loading ? <Loader2 className="spin" size={18} /> : <Play size={18} />}>
              {loading ? 'Processing...' : 'Run Import Pipeline'}
            </PrimaryButton>
          </div>
        </header>

        {notice && (
          <div className={`notice ${stage === 'error' ? 'notice-error' : stage === 'ready' ? 'notice-success' : 'notice-info'}`}>
            {stage === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}
            {notice}
            <button onClick={() => setNotice('')}>x</button>
          </div>
        )}

        {showProcessLog && (
          <div className="pipeline-log-modal-backdrop" role="presentation" onClick={() => setShowProcessLog(false)}>
            <section className={`pipeline-log-panel pipeline-log-modal ${pipelineLog?.running ? 'running' : 'idle'}`} role="dialog" aria-modal="true" aria-labelledby="raw-process-monitor-title" onClick={(event) => event.stopPropagation()}>
            <div className="pipeline-log-head">
              <div>
                <div className="section-eyebrow">PYTHON BACKEND</div>
                <h2 id="raw-process-monitor-title">Process Monitor</h2>
              </div>
              <button className="pipeline-log-close" type="button" onClick={() => setShowProcessLog(false)} aria-label="Close process monitor">×</button>
              <div className={`pipeline-log-status ${pipelineLog?.running ? 'running' : pipelineLog?.stage === 'error' ? 'error' : 'idle'}`}>
                {pipelineLog?.running ? <Activity size={14} /> : pipelineLog?.stage === 'error' ? <AlertCircle size={14} /> : <Terminal size={14} />}
                {pipelineLog?.running ? 'Live output' : pipelineLog?.stage === 'error' ? 'Failed' : 'Latest snapshot'}
              </div>
            </div>
            <div className="pipeline-log-meta">
              <span>Stage: {pipelineLog?.stage ?? 'idle'}</span>
              <span>Last run: {formatLogTime(pipelineLog?.last_run_at)}</span>
              <span>{pipelineLog?.log_path ? pipelineLog.log_path.split(/[\\/]/).slice(-2).join('/') : 'Other Logs/Runtime/import_pipeline.log'}</span>
            </div>
            <div className="pipeline-log-stream" role="log" aria-live="polite">
              {pipelineLogTail.length ? (
                pipelineLogTail.map((line, index) => (
                  <div className="pipeline-log-line" key={`${index}-${line}`}>
                    {line}
                  </div>
                ))
              ) : (
                <div className="pipeline-log-empty">No log lines yet. Run the pipeline to capture backend output here.</div>
              )}
            </div>
            </section>
          </div>
        )}

        <WorkflowTimeline
          stage={stage}
          status={stage === 'error' ? 'error' : stage === 'ready' ? 'success' : stage === 'files' ? 'files' : stage === 'idle' ? 'idle' : 'running'}
          message={pipelineLog?.message}
          onSelectFile={() => inputRef.current?.click()}
        />

        <div className="workspace-columns">
          <div className="workspace-left">
            <section className="workspace-section">
              <SectionHeader title="Today's Imports" action={<button className="view-all">View All</button>} />
              <div className="file-grid">
                {files.map((file) => (
                  <ImportFileCard
                    key={file.id}
                    file={file}
                    selected={file.id === files[0]?.id}
                    onSelect={() => setNotice(`Viewing ${file.name}`)}
                    onReload={() => setNotice(`Reload queued for ${file.name}`)}
                    onDelete={() => setFiles(files.filter((item) => item.id !== file.id))}
                  />
                ))}
              </div>
            </section>

            <section className="workspace-section table-section">
              <SectionHeader
                title="Trades"
                action={
                  <div className="raw-table-toolbar raw-table-toolbar--header">
                    <select className="raw-allocation-filter" aria-label="Allocation status" value={allocationFilter} onChange={(event) => setAllocationFilter(event.target.value as typeof allocationFilter)}>
                      <option value="all">All Allocation</option>
                      <option value="allocated">Allocated</option>
                      <option value="unallocated">Unallocated</option>
                    </select>
                    <div className="search-box smart-search-box">
                      <Search size={15} />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search any trade field..."
                        aria-label="Smart search"
                      />
                    </div>
                  </div>
                }
              />
              <RawTradesTable
                trades={pageTrades}
                totalCount={totalCount}
                page={safePage}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </section>
          </div>
        </div>
      </main>
      <StickyActionBar
        status={stage === 'ready' ? 'Ready for merge' : 'Processing import'}
        ready={stage === 'ready'}
        onReimport={() => inputRef.current?.click()}
        onProceed={proceed}
      />
    </div>
  );
}
