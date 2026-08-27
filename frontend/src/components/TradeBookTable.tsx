import { Trash2 } from 'lucide-react';
import { TradeBookRecord } from '../lib/tradeBook';
import { StrategyBadge } from './StrategyBadge';

export type TradeSortKey = 'date' | 'time' | 'tradeId' | 'side' | 'scrip' | 'expiry' | 'strike' | 'optType' | 'qty' | 'price' | 'mtm' | 'strategy' | 'status';

function formatMoney(value: number) { return `${value >= 0 ? '+' : '-'}₹${Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function SortButton({ label, field, sortKey, sortDirection, onSort }: { label: string; field: TradeSortKey; sortKey: TradeSortKey | null; sortDirection: 'asc' | 'desc'; onSort: (field: TradeSortKey) => void }) { return <button className="reference-sort-button" onClick={() => onSort(field)}>{label.toUpperCase()}{sortKey === field && <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>}</button>; }

export function TradeBookTable({ rows, sortKey, sortDirection, onSort, openMenu, onDelete, showStatus, showPlAmt, showCmp, closedView, openView, showTradeId = true, selectionMode, selectedTradeIds, onToggleTrade, onToggleAll }: { rows: TradeBookRecord[]; sortKey: TradeSortKey | null; sortDirection: 'asc' | 'desc'; onSort: (field: TradeSortKey) => void; openMenu: string | null; onOpenMenu?: (id: string | null) => void; onDelete: (tradeId: string) => void; showStatus: boolean; showPlAmt: boolean; showCmp: boolean; closedView?: boolean; openView?: boolean; showTradeId?: boolean; selectionMode: boolean; selectedTradeIds: Set<string>; onToggleTrade: (tradeId: string) => void; onToggleAll: (tradeIds: string[], checked: boolean) => void }) {
  const visibleTradeIds = rows.map((row) => row.tradeId);
  const allVisibleSelected = visibleTradeIds.length > 0 && visibleTradeIds.every((tradeId) => selectedTradeIds.has(tradeId));
  return (
    <div className="reference-table-wrap">
      <table data-trade-layout={closedView ? 'closed' : openView ? 'open' : 'standard'} className={`reference-table reference-tradebook-table ${closedView ? 'closed-trade-layout' : ''} ${openView ? 'open-trade-layout' : ''} ${showPlAmt ? 'with-pl-amt' : 'without-pl-amt'}`}>
        <colgroup>
          {selectionMode && <col className="trade-col-select" />}
          {!closedView && <col className="trade-col-date" />}
          {!closedView && <col className="trade-col-time" />}
          {showTradeId && <col className="trade-col-trade-id" />}
          <col className="trade-col-side" />
          <col className="trade-col-scrip" />
          <col className="trade-col-expiry" />
          <col className="trade-col-strike" />
          <col className="trade-col-option" />
          <col className="trade-col-qty" />
          {!closedView && <col className="trade-col-price" />}
          {closedView && <><col className="trade-col-date" /><col className="trade-col-time" /><col className="trade-col-price" /></>}
          {showCmp && <col className="trade-col-cmp" />}
          {showPlAmt && <col className="trade-col-pl-amt" />}
          <col className="trade-col-strategy" />
          {showStatus && <col className="trade-col-status" />}
          <col className="trade-col-actions" />
        </colgroup>
        <thead>
          <tr>
            {selectionMode && <th className="trade-select-column"><input type="checkbox" aria-label="Select all visible trades" checked={allVisibleSelected} onChange={(event) => onToggleAll(visibleTradeIds, event.target.checked)} /></th>}
            {!closedView && <th><SortButton label="Date" field="date" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>}
            {!closedView && <th><SortButton label="Time" field="time" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>}
            {showTradeId && <th className="trade-id-column"><SortButton label="Trade ID" field="tradeId" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>}
            <th><SortButton label="Trade" field="side" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Scrip" field="scrip" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Expiry" field="expiry" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Strike" field="strike" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Option" field="optType" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            <th><SortButton label="Qty" field="qty" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>
            {!closedView && <th><SortButton label="Price" field="price" sortKey={sortKey} sortDirection={sortDirection} onSort={onSort} /></th>}
            {closedView && <><th>ENTRY DATE</th><th>ENTRY TIME</th><th>ENTRY PRICE</th><th>EXIT DATE</th><th>EXIT TIME</th><th>EXIT PRICE</th></>}
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
              {selectionMode && <td className="trade-select-column"><input type="checkbox" aria-label={`Select trade ${row.tradeId}`} checked={selectedTradeIds.has(row.tradeId)} onChange={() => onToggleTrade(row.tradeId)} /></td>}
              {!closedView && <><td>{row.date}</td><td>{row.time}</td></>}
              {showTradeId && <td className="trade-id-column">{row.tradeId}</td>}
              <td><span className={`reference-side-badge ${row.side.toLowerCase()}`}>{row.side}</span></td>
              <td className="reference-scrip">{row.scrip}</td>
              <td>{row.expiry}</td>
              <td>{row.strike}</td>
              <td><span className={`reference-option-badge ${row.optType.toLowerCase()}`}>{row.optType}</span></td>
              <td>{row.qty.toLocaleString('en-IN')}</td>
              {!closedView && <td>{row.price.toFixed(2)}</td>}
              {closedView && <><td>{row.entryDate}</td><td>{row.entryTime}</td><td>{(row.entryPrice ?? 0).toFixed(2)}</td><td>{row.exitDate}</td><td>{row.exitTime}</td><td>{(row.exitPrice ?? 0).toFixed(2)}</td></>}
              {showCmp && <td className="reference-cmp-value">{row.cmp == null ? '—' : row.cmp.toFixed(2)}</td>}
              {showPlAmt && <td className={`reference-mtm ${row.mtm >= 0 ? 'positive' : 'negative'}`}>{formatMoney(row.mtm)}</td>}
              <td className="trade-strategy-cell"><StrategyBadge value={row.strategy} className={`reference-strategy ${row.strategy === 'Unassigned' ? 'unassigned' : ''}`} /></td>
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
