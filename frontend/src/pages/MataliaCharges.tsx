import { useEffect, useMemo, useState } from 'react';
import { Activity, CalendarDays, ChevronDown, ChevronUp, Download, RefreshCw, ReceiptIndianRupee, Search } from 'lucide-react';
import { API_BASE, cancelMataliaFetch, loadMataliaCharges, loadMataliaFetchStatus, loadMataliaNextDate, MataliaChargesResponse, MataliaFetchStatus, startMataliaFetch, submitMataliaCaptcha } from '../lib/api';
import Calendar from '../components/Calendar';
import './matalia-charges.css';
import './matalia-charges-overrides.css';

const inr = (value: number | string) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  const [filterOpen, setFilterOpen] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loadMataliaCharges(fromDate, toDate));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load Matalia charges.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMataliaNextDate().then(async ({ next_date, today }) => {
      const end = today >= next_date ? today : next_date;
      setFromDate(next_date);
      setToDate(end);
      setData(await loadMataliaCharges());
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load the next fetch date.'));
  }, []);

  useEffect(() => {
    if (!fetchOpen) return;
    const poll = window.setInterval(async () => {
      try {
        const status = await loadMataliaFetchStatus();
        setFetchStatus(status);
        if (status.status === 'completed' || status.status === 'error') {
          window.clearInterval(poll);
          if (status.status === 'completed') await refresh();
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to read fetch status.');
      }
    }, 900);
    void loadMataliaFetchStatus().then(setFetchStatus).catch(() => undefined);
    return () => window.clearInterval(poll);
  }, [fetchOpen]);

  useEffect(() => {
    if (fetchStatus?.status === 'waiting_captcha') {
      setCaptchaLoaded(false);
      setCaptchaUrl(`${API_BASE}/api/matalia-charges/fetch/captcha?ts=${Date.now()}`);
    }
  }, [fetchStatus?.status]);

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

    <section className={`matalia-filter-card ${filterOpen ? '' : 'collapsed'}`}>
      <button className="matalia-filter-toggle" type="button" onClick={() => setFilterOpen((open) => !open)} aria-expanded={filterOpen} aria-label={filterOpen ? 'Collapse report filters' : 'Expand report filters'} title={filterOpen ? 'Collapse report filters' : 'Expand report filters'}>
        {filterOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
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
      <div className="matalia-kpi"><span><CalendarDays size={16} /> Report days</span><strong>{data?.total_days ?? 0}</strong></div>
    </section>

    <section className="matalia-panel">
      <div className="matalia-panel-head"><div><h2>Charges by day</h2></div><span>{data?.last_fetched_at ? `Last fetched ${data.last_fetched_at.replace('T', ' ')}` : 'No data loaded'}</span></div>
      <div className="matalia-table-wrap"><table className="matalia-table"><thead><tr><th>Date</th><th>NSE charges</th><th>BSE charges</th><th>Total charges</th><th>Status</th></tr></thead><tbody>
        {(data?.daily ?? []).map((row) => <tr key={row.report_date}><td>{row.report_date}</td><td>{inr(row.nse_charges)}</td><td>{inr(row.bse_charges)}</td><td className="charge-value">{inr(row.total_charges)}</td><td><span className={`matalia-status ${row.reconciliation_status}`}>{row.reconciliation_status}</span></td></tr>)}
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
          <div className="matalia-fetch-progress"><div className="matalia-fetch-progress-head"><span>Progress</span><strong>{fetchProgress.percent}%</strong></div><div className="matalia-progress"><span style={{ width: `${Math.max(fetchProgress.percent, 4)}%` }} /></div><div className="matalia-progress-latest">Latest: {fetchProgress.latest}</div>{fetchProgress.dateActivity && <div className="matalia-date-progress"><div><strong>{fetchProgress.dateActivity.exchange}</strong><span>Current date: {fetchProgress.dateActivity.current}</span></div><div><strong>{fetchProgress.dateActivity.completed}/{fetchProgress.dateActivity.total}</strong><span>Done · {fetchProgress.dateActivity.pending} pending</span></div><small>Recently completed: {fetchProgress.dateActivity.recent.join(', ')}</small></div>}<div className="matalia-progress-steps">{fetchProgress.steps.map((step) => <div className={`matalia-progress-step ${step.state}`} key={step.label}><span className="matalia-progress-dot" /> <span>{step.label}</span><em>{step.state === 'done' ? 'Done' : step.state === 'active' ? 'Working' : 'Pending'}</em></div>)}</div></div>
          {fetchStatus?.status === 'waiting_captcha' && <>{!captchaLoaded && <div className="matalia-image-loading">Loading CAPTCHA image…</div>}<img className={`matalia-captcha ${captchaLoaded ? '' : 'hidden'}`} src={captchaUrl} alt="Jobber CAPTCHA" onLoad={() => setCaptchaLoaded(true)} onError={() => setCaptchaLoaded(false)} />{captchaLoaded && <div className="matalia-captcha-row"><input value={captcha} onChange={(event) => setCaptcha(event.target.value)} placeholder="Enter CAPTCHA" autoFocus /><button className="matalia-primary" type="button" onClick={() => void sendCaptcha()}>Submit</button></div>}</>}
          {fetchStatus?.status === 'error' && <div className="matalia-error">{fetchStatus.error || fetchStatus.message}</div>}
          <div className="matalia-modal-actions">{fetchStatus?.status === 'completed' ? <button className="matalia-primary" type="button" onClick={() => setFetchOpen(false)}>Close</button> : <button className="matalia-secondary" type="button" onClick={() => void cancelFetch()}>Cancel</button>}</div>
        </>}
      </div>
    </div>}
  </main>;
}
