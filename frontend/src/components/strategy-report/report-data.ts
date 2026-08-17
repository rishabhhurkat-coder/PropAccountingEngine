import { createContext, useContext } from 'react';

export type ReportRow = {
  name: string;
  pnl: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
};

export type ReportData = {
  filters: { fromDate: string | null; toDate: string | null; instrument: string; strategy: string };
  stats: { totalPnl: number; totalTrades: number; winRate: number; profitFactor: number; avgWin: number; avgLoss: number; maxDrawdown: number };
  pnlTrend: Array<{ date: string; pnl: number; cumulative: number }>;
  contributions: Array<ReportRow & { value: number; pct: number }>;
  strategyRows: ReportRow[];
  profitFactorDist: Array<{ bucket: string; count: number; color: string }>;
  heatmap: Array<{ year: number; values: Array<number | null>; total: number }>;
  dayOfWeek: Array<{ day: string; value: number }>;
  timeOfDay: Array<{ time: string; value: number }>;
  winningLosing: { profitablePct: number; profitableCount: number; profitableTotalPct: number; losingCount: number; losingTotalPct: number };
};

export const emptyReport: ReportData = {
  filters: { fromDate: null, toDate: null, instrument: 'All Instruments', strategy: 'All Strategies' },
  stats: { totalPnl: 0, totalTrades: 0, winRate: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, maxDrawdown: 0 },
  pnlTrend: [], contributions: [], strategyRows: [], profitFactorDist: [], heatmap: [], dayOfWeek: [], timeOfDay: [],
  winningLosing: { profitablePct: 0, profitableCount: 0, profitableTotalPct: 0, losingCount: 0, losingTotalPct: 0 },
};

export const ReportDataContext = createContext<ReportData>(emptyReport);
export const useReportData = () => useContext(ReportDataContext);

export function formatINR(value: number) {
  const abs = Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? '-' : ''}₹ ${abs}`;
}
