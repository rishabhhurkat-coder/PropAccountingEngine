import { Trash2 } from 'lucide-react';
import { TradeBookRecord } from '../lib/tradeBook';

export type TradeSortKey = 'time' | 'tradeId' | 'side' | 'scrip' | 'expiry' | 'strike' | 'qty' | 'price' | 'mtm' | 'strategy' | 'status';

function formatMoney(value: number) { return `${value >= 0 ? '+' : '-'}₹${Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function SortButton({ label, field, sortKey, sortDirection, onSort }: { label: string; field: TradeSortKey; sortKey: TradeSortKey | null; sortDirection: 'asc' | 'desc'; onSort: (field: TradeSortKey) => void }) { return <button className="reference-sort-button" onClick={() => onSort(field)}>{label.toUpperCase()}{sortKey === field && <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>}</button>; }

export function TradeBookTable({ rows, sortKey, sortDirection, onSort, openMenu, onDelete, showStatus, showPlAmt, showCmp }: { rows: TradeBookRecord[]; sortKey: TradeSortKey | null; sortDirection: 'asc' | 'desc'; onSort: (field: TradeSortKey) => void; openMenu: string | null; onOpenMenu?: (id: string | null) => void; onDelete: (tradeId: string) => void; showStatus: boolean; showPlAmt: boolean; showCmp: boolean }) {
  return (
    <div className="reference-table-wrap">
      <table className={`reference-table reference-tradebook-table ${showPlAmt ? 'with-pl-amt' : 'without-pl-amt'}`}>
        <colgroup>
          <col className="trade-col-date" />
          <col className="trade-col-time" />
          <col className="trade-col-trade-id" />
          <col className="trade-col-side" />
          <col className="trade-col-scrip" />
          <col className="trade-col-expiry" />
          <col className="trade-col-strike" />
          <col className="trade-col-option" />
          <col className="trade-col-qty" />
          <col className="trade-col-price" />
          {showCmp && <col className="trade-col-cmp" />}
          {showPlAmt && <col className="trade-col-pl-amt" />}
          <col className="trade-col-strategy" />
          <col className="trade-col-status" />
          <col className="trade-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>DATE</th>
            <th><SortButton label="Time" field="time" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Trade ID" field="tradeId" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Trade" field="side" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Scrip" field="scrip" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Expiry" field="expiry" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Strike" field="strike" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th>OPTION</th>
            <th><SortButton label="Qty" field="qty" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Price" field="price" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            {showCmp && <th>CMP</th>}
            {showPlAmt && <th><SortButton label="PL Amt" field="mtm" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>}
            <th><SortButton label="Strategy" field="strategy" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            {showStatus && <th><SortButton label="Status" field="status" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>}
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.id}-${row.status}-${row.time}-${row.price}`}>
              <td>{row.date}</td>
              <td>{row.time}</td>
              <td>{row.tradeId}</td>
              <td><span className={`reference-side-badge ${row.side.toLowerCase()}`}>{row.side}</span></td>
              <td className="reference-scrip">{row.scrip}</td>
              <td>{row.expiry}</td>
              <td>{row.strike}</td>
              <td><span className={`reference-option-badge ${row.optType.toLowerCase()}`}>{row.optType}</span></td>
              <td>{row.qty.toLocaleString('en-IN')}</td>
              <td>{row.price.toFixed(2)}</td>
              {showCmp && <td className="reference-cmp-value">{row.cmp == null ? '—' : row.cmp.toFixed(2)}</td>}
              {showPlAmt && <td className={`reference-mtm ${row.mtm >= 0 ? 'positive' : 'negative'}`}>{formatMoney(row.mtm)}</td>}
              <td><span className={`reference-strategy ${row.strategy === 'Unassigned' ? 'unassigned' : ''}`}>{row.strategy}</span></td>
              {showStatus && <td><span className={`reference-status ${row.status.toLowerCase()}`}>{row.status}</span></td>}
              <td><div className="reference-row-actions"><button aria-label={`Delete trade ${row.tradeId}`} onClick={() => onDelete(row.tradeId)}><Trash2 size={14} /></button></div></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="reference-empty">No trades found for the selected filters.</div>}
    </div>
  );
}
