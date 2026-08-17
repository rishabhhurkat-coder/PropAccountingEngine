import { useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import Calendar from './Calendar';

type FilterValues = { date: string; expiry: string; scrip: string; strategy: string; tradeType: string; search: string };
type Props = {
  values: FilterValues;
  options: {
    expiries: string[];
    scrips: string[];
    strategies: string[];
  };
  onChange: (key: keyof FilterValues, value: string) => void;
};

function parseDisplayDate(value: string) {
  const match = value.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (!match) return '';
  const day = match[1].padStart(2, '0');
  const monthMap: Record<string, string> = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  };
  const month = monthMap[match[2]] ?? '01';
  return `${match[3]}-${month}-${day}`;
}

function formatDisplayDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const day = match[3];
  const monthIndex = Number(match[2]) - 1;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[monthIndex]} ${match[1]}`;
}

function FieldButton({
  label,
  value,
  options,
  displayValue,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  displayValue?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const shownValue = useMemo(() => displayValue ?? value ?? `All ${label}`, [displayValue, label, value]);

  return (
    <div className="reference-filter-field reference-dropdown-field">
      <span>{label}</span>
      <button type="button" className="reference-dropdown-button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <strong>{shownValue}</strong>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="reference-dropdown-menu" role="listbox">
          {options.map((option) => (
            <button
              type="button"
              key={option}
              className={`reference-dropdown-option ${option === value ? 'active' : ''}`}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TradeBookFilters({ values, options, onChange }: Props) {
  return (
    <section className="reference-filter-card">
      <div className="reference-filter-field date-field">
        <span>Trade Date</span>
        <Calendar className="trade-book-calendar" value={parseDisplayDate(values.date)} placeholder="All Dates" allowClear onChange={(value) => onChange('date', value ? formatDisplayDate(value) : '')} />
      </div>
      <FieldButton label="Expiry" value={values.expiry} options={options.expiries} onChange={(value) => onChange('expiry', value)} />
      <FieldButton label="Scrip" value={values.scrip} options={options.scrips} onChange={(value) => onChange('scrip', value)} />
      <FieldButton label="Strategy" value={values.strategy} options={options.strategies} onChange={(value) => onChange('strategy', value)} />
      <FieldButton label="Trade Type" value={values.tradeType} displayValue={values.tradeType === 'All' ? 'All' : values.tradeType} options={['All', 'Buy', 'Sell']} onChange={(value) => onChange('tradeType', value)} />
      <label className="reference-search-field">
        <Search size={15} />
        <input value={values.search} onChange={(event) => onChange('search', event.target.value)} placeholder="Search anything..." />
      </label>
    </section>
  );
}
