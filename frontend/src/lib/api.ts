import { ImportedFile, PropUser, PropUserInput, RawTrade, Validation } from '../types';
import { accessToken, signOut } from './auth';
import { TradeBookRecord, TradeBookTab, tradeBookTabViewMap } from './tradeBook';

// The launcher injects the backend URL so Matalia can move off a busy port.
// The fallback keeps direct Vite development consistent with the launcher.
const configuredApiBase = import.meta.env.VITE_BACKEND_URL?.trim();
export const API_BASE = configuredApiBase || import.meta.env.BASE_URL.replace(/\/$/, '');

const GET_CACHE_TTL_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CONFIRMATION_REQUEST_TIMEOUT_MS = 120_000;
const STRATEGY_ALLOCATION_TIMEOUT_MS = 12_000;
const GET_CACHE = new Map<string, { expiresAt: number; value: unknown }>();
const TRADE_BOOK_CACHE = new Map<TradeBookTab, TradeBookResponse>();
let TRADE_BOOK_PRELOAD: Promise<TradeBookResponse> | null = null;
const STRATEGY_ALLOCATION_STORAGE_KEY = 'prop_trading_engine_strategy_allocation_snapshot_v1';
const STRATEGY_ALLOCATION_STORAGE_MAX_AGE_MS = 5 * 60 * 1000;
const TRANSIENT_API_STATUSES = new Set([502, 503, 504]);
const API_RETRY_DELAYS_MS = [300, 900, 1800];
export const API_RECOVERY_FAILED_EVENT = 'prop-api-retry-failed';
export const API_RECOVERY_EVENT = 'prop-api-recovered';
export const API_RECOVERY_ATTEMPT_KEY = 'prop_trading_engine_recovery_attempt_at';
const MATALIA_CHARGES_STORAGE_KEY = 'prop_trading_engine_matalia_charges_cache_v1';
const MATALIA_CHARGES_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const MATALIA_CHARGES_CACHE_LIMIT = 4;
const ACTUAL_POSITIONS_CACHE_KEY = 'prop_trading_engine_actual_positions_snapshot_v1';
const ACTUAL_POSITIONS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type MataliaChargesCacheEntry = { savedAt: number; value: MataliaChargesResponse };
const MATALIA_CHARGES_CACHE = new Map<string, MataliaChargesCacheEntry>();
const MATALIA_CHARGES_INFLIGHT = new Map<string, Promise<MataliaChargesResponse>>();

function mataliaChargesCacheKey(fromDate?: string, toDate?: string) {
  return `${fromDate ?? ''}|${toDate ?? ''}`;
}

function readMataliaChargesCache() {
  try {
    const raw = window.sessionStorage.getItem(MATALIA_CHARGES_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Record<string, MataliaChargesCacheEntry>;
    Object.entries(stored).forEach(([key, entry]) => {
      if (entry?.value && entry.savedAt && Date.now() - entry.savedAt <= MATALIA_CHARGES_CACHE_MAX_AGE_MS) {
        MATALIA_CHARGES_CACHE.set(key, entry);
      }
    });
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function persistMataliaChargesCache() {
  try {
    const entries = Array.from(MATALIA_CHARGES_CACHE.entries())
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, MATALIA_CHARGES_CACHE_LIMIT);
    window.sessionStorage.setItem(MATALIA_CHARGES_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function clearMataliaChargesCache() {
  MATALIA_CHARGES_CACHE.clear();
  MATALIA_CHARGES_INFLIGHT.clear();
  try {
    window.sessionStorage.removeItem(MATALIA_CHARGES_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function cacheMataliaCharges(key: string, value: MataliaChargesResponse) {
  MATALIA_CHARGES_CACHE.set(key, { savedAt: Date.now(), value });
  persistMataliaChargesCache();
  return value;
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

function invalidateGetCache() {
  GET_CACHE.clear();
  clearStrategyAllocationSnapshot();
  TRADE_BOOK_CACHE.clear();
  TRADE_BOOK_PRELOAD = null;
  clearMataliaChargesCache();
}

export type DataVersion = {
  version: number;
  updatedAt: string;
};

export type DataVersionsResponse = {
  success: boolean;
  versions: {
    allocation: DataVersion;
    strategyMaster: DataVersion;
  };
};

export type StrategyAllocationSnapshot = {
  allocation: StrategyAllocationResponse;
  master: StrategyMasterResponse;
  versions: DataVersionsResponse;
};

let STRATEGY_ALLOCATION_SNAPSHOT: StrategyAllocationSnapshot | null = null;
let STRATEGY_ALLOCATION_PRELOAD: Promise<StrategyAllocationSnapshot> | null = null;

export function clearStrategyAllocationSnapshot() {
  STRATEGY_ALLOCATION_SNAPSHOT = null;
  STRATEGY_ALLOCATION_PRELOAD = null;
  try {
    window.sessionStorage.removeItem(STRATEGY_ALLOCATION_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function readStoredStrategyAllocationSnapshot(): StrategyAllocationSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(STRATEGY_ALLOCATION_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { savedAt?: number; snapshot?: StrategyAllocationSnapshot };
    if (!stored.snapshot || !stored.savedAt || Date.now() - stored.savedAt > STRATEGY_ALLOCATION_STORAGE_MAX_AGE_MS) {
      window.sessionStorage.removeItem(STRATEGY_ALLOCATION_STORAGE_KEY);
      return null;
    }
    if (!stored.snapshot.allocation?.success || !stored.snapshot.master?.success) return null;
    return stored.snapshot;
  } catch {
    return null;
  }
}

function persistStrategyAllocationSnapshot(snapshot: StrategyAllocationSnapshot) {
  try {
    window.sessionStorage.setItem(STRATEGY_ALLOCATION_STORAGE_KEY, JSON.stringify({
      savedAt: Date.now(),
      snapshot,
    }));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  cacheResponse = true,
  preserveStrategyAllocationSnapshot = false,
): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = await accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const method = (init?.method ?? 'GET').toUpperCase();
  const cacheKey = `${method}:${path}`;
  if (method === 'GET') {
    const cached = GET_CACHE.get(cacheKey);
    if (cacheResponse && cached && cached.expiresAt > Date.now()) return cached.value as T;
    GET_CACHE.delete(cacheKey);
  } else {
    if (preserveStrategyAllocationSnapshot) GET_CACHE.clear();
    else invalidateGetCache();
  }
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = timeoutMs ? window.setTimeout(() => controller?.abort(), timeoutMs) : undefined;
  let retryAttempt = 0;
  try {
    while (true) {
      let response: Response;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          ...init,
          headers,
          signal: init?.signal ?? controller?.signal,
        });
      } catch (error) {
        if (method === 'GET' && error instanceof TypeError && retryAttempt < API_RETRY_DELAYS_MS.length) {
          await waitForRetry(API_RETRY_DELAYS_MS[retryAttempt]);
          retryAttempt += 1;
          continue;
        }
        throw error;
      }

      const body = await response.json().catch(() => null) as { message?: string; detail?: string } | null;
      if (response.status === 401) await signOut();
      if (!response.ok) {
        if (method === 'GET' && TRANSIENT_API_STATUSES.has(response.status) && retryAttempt < API_RETRY_DELAYS_MS.length) {
          await waitForRetry(API_RETRY_DELAYS_MS[retryAttempt]);
          retryAttempt += 1;
          continue;
        }
        if (method === 'GET' && TRANSIENT_API_STATUSES.has(response.status)) {
          window.dispatchEvent(new CustomEvent(API_RECOVERY_FAILED_EVENT, {
            detail: { path, status: response.status },
          }));
        }
        throw new Error(body?.message || body?.detail || `Request failed: ${response.status}`);
      }

      if (method === 'GET') window.dispatchEvent(new Event(API_RECOVERY_EVENT));
      if (method === 'GET' && cacheResponse) GET_CACHE.set(cacheKey, { expiresAt: Date.now() + GET_CACHE_TTL_MS, value: body });
      return body as T;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('This request is taking too long. Please retry.');
    }
    throw error;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export const uploadImportFiles = (files: File[]) => {
  const body = new FormData();
  files.forEach((file) => body.append('file', file));
  return request<{ files: ImportedFile[]; message?: string }>('/api/raw-trades/import', { method: 'POST', body });
};
export const uploadImportFile = (file: File) => uploadImportFiles([file]);
export const loadImportFiles = () => request<{ files: ImportedFile[] }>('/api/raw-trades/import');
export type PipelineResponse = {
  success: boolean;
  message?: string;
  failed_step?: string;
  stdout?: string;
  stderr?: string;
  return_code?: number | null;
  error?: string;
  log?: string[];
  running?: boolean;
  stage?: string;
  started_at?: string | null;
  finished_at?: string | null;
  last_run_at?: string | null;
  log_path?: string;
  files?: PipelineFileResult[];
  failed_files?: PipelineFileResult[];
};
export type PipelineFileResult = {
  name: string;
  date?: string;
  records?: number;
  status?: string;
  reason?: string;
};
export const runImportPipeline = () => request<PipelineResponse>('/api/pipeline/import', { method: 'POST' });
export type PipelineLogResponse = {
  success: boolean;
  running: boolean;
  stage: string;
  message: string;
  started_at?: string | null;
  finished_at?: string | null;
  last_run_at?: string | null;
  return_code?: number | null;
  failed_step?: string | null;
  error?: string | null;
  log: string[];
  log_path: string;
  files?: PipelineFileResult[];
  failed_files?: PipelineFileResult[];
};
export const loadImportPipelineLog = () => request<PipelineLogResponse>('/api/pipeline/import/log');
export type RawTxtDataResponse = { success: boolean; rows: Record<string, unknown>[]; total_rows: number; message?: string };
export const loadRawTxtData = () => request<RawTxtDataResponse>('/api/rawtxtdata');
export const loadRawTrades = () => request<{ files: ImportedFile[]; trades: RawTrade[]; validation: Validation[] }>('/api/raw-trades');
export const proceedToMerge = () => request('/api/raw-trades/proceed', { method: 'POST' });

export type MataliaDailyCharge = {
  report_date: string;
  nse_charges: string;
  bse_charges: string;
  gross_ledger_amount: string;
  total_charges: string;
  net_ledger_amount: string;
  reconciliation_status: string;
  fetched_at?: string;
};
export type MataliaTrade = {
  report_date: string;
  series_id: string;
  description: string;
  buy_qty: string;
  sell_qty: string;
  mtm_premium: string;
};
export type MataliaChargesResponse = {
  success: boolean;
  daily: MataliaDailyCharge[];
  trades: MataliaTrade[];
  charges: Record<string, string>[];
  total_charges: number;
  total_trades: number;
  total_days: number;
  last_fetched_at?: string | null;
  message?: string;
};
export function loadMataliaCharges(fromDate?: string, toDate?: string, options?: { force?: boolean }) {
  const params = new URLSearchParams();
  if (fromDate) params.set('from_date', fromDate);
  if (toDate) params.set('to_date', toDate);
  const key = mataliaChargesCacheKey(fromDate, toDate);
  if (!MATALIA_CHARGES_CACHE.size) readMataliaChargesCache();
  const cached = MATALIA_CHARGES_CACHE.get(key);
  if (!options?.force && cached && Date.now() - cached.savedAt <= MATALIA_CHARGES_CACHE_MAX_AGE_MS) {
    if (!MATALIA_CHARGES_INFLIGHT.has(key)) {
      void loadMataliaCharges(fromDate, toDate, { force: true }).catch(() => undefined);
    }
    return Promise.resolve(cached.value);
  }
  const inFlight = MATALIA_CHARGES_INFLIGHT.get(key);
  if (inFlight) return inFlight;
  const requestPath = `/api/matalia-charges${params.toString() ? `?${params}` : ''}`;
  const requestPromise = request<MataliaChargesResponse>(requestPath, undefined, DEFAULT_REQUEST_TIMEOUT_MS, false)
    .then((value) => cacheMataliaCharges(key, value))
    .finally(() => MATALIA_CHARGES_INFLIGHT.delete(key));
  MATALIA_CHARGES_INFLIGHT.set(key, requestPromise);
  return requestPromise;
}
export const loadMataliaNextDate = () => request<{ success: boolean; next_date: string; today: string }>('/api/matalia-charges/next-date');
export type MataliaFetchStatus = {
  success: boolean;
  status: string;
  message: string;
  log: string[];
  error?: string | null;
  captcha_available?: boolean;
  started_at?: string | null;
  finished_at?: string | null;
  captcha_ready_at?: string | null;
  elapsed_seconds?: number | null;
};
export const startMataliaFetch = (fromDate: string, toDate: string, existingAction?: 'use' | 'refetch') => request<{ success: boolean; requires_choice?: boolean; existing_dates?: string[]; status?: string; message?: string }>('/api/matalia-charges/fetch/start', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_date: fromDate, to_date: toDate, existing_action: existingAction }),
});
export const loadMataliaFetchStatus = () => request<MataliaFetchStatus>('/api/matalia-charges/fetch/status');
export const loadMataliaCaptcha = async (): Promise<string> => {
  const headers = new Headers();
  const token = await accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${API_BASE}/api/matalia-charges/fetch/captcha?ts=${Date.now()}`, { headers, cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (response.status === 401) await signOut();
      throw new Error(body?.message || `CAPTCHA image request failed: ${response.status}`);
    }
    return URL.createObjectURL(await response.blob());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('CAPTCHA image request timed out. Please retry.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};
export const submitMataliaCaptcha = (captcha: string) => request<{ success: boolean }>('/api/matalia-charges/fetch/captcha', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captcha }),
});
export const cancelMataliaFetch = () => request<{ success: boolean }>('/api/matalia-charges/fetch/cancel', { method: 'POST' });

export type TradeBookResponse = {
  success: boolean;
  view: TradeBookTab;
  rows: TradeBookRecord[];
  counts: Record<TradeBookTab, number>;
  total_rows: number;
  verification?: {
    source: string;
    checked_at: string;
    counts_match: boolean;
    rows_count: number;
    expected_rows: number;
  };
  message?: string;
};

function cacheTradeBookResponse(response: TradeBookResponse) {
  TRADE_BOOK_CACHE.set(response.view, response);
  return response;
}

export function preloadTradeBook(): Promise<TradeBookResponse> {
  const cached = TRADE_BOOK_CACHE.get('All Trades');
  if (cached) return Promise.resolve(cached);
  if (TRADE_BOOK_PRELOAD) return TRADE_BOOK_PRELOAD;
  TRADE_BOOK_PRELOAD = request<TradeBookResponse>('/api/trade-book?view=All%20Trades')
    .then(cacheTradeBookResponse)
    .finally(() => { TRADE_BOOK_PRELOAD = null; });
  return TRADE_BOOK_PRELOAD;
}

export async function loadTradeBook(view: TradeBookTab): Promise<TradeBookResponse> {
  const cached = TRADE_BOOK_CACHE.get(view);
  if (cached) return cached;
  if (view === 'All Trades') return cacheTradeBookResponse(await preloadTradeBook());

  // Open and Closed must come directly from their Supabase strategy views.
  // Filtering the All Trades snapshot loses the view-specific entry/exit fields.
  const response = await request<TradeBookResponse>(
    `/api/trade-book?view=${encodeURIComponent(tradeBookTabViewMap[view])}`,
  );
  return cacheTradeBookResponse(response);
}
export const refreshZerodhaPrices = (positions: Array<{ id: string; scrip: string; expiry: string; strike: string; optType: string }>) => request<{ success: boolean; prices: Record<string, number>; message?: string }>('/api/zerodha/refresh-prices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ positions }),
});
export type LivePriceResponse = {
  success: boolean;
  connected: boolean;
  prices: Record<string, number>;
  mapped?: number;
  last_error?: string | null;
  message?: string;
  timings?: Record<string, number>;
};
export const loadZerodhaLivePrices = () => request<LivePriceResponse>(`/api/zerodha/live-prices?ts=${Date.now()}`);
export const startZerodhaLivePrices = (positions: Array<{ id: string; scrip: string; expiry: string; strike: string; optType: string }>) => request<LivePriceResponse>('/api/zerodha/start-live-prices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ positions }),
});
export const updateOpenTradeCmps = () => request<{ success: boolean; requested: number; fetched: number; updated: number; prices: Record<string, number>; mapped?: number; last_error?: string | null; timings?: Record<string, number>; message?: string }>('/api/positions/update-cmp', { method: 'POST' });
export type ActualPositionsResponse = {
  success: boolean;
  imported: boolean;
  needs_reimport?: boolean;
  imported_at?: string | null;
  rows: TradeBookRecord[];
  total_rows: number;
  imported_count?: number;
  expiry_count?: number;
  message?: string;
};

export function loadCachedActualPositions(): ActualPositionsResponse | null {
  try {
    const raw = window.sessionStorage.getItem(ACTUAL_POSITIONS_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { savedAt?: number; value?: ActualPositionsResponse };
    if (!cached.value || !cached.savedAt || Date.now() - cached.savedAt > ACTUAL_POSITIONS_CACHE_MAX_AGE_MS) return null;
    return cached.value;
  } catch {
    return null;
  }
}

function cacheActualPositions(response: ActualPositionsResponse) {
  try {
    window.sessionStorage.setItem(ACTUAL_POSITIONS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), value: response }));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return response;
}

export const loadActualPositions = () => request<ActualPositionsResponse>('/api/actual-positions').then(cacheActualPositions);
export const importActualPositions = () => request<ActualPositionsResponse>('/api/actual-positions/import', { method: 'POST' }).then(cacheActualPositions);
export type ActualPositionCreatePayload = {
  strategyName: string;
  date: string;
  time: string;
  instrument: string;
  expiry: string;
  strike: number;
  option: string;
  qty: number;
  entryPrice: number;
  side: 'BUY' | 'SELL';
};
export const addActualPosition = (payload: ActualPositionCreatePayload) => request<ActualPositionsResponse>('/api/actual-positions/rows', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}).then(cacheActualPositions);
export type ActualPositionStrategyQuoteRow = {
  strategyName: string;
  qty: number;
  option: 'CE' | 'PE' | string;
  strike: string;
  entryPrice: number | null;
  livePrice?: number | null;
};
export type ActualPositionStrategyQuoteResponse = {
  success: boolean;
  strategy: string;
  instrument: string;
  side?: 'BUY' | 'SELL' | null;
  expiry_choices: Array<{ value: string; label: string; dte: string }>;
  rows: ActualPositionStrategyQuoteRow[];
  underlying_price?: number | null;
  atm?: number | null;
  strike_choices?: number[];
  quote_error?: string | null;
  manual_required?: boolean;
  message?: string;
};
export const loadActualPositionStrategyQuotes = (payload: { strategy: string; expiry?: string; option?: string; side?: string; underlyingPrice?: number | null; strike?: number | null; strategyName?: string }) => request<ActualPositionStrategyQuoteResponse>('/api/actual-positions/strategy-quotes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
export const addActualPositionsBulk = (rows: ActualPositionCreatePayload[]) => request<ActualPositionsResponse>('/api/actual-positions/rows/bulk', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rows }),
}).then(cacheActualPositions);
export const updateActualPosition = (positionId: string, payload: ActualPositionCreatePayload) => request<ActualPositionsResponse>(`/api/actual-positions/rows/${encodeURIComponent(positionId)}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}).then(cacheActualPositions);
export const deleteActualPosition = (positionId: string) => request<ActualPositionsResponse>(`/api/actual-positions/rows/${encodeURIComponent(positionId)}`, {
  method: 'DELETE',
}).then(cacheActualPositions);
export const deleteTradeBookTrade = (tradeId: string) => request<{ success: boolean; message: string }>(`/api/trade-book/${encodeURIComponent(tradeId)}`, { method: 'DELETE' });

export type StrategyAllocationRow = {
  id: string;
  date: string;
  time: string;
  tradeId: string;
  side: string;
  scrip: string;
  expiry: string;
  strike: string;
  optType: string;
  qty: number;
  price: number;
  account?: string;
  mtm: number;
  strategy: string;
  status: string;
  bucket: 'Open' | 'Unassigned';
  source: string;
  sourceId?: string;
  splitTradeId?: string;
};

export type StrategyAllocationResponse = {
  success: boolean;
  rows: StrategyAllocationRow[];
  counts: {
    'Open Trades': number;
    'Unassigned Trades': number;
    'Allocated Trades': number;
    Strategies: number;
  };
  total_rows: number;
  verification?: {
    source: string;
    checked_at: string;
    counts_match: boolean;
    open_rows: number;
    unassigned_rows: number;
    expected_rows: number;
  };
  message?: string;
};

export const loadStrategyAllocation = (fresh = false) => request<StrategyAllocationResponse>(fresh ? `/api/strategy-allocation?fresh=1&ts=${Date.now()}` : '/api/strategy-allocation', undefined, STRATEGY_ALLOCATION_TIMEOUT_MS);

export type StrategyMasterRow = {
  mappingId: number | null;
  parentQty: number | null;
  expiry: string;
  instrument: string;
  seq: number | null;
  splitMethod: string;
  splitPercentage: number | null;
  splitQty: number | null;
  strategyName: string;
  active: boolean;
};

export type StrategyMasterResponse = {
  success: boolean;
  rows: StrategyMasterRow[];
  total_rows: number;
  message?: string;
};

export const loadStrategyMaster = () => request<StrategyMasterResponse>('/api/strategy-master');

export const loadDataVersions = () => request<DataVersionsResponse>('/api/data-versions', undefined, DEFAULT_REQUEST_TIMEOUT_MS, false);

export function getStrategyAllocationSnapshot() {
  return STRATEGY_ALLOCATION_SNAPSHOT;
}

export function applyConfirmedStrategyAllocations(rows: StrategyAllocationConfirmationRow[]): StrategyAllocationResponse | undefined {
  const snapshot = STRATEGY_ALLOCATION_SNAPSHOT;
  if (!snapshot || !rows.length) return snapshot?.allocation;

  const matchesConfirmation = (allocationRow: StrategyAllocationRow, confirmation: StrategyAllocationConfirmationRow) => {
    if (allocationRow.source !== confirmation.source) return false;
    if (allocationRow.source === 'strategy_open') {
      return allocationRow.id === confirmation.sourceId ||
        allocationRow.tradeId === confirmation.sourceId ||
        allocationRow.tradeId === confirmation.tradeId;
    }
    if (confirmation.splitTradeId && allocationRow.splitTradeId) {
      return allocationRow.splitTradeId === confirmation.splitTradeId && allocationRow.sourceId === confirmation.sourceId;
    }
    return allocationRow.sourceId === confirmation.sourceId && allocationRow.tradeId === confirmation.tradeId;
  };

  const updatedRows = snapshot.allocation.rows.flatMap((allocationRow) => {
    const confirmation = rows.find((candidate) => matchesConfirmation(allocationRow, candidate));
    if (!confirmation) return [allocationRow];
    if (allocationRow.source === 'strategy_open') return [{ ...allocationRow, strategy: confirmation.strategyName }];
    return [];
  });

  const updatedAllocation: StrategyAllocationResponse = {
    ...snapshot.allocation,
    rows: updatedRows,
    total_rows: updatedRows.length,
    counts: {
      ...snapshot.allocation.counts,
      'Open Trades': updatedRows.filter((row) => row.bucket === 'Open').length,
      'Unassigned Trades': updatedRows.filter((row) => !row.strategy || row.strategy.trim().toLowerCase() === 'unassigned').length,
    },
  };
  STRATEGY_ALLOCATION_SNAPSHOT = { ...snapshot, allocation: updatedAllocation };
  persistStrategyAllocationSnapshot(STRATEGY_ALLOCATION_SNAPSHOT);
  return updatedAllocation;
}

export function preloadStrategyAllocation(
  force = false,
  onAllocation?: (allocation: StrategyAllocationResponse) => void,
): Promise<StrategyAllocationSnapshot> {
  if (!force && !STRATEGY_ALLOCATION_SNAPSHOT) {
    STRATEGY_ALLOCATION_SNAPSHOT = readStoredStrategyAllocationSnapshot();
  }
  if (!force && STRATEGY_ALLOCATION_SNAPSHOT) {
    onAllocation?.(STRATEGY_ALLOCATION_SNAPSHOT.allocation);
    return Promise.resolve(STRATEGY_ALLOCATION_SNAPSHOT);
  }
  if (!force && STRATEGY_ALLOCATION_PRELOAD) {
    STRATEGY_ALLOCATION_PRELOAD.then(({ allocation }) => onAllocation?.(allocation)).catch(() => undefined);
    return STRATEGY_ALLOCATION_PRELOAD;
  }

  const allocationRequest = loadStrategyAllocation(force);
  // Let the page render the primary dataset without waiting for secondary
  // metadata requests to finish.
  allocationRequest.then((allocation) => onAllocation?.(allocation)).catch(() => undefined);

  const preload = Promise.all([
    allocationRequest,
    loadStrategyMaster(),
    loadDataVersions(),
  ]).then(([allocation, master, versions]) => {
    const snapshot = { allocation, master, versions };
    STRATEGY_ALLOCATION_SNAPSHOT = snapshot;
    persistStrategyAllocationSnapshot(snapshot);
    return snapshot;
  }).finally(() => {
    STRATEGY_ALLOCATION_PRELOAD = null;
  });
  STRATEGY_ALLOCATION_PRELOAD = preload;
  return preload;
}

export async function revalidateStrategyAllocationSnapshot(): Promise<StrategyAllocationSnapshot> {
  const cached = STRATEGY_ALLOCATION_SNAPSHOT;
  if (!cached) return preloadStrategyAllocation(false);

  const versions = await loadDataVersions();
  const unchanged = versions.versions.allocation.version === cached.versions.versions.allocation.version &&
    versions.versions.allocation.updatedAt === cached.versions.versions.allocation.updatedAt &&
    versions.versions.strategyMaster.version === cached.versions.versions.strategyMaster.version &&
    versions.versions.strategyMaster.updatedAt === cached.versions.versions.strategyMaster.updatedAt;
  if (unchanged) {
    STRATEGY_ALLOCATION_SNAPSHOT = { ...cached, versions };
    return STRATEGY_ALLOCATION_SNAPSHOT;
  }
  return preloadStrategyAllocation(true);
}

export function preloadWorkspaceData() {
  void preloadStrategyAllocation(false).catch(() => undefined);
}

export type StrategyReportResponse = import('../components/strategy-report/report-data').ReportData;
export const loadStrategyReport = (filters?: { fromDate?: string; toDate?: string; instrument?: string; strategy?: string }) => {
  const params = new URLSearchParams();
  Object.entries(filters ?? {}).forEach(([key, value]) => { if (value) params.set(key, value); });
  return request<StrategyReportResponse>(`/api/strategy-report${params.toString() ? `?${params.toString()}` : ''}`);
};
export const suggestNextStrategyExpiries = (expiries: string[]) =>
  request<{ success: boolean; expiries: string[] }>('/api/strategy-master/next-expiry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiries }),
  });
export const deleteStrategyMaster = (mappingId: number, strategyName: string) =>
  request<StrategyMasterResponse & { deletedRows: number }>('/api/strategy-master', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mappingId, strategyName }),
  });

export type StrategySetupAccount = { name: string; qty: number };
export type StrategySetupPayload = {
  mappingId?: number | null;
  originalStrategyName?: string;
  strategyName: string;
  expiries: string[];
  instrument: string;
  parentQty: number;
  splitRequired: boolean;
  splitMethod: string;
  accounts: StrategySetupAccount[];
};
export type StrategySetupResponse = {
  success: boolean;
  message: string;
  rows: StrategyMasterRow[];
  updatedRows?: number;
};

export const saveStrategySetup = (payload: StrategySetupPayload) =>
  request<StrategySetupResponse>('/api/strategy-master', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export type StrategyAllocationConfirmationRow = {
  tradeId: string;
  source: string;
  sourceId: string;
  splitTradeId?: string;
  instrument: string;
  expiry: string;
  strike: string;
  option: string;
  side: string;
  qty: number;
  price: number;
  strategyName: string;
};

export type StrategyAllocationConfirmResponse = {
  success: boolean;
  processed_count?: number;
  merge_count?: number;
  split_count?: number;
  allocation_count?: number;
  skipped_count?: number;
  merge_trades_created?: number;
  split_trades_created?: number;
  allocations_created?: number;
  errors?: string[];
  message?: string;
  updated_rows?: number;
};

export type ConfirmationProgressResponse = {
  success: boolean;
  progress_id: string;
  status: 'running' | 'completed' | 'failed';
  stage: 'preparing' | 'loading' | 'processing' | 'finalizing' | 'completed' | 'failed';
  total_rows: number;
  completed_rows: number;
  processed_count: number;
  skipped_count: number;
  current_index: number;
  current_trade?: string | null;
  current_process?: {
    trade_index: number;
    step_key: string;
    label: string;
    detail: string;
  } | null;
  trade_processes?: Array<Array<{
    key: string;
    label: string;
    status: 'waiting' | 'processing' | 'completed' | 'skipped' | 'failed';
    detail: string;
    duration_ms?: number | null;
  }>>;
  row_statuses: Array<'waiting' | 'processing' | 'completed' | 'skipped' | 'failed'>;
  message: string;
  error?: string | null;
};

export const confirmStrategyAllocations = (rows: StrategyAllocationConfirmationRow[], progressId?: string) =>
  request<StrategyAllocationConfirmResponse>('/api/instrument-allocation/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rows, progressId }),
  }, CONFIRMATION_REQUEST_TIMEOUT_MS, true, true);

export const loadConfirmationProgress = (progressId: string) =>
  request<ConfirmationProgressResponse>(
    `/api/instrument-allocation/confirm/progress/${encodeURIComponent(progressId)}`,
    undefined,
    DEFAULT_REQUEST_TIMEOUT_MS,
    false,
  );

export type SplitTradePayload = {
  rawTradeId?: string;
  splitTradeId?: string;
  originalQty: number;
  quantities: number[];
};

export type SplitTradeResponse = { success: boolean; message: string };

export const splitInstrumentTrade = (payload: SplitTradePayload) =>
  request<SplitTradeResponse>('/api/instrument-allocation/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw_trade_id: payload.rawTradeId ? Number(payload.rawTradeId) : undefined,
      split_trade_id: payload.splitTradeId ? Number(payload.splitTradeId) : undefined,
      original_qty: payload.originalQty,
      quantities: payload.quantities,
    }),
  });

export type MergeTradesPayload = {
  rawTradeIds: string[];
};

export const mergeInstrumentTrades = (payload: MergeTradesPayload) =>
  request<SplitTradeResponse>('/api/instrument-allocation/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_trade_ids: payload.rawTradeIds.map(Number) }),
  });

export const getPropUsers = () => request<PropUser[]>('/api/users');

export const createPropUser = (payload: PropUserInput) => request<PropUser>('/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export const updatePropUser = (userId: number, payload: PropUserInput) => request<PropUser>(`/api/users/${userId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
