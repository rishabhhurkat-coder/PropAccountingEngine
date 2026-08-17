import { TradeBookTab, tradeBookTabs } from '../lib/tradeBook';

type Props = {
  activeTab: TradeBookTab;
  counts: Record<TradeBookTab, number>;
  onChange: (tab: TradeBookTab) => void;
};

export function TradeBookTabs({ activeTab, counts, onChange }: Props) {
  return (
    <div className="reference-tabs" role="tablist">
      {tradeBookTabs.map((tab) => (
        <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => onChange(tab)} role="tab" aria-selected={activeTab === tab}>
          {tab}
          <span>{counts[tab] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
