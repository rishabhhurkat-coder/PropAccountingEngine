import { Activity, BarChart3, FileChartColumn, History, SlidersHorizontal, Sparkles } from 'lucide-react';

const STRATEGY_FAMILY_BADGES = [
  { match: 'BANKNIFTY FING', tone: 'purple', icon: FileChartColumn },
  { match: 'BANKNIFTY AVWAP', tone: 'green', icon: Activity },
  { match: 'NIFTY AVWAP', tone: 'blue', icon: BarChart3 },
  { match: 'NIFTY FING', tone: 'orange', icon: Sparkles },
  { match: 'ATM EMA INTRADAY', tone: 'cyan', icon: Activity },
  { match: 'NIFTY OPT BUY', tone: 'pink', icon: SlidersHorizontal },
  { match: 'NIFTY EXPIRY TRADES', tone: 'yellow', icon: History },
];

function strategyBadgePattern(strategy: string) {
  const normalized = strategy.replace(/\s+/g, ' ').trim().toUpperCase();
  return STRATEGY_FAMILY_BADGES.find(({ match }) => normalized.includes(match)) || { tone: 'neutral', icon: BarChart3 };
}

export function StrategyBadge({ value, className = '' }: { value: string; className?: string }) {
  const pattern = strategyBadgePattern(value || '—');
  const Icon = pattern.icon;
  return <span className={`strategy-color-badge ${pattern.tone} ${className}`.trim()}><Icon size={14} aria-hidden="true" /><span>{value || '—'}</span></span>;
}
