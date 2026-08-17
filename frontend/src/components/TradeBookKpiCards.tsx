import { BarChart3, ClipboardList, LineChart, ShoppingCart, TrendingUp, WalletCards } from 'lucide-react';

const cards = [
  { label: 'Total Trades', value: '156', icon: ClipboardList, tone: 'violet' },
  { label: 'Total Buy Qty', value: '1,240', secondary: 'Avg. Price  ₹214.36', icon: ShoppingCart, tone: 'green' },
  { label: 'Total Sell Qty', value: '1,240', secondary: 'Avg. Price  ₹216.82', icon: ShoppingCart, tone: 'red' },
  { label: 'Net P&L (MTM)', value: '₹2,45,630.50', icon: LineChart, tone: 'green', sparkline: true },
  { label: 'Realized P&L', value: '₹85,320.00', icon: WalletCards, tone: 'blue' },
  { label: 'Unrealized P&L', value: '₹1,60,310.50', icon: TrendingUp, tone: 'orange' },
];

export function TradeBookKpiCards() {
  return <section className="reference-kpi-card">{cards.map(({ label, value, secondary, icon: Icon, tone, sparkline }) => <div className="reference-kpi" key={label}><div className={`reference-kpi-icon ${tone}`}><Icon size={19} /></div><div className="reference-kpi-copy"><span>{label}</span><strong className={tone === 'green' && label.includes('P&L') ? 'positive-value' : ''}>{value}</strong>{secondary && <small>{secondary}</small>}</div>{sparkline && <svg className="reference-sparkline" viewBox="0 0 72 28" aria-hidden="true"><path d="M1 24L12 21L19 23L28 14L36 18L45 8L55 14L64 5L71 9" /></svg>}</div>)}</section>;
}
