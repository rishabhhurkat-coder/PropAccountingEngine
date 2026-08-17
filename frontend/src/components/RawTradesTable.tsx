import { Search } from 'lucide-react';
import { RawTrade } from '../types';

type Props = {
  trades: RawTrade[];
  totalCount: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

const PAGE_SIZE_OPTIONS = [25, 50, 100];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDisplayDate(value: string) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, , month, day] = isoMatch;
    return `${day}-${MONTHS[Number(month) - 1]}-${isoMatch[1].slice(-2)}`;
  }

  const slashMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, '0');
    const month = Number(slashMatch[2]);
    const year = slashMatch[3].length === 2 ? slashMatch[3] : slashMatch[3].slice(-2);
    return `${day}-${MONTHS[month - 1]}-${year}`;
  }

  const compactMatch = raw.match(/^(\d{1,2})([A-Za-z]{3})(\d{2,4})$/);
  if (compactMatch) {
    const day = compactMatch[1].padStart(2, '0');
    const month = compactMatch[2].slice(0, 1).toUpperCase() + compactMatch[2].slice(1).toLowerCase();
    const year = compactMatch[3].length === 2 ? compactMatch[3] : compactMatch[3].slice(-2);
    return `${day}-${month}-${year}`;
  }

  return raw;
}

function buildPageItems(currentPage: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const items: Array<number | '…'> = [1];
  const left = Math.max(2, currentPage - 1);
  const right = Math.min(totalPages - 1, currentPage + 1);

  if (left > 2) items.push('…');
  for (let page = left; page <= right; page += 1) items.push(page);
  if (right < totalPages - 1) items.push('…');
  items.push(totalPages);
  return items;
}

export function RawTradesTable({ trades, totalCount, page, pageSize, onPageChange, onPageSizeChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStartIndex = totalCount === 0 ? 0 : (safePage - 1) * pageSize;
  const pageEndIndex = totalCount === 0 ? 0 : pageStartIndex + trades.length;
  const pageItems = buildPageItems(safePage, totalPages);

  return (
    <div className="raw-table-component">
      <div className="raw-table-scroll">
        <table className="raw-trades-table">
          <thead>
            <tr>
              <th className="sticky-first">Date</th>
              <th>Time</th>
              <th>Trade</th>
              <th>Instrument</th>
              <th>Expiry</th>
              <th>Strike</th>
              <th>Options</th>
              <th>Qty</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <tr style={{ animationDelay: `${index * 25}ms` }} key={trade.id}>
                <td className="sticky-first table-mono">{formatDisplayDate(trade.date)}</td>
                <td className="table-mono">{trade.time}</td>
                <td>
                  <span className={`table-side ${trade.side.toLowerCase()}`}>{trade.side.toUpperCase()}</span>
                </td>
                <td className="table-strong">{trade.instrument}</td>
                <td>{trade.expiry}</td>
                <td>{trade.strike}</td>
                <td>
                  <span className={`table-option ${trade.option.toLowerCase()}`}>{trade.option}</span>
                </td>
                <td>{trade.quantity}</td>
                <td className="table-mono">{trade.price}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!totalCount && (
          <div className="empty-state table-empty">
            <Search size={28} />
            <strong>No data found</strong>
            <span>No trades match the selected filters.</span>
          </div>
        )}
      </div>

      <div className="raw-table-footer">
        <span>{totalCount ? `Showing ${pageStartIndex + 1} to ${pageEndIndex} of ${totalCount.toLocaleString('en-IN')} trades` : 'No data found'}</span>
        <div className="pagination">
          <button onClick={() => onPageChange(Math.max(1, safePage - 1))} disabled={safePage === 1} aria-label="Previous page">
            ‹
          </button>
          {pageItems.map((item, index) =>
            item === '…' ? (
              <span key={`ellipsis-${index}`}>…</span>
            ) : (
              <button key={item} className={item === safePage ? 'active' : ''} onClick={() => onPageChange(item)}>
                {item.toLocaleString('en-IN')}
              </button>
            ),
          )}
          <button onClick={() => onPageChange(Math.min(totalPages, safePage + 1))} disabled={safePage === totalPages} aria-label="Next page">
            ›
          </button>
          <select aria-label="Rows per page" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
