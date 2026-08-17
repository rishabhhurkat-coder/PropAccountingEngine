import { CalendarDays, ChevronDown } from 'lucide-react'

export function TradeBookHeader({ onRefresh: _onRefresh }: { onRefresh: () => void }) {
  return <header className="reference-trade-header"><div><h1>Trade Book</h1></div><div className="reference-header-actions"><button className="reference-date-button"><CalendarDays size={15}/><strong>01 Aug 2026</strong><ChevronDown size={13}/></button></div></header>
}
