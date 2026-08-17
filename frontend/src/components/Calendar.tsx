import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

export type CalendarProps = {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  minDate?: string;
  maxDate?: string;
  allowedDates?: string[];
  rangeStart?: string;
  rangeEnd?: string;
  className?: string;
};

type ViewMode = 'days' | 'months' | 'years';

const months = Array.from({ length: 12 }, (_, index) => new Date(2000, index, 1).toLocaleDateString('en-IN', { month: 'short' }));
const toKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const fromKey = (value: string) => { const [year, month, day] = value.split('-').map(Number); return year && month && day ? new Date(year, month - 1, day) : null; };
const monthKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}`;
const displayDate = (value: string, placeholder: string) => { const date = fromKey(value); return date ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : placeholder; };

export default function Calendar({ value, onChange, label, placeholder = 'Select date', disabled = false, allowClear = false, minDate, maxDate, allowedDates, rangeStart = '', rangeEnd = '', className = '' }: CalendarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ViewMode>('days');
  const [direction, setDirection] = useState<'next' | 'previous'>('next');
  const [viewDate, setViewDate] = useState(() => fromKey(value) || fromKey(minDate || '') || new Date());
  const uniqueAllowed = useMemo(() => allowedDates ? [...new Set(allowedDates)].sort() : null, [allowedDates]);
  const allowedSet = useMemo(() => new Set(uniqueAllowed || []), [uniqueAllowed]);
  const years = useMemo(() => uniqueAllowed ? [...new Set(uniqueAllowed.map((date) => Number(date.slice(0, 4))))].sort((a, b) => a - b) : Array.from({ length: 11 }, (_, index) => viewDate.getFullYear() - 5 + index), [uniqueAllowed, viewDate]);
  const days = useMemo(() => { const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1); return Array.from({ length: 42 }, (_, index) => new Date(viewDate.getFullYear(), viewDate.getMonth(), 1 - first.getDay() + index)); }, [viewDate]);

  useEffect(() => { if (value) { const date = fromKey(value); if (date) setViewDate(date); } }, [value]);
  useEffect(() => { const outside = (event: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false); }; document.addEventListener('mousedown', outside); return () => document.removeEventListener('mousedown', outside); }, []);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); }; document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape); }, []);

  const isAllowed = (key: string) => {
    if (uniqueAllowed && !allowedSet.has(key)) return false;
    if (minDate && key < minDate) return false;
    if (maxDate && key > maxDate) return false;
    return true;
  };
  const month = monthKey(viewDate);
  const minMonth = minDate ? monthKey(fromKey(minDate)!) : uniqueAllowed?.length ? monthKey(fromKey(uniqueAllowed[0])!) : '';
  const maxMonth = maxDate ? monthKey(fromKey(maxDate)!) : uniqueAllowed?.length ? monthKey(fromKey(uniqueAllowed[uniqueAllowed.length - 1])!) : '';
  const moveMonth = (offset: number) => { setDirection(offset > 0 ? 'next' : 'previous'); setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1)); };
  const hasMonth = (year: number, index: number) => uniqueAllowed ? uniqueAllowed.some((date) => date.startsWith(`${year}-${String(index + 1).padStart(2, '0')}-`)) : true;
  const chooseYear = (year: number) => { setDirection(year >= viewDate.getFullYear() ? 'next' : 'previous'); setViewDate((current) => new Date(year, current.getMonth(), 1)); setMode('months'); };
  const chooseMonth = (index: number) => { setDirection(index >= viewDate.getMonth() ? 'next' : 'previous'); setViewDate((current) => new Date(current.getFullYear(), index, 1)); setMode('days'); };

  return <div className={`matalia-calendar ${className}`} ref={rootRef} onClick={(event) => event.stopPropagation()}>
    {label && <span className="matalia-calendar-label">{label}</span>}
    <button type="button" className="matalia-calendar-trigger" onClick={() => { setOpen((current) => !current); setMode('days'); }} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}>
      <CalendarDays size={14} /><strong>{displayDate(value, placeholder)}</strong><ChevronDown size={13} />
    </button>
    {open && <div className="matalia-calendar-popover" role="dialog" aria-label={label || 'Select date'}>
      <div className="matalia-calendar-header">
        <button type="button" className="matalia-calendar-nav" onClick={() => mode === 'days' ? moveMonth(-1) : setMode(mode === 'years' ? 'months' : 'days')} disabled={mode === 'days' ? Boolean(minMonth && month <= minMonth) : false} aria-label="Previous"><ChevronLeft size={15} /></button>
        {mode === 'days' && <button type="button" className="matalia-calendar-month-button" onClick={() => setMode('months')}>{viewDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}<ChevronDown size={13} /></button>}
        {mode === 'months' && <button type="button" className="matalia-calendar-month-button" onClick={() => setMode('years')}>{viewDate.getFullYear()}<ChevronDown size={13} /></button>}
        {mode === 'years' && <strong>Select year</strong>}
        <button type="button" className="matalia-calendar-nav" onClick={() => mode === 'days' ? moveMonth(1) : undefined} disabled={mode !== 'days' || Boolean(maxMonth && month >= maxMonth)} aria-label="Next"><ChevronRight size={15} /></button>
      </div>
      {mode === 'days' && <><div className="matalia-calendar-weekdays">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => <span key={day}>{day}</span>)}</div><div className={`matalia-calendar-grid ${direction}`} key={month}>{days.map((date) => { const key = toKey(date); const current = date.getMonth() === viewDate.getMonth(); const selectable = current && isAllowed(key); const selected = key === value; const inRange = Boolean(rangeStart && rangeEnd && selectable && key >= rangeStart && key <= rangeEnd); return <button type="button" key={key} disabled={!selectable} className={`matalia-calendar-day ${current ? 'current-month' : ''} ${selectable ? 'has-data' : ''} ${selected ? 'selected' : ''} ${inRange ? 'in-range' : ''} ${key === rangeStart ? 'range-start' : ''} ${key === rangeEnd ? 'range-end' : ''} ${key === toKey(new Date()) ? 'today' : ''}`} onClick={() => { onChange(key); setOpen(false); }} aria-label={displayDate(key, key)} aria-pressed={selected}>{date.getDate()}</button>; })}</div></>}
      {mode === 'months' && <div className="matalia-calendar-choice-grid">{months.map((name, index) => <button type="button" key={name} disabled={!hasMonth(viewDate.getFullYear(), index)} className={index === viewDate.getMonth() ? 'selected' : ''} onClick={() => chooseMonth(index)}>{name}</button>)}</div>}
      {mode === 'years' && <div className="matalia-calendar-choice-grid">{years.map((year) => <button type="button" key={year} className={year === viewDate.getFullYear() ? 'selected' : ''} onClick={() => chooseYear(year)}>{year}</button>)}</div>}
      {allowClear && value && <button type="button" className="matalia-calendar-clear" onClick={() => { onChange(''); setOpen(false); }}>Clear date</button>}
    </div>}
  </div>;
}
