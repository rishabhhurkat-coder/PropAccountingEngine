import { ReportHeader } from '../components/strategy-report/report-header';
import { StatCards } from '../components/strategy-report/stat-cards';
import { PnlTrendChart } from '../components/strategy-report/pnl-trend-chart';
import { PnlContributionChart } from '../components/strategy-report/pnl-contribution-chart';
import { WinningLosingGauge } from '../components/strategy-report/winning-losing-gauge';
import { ProfitFactorDistribution } from '../components/strategy-report/distribution-charts';
import { StrategyTable } from '../components/strategy-report/strategy-table';
import { MonthlyHeatmap } from '../components/strategy-report/monthly-heatmap';
import { DayOfWeekChart, TimeOfDayChart } from '../components/strategy-report/timing-charts';
import { emptyReport, ReportDataContext, type ReportData } from '../components/strategy-report/report-data';

export function StrategyReport() {
  const [report, setReport] = useState<ReportData>(emptyReport);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { let cancelled = false; setLoading(true); loadStrategyReport().then((data) => { if (!cancelled) setReport(data); }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load strategy report.'); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, []);
  return <ReportDataContext.Provider value={report}><main className="strategy-report-v0"><ReportHeader/><>{loading && <div className="v0-report-state">Loading live strategy report...</div>}{error && <div className="v0-report-state v0-report-error">{error}</div>}</><StatCards/><section className="v0-top-grid"><PnlTrendChart/><PnlContributionChart/><WinningLosingGauge/></section><section className="v0-table-grid"><div><StrategyTable/></div><aside><ProfitFactorDistribution/></aside></section><section className="v0-bottom-grid"><MonthlyHeatmap/><DayOfWeekChart/><TimeOfDayChart/></section></main></ReportDataContext.Provider>;
}
import { useEffect, useState } from 'react';
import { loadStrategyReport } from '../lib/api';
