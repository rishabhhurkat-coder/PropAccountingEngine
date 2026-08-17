import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Calendar from '../Calendar';
import { useReportData } from './report-data';

export function ReportHeader() {
  const { filters } = useReportData();
  const [fromDate, setFromDate] = useState(filters.fromDate ?? '');
  const [toDate, setToDate] = useState(filters.toDate ?? '');

  useEffect(() => {
    setFromDate(filters.fromDate ?? '');
    setToDate(filters.toDate ?? '');
  }, [filters.fromDate, filters.toDate]);

  const changeFromDate = (value: string) => {
    setFromDate(value);
    if (value && toDate && toDate < value) setToDate(value);
  };

  return <header className="v0-page-header">
    <div><h1>Strategy Report</h1></div>
    <div className="v0-header-controls">
      <div className="v0-report-date-range">
        <Calendar label="From" value={fromDate} placeholder="Select date" onChange={changeFromDate} rangeStart={fromDate} rangeEnd={toDate} />
        <span className="v0-report-date-separator">to</span>
        <Calendar label="To" value={toDate} placeholder="Select date" minDate={fromDate || undefined} onChange={setToDate} rangeStart={fromDate} rangeEnd={toDate} />
      </div>
      <button>{filters.instrument}<ChevronDown size={13}/></button>
    </div>
  </header>;
}
