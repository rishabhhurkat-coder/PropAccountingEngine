import { Activity, BarChart3, BriefcaseBusiness, Clock3, Target, WalletCards } from 'lucide-react';

const items = [{ label: 'Total Quantity', value: '2,480', icon: BriefcaseBusiness, tone: 'violet' }, { label: 'Net MTM', value: '₹2,45,630.50', icon: BarChart3, tone: 'green' }, { label: 'Realized P&L', value: '₹85,320.00', icon: WalletCards, tone: 'blue' }, { label: 'Unrealized P&L', value: '₹1,60,310.50', icon: Activity, tone: 'orange' }, { label: 'Avg. Holding Time', value: '2h 35m', icon: Clock3, tone: 'violet' }, { label: 'Win Rate', value: '63.24%', icon: Target, tone: 'blue' }];

export function TradeBookBottomSummary() { return <section className="reference-bottom-summary">{items.map(({ label, value, icon: Icon, tone }) => <div className="reference-bottom-item" key={label}><div className={`reference-bottom-icon ${tone}`}><Icon size={17} /></div><div><span>{label}</span><strong className={tone === 'green' ? 'positive-value' : ''}>{value}</strong></div></div>)}</section>; }
