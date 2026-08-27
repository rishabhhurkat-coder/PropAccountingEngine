import { useEffect, useMemo, useState } from 'react';
import { Activity, Download, RefreshCw, ReceiptIndianRupee, Search } from 'lucide-react';
import { cancelMataliaFetch, loadMataliaCaptcha, loadMataliaCharges, loadMataliaFetchStatus, loadMataliaNextDate, MataliaChargesResponse, MataliaFetchStatus, startMataliaFetch, submitMataliaCaptcha } from '../lib/api';
import Calendar from '../components/Calendar';
import './matalia-charges.css';
import './matalia-charges-overrides.css';

const inr = (value: number | string) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatReportDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
};
const ledgerTone = (value: string | number) => Number(value) > 0 ? 'positive' : Number(value) < 0 ? 'negative' : 'neutral';
type ProgressState = 'done' | 'active' | 'pending';

export function MataliaCharges() {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [data, setData] = useState<MataliaChargesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fetchStatus, setFetchStatus] = useState<MataliaFetchStatus | null>(null);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [existingDates, setExistingDates] = useState<string[]>([]);
  const [captcha, setCaptcha] = useState('');
  const [captchaLoaded, setCaptchaLoaded] = useState(false);
  const [captchaUrl, setCaptchaUrl] = useState('');
  const [captchaError, setCaptchaError] = useState('');
  const [captchaReload, setCaptchaReload] = useState(0);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loadMataliaCharges(fromDate, toDate, { force: true }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load Matalia charges.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Load the table and date controls independently so a slow/failed helper
    // request cannot block already-available cached charges from rendering.
    void loadMataliaCharges().then((charges) => {
      setData(charges);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load Matalia charges.'));
    void loadMataliaNextDate().then(({ next_date, today }) => {
      const end = today >= next_date ? today : next_date;
      setFromDate(next_date);
      setToDate(end);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load the next fetch date.'));
  }, []);

  useEffect(() => {
    if (!fetchOpen) return;
    let polling = false;
    const poll = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const status = await loadMataliaFetchStatus();
        setFetchStatus(status);
        if (status.status === 'completed' || status.status === 'error') {
          window.clearInterval(poll);
          if (status.status === 'completed') await refresh();
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to read fetch status.');
      } finally {
        polling = false;
      }
    }, 1500);
    void loadMataliaFetchStatus().then(setFetchStatus).catch(() => undefined);
    return () => window.clearInterval(poll);
  }, [fetchOpen]);

  useEffect(() => {
    if (fetchStatus?.status !== 'waiting_captcha') return;
    let active = true;
    let objectUrl = '';
    setCaptchaLoaded(false);
    setCaptchaError('');
    setCaptchaUrl('');
    void loadMataliaCaptcha().then((url) => {
      objectUrl = url;
      if (active) setCaptchaUrl(url);
      else URL.revokeObjectURL(url);
    }).catch((caught) => {
      if (active) setCaptchaError(caught instanceof Error ? caught.message : 'The CAPTCHA image could not be loaded.');
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fetchStatus?.status, captchaReload]);

  const startFetch = async (existingAction?: 'use' | 'refetch') => {
    setError('');
    try {
      const response = await startMataliaFetch(fromDate, toDate, existingAction);
      if (response.requires_choice) {
        setExistingDates(response.existing_dates ?? []);
        return;
      }
      setFetchStatus({ success: true, status: 'running', message: 'Starting…', log: [] });
      setFetchOpen(true);
      setExistingDates([]);
      setCaptchaLoaded(false);
      setCaptchaUrl('');
      setCaptchaError('');
      setCaptchaReload(0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to start report fetch.');
    }
  };

  const sendCaptcha = async () => {
    try {
      await submitMataliaCaptcha(captcha);
      setCaptcha('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to submit CAPTCHA.');
    }
  };

  const cancelFetch = async () => {
    try {
      await cancelMataliaFetch();
      setFetchOpen(false);
      setFetchStatus(null);
      setExistingDates([]);
      setCaptcha('');
      setCaptchaLoaded(false);
      setCaptchaUrl('');
      setCaptchaError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to cancel report fetch.');
    }
  };

  const fetchProgress = useMemo(() => {
    const logs = fetchStatus?.log ?? [];
    const dateEvents = logs.map((line) => {
      const match = line.match(/^REPORT_PROGRESS\|([^|]+)\|([^|]+)\|\d+\|(\d+)$/);
      return match ? { exchange: match[1] === 'BNF' ? 'NSE' : match[1], date: match[2], total: Number(match[3]) } : null;
    }).filter((event): event is { exchange: string; date: string; total: number } => Boolean(event));
    const has = (text: string) => logs.some((line) => line.toLowerCase().includes(text.toLowerCase()));
    const captchaReady = fetchStatus?.status === 'waiting_captcha' || has('captcha image saved');
    const nseStarted = has('downloading bnf') || has('downloading nse');
    const nseDone = has('downloaded ') && (has(' bnf report') || has(' nse report'));
    const bseStarted = has('downloading bse');
    const bseDone = has(' bse report');
    const processing = has('processing all reports');
    const completed = fetchStatus?.status === 'completed';
    const steps: Array<{ label: string; state: ProgressState }> = [
      { label: 'Connect and authenticate', state: captchaReady || nseStarted ? 'done' : 'active' },
      { label: 'Download NSE reports', state: nseDone ? 'done' : nseStarted ? 'active' : 'pending' },
      { label: 'Download BSE reports', state: bseDone ? 'done' : bseStarted ? 'active' : 'pending' },
      { label: 'Process and save combined report', state: completed ? 'done' : processing ? 'active' : 'pending' },
    ];
    if (fetchStatus?.status === 'waiting_captcha') steps[0].state = 'active';
    const doneCount = steps.filter((step) => step.state === 'done').length;
    const latestEvent = dateEvents[dateEvents.length - 1];
    const exchangeEvents = latestEvent ? dateEvents.filter((event) => event.exchange === latestEvent.exchange) : [];
    const dateActivity = latestEvent ? {
      exchange: latestEvent.exchange,
      current: latestEvent.date,
      completed: exchangeEvents.length,
      total: latestEvent.total,
      pending: Math.max(latestEvent.total - exchangeEvents.length, 0),
      recent: exchangeEvents.slice(-3).map((event) => event.date),
    } : null;
    return { steps, percent: completed ? 100 : Math.round((doneCount / steps.length) * 100), latest: fetchStatus?.message ?? 'Preparing…', dateActivity };
  }, [fetchStatus]);

  return <main className="matalia-page">
    <header className="matalia-header">
      <div>
        <div className="section-eyebrow">MATALIA REPORTS</div>
        <h1>Matalia Charges</h1>
      </div>
      <button className="matalia-refresh" type="button" onClick={() => void refresh()} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin' : ''} /> {loading ? 'Loading…' : 'Refresh data'}
      </button>
    </header>

    <section className="matalia-filter-card">
      <div className="matalia-filter-content">
        <div className="matalia-date-field"><Calendar label="From" value={fromDate} onChange={setFromDate} /></div>
        <div className="matalia-date-field"><Calendar label="To" value={toDate} minDate={fromDate} onChange={setToDate} /></div>
        <button className="matalia-primary" type="button" onClick={() => void refresh()}><Search size={15} /> Apply range</button>
        <button className="matalia-fetch" type="button" onClick={() => void startFetch()}><Download size={15} /> Fetch reports</button>
      </div>
    </section>

    {error && <div className="matalia-error">{error}</div>}
    {data?.message && !data.daily.length && <div className="matalia-empty">{data.message}</div>}

    <section className="matalia-kpis">
      <div className="matalia-kpi"><span><ReceiptIndianRupee size={16} /> Total charges</span><strong>{inr(data?.total_charges ?? 0)}</strong></div>
    </section>

    <section className="matalia-panel">
      <div className="matalia-panel-head"><div><h2>Charges by day</h2></div></div>
      <div className="matalia-table-wrap"><table className="matalia-table"><thead><tr><th>Date</th><th>Gross ledger amount</th><th>Total charges</th><th>Net ledger amount</th></tr></thead><tbody>
        {(data?.daily ?? []).map((row) => <tr key={row.report_date}><td className="matalia-report-date">{formatReportDate(row.report_date)}</td><td className={`ledger-value ${ledgerTone(row.gross_ledger_amount)}`}>{inr(row.gross_ledger_amount)}</td><td className="charge-value">{inr(row.total_charges)}</td><td className={`ledger-value ${ledgerTone(row.net_ledger_amount)}`}>{inr(row.net_ledger_amount)}</td></tr>)}
      </tbody></table></div>
    </section>

    {(existingDates.length > 0 || fetchOpen) && <div className="matalia-modal-backdrop">
      <div className="matalia-modal">
        {existingDates.length > 0 ? <>
          <div className="section-eyebrow">EXISTING DATA</div><h2>Dates already stored</h2>
          <p>The selected range contains existing dates. Choose whether to reuse them or refetch and overwrite them.</p>
          <div className="matalia-existing-dates">{existingDates.map((date) => <span key={date}>{date}</span>)}</div>
          <div className="matalia-modal-actions"><button className="matalia-secondary" type="button" onClick={() => setExistingDates([])}>Cancel</button><button className="matalia-secondary" type="button" onClick={() => void startFetch('use')}>Use existing</button><button className="matalia-primary" type="button" onClick={() => void startFetch('refetch')}>Refetch & overwrite</button></div>
        </> : <>
          <div className="section-eyebrow">FETCHING REPORTS</div><h2>{fetchStatus?.status === 'waiting_captcha' ? 'Enter CAPTCHA' : 'Fetching one day at a time'}</h2>
          <p>{fetchStatus?.message ?? 'Preparing the Jobber report session…'}</p>
          {fetchStatus?.status === 'running' && (fetchStatus.elapsed_seconds ?? 0) >= 45 && <div className="matalia-fetch-timeout"><Activity size={14} /> Authentication is taking longer than 45 seconds. Check the Jobber portal/credentials, or cancel and retry.</div>}
          <div className="matalia-fetch-progress"><div className="matalia-fetch-progress-head"><span>Progress</span><strong>{fetchProgress.percent}%</strong></div><div className="matalia-progress"><span style={{ width: `${Math.max(fetchProgress.percent, 4)}%` }} /></div><div className="matalia-progress-latest">Latest: {fetchProgress.latest}</div>{fetchProgress.dateActivity && <div className="matalia-date-progress"><div><strong>{fetchProgress.dateActivity.exchange}</strong><span>Current date: {fetchProgress.dateActivity.current}</span></div><div><strong>{fetchProgress.dateActivity.completed}/{fetchProgress.dateActivity.total}</strong><span>Done · {fetchProgress.dateActivity.pending} pending</span></div><small>Recently completed: {fetchProgress.dateActivity.recent.join(', ')}</small></div>}<div className="matalia-progress-steps">{fetchProgress.steps.map((step) => <div className={`matalia-progress-step ${step.state}`} key={step.label}><span className="matalia-progress-dot" /> <span>{step.label}</span><em>{step.state === 'done' ? 'Done' : step.state === 'active' ? 'Working' : 'Pending'}</em></div>)}</div></div>
          {fetchStatus?.status === 'waiting_captcha' && <>{captchaError ? <div className="matalia-error"><strong>CAPTCHA could not be loaded.</strong> {captchaError}<button className="matalia-inline-retry" type="button" onClick={() => setCaptchaReload((value) => value + 1)}>Try again</button></div> : <>{!captchaLoaded && <div className="matalia-image-loading">Loading CAPTCHA image…</div>}<img className={`matalia-captcha ${captchaLoaded ? '' : 'hidden'}`} src={captchaUrl} alt="Jobber CAPTCHA" onLoad={() => setCaptchaLoaded(true)} onError={() => { setCaptchaLoaded(false); setCaptchaError('The authenticated image request was rejected or expired.'); }} />{captchaLoaded && <div className="matalia-captcha-row"><input value={captcha} onChange={(event) => setCaptcha(event.target.value)} placeholder="Enter CAPTCHA" autoFocus /><button className="matalia-primary" type="button" onClick={() => void sendCaptcha()}>Submit</button></div>}</>}</>}
          {fetchStatus?.status === 'error' && <div className="matalia-error">{fetchStatus.error || fetchStatus.message}</div>}
          <div className="matalia-modal-actions">{fetchStatus?.status === 'completed' ? <button className="matalia-primary" type="button" onClick={() => setFetchOpen(false)}>Close</button> : <button className="matalia-secondary" type="button" onClick={() => void cancelFetch()}>Cancel</button>}</div>
        </>}
      </div>
    </div>}
  </main>;
}
