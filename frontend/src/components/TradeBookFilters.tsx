import { useMemo, useState } from 'react';
import { Filter, Search } from 'lucide-react';
import Calendar from './Calendar';

export type TradeBookFilterValues = {
  date: string;
  expiry: string;
  scrip: string;
  strategy: string;
  tradeType: string;
  optionType: string;
  search: string;
};

type FilterOptions = {
  dates: string[];
  expiries: string[];
  scrips: string[];
  strategies: string[];
  optionTypes: string[];
};

type FilterProps = {
  values: TradeBookFilterValues;
  options: FilterOptions;
  onChange: (key: keyof TradeBookFilterValues, value: string) => void;
};

function parseDisplayDate(value: string) {
  const match = value.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (!match) return '';
  const monthMap: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return `${match[3]}-${monthMap[match[2]] ?? '01'}-${match[1].padStart(2, '0')}`;
}

function formatDisplayDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${match[3]} ${months[Number(match[2]) - 1] ?? ''} ${match[1]}`.trim();
}

function normalizeDateText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function dateVariants(value: string) {
  const match = value.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (!match) return [value];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthNumber = String(months.findIndex((month) => month.toLowerCase() === match[2].toLowerCase()) + 1).padStart(2, '0');
  return [value, `${match[1]}-${match[2]}`, `${match[1]}-${monthNumber}`, `${match[1]}/${monthNumber}`];
}

export function TradeBookFilterControls({ values, showFilters, activeFilterCount, onToggleFilters, onChange }: Pick<FilterProps, 'values' | 'onChange'> & { showFilters: boolean; activeFilterCount: number; onToggleFilters: () => void }) {
  return (
    <div className="table-tools trade-book-filter-controls">
      <label className="table-search trade-book-search">
        <Search size={15} />
        <input value={values.search} onChange={(event) => onChange('search', event.target.value)} placeholder="Search trades..." />
      </label>
      <button type="button" className={`table-filter-button trade-book-filter-icon${showFilters || activeFilterCount ? ' active' : ''}`} onClick={onToggleFilters} aria-expanded={showFilters} aria-label={activeFilterCount ? `Filters active (${activeFilterCount})` : 'Open filters'} title={activeFilterCount ? `Filters active (${activeFilterCount})` : 'Open filters'}>
        <Filter size={14} />
      </button>
    </div>
  );
}

export function TradeBookFilterPanel({ values, options, onChange, onClear }: FilterProps & { onClear: () => void }) {
  const [showDateSuggestions, setShowDateSuggestions] = useState(false);
  const dateSuggestions = useMemo(() => {
    const query = normalizeDateText(values.date);
    return options.dates
      .filter((value) => value !== 'All Dates' && (!query || dateVariants(value).some((variant) => normalizeDateText(variant).includes(query))))
      .slice(0, 8);
  }, [options.dates, values.date]);
  return (
    <section className="table-filter-panel trade-book-filter-panel">
      <label className="table-filter-date">
        <span>Date</span>
        <div className="table-filter-date-controls">
          <Calendar className="trade-book-calendar" value={parseDisplayDate(values.date)} placeholder="Any date" allowClear allowedDates={options.dates.filter((value) => value !== 'All Dates').map(parseDisplayDate)} onChange={(value) => { onChange('date', value ? formatDisplayDate(value) : ''); setShowDateSuggestions(false); }} />
          <input value={values.date} onChange={(event) => onChange('date', event.target.value)} onFocus={() => setShowDateSuggestions(true)} onBlur={() => window.setTimeout(() => setShowDateSuggestions(false), 120)} placeholder="Type date" aria-label="Type date" aria-autocomplete="list" aria-expanded={showDateSuggestions && dateSuggestions.length > 0} />
          {showDateSuggestions && dateSuggestions.length > 0 && <div className="table-filter-date-suggestions" role="listbox">{dateSuggestions.map((value) => <button type="button" role="option" key={value} onMouseDown={(event) => { event.preventDefault(); onChange('date', value); setShowDateSuggestions(false); }}>{value}</button>)}</div>}
        </div>
      </label>
      <label className="table-filter-field"><span>Instrument</span><select aria-label="Instrument" value={values.scrip === 'All Scrips' ? '' : values.scrip} onChange={(event) => onChange('scrip', event.target.value || 'All Scrips')}><option value="">All</option>{options.scrips.filter((value) => value !== 'All Scrips').map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="table-filter-field"><span>Expiry</span><select aria-label="Expiry" value={values.expiry === 'All Expiry' ? '' : values.expiry} onChange={(event) => onChange('expiry', event.target.value || 'All Expiry')}><option value="">All</option>{options.expiries.filter((value) => value !== 'All Expiry').map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="table-filter-field"><span>Trade</span><select aria-label="Trade" value={values.tradeType === 'All' ? '' : values.tradeType} onChange={(event) => onChange('tradeType', event.target.value || 'All')}><option value="">All</option><option value="BUY">BUY</option><option value="SELL">SELL</option></select></label>
      <label className="table-filter-field"><span>Option</span><select aria-label="Option" value={values.optionType} onChange={(event) => onChange('optionType', event.target.value)}><option value="">All</option>{options.optionTypes.filter((value) => value !== 'All Options').map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="table-filter-field"><span>Strategy</span><select aria-label="Strategy" value={values.strategy === 'All Strategies' ? '' : values.strategy} onChange={(event) => onChange('strategy', event.target.value || 'All Strategies')}><option value="">All</option>{options.strategies.filter((value) => value !== 'All Strategies').map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <button type="button" className="table-filter-clear" onClick={onClear} aria-label="Clear filters" title="Clear filters">×</button>
    </section>
  );
}
