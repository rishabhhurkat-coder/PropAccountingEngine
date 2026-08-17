import { ImportedFile, RawTrade, Validation } from '../types';
import { TradeBookRecord, TradeBookTab, tradeBookTabViewMap } from './tradeBook';

// The launcher injects the backend URL so Matalia can move off a busy port.
// The fallback keeps direct Vite development consistent with the launcher.
export const API_BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8001';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const body = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(body?.message || `Request failed: ${response.status}`);
  return body as T;
}

export const uploadImportFile = (file: File) => {
  const body = new FormData();
  body.append('file', file);
  return request<{ files: ImportedFile[]; message?: string }>('/api/raw-trades/import', { method: 'POST', body });
};
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
  total_charges: string;
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
export const loadMataliaCharges = (fromDate?: string, toDate?: string) => {
  const params = new URLSearchParams();
  if (fromDate) params.set('from_date', fromDate);
  if (toDate) params.set('to_date', toDate);
  return request<MataliaChargesResponse>(`/api/matalia-charges${params.toString() ? `?${params}` : ''}`);
};
export const loadMataliaNextDate = () => request<{ success: boolean; next_date: string; today: string }>('/api/matalia-charges/next-date');
export type MataliaFetchStatus = { success: boolean; status: string; message: string; log: string[]; error?: string | null; captcha_available?: boolean; started_at?: string | null; finished_at?: string | null };
export const startMataliaFetch = (fromDate: string, toDate: string, existingAction?: 'use' | 'refetch') => request<{ success: boolean; requires_choice?: boolean; existing_dates?: string[]; status?: string; message?: string }>('/api/matalia-charges/fetch/start', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_date: fromDate, to_date: toDate, existing_action: existingAction }),
});
export const loadMataliaFetchStatus = () => request<MataliaFetchStatus>('/api/matalia-charges/fetch/status');
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
  message?: string;
};

export const loadTradeBook = (view: TradeBookTab) => request<TradeBookResponse>(`/api/trade-book?view=${encodeURIComponent(tradeBookTabViewMap[view])}`);
export const refreshZerodhaPrices = (positions: Array<{ id: string; scrip: string; expiry: string; strike: string; optType: string }>) => request<{ success: boolean; prices: Record<string, number>; message?: string }>('/api/zerodha/refresh-prices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ positions }),
});
export const loadZerodhaLivePrices = () => request<{ success: boolean; connected: boolean; prices: Record<string, number>; message?: string }>('/api/zerodha/live-prices');
export const startZerodhaLivePrices = (positions: Array<{ id: string; scrip: string; expiry: string; strike: string; optType: string }>) => request<{ success: boolean; connected: boolean; prices: Record<string, number>; message?: string }>('/api/zerodha/start-live-prices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ positions }),
});
export const updateOpenTradeCmps = () => request<{ success: boolean; requested: number; fetched: number; updated: number; message?: string }>('/api/positions/update-cmp', { method: 'POST' });
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
  message?: string;
};

export const loadStrategyAllocation = () => request<StrategyAllocationResponse>('/api/strategy-allocation');

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

export const confirmStrategyAllocations = (rows: StrategyAllocationConfirmationRow[]) =>
  request<StrategyAllocationConfirmResponse>('/api/instrument-allocation/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rows }),
  });

export type SplitTradePayload = {
  rawTradeId: string;
  originalQty: number;
  quantities: number[];
};

export type SplitTradeResponse = { success: boolean; message: string };

export const splitInstrumentTrade = (payload: SplitTradePayload) =>
  request<SplitTradeResponse>('/api/instrument-allocation/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw_trade_id: Number(payload.rawTradeId),
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
