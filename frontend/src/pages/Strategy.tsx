import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, Edit3, Eye, Filter, Layers3, LayoutGrid, List, Plus, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { deleteStrategyMaster, loadStrategyMaster, suggestNextStrategyExpiries } from '../lib/api';
import type { StrategyMasterRow } from '../lib/api';
import { StrategySetupModal, ThemeSelect, type StrategySetupInitialValues } from './StrategyAllocation';

type StrategyRow = {
  mappingId: number;
  parentQty: number;
  expiry: string;
  instrument: string;
  seq: number;
  splitMethod: string;
  splitPercentage: number | null;
  splitQty: number;
  strategyName: string;
  active: boolean;
};

type Strategy = {
  mappingId: number;
  name: string;
  instrument: string;
  totalQty: number;
  splitQty: number;
  expiries: string[];
  active: boolean;
  rows: StrategyRow[];
};

type StrategySortKey = 'Name' | 'Instrument' | 'Quantity' | 'Split Quantity' | 'Expiry' | 'Status';

function normalizeStrategyRow(row: StrategyMasterRow): StrategyRow {
  return {
    mappingId: row.mappingId ?? 0,
    parentQty: row.parentQty ?? 0,
    expiry: row.expiry,
    instrument: row.instrument,
    seq: row.seq ?? 0,
    splitMethod: row.splitMethod,
    splitPercentage: row.splitPercentage,
    splitQty: row.splitQty ?? 0,
    strategyName: row.strategyName,
    active: row.active,
  };
}

function formatExpiry(value: string) {
  const match = value.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  return match ? `${match[1]}-${match[2][0]}${match[2].slice(1).toLowerCase()}-${match[3].slice(-2)}` : value;
}

function formatSplitQuantities(strategy: Strategy) {
  return strategy.rows
    .slice()
    .sort((left, right) => left.seq - right.seq)
    .map((row) => row.splitQty.toLocaleString('en-IN'))
    .join(', ');
}

function aggregateStrategies(rows: StrategyRow[]): Strategy[] {
  const grouped = new Map<number, Strategy>();
  rows.forEach((row) => {
    const mappingId = row.mappingId || 0;
    const current = grouped.get(mappingId) ?? { mappingId, name: row.strategyName, instrument: row.instrument, totalQty: row.parentQty, splitQty: 0, expiries: [], active: row.active, rows: [] };
    current.splitQty += row.splitQty;
    current.instrument = current.instrument === row.instrument ? current.instrument : 'Multiple';
    if (!current.expiries.includes(row.expiry)) current.expiries.push(row.expiry);
    current.active = current.active && row.active;
    current.rows.push(row);
    grouped.set(mappingId, current);
  });
  return Array.from(grouped.values());
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="strategy-field"><span>{label}</span><strong>{value}</strong></div>;
}

export function Strategy() {
  const [masterRows, setMasterRows] = useState<StrategyRow[]>([]);
  const [query, setQuery] = useState('');
  const [instrument, setInstrument] = useState('All Instruments');
  const [status, setStatus] = useState('All Status');
  const [expiry, setExpiry] = useState('All Expiry');
  const [sort, setSort] = useState<StrategySortKey>('Name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [viewMode, setViewMode] = useState<'tile' | 'list'>('list');
  const [showStrategyFilters, setShowStrategyFilters] = useState(false);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit' | 'view'; strategy?: Strategy } | null>(null);
  const [setupModal, setSetupModal] = useState<{ mode: 'create' | 'edit'; strategy?: Strategy; initialValues?: StrategySetupInitialValues } | null>(null);
  const [viewStrategy, setViewStrategy] = useState<Strategy | null>(null);

  useEffect(() => {
    if (!modal) return;
    if (modal.mode === 'view') {
      setViewStrategy(modal.strategy ?? null);
      setModal(null);
      return;
    }
    setSetupModal({ mode: modal.mode === 'add' ? 'create' : 'edit', strategy: modal.strategy });
    setModal(null);
  }, [modal]);

  async function deleteStrategy(strategy: Strategy) {
    if (!window.confirm(`Delete ${strategy.name}? This removes all rows for this strategy mapping.`)) return;
    try {
      const response = await deleteStrategyMaster(strategy.mappingId, strategy.name);
      setMasterRows((response.rows ?? []).map(normalizeStrategyRow));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to delete strategy.');
    }
  }

  async function copyStrategy(strategy: Strategy) {
    try {
      const response = await suggestNextStrategyExpiries(strategy.expiries);
      setSetupModal({
        mode: 'create',
        initialValues: {
          name: strategy.name,
          instrument: strategy.instrument === 'Multiple' ? strategy.rows[0]?.instrument : strategy.instrument,
          parentQty: strategy.totalQty,
          expiries: response.expiries.length ? response.expiries : strategy.expiries,
          splitRequired: strategy.rows.length > 1 || strategy.rows[0]?.splitMethod !== 'None',
          splitMethod: strategy.rows[0]?.splitMethod || 'Quantity',
          accounts: Array.from(new Map(strategy.rows.map((row) => [row.seq, row])).values())
            .sort((left, right) => left.seq - right.seq)
            .map((row, index) => ({ name: index === 0 ? 'H&L' : index === 1 ? 'Richa' : `Account ${index + 1}`, qty: row.splitQty })),
        },
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to prepare a copy of this strategy.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    loadStrategyMaster()
      .then((response) => {
        if (!cancelled) setMasterRows((response.rows ?? []).map(normalizeStrategyRow));
      })
      .catch(() => {
        if (!cancelled) setMasterRows([]);
      });
    return () => { cancelled = true; };
  }, []);

  const strategies = useMemo(() => aggregateStrategies(masterRows), [masterRows]);
  const instruments = ['All Instruments', ...Array.from(new Set(strategies.map((item) => item.instrument))).filter((item) => item !== 'Multiple')];
  const expiries = ['All Expiry', ...Array.from(new Set(masterRows.map((row) => row.expiry)))];
  const visibleStrategies = useMemo(() => {
    const search = query.trim().toLowerCase();
    const filtered = strategies.filter((item) => {
      const searchMatch = !search || `${item.name} ${item.instrument} ${item.expiries.join(' ')}`.toLowerCase().includes(search);
      const instrumentMatch = instrument === 'All Instruments' || item.instrument === instrument;
      const statusMatch = status === 'All Status' || (status === 'Active' ? item.active : !item.active);
      const expiryMatch = expiry === 'All Expiry' || item.expiries.includes(expiry);
      return searchMatch && instrumentMatch && statusMatch && expiryMatch;
    });
    return filtered.sort((left, right) => {
      let comparison = 0;
      if (sort === 'Quantity') comparison = left.totalQty - right.totalQty;
      else if (sort === 'Split Quantity') comparison = left.splitQty - right.splitQty;
      else if (sort === 'Instrument') comparison = left.instrument.localeCompare(right.instrument);
      else if (sort === 'Expiry') comparison = (left.expiries[0] ?? '').localeCompare(right.expiries[0] ?? '');
      else if (sort === 'Status') comparison = Number(left.active) - Number(right.active);
      else comparison = left.name.localeCompare(right.name);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [strategies, query, instrument, status, expiry, sort, sortDirection]);

  const activeCount = strategies.filter((item) => item.active).length;
  const totalQuantity = strategies.reduce((sum, item) => sum + item.totalQty, 0);
  const strategyFilterCount = [instrument !== 'All Instruments', status !== 'All Status', expiry !== 'All Expiry'].filter(Boolean).length;
  const toggleSort = (nextSort: StrategySortKey) => {
    if (sort === nextSort) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else { setSort(nextSort); setSortDirection('asc'); }
  };
  const sortIcon = (key: StrategySortKey) => sort === key ? (sortDirection === 'asc' ? <ArrowUp size={12} className="active" /> : <ArrowDown size={12} className="active" />) : <ArrowUpDown size={12} />;
  return <div className="strategy-page">
    <style>{`
      .strategy-page{min-height:100vh;background:#fcfdff;color:#142451;padding:26px 30px 42px}.strategy-page *{box-sizing:border-box}.strategy-top{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:24px}.strategy-eyebrow{font-size:10px;letter-spacing:.08em;color:#6b7899;font-weight:600;margin-bottom:7px}.strategy-top h1{margin:0;color:#155eef;font-size:30px;letter-spacing:-.04em}.strategy-top p{margin:7px 0 0;color:#647394;font-size:12px}.strategy-actions{display:flex;align-items:center;gap:10px}.strategy-control{height:40px;border:1px solid #dce5f4;border-radius:9px;background:#fff;display:flex;align-items:center;gap:8px;padding:0 12px;color:#23375b;font:500 11px inherit;box-shadow:0 2px 5px #102c6810}.strategy-control select{border:0;outline:0;background:transparent;color:inherit;font:inherit;appearance:none}.strategy-add{height:40px;border:1px solid #155eef;border-radius:9px;background:#155eef;color:#fff;padding:0 15px;display:flex;align-items:center;gap:7px;font:600 11px inherit;cursor:pointer;box-shadow:0 7px 18px #155eef24}.strategy-add:hover{background:#134fd0}.strategy-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-bottom:16px}.strategy-stat{min-height:91px;border:1px solid #e4eaf5;border-radius:10px;padding:16px;background:#fff;box-shadow:0 2px 8px #102c6808;display:flex;gap:12px;align-items:center}.strategy-stat-icon{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:#e9edff;color:#4059ef}.strategy-stat:nth-child(2) .strategy-stat-icon{background:#e3f7ed;color:#0ba563}.strategy-stat:nth-child(3) .strategy-stat-icon{background:#fff0e3;color:#ee911e}.strategy-stat:nth-child(4) .strategy-stat-icon{background:#eeeaff;color:#7656dd}.strategy-stat span,.strategy-stat small{display:block;color:#000;font-size:12px}.strategy-stat strong{display:block;margin:4px 0 2px;font-size:25px;color:#000}.strategy-filter{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:12px;border:1px solid #e4eaf5;border-radius:10px;background:#fff;margin-bottom:16px}.strategy-search{height:34px;min-width:240px;flex:1;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid #dfe6f3;border-radius:7px;color:#71809c}.strategy-search input{border:0;outline:0;width:100%;font:500 11px inherit;color:#25355f}.strategy-select{height:34px;border:1px solid #dfe6f3;border-radius:7px;background:#fff;color:#344a7b;padding:0 9px;font:500 11px inherit;cursor:pointer}.strategy-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.strategy-card{border:1px solid #e2e8f3;border-radius:11px;background:#fff;padding:15px;box-shadow:0 3px 11px #24365a09;min-width:0}.strategy-card:hover{border-color:#bdcafa;box-shadow:0 8px 22px #385bd01a}.strategy-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:16px}.strategy-title-row{display:flex;align-items:center;gap:6px}.strategy-card h2{font-size:16px;line-height:1.35;margin:0;color:#000}.strategy-copy{width:24px;height:24px;border:1px solid #d7e0ff;border-radius:6px;background:#fff;color:#155eef;display:grid;place-items:center;cursor:pointer}.strategy-copy:hover{background:#f5f7ff}.strategy-card .instrument{color:#000;font-size:12px;margin-top:5px}.strategy-status{border-radius:999px;padding:4px 7px;font-size:9px;font-weight:700;white-space:nowrap;background:#e9faf1;border:1px solid #bfeeda;color:#0b9b60}.strategy-status.inactive{background:#f2f3f6;border-color:#e2e5eb;color:#7b8799}.strategy-fields{border-top:1px solid #edf0f6;border-bottom:1px solid #edf0f6;padding:4px 0;margin-bottom:13px}.strategy-field{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;font-size:12px}.strategy-field span{color:#000}.strategy-field strong{color:#000;font-weight:600;text-align:right}.strategy-actions-row{display:flex;gap:8px}.strategy-action{height:29px;flex:1;border:1px solid #d7e0ff;border-radius:6px;color:#155eef;background:#fff;display:flex;align-items:center;justify-content:center;gap:6px;font:600 10px inherit;cursor:pointer}.strategy-action:hover{background:#f5f7ff}.strategy-empty{grid-column:1/-1;border:1px dashed #d8e0ef;border-radius:10px;padding:40px;text-align:center;color:#71809c;font-size:12px}.strategy-modal-backdrop{position:fixed;inset:0;background:#10204a33;display:grid;place-items:center;padding:20px;z-index:10}.strategy-modal{width:min(520px,100%);max-height:90vh;overflow:auto;border:1px solid #e1e7f2;border-radius:13px;background:#fff;box-shadow:0 20px 55px #172c5a2e;padding:20px}.strategy-modal-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}.strategy-modal h2{font-size:18px;margin:0;color:#102252}.strategy-modal p{font-size:11px;color:#6b7896;margin:6px 0 0}.strategy-close{border:0;background:#f5f7fb;color:#687895;border-radius:7px;width:30px;height:30px;display:grid;place-items:center;cursor:pointer}.strategy-detail-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.strategy-detail-grid>div{border:1px solid #edf1f8;border-radius:8px;padding:10px;background:#fbfcff}.strategy-detail-grid span{display:block;color:#71809c;font-size:9px;margin-bottom:5px}.strategy-detail-grid strong{font-size:12px;color:#142452}.strategy-form{display:grid;gap:10px}.strategy-form label{display:grid;gap:5px;color:#647394;font-size:10px;font-weight:600}.strategy-form input,.strategy-form select{height:35px;border:1px solid #dfe6f3;border-radius:7px;padding:0 9px;color:#142452;font:500 11px inherit}.strategy-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:9px}.strategy-form-actions button{height:34px;border-radius:7px;padding:0 13px;font:600 10px inherit;cursor:pointer}.strategy-cancel{border:1px solid #d7e1f1;background:#fff;color:#145fe4}.strategy-save{border:1px solid #155eef;background:#155eef;color:#fff}@media(max-width:1120px){.strategy-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:850px){.strategy-page{padding:20px 16px}.strategy-top{align-items:flex-start;flex-direction:column}.strategy-actions{width:100%;flex-wrap:wrap}.strategy-control{flex:1}.strategy-add{width:100%;justify-content:center}.strategy-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.strategy-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:540px){.strategy-summary,.strategy-grid{grid-template-columns:1fr}.strategy-filter{align-items:stretch}.strategy-search{min-width:0;flex-basis:100%}.strategy-select{flex:1;min-width:0}}
    `}</style>
    <style>{`.strategy-cancel{border:1px solid #dfe6f3;background:#fff;color:#4a5d80}.strategy-save{border:1px solid #155eef;background:#155eef;color:#fff}.strategy-view-toggle{height:34px;display:inline-flex;align-items:center;gap:2px;padding:3px;border:1px solid #dfe6f3;border-radius:8px;background:#fff}.strategy-view-toggle button{width:30px;height:26px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:#71809c;cursor:pointer}.strategy-view-toggle button.active{background:#155eef;color:#fff}.strategy-view-toggle button:hover:not(.active){background:#f2f5ff;color:#155eef}.strategy-list-wrap{width:100%;overflow-x:auto;border:1px solid #e4e9f2;border-radius:7px;background:#fff;box-shadow:none}.strategy-list{width:100%;min-width:1080px;border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:10px;color:#000}.strategy-list col:nth-child(1){width:22%}.strategy-list col:nth-child(2){width:12%}.strategy-list col:nth-child(3){width:10%}.strategy-list col:nth-child(4){width:15%}.strategy-list col:nth-child(5){width:13%}.strategy-list col:nth-child(6){width:10%}.strategy-list col:nth-child(7){width:18%}.strategy-list th{height:35px;padding:0 10px;text-align:left;background:#fafbfe;color:#155eef;font-family:'DM Sans',Arial,sans-serif;font-size:10.35px;font-weight:600;letter-spacing:0;white-space:nowrap;border-bottom:1px solid #e4e9f2}.strategy-list td{height:43px;padding:0 10px;color:#000;font-size:10px;vertical-align:middle;white-space:nowrap;border-bottom:1px solid #edf0f6}.strategy-list tbody tr:last-child td{border-bottom:0}.strategy-list tbody tr:hover{background:#fbfcff}.strategy-list .list-strategy-name{display:block;color:#000;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.strategy-list .list-instrument,.strategy-list .list-expiry{color:#000}.strategy-list .strategy-status{display:inline-block}.strategy-list-actions{display:flex;align-items:center;gap:18px;white-space:nowrap}.strategy-list-action{border:0;background:transparent;padding:0;color:#155eef;font:500 10px inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px}.strategy-list-action:hover{color:#0f49bf}.strategy-list-action.danger{color:#d33f4d}.strategy-list-action.danger:hover{color:#b42332}.strategy-list-empty{padding:40px!important;text-align:center;color:#71809c}.strategy-grid.tile-view{grid-template-columns:repeat(4,minmax(0,1fr))}.strategy-top h1{font-size:25px;color:#155eef;letter-spacing:-.025em}.strategy-filter{display:grid;grid-template-columns:minmax(220px,1.6fr) repeat(4,minmax(120px,1fr)) auto;gap:9px;align-items:end;margin-bottom:15px;padding:11px 13px;border:1px solid #dfe7f4;border-radius:9px;background:#f8faff}.strategy-search,.strategy-filter-field{min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:5px}.strategy-search{height:auto;flex:none;padding:0;border:0;border-radius:0;color:inherit}.strategy-search>span,.strategy-filter-field>span{color:#5d6f92;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.strategy-search-control{height:30px;min-width:0;display:flex;align-items:center;gap:8px;padding:0 8px;border:1px solid #d7e0ef;border-radius:6px;background:#fff;color:#71809c}.strategy-search-control:focus-within{border-color:#4b75ef;box-shadow:0 0 0 3px rgba(49,92,239,.09)}.strategy-search-control input{border:0;outline:0;width:100%;font:500 10px inherit;color:#000}.strategy-search-control input::placeholder{color:#8c9ab1}.strategy-filter .strategy-select{height:30px;min-width:0;border:1px solid #d7e0ef;border-radius:6px;background:#fff;color:#000;padding:0 8px;font:500 10px inherit;outline:0}.strategy-filter .strategy-select:focus{border-color:#4b75ef;box-shadow:0 0 0 3px rgba(49,92,239,.09)}.strategy-filter-clear{height:30px;width:30px;border:1px solid #e4c4c7;border-radius:6px;background:#fff6f6;color:#b44750;display:grid;place-items:center;cursor:pointer}.strategy-filter-clear:hover{background:#ffecee}@media(max-width:1120px){.strategy-grid.tile-view{grid-template-columns:repeat(3,minmax(0,1fr))}.strategy-filter{grid-template-columns:repeat(3,minmax(120px,1fr)) auto}.strategy-search{grid-column:1/-1}}@media(max-width:850px){.strategy-list{min-width:820px}.strategy-list th,.strategy-list td{padding-left:10px;padding-right:10px}.strategy-list-actions{gap:14px}.strategy-grid.tile-view{grid-template-columns:repeat(2,minmax(0,1fr))}.strategy-filter{grid-template-columns:repeat(2,minmax(120px,1fr))}.strategy-search{grid-column:1/-1}.strategy-filter-clear{width:100%}}@media(max-width:540px){.strategy-list{min-width:760px}.strategy-grid.tile-view{grid-template-columns:1fr}.strategy-filter{grid-template-columns:1fr}.strategy-filter-clear{width:100%}}`}</style>
    <style>{`.strategy-list{font-family:'DM Sans',Arial,sans-serif;font-size:11.5px;color:#000}.strategy-list td{height:49px;font-family:'DM Sans',Arial,sans-serif;font-size:11.5px;color:#111827}.strategy-list-sort-button{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;padding:0;color:inherit;font:inherit;text-transform:inherit;letter-spacing:inherit;cursor:pointer}.strategy-list-sort-button svg{color:#8a98b2;transition:color .2s,transform .2s}.strategy-list-sort-button:hover,.strategy-list-sort-button:hover svg,.strategy-list-sort-button svg.active{color:#2455db}.strategy-list-sort-button svg.active{transform:scale(1.08)}`}</style>
    {viewStrategy && <div className="strategy-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewStrategy(null); }}><div className="strategy-modal" role="dialog" aria-modal="true"><div className="strategy-modal-head"><div><h2>Strategy Details</h2><p>{viewStrategy.name}</p></div><button className="strategy-close" onClick={() => setViewStrategy(null)} aria-label="Close"><X size={16}/></button></div><div className="strategy-detail-grid">{[['Strategy Name', viewStrategy.name], ['Instrument', viewStrategy.instrument], ['Quantity', viewStrategy.totalQty.toLocaleString('en-IN')], ['Split Quantity', formatSplitQuantities(viewStrategy)], ['Expiry', viewStrategy.expiries.map(formatExpiry).join(', ')], ['Split Method', viewStrategy.rows[0]?.splitMethod ?? '—'], ['Status', viewStrategy.active ? 'Active' : 'Inactive']].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></div></div>}
    {setupModal && <StrategySetupModal mode={setupModal.mode} rows={masterRows} initialValues={setupModal.initialValues} editMappingId={setupModal.strategy?.rows[0]?.mappingId} onClose={() => setSetupModal(null)} onSaved={async () => {
      const response = await loadStrategyMaster();
      setMasterRows((response.rows ?? []).map(normalizeStrategyRow));
    }} />}
    <header className="strategy-top"><div><h1>Strategies</h1></div><div className="strategy-actions"><div className="strategy-view-toggle" role="group" aria-label="Strategy view mode"><button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} aria-label="List view" aria-pressed={viewMode === 'list'}><List size={15}/></button><button type="button" className={viewMode === 'tile' ? 'active' : ''} onClick={() => setViewMode('tile')} aria-label="Tile view" aria-pressed={viewMode === 'tile'}><LayoutGrid size={15}/></button></div><button className="strategy-add" onClick={()=>setModal({mode:'add'})}><Plus size={16}/> Add Strategy</button></div></header>
    <section className="strategy-summary"><div className="strategy-stat"><div className="strategy-stat-icon"><Layers3 size={19}/></div><div><span>Total Strategies</span><strong>{strategies.length}</strong><small>All Strategies</small></div></div><div className="strategy-stat"><div className="strategy-stat-icon"><Check size={19}/></div><div><span>Active Strategies</span><strong>{activeCount}</strong><small>Enabled</small></div></div><div className="strategy-stat"><div className="strategy-stat-icon"><ShieldCheck size={19}/></div><div><span>Inactive Strategies</span><strong>{strategies.length-activeCount}</strong><small>Disabled</small></div></div><div className="strategy-stat"><div className="strategy-stat-icon"><Activity size={19}/></div><div><span>Total Quantity</span><strong>{totalQuantity.toLocaleString('en-IN')}</strong><small>Across all strategies</small></div></div></section>
    <section className="alloc-card strategy-data-card">
      <div className="alloc-card-head">
        <div>
          <h2>Strategies</h2>
          <p>{visibleStrategies.length} record{visibleStrategies.length === 1 ? '' : 's'}</p>
        </div>
        <div className="table-tools">
          <label className="table-search">
            <Search size={15} />
            <input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Search strategies..." />
          </label>
          <button type="button" className={'table-filter-button' + (showStrategyFilters || strategyFilterCount ? ' active' : '')} onClick={() => setShowStrategyFilters((current) => !current)} aria-expanded={showStrategyFilters}>
            <Filter size={14} /> Filters{strategyFilterCount ? ' (' + strategyFilterCount + ')' : ''}
          </button>
        </div>
      </div>
      {showStrategyFilters && <div className="table-filter-panel strategy-data-filter">
        <div className="table-filter-field"><span>Instrument</span><ThemeSelect label="Instrument" value={instrument === 'All Instruments' ? '' : instrument} options={['', ...instruments.filter((item) => item !== 'All Instruments')]} onChange={(value) => setInstrument(value || 'All Instruments')} /></div>
        <div className="table-filter-field"><span>Status</span><ThemeSelect label="Status" value={status === 'All Status' ? '' : status} options={['', 'Active', 'Inactive']} onChange={(value) => setStatus(value || 'All Status')} /></div>
        <div className="table-filter-field"><span>Expiry</span><ThemeSelect label="Expiry" value={expiry === 'All Expiry' ? '' : expiry} options={['', ...expiries.filter((item) => item !== 'All Expiry')]} onChange={(value) => setExpiry(value || 'All Expiry')} /></div>
        <button type="button" className="table-filter-clear" onClick={() => { setQuery(''); setInstrument('All Instruments'); setStatus('All Status'); setExpiry('All Expiry'); setSort('Name'); setSortDirection('asc'); }} aria-label="Clear filters" title="Clear filters"><X size={14} /></button>
      </div>}
      {viewMode === 'list' ? <div className="alloc-table-wrap strategy-table-wrap"><table className="alloc-table strategy-list"><colgroup><col/><col/><col/><col/><col/><col/><col/></colgroup><thead><tr><th aria-sort={sort === 'Name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="table-sort-button" onClick={()=>toggleSort('Name')} title="Sort Strategy">Strategy{sortIcon('Name')}</button></th><th aria-sort={sort === 'Instrument' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="table-sort-button" onClick={()=>toggleSort('Instrument')} title="Sort Instrument">Instrument{sortIcon('Instrument')}</button></th><th aria-sort={sort === 'Quantity' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="table-sort-button" onClick={()=>toggleSort('Quantity')} title="Sort Quantity">Quantity{sortIcon('Quantity')}</button></th><th aria-sort={sort === 'Split Quantity' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="table-sort-button" onClick={()=>toggleSort('Split Quantity')} title="Sort Split Quantity">Split Quantity{sortIcon('Split Quantity')}</button></th><th aria-sort={sort === 'Expiry' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="table-sort-button" onClick={()=>toggleSort('Expiry')} title="Sort Expiry">Expiry{sortIcon('Expiry')}</button></th><th aria-sort={sort === 'Status' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}><button type="button" className="table-sort-button" onClick={()=>toggleSort('Status')} title="Sort Status">Status{sortIcon('Status')}</button></th><th>Actions</th></tr></thead><tbody>{visibleStrategies.length ? visibleStrategies.map((item)=><tr key={item.mappingId}><td><span className="list-strategy-name" title={item.name}>{item.name}</span></td><td className="list-instrument">{item.instrument}</td><td>{item.totalQty.toLocaleString('en-IN')}</td><td>{formatSplitQuantities(item)}</td><td className="list-expiry">{item.expiries.map(formatExpiry).join(', ')}</td><td><span className={'strategy-status ' + (item.active?'':'inactive')}>{item.active?'Active':'Inactive'}</span></td><td><div className="strategy-list-actions"><button className="strategy-list-action" onClick={()=>setModal({mode:'edit',strategy:item})} aria-label="Edit strategy" title="Edit strategy"><Edit3 size={15}/></button><button className="strategy-list-action" onClick={()=>setModal({mode:'view',strategy:item})} aria-label="View strategy" title="View strategy"><Eye size={15}/></button><button className="strategy-list-action danger" onClick={()=>deleteStrategy(item)} aria-label="Delete strategy" title="Delete strategy"><Trash2 size={15}/></button></div></td></tr>) : <tr><td className="strategy-list-empty" colSpan={7}>No strategies match the selected filters.</td></tr>}</tbody></table></div> : <section className="strategy-grid tile-view">{visibleStrategies.length ? visibleStrategies.map((item)=><article className="strategy-card" key={item.mappingId}><div className="strategy-card-head"><div><div className="strategy-title-row"><h2>{item.name}</h2><button className="strategy-copy" onClick={()=>copyStrategy(item)} aria-label={'Copy ' + item.name} title="Copy strategy"><Copy size={13}/></button></div><div className="instrument">{item.instrument}</div></div><span className={'strategy-status ' + (item.active?'':'inactive')}>{item.active?'Active':'Inactive'}</span></div><div className="strategy-fields"><Field label="Quantity" value={item.totalQty.toLocaleString('en-IN')}/><Field label="Split Quantity" value={formatSplitQuantities(item)}/><Field label="Expiry" value={item.expiries.map(formatExpiry).join(', ')}/></div><div className="strategy-actions-row"><button className="strategy-action" onClick={()=>setModal({mode:'edit',strategy:item})}><Edit3 size={13}/> Edit</button><button className="strategy-action" onClick={()=>setModal({mode:'view',strategy:item})}><Eye size={13}/> View</button><button className="strategy-action" onClick={()=>deleteStrategy(item)}><Trash2 size={13}/> Delete</button></div></article>):<div className="strategy-empty">No strategies match the selected filters.</div>}</section>}
      <div className="table-footer">
        <span>Showing {visibleStrategies.length ? 1 : 0} to {visibleStrategies.length} of {visibleStrategies.length} strategies</span>
      </div>
    </section>
    {modal && <div className="strategy-modal-backdrop" role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget)setModal(null)}}><div className="strategy-modal" role="dialog" aria-modal="true"><div className="strategy-modal-head"><div><h2>{modal.mode==='add'?'Add Strategy':modal.mode==='edit'?'Edit Strategy':'Strategy Details'}</h2><p>{modal.strategy?.name ?? 'Create a new Strategy Master mapping'}</p></div><button className="strategy-close" onClick={()=>setModal(null)} aria-label="Close"><X size={16}/></button></div>{modal.mode==='view'&&modal.strategy?<div className="strategy-detail-grid">{[['Strategy Name',modal.strategy.name],['Instrument',modal.strategy.instrument],['Total Quantity',modal.strategy.totalQty.toLocaleString('en-IN')],['Split Quantity',modal.strategy.splitQty.toLocaleString('en-IN')],['Expiry',modal.strategy.expiries.map(formatExpiry).join(', ')],['Mappings',String(modal.strategy.rows.length)],['Split Method',modal.strategy.rows[0]?.splitMethod ?? '—'],['Status',modal.strategy.active?'Active':'Inactive']].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>:<form className="strategy-form" onSubmit={(event)=>{event.preventDefault();setModal(null)}}><label>Strategy name<input defaultValue={modal.strategy?.name ?? ''} placeholder="e.g. ATM EMA Intraday" required/></label><label>Instrument<select defaultValue={modal.strategy?.instrument ?? 'NIFTY'}><option>NIFTY</option><option>BANKNIFTY</option><option>FINNIFTY</option></select></label><label>Parent quantity<input type="number" defaultValue={modal.strategy?.totalQty ?? ''} min="0" required/></label><label>Expiry<input defaultValue={modal.strategy?.expiries[0] ?? ''} placeholder="e.g. 28JUL2026" required/></label><div className="strategy-form-actions"><button type="button" className="strategy-cancel" onClick={()=>setModal(null)}>Cancel</button><button className="strategy-save" type="submit">{modal.mode==='add'?'Create Strategy':'Save Changes'}</button></div></form>}</div></div>}
    <style>{`.strategy-data-card{margin-bottom:14px}.strategy-data-card .strategy-table-wrap{padding:0 10px}.strategy-data-card .strategy-list{min-width:900px;font-family:'DM Sans',Arial,sans-serif;font-size:11.5px;color:#111827}.strategy-data-card .strategy-list th{height:35px;background:#fafbfe;text-align:left;color:#155eef;font-size:10.35px;font-weight:600;white-space:nowrap;border-bottom:1px solid #e4e9f2}.strategy-data-card .strategy-list th,.strategy-data-card .strategy-list td{padding:0 10px}.strategy-data-card .strategy-list td{height:49px;border-bottom:1px solid #edf0f6;white-space:nowrap;color:#111827;font-size:11.5px}.strategy-data-card .strategy-list tr:last-child td{border-bottom:0}.strategy-data-card .strategy-list .list-strategy-name{font-weight:600;color:#111827}.strategy-data-card .strategy-list .list-instrument{font-weight:600}.strategy-data-card .strategy-list .table-sort-button{color:#155eef;text-transform:none}.strategy-data-card .strategy-list .table-sort-button svg{margin:0!important;color:#8290ad!important}.strategy-data-card .strategy-list .table-sort-button:hover,.strategy-data-card .strategy-list .table-sort-button:hover svg,.strategy-data-card .strategy-list .table-sort-button svg.active{color:#2455db!important}.strategy-data-card .strategy-list-actions{gap:18px}.strategy-data-card .strategy-list-action{font-size:11.5px}.strategy-data-filter{grid-template-columns:repeat(3,minmax(120px,1fr)) auto}.strategy-data-filter .table-filter-field{display:flex;flex-direction:column;gap:5px;color:#5d6f92;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.strategy-data-filter .theme-select{width:100%}@media(max-width:680px){.strategy-data-filter{grid-template-columns:1fr 1fr}.strategy-data-filter .table-filter-clear{width:100%}}`}</style>
    <style>{`.strategy-top h1{font-family:'DM Sans',Arial,sans-serif;font-size:32px!important;color:#155EEF}.strategy-data-card .strategy-list th:last-child{text-align:center}.strategy-data-card .strategy-list td:last-child{text-align:center}.strategy-data-card .strategy-list-actions{justify-content:center;gap:14px}.strategy-data-card .strategy-list-action{width:28px;height:28px;justify-content:center;gap:0}`}</style>
  </div>;
}
